/**
 * What came back, and whether it was the API answering at all.
 *
 * ## The problem this exists for
 *
 * `fetch` resolves for every answer that arrived, including the ones that are
 * not this app's. A phone asking for `/api/overview` can be handed a page
 * instead of a payload, and there are at least three ways for that to happen
 * without anything in this repository being wrong at the time:
 *
 *   - the Worker throws or runs out of CPU, and Cloudflare answers the request
 *     itself with its own error page — `Error 1101`, `text/html`, status 5xx;
 *   - an edge or proxy layer between the phone and the Worker answers with a
 *     502/503/504 interstitial while the origin is cold or being deployed;
 *   - the static-asset router answers before the Worker and the
 *     single-page-application fallback returns `index.html` — **status 200**,
 *     `text/html`, and the API never ran (see `run_worker_first` in
 *     wrangler.toml, which is the line that stops this and therefore the line
 *     whose absence causes it).
 *
 * The old client read the body and called `JSON.parse` on it before it looked
 * at anything else, so all three arrived at the user as the parser's own
 * complaint. On V8 that reads `Unexpected token '<', "<!DOCTYPE "... is not
 * valid JSON`; on the JavaScriptCore that every iPhone runs it reads `JSON
 * Parse error: Unrecognized token '<'`, which is the message this module was
 * written in response to. Every screen in this app renders `err.message`
 * verbatim, so that string was the whole of what a person saw — and because the
 * parser quotes the input it failed on, the message was also a small leak of
 * whatever page had been substituted for the answer.
 *
 * ## What it does
 *
 * One rule, and everything else follows from it: **the status and the
 * content-type are read before the body is parsed, and a body that is not JSON
 * is never handed to the parser.** What comes back instead is an `ApiError` that
 * says what kind of answer arrived, whether asking again could plausibly help,
 * and a short sanitized prefix of the body for diagnosis — carried beside the
 * message rather than inside it, because the message is rendered and the prefix
 * must never be.
 *
 * ## What it deliberately does not do
 *
 * It does not retry, and it does not swallow. A failure that reaches here
 * leaves as a rejection every time; `retryable` is a fact about the failure
 * offered to whoever owns the retry policy, not a retry performed here. Two
 * things in this app already own that policy — the Draft refresh controller
 * with its backoff, and the reader with pull-to-refresh — and a third retry
 * loop hidden at this seam would fight both of them.
 *
 * It does not decide that a bad answer is as good as no answer. Nothing here
 * returns `null` on failure: a resolved `null` would be stored by the session
 * cache as though the server had said so, which is how a transient edge page
 * becomes a screen that is confidently empty.
 */

/** What the body actually was, regardless of what was asked for. */
export type ResponseKind = 'json' | 'html' | 'text' | 'empty';

/**
 * Why the request did not produce a value.
 *
 * `protocol` is the one worth naming separately: the request completed, the
 * status may even be 200, and the thing that answered was not the API. Folding
 * it into `server` would lose the distinction that matters when reading a
 * report — a 500 means this app's code failed, a protocol failure means this
 * app's code never ran.
 */
export type FailureKind = 'auth' | 'client' | 'server' | 'protocol' | 'network';

/** Everything worth knowing about a failed request, for logs and for tests. */
export interface ApiFailure {
  method: string;
  endpoint: string;
  status: number;
  kind: ResponseKind;
  failure: FailureKind;
  /** Whether asking again could plausibly succeed. Advice, never an action. */
  retryable: boolean;
  contentType: string | null;
  /**
   * A short, tag-stripped prefix of the body.
   *
   * For a person reading a log, this is the difference between "the API is
   * down" and "Cloudflare said Error 1101". It is deliberately not part of
   * `message`: screens render the message, and a response body is exactly the
   * thing that must not reach a screen.
   */
  detail: string | null;
  /** Cloudflare's request id when there is one, so a log line can be traced. */
  ray: string | null;
}

/**
 * A failure with its provenance attached.
 *
 * `message` is the sentence a person reads and nothing else — no status codes,
 * no body, no parser output. Everything a developer needs is in the fields
 * beside it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly kind: ResponseKind;
  readonly failure: FailureKind;
  readonly retryable: boolean;
  readonly method: string;
  readonly endpoint: string;
  readonly contentType: string | null;
  readonly detail: string | null;
  readonly ray: string | null;

  constructor(message: string, status: number, info: Partial<ApiFailure> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = info.kind ?? 'json';
    this.failure = info.failure ?? failureFor(status, this.kind);
    this.retryable = info.retryable ?? retryableFor(status, this.failure);
    this.method = info.method ?? 'GET';
    this.endpoint = info.endpoint ?? '';
    this.contentType = info.contentType ?? null;
    this.detail = info.detail ?? null;
    this.ray = info.ray ?? null;
  }

  /** The whole failure as one record. For diagnostics; never for display. */
  describe(): ApiFailure {
    return {
      method: this.method,
      endpoint: this.endpoint,
      status: this.status,
      kind: this.kind,
      failure: this.failure,
      retryable: this.retryable,
      contentType: this.contentType,
      detail: this.detail,
      ray: this.ray,
    };
  }
}

