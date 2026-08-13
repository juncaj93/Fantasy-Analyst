/**
 * Passphrase auth for a single-user private tool.
 *
 * - The passphrase and signing secret are worker secrets; neither reaches the
 *   browser.
 * - The session cookie is an HMAC-signed expiry stamp (no server-side session
 *   store needed on D1).
 * - Comparisons are constant-time.
 * - Every /api route except login/health requires a valid session.
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
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
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
  const secret = env.SESSION_SECRET;
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

/** Routes that do not require a session. */
export const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/status']);

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
