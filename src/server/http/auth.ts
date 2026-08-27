/**
 * Auth for a personal tool whose DATA is public but whose CONTROLS are not.
 *
 * The distinction that matters here is privacy vs security. Fantasy data —
 * rosters, rankings, tallies, recommendations — is fine to read publicly, so
 * reads need no login at all and the app opens instantly on a phone.
 *
 * Anything that CHANGES state still needs the passphrase, not for privacy but
 * because an open write endpoint would let a stranger poison the evidence
 * ledger, wipe your rankings, or trigger repeated multi-megabyte syncs.
 *
 * - The passphrase is a worker secret and never reaches the browser.
 * - The session cookie is an HMAC-signed expiry stamp (no session store).
 * - Comparisons are constant-time.
 */

const COOKIE_NAME = 'fa_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface AuthEnv {
  APP_PASSPHRASE?: string;
  SESSION_SECRET?: string;
  /**
   * Drops the `Secure` cookie attribute so a session works over plain HTTP.
   * LOCAL DEVELOPMENT AND E2E ONLY — the worker never sets this, so deployed
   * cookies are always Secure.
   */
  insecureCookies?: boolean;
}

const encoder = new TextEncoder();

/**
 * The key used to sign session cookies.
 *
 * `SESSION_SECRET` is used when present. Otherwise one is derived from the
 * passphrase, so a deployment needs exactly one secret instead of two, and
 * sessions still survive redeploys (a randomly generated key would not).
 * The derived value is never the passphrase itself.
 */
export async function resolveSessionSecret(env: AuthEnv): Promise<string | null> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!env.APP_PASSPHRASE) return null;
  return hmac(env.APP_PASSPHRASE, 'fantasy-analyst/session-key/v1');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Compare lengths without early-exit on content.
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function createSessionCookie(env: AuthEnv, now = Date.now()): Promise<string> {
  const secret = await resolveSessionSecret(env);
  if (!secret) throw new Error('no passphrase configured');
  const expiry = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expiry);
  const signature = await hmac(secret, payload);
  const value = `${payload}.${signature}`;
  const secure = env.insecureCookies ? '' : ' Secure;';
  return `${COOKIE_NAME}=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function verifySession(request: Request, env: AuthEnv, now = Date.now()): Promise<boolean> {
  const secret = await resolveSessionSecret(env);
  if (!secret) return false;
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return false;
  const value = match.slice(COOKIE_NAME.length + 1);
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(expected, signature)) return false;
  const expiry = Number(payload);
  if (!Number.isFinite(expiry)) return false;
  return expiry * 1000 > now;
}

export function checkPassphrase(env: AuthEnv, submitted: string): boolean {
  const expected = env.APP_PASSPHRASE;
  if (!expected) return false;
  return timingSafeEqual(expected, submitted ?? '');
}

/** Routes that never require a session, whatever the method. */
export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/status',
  '/api/auth/logout',
  // Entering and leaving Demo Mode changes nothing but whether the demo is
  // running, so it needs no passphrase — and *leaving* must never be able to
  // fail for want of one.
  '/api/demo/enter',
  '/api/demo/exit',
  '/api/demo/status',
  // A mock draft's marker, on the same reasoning: it changes nothing but
  // whether a rehearsal is running, and *leaving* one must never be able to
  // fail for want of a passphrase.
  '/api/mock/enter',
  '/api/mock/exit',
  '/api/mock/status',
]);

// ------------------------------------------------------------- demo mode

/**
 * The marker that says a browser is in Demo Mode.
 *
 * Demo Mode's data is served in the browser, from fixtures, so the server
 * ordinarily never hears about it at all. This cookie is how it hears anyway,
 * and it exists for exactly one reason: §2 requires that a mutation be refused
 * *below the UI as well as in it*, and "below the UI" has to include a request
 * this app's own code did not make — one typed into a console, replayed from a
 * history, or fired by a screen that forgot to disable a button.
 *
 * A cookie rather than a header, because a cookie rides on every same-origin
 * request automatically. A header can be forgotten; that is the whole failure
 * this is here to prevent.
 *
 * It is not a security boundary and is not pretending to be one — whoever set
 * it can clear it, and clearing it is exactly what leaving Demo Mode does. It
 * is a safety interlock for the session that turned the demo on.
 */
const DEMO_COOKIE = 'fa_demo';

/** Session-scoped: no `Max-Age`, so closing the browser ends the demo. */
export function createDemoCookie(env: AuthEnv): string {
  const secure = env.insecureCookies ? '' : ' Secure;';
  return `${DEMO_COOKIE}=1;${secure} SameSite=Lax; Path=/`;
}

export function clearDemoCookie(env: AuthEnv): string {
  const secure = env.insecureCookies ? '' : ' Secure;';
  return `${DEMO_COOKIE}=;${secure} SameSite=Lax; Path=/; Max-Age=0`;
}

export function isDemoRequest(request: Request): boolean {
  return hasFlagCookie(request, DEMO_COOKIE);
}

// ------------------------------------------------------------- mock draft

/**
 * The marker that says a browser is running a practice draft.
 *
 * The same device as `fa_demo`, for the same reason and with the same limits.
 * A mock draft's state lives in the browser and reaches the server only as the
 * body of a read, so ordinarily nothing that could write arrives here at all
 * while one is running. This cookie is how the server hears anyway — and it
 * exists for the request this app's own code did not make.
 *
 * It is not a security boundary and is not pretending to be one. Whoever set it
 * can clear it, and clearing it is exactly what leaving a mock draft does. It
 * is a safety interlock for the session that started the rehearsal, on the one
 * afternoon of the year when a stray write to the real pick stream would be
 * most expensive.
 */
const MOCK_COOKIE = 'fa_mock';

/** Session-scoped: no `Max-Age`, so closing the browser ends the rehearsal. */
export function createMockCookie(env: AuthEnv): string {
  const secure = env.insecureCookies ? '' : ' Secure;';
  return `${MOCK_COOKIE}=1;${secure} SameSite=Lax; Path=/`;
}

export function clearMockCookie(env: AuthEnv): string {
  const secure = env.insecureCookies ? '' : ' Secure;';
  return `${MOCK_COOKIE}=;${secure} SameSite=Lax; Path=/; Max-Age=0`;
}

export function isMockRequest(request: Request): boolean {
  return hasFlagCookie(request, MOCK_COOKIE);
}

function hasFlagCookie(request: Request, name: string): boolean {
  const cookie = request.headers.get('cookie') ?? '';
  return cookie.split(/;\s*/).some((c) => c === `${name}=1`);
}

/**
 * Does this request change anything?
 *
 * Reads are public. Everything else needs an unlocked session.
 */
export function isWrite(method: string): boolean {
  return method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD';
}

/**
 * Simple in-memory rate limiter for login attempts and manual refreshes.
 * Per-isolate only — good enough for a single-user private tool, and documented
 * as such.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      const oldest = list[0]!;
      return { allowed: false, retryAfterSeconds: Math.ceil((this.windowMs - (now - oldest)) / 1000) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