/**
 * How much of a strange body to keep.
 *
 * Enough for `Error 1101 Worker threw exception` or `502 Bad Gateway nginx` to
 * survive intact, and far short of a page.
 */
const DETAIL_LIMIT = 120;

/**
 * A body reduced to something safe to write down.
 *
 * Markup is removed rather than escaped, so there is no path by which a tag
 * reaches a log, a report or — if this ever gets rendered by mistake — a
 * screen. Whitespace is collapsed because an HTML error page is mostly
 * whitespace and a prefix of newlines says nothing.
 */
function sanitize(text: string): string | null {
  const flattened = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flattened) return null;
  return flattened.length > DETAIL_LIMIT ? `${flattened.slice(0, DETAIL_LIMIT)}…` : flattened;
}

const JSON_TYPE = /^application\/(json|[\w.+-]+\+json)\b/i;
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;

/**
 * What kind of answer this is.
 *
 * The declared content-type decides it when there is one, because that is the
 * server's own statement about what it sent and disagreeing with it would mean
 * guessing. A missing content-type is the only case that sniffs, and it sniffs
 * conservatively: something that parses as JSON is JSON, something starting
 * with `<` is markup, and everything else is text nobody promised anything
 * about.
 *
 * A body that declares itself JSON and is not stays `'json'` here. The kind is
 * what arrived, not whether it was any good; a payload that lied about itself
 * is a protocol failure and is classified as one below.
 */
export function responseKind(contentType: string | null, text: string): ResponseKind {
  if (!text.trim()) return 'empty';
  const declared = (contentType ?? '').trim();
  if (JSON_TYPE.test(declared)) return 'json';
  if (HTML_TYPE.test(declared)) return 'html';
  if (text.trimStart().startsWith('<')) return 'html';
  if (!declared && parses(text)) return 'json';
  return 'text';
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Which family of failure a status belongs to, given what came back. */
function failureFor(status: number, kind: ResponseKind): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (kind !== 'json') return 'protocol';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * Whether asking again could plausibly help.
 *
 * The cases that recover on their own: a cold or overloaded origin (5xx), a
 * timeout, a rate limit that expires, a request that never completed, and the
 * protocol failures that come with a 2xx or a 5xx — a static fallback served
 * during a deploy and an edge error page are both answers that stop being given
 * once the Worker is up.
 *
 * The cases that do not: anything the caller was told it may not do. An auth
 * failure retried is an auth failure again, and treating one as transient is
 * how a locked session turns into a spinner that never resolves.
 */
function retryableFor(status: number, failure: FailureKind): boolean {
  if (failure === 'auth') return false;
  if (failure === 'network') return true;
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return failure === 'protocol' && status >= 200 && status < 300;
}

/**
 * What a person is told.
 *
 * Four sentences, chosen by what happened and by whether the request was a read
 * or a write — "pull to refresh" is advice on a screen that is trying to load
 * and nonsense on one that was trying to save. None of them contains a status
 * code, a body, an endpoint or a parser's opinion.
 *
 * The wording says what to do rather than what broke, because what broke is not
 * actionable by the person holding the phone and what to do is.
 */
function messageFor(failure: FailureKind, status: number, method: string): string {
  if (failure === 'auth') {
    return status === 403
      ? 'That change was refused. Check you are unlocked in Setup and not in Demo Mode.'
      : 'Unlock in Setup to make changes.';
  }
  if (status === 429) return 'Too many requests just now. Try again in a moment.';
  return isRead(method)
    ? 'Couldn’t load this yet. Pull to refresh or try again.'
    : 'Couldn’t save that yet. Try again in a moment.';
}

function isRead(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD';
}

/**
 * Read a response that was supposed to be JSON.
 *
 * The order is the contract, and it is the whole fix: status and content-type
 * first, body second, parser only for a body that claims to be JSON. There is
 * no path through this function on which markup reaches `JSON.parse`.
 *
 * A JSON error response keeps the server's own `error` string as the message,
 * unchanged, because the server writes better copy about its own refusals than
 * anything general could — "Demo Mode is read-only…", "Unlock in Setup…". The
 * generic sentences are only for the answers that did not come from the server
 * at all.
 */
export async function readJson<T>(res: Response, method: string, endpoint: string): Promise<T> {
  const contentType = res.headers.get('content-type');
  const ray = res.headers.get('cf-ray');

  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    /*
     * The headers arrived and the body did not — a connection dropped
     * mid-stream, which on a phone changing cells is a normal Tuesday. It is a
     * network failure rather than a protocol one: nothing answered wrongly,
     * the answer simply stopped.
     */
    throw fail({
      method,
      endpoint,
      status: res.status,
      kind: 'empty',
      failure: 'network',
      retryable: true,
      contentType,
      detail: sanitize(cause instanceof Error ? cause.message : String(cause)),
      ray,
    });
  }

  const kind = responseKind(contentType, text);

  if (kind === 'json') {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /*
       * It said JSON and it was not. Truncation is the usual cause and it is
       * worth retrying; either way the parser's own message dies here rather
       * than travelling to a screen.
       */
      throw fail({
        method,
        endpoint,
        status: res.status,
        kind,
        failure: 'protocol',
        retryable: true,
        contentType,
        detail: sanitize(text),
        ray,
      });
    }
    if (res.ok) return body as T;
    const server = (body as { error?: unknown } | null)?.error;
    const message = typeof server === 'string' && server.trim() ? server : null;
    throw fail(
      {
        method,
        endpoint,
        status: res.status,
        kind,
        failure: failureFor(res.status, kind),
        contentType,
        detail: message ? null : sanitize(text),
        ray,
      },
      message,
    );
  }

  if (kind === 'empty') {
    /*
     * No body at all.
     *
     * `204 No Content` is a legitimate way to say nothing and resolves to
     * `null`, which is what this client has always done with an empty body.
     * Every other empty answer is a failure being reported as a success: a 200
     * that promised JSON and sent none is a truncated or intercepted response,
     * and an empty 502 is an edge that gave up without a page to show for it.
     */
    if (res.ok && (res.status === 204 || res.status === 205)) return null as T;
    throw fail({
      method,
      endpoint,
      status: res.status,
      kind,
      failure: res.ok ? 'protocol' : failureFor(res.status, kind),
      contentType,
      detail: null,
      ray,
    });
  }

  /*
   * Markup, or something else that is not JSON. The parser is never asked.
   *
   * Auth is classified from the status even here, and that is the point of
   * doing it in this order: a 401 that arrives as a sign-in page is still a 401,
   * and must not be softened into "try again" by the fact that its body was
   * unreadable.
   */
  throw fail({
    method,
    endpoint,
    status: res.status,
    kind,
    failure: failureFor(res.status, kind),
    contentType,
    detail: sanitize(text),
    ray,
  });
}

/**
 * The request never completed.
 *
 * `fetch` rejects for a dropped connection, a DNS failure and an aeroplane, and
 * the messages differ by engine — `Failed to fetch`, `Load failed`, `The
 * Internet connection appears to be offline.` Normalising them here means a
 * caller can ask one question about any failure at this seam instead of
 * pattern-matching on engine strings.
 */
export function networkFailure(method: string, endpoint: string, cause: unknown): ApiError {
  return fail({
    method,
    endpoint,
    status: 0,
    kind: 'empty',
    failure: 'network',
    retryable: true,
    contentType: null,
    detail: sanitize(cause instanceof Error ? cause.message : String(cause)),
    ray: null,
  });
}

/** Build the error, report it, hand it back to be thrown. */
function fail(info: Omit<ApiFailure, 'retryable'> & { retryable?: boolean }, serverMessage: string | null = null): ApiError {
  const retryable = info.retryable ?? retryableFor(info.status, info.failure);
  const message = serverMessage ?? messageFor(info.failure, info.status, info.method);
  const error = new ApiError(message, info.status, { ...info, retryable });
  report(error);
  return error;
}

/**
 * Say what happened, once, where a developer can find it.
 *
 * The record and not the page: method, endpoint, status, what kind of answer
 * arrived, whether it is worth retrying, Cloudflare's request id, and the
 * bounded prefix. No cookies, no passphrase, no token, no user data — none of
 * which this function is given in the first place, which is the reason it takes
 * an `ApiError` rather than the `Response`.
 *
 * A JSON refusal the server wrote on purpose is not logged: a 401 on a write by
 * a locked reader is the system working, and reporting it as a fault would bury
 * the ones that are.
 */
function report(error: ApiError): void {
  if (error.failure === 'auth' && error.kind === 'json') return;
  globalThis.console?.warn?.('[api] request failed', error.describe());
}
