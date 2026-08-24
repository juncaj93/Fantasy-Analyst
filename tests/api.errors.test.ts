/**
 * The fetch boundary, against the answers a real phone actually gets.
 *
 * The defect these were written for was reproduced on a physical iPhone as
 * `JSON Parse error: Unrecognized token '<'` — JavaScriptCore's wording for
 * "you asked me to parse a page". The client read every body and parsed it
 * before it looked at the status or the content-type, so any answer that was
 * not this app's — a Cloudflare error page, an edge interstitial, the
 * single-page-application fallback — became the parser's complaint, and every
 * screen in this app renders `err.message` verbatim.
 *
 * So the assertions come in pairs. Each case checks that the failure is
 * *classified* — auth stays auth, transient stays retryable — and that the
 * message a screen would show contains no markup, no parser wording and no
 * fragment of the body. The second half is the one that would have caught the
 * original bug, and it is asserted for every case rather than for the obvious
 * ones, because the bug was not in any single case: it was in the order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/web/api.ts';
import { cached, clearSessionCache } from '../src/web/sessionCache.ts';

/** A Cloudflare error page, near enough. This is what a thrown Worker returns. */
const CLOUDFLARE_HTML = `<!DOCTYPE html><html><head><title>fantasy-analyst.workers.dev | 502: Bad gateway</title></head><body><h1>Error 1101</h1><p>Worker threw exception</p><p>Ray ID: 8f2c1a9b0d4e0000</p></body></html>`;

/** The single-page-application fallback: status 200, and the API never ran. */
const SPA_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Junculator</title></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>`;

function html(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Answer every request with this, and count how many were asked. */
function serve(...responses: (() => Response)[]) {
  const calls: { method: string; path: string }[] = [];
  let index = 0;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path });
    const make = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return make();
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls };
}

/** The failure, as an `ApiError`. Fails the test if anything else came back. */
async function failureOf(run: Promise<unknown>): Promise<ApiError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'the request should have rejected').not.toBeNull();
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/**
 * The one assertion every case shares.
 *
 * A `SyntaxError` is what the parser throws and is the original bug's
 * signature; the string checks are for the same bug arriving by another route,
 * such as an error built by hand out of a response body.
 */
function assertNothingRawLeaked(err: unknown): void {
  expect(err).not.toBeInstanceOf(SyntaxError);
  const message = (err as Error).message;
  expect(message).not.toMatch(/[<>]/);
  expect(message).not.toMatch(/token/i);
  expect(message).not.toMatch(/JSON/i);
  expect(message).not.toMatch(/DOCTYPE/i);
  expect(message).not.toMatch(/Error 1101/);
}

beforeEach(() => {
  clearSessionCache();
  // The classification is being tested, not the reporting. Silence the one
  // console line the boundary writes so a passing run stays readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an HTML page where JSON was expected', () => {
  it('turns a 502 into a typed retryable failure and no parser error', async () => {
    serve(() => html(CLOUDFLARE_HTML, 502));
    const err = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(err);
    expect(err.status).toBe(502);
    expect(err.kind).toBe('html');
    expect(err.failure).toBe('protocol');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Couldn’t load this yet. Pull to refresh or try again.');
  });

  it('turns a 503 into the same thing', async () => {
    serve(() => html('<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>', 503));
    const err = await failureOf(api.get('/api/leagues'));
    assertNothingRawLeaked(err);
    expect(err.status).toBe(503);
    expect(err.failure).toBe('protocol');
    expect(err.retryable).toBe(true);
  });

  it('treats a 200 page on an API route as a protocol failure, not as data', async () => {
    /*
     * The static-asset router answering before the Worker. The status says
     * everything is fine, the content-type says it is a page, and the API never
     * ran — which is precisely the case a status check alone would miss.
     */
    serve(() => html(SPA_HTML, 200));
    const err = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(err);
    expect(err.status).toBe(200);
    expect(err.kind).toBe('html');
    expect(err.failure).toBe('protocol');
    expect(err.retryable).toBe(true);
  });

  it('says what to do about a write, not what to do about a read', async () => {
    serve(() => html(CLOUDFLARE_HTML, 502));
    const err = await failureOf(api.post('/api/leagues/1/star', { playerId: 'x' }));
    assertNothingRawLeaked(err);
    expect(err.message).toBe('Couldn’t save that yet. Try again in a moment.');
    expect(err.method).toBe('POST');
    expect(err.endpoint).toBe('/api/leagues/1/star');
  });

  it('recognises markup that arrives without a content-type', async () => {
    serve(() => new Response(CLOUDFLARE_HTML, { status: 502 }));
    const err = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(err);
    expect(err.kind).toBe('html');
  });
});

describe('auth semantics', () => {
  it('keeps a 401 an auth failure even when its body is a page', async () => {
    serve(() => html('<html><body>Sign in to continue</body></html>', 401));
    const err = await failureOf(api.post('/api/leagues/1/select'));
    assertNothingRawLeaked(err);
    expect(err.failure).toBe('auth');
    expect(err.status).toBe(401);
    // The one that matters: an auth failure must never be dressed up as
    // transient, or a locked session becomes a retry that can never succeed.
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Unlock in Setup to make changes.');
  });

  it('keeps a 403 an auth failure even when its body is a page', async () => {
    serve(() => html('<html><body>Forbidden</body></html>', 403));
    const err = await failureOf(api.post('/api/evidence/1/accept'));
    assertNothingRawLeaked(err);
    expect(err.failure).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('keeps the server’s own words when the refusal is JSON', async () => {
    serve(() => json({ error: 'Unlock in Setup to make changes.' }, 401));
    const err = await failureOf(api.post('/api/leagues/1/select'));
    expect(err.message).toBe('Unlock in Setup to make changes.');
    expect(err.failure).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('keeps the demo refusal exactly as the server wrote it', async () => {
    serve(() => json({ error: 'Demo Mode is read-only. Leave Demo Mode in Settings to make changes.' }, 403));
    const err = await failureOf(api.post('/api/leagues/1/star', { playerId: 'x' }));
    expect(err.message).toContain('Demo Mode is read-only');
    expect(err.failure).toBe('auth');
  });

  it('never turns an unauthorized write into a success', async () => {
    serve(() => html('<html><body>Sign in</body></html>', 401));
    const result = await api.post('/api/leagues/1/select').then(
      () => 'resolved',
      () => 'rejected',
    );
    expect(result).toBe('rejected');
  });
});

describe('a body that lied about itself', () => {
  it('reports malformed JSON as a protocol failure, not as a parser error', async () => {
    serve(
      () =>
        new Response('{"players": 41', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    );
    const err = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(err);
    expect(err.kind).toBe('json');
    expect(err.failure).toBe('protocol');
    expect(err.retryable).toBe(true);
  });

  it('reports an empty body where JSON was expected', async () => {
    serve(() => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
    const err = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(err);
    expect(err.kind).toBe('empty');
    expect(err.failure).toBe('protocol');
  });

  it('still accepts a 204 as the nothing it legitimately is', async () => {
    serve(() => new Response(null, { status: 204 }));
    await expect(api.get('/api/overview')).resolves.toBeNull();
  });
});

describe('the answers that are fine', () => {
  it('returns valid JSON unchanged', async () => {
    const body = { players: 412, leagues: 2, selectedLeague: null, nested: { a: [1, 2, 3] } };
    serve(() => json(body));
    await expect(api.get('/api/overview')).resolves.toEqual(body);
  });

  it('returns valid JSON from a write unchanged', async () => {
    serve(() => json({ ok: true }));
    await expect(api.post('/api/auth/login', { passphrase: 'x' })).resolves.toEqual({ ok: true });
  });

  it('keeps a JSON 404 a plain client failure', async () => {
    serve(() => json({ error: 'not found', path: '/api/nope' }, 404));
    const err = await failureOf(api.get('/api/nope'));
    expect(err.failure).toBe('client');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('not found');
  });

  it('marks a JSON 500 retryable and keeps the server’s message', async () => {
    serve(() => json({ error: 'no such table: players' }, 500));
    const err = await failureOf(api.get('/api/overview'));
    expect(err.failure).toBe('server');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('no such table: players');
  });

  it('treats a rate limit as worth trying again', async () => {
    serve(() => json({ error: 'too many attempts; retry in 42s' }, 429));
    const err = await failureOf(api.post('/api/auth/login', { passphrase: 'x' }));
    expect(err.retryable).toBe(true);
  });
});

describe('a request that never completed', () => {
  it('becomes a typed network failure rather than an engine string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Load failed');
      }),
    );
    const err = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(err);
    expect(err.failure).toBe('network');
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Couldn’t load this yet. Pull to refresh or try again.');
  });
});

describe('diagnostics', () => {
  it('carries the request’s identity and a bounded, tag-free prefix', async () => {
    serve(() => html(CLOUDFLARE_HTML, 502, { 'cf-ray': '8f2c1a9b0d4e0000-LHR' }));
    const err = await failureOf(api.get('/api/leagues/123/matchup'));
    const record = err.describe();
    expect(record.method).toBe('GET');
    expect(record.endpoint).toBe('/api/leagues/123/matchup');
    expect(record.status).toBe(502);
    expect(record.kind).toBe('html');
    expect(record.retryable).toBe(true);
    expect(record.ray).toBe('8f2c1a9b0d4e0000-LHR');
    // Enough to recognise the page, and none of the page.
    expect(record.detail).toContain('Error 1101');
    expect(record.detail).not.toMatch(/[<>]/);
    expect(record.detail!.length).toBeLessThanOrEqual(121);
  });

  it('keeps the whole page out of the record, however long it is', async () => {
    serve(() => html(`<html><body>${'x'.repeat(50_000)}</body></html>`, 500));
    const err = await failureOf(api.get('/api/overview'));
    expect(err.detail!.length).toBeLessThanOrEqual(121);
  });

  it('does not report a refusal the server wrote on purpose', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve(() => json({ error: 'Unlock in Setup to make changes.' }, 401));
    await failureOf(api.post('/api/leagues/1/select'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('does report an answer that was not the API’s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve(() => html(CLOUDFLARE_HTML, 502));
    await failureOf(api.get('/api/overview'));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the cache is not poisoned by a bad answer', () => {
  const WORLD = 'live';

  it('keeps good data on screen when a revalidation comes back as a page', async () => {
    serve(() => json({ players: 412 }));
    expect(await api.get('/api/overview')).toEqual({ players: 412 });

    const errors: unknown[] = [];
    serve(() => html(CLOUDFLARE_HTML, 502));
    /*
     * The second read is served from cache and revalidates behind it. The
     * revalidation is the thing being tested: it fails, it is reported, and it
     * does not replace what the screen is showing.
     */
    expect(await api.get('/api/overview', { onStaleError: (e) => errors.push(e) })).toEqual({ players: 412 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    assertNothingRawLeaked(errors[0]);
    expect((errors[0] as ApiError).retryable).toBe(true);

    // Still the good answer, from the cache, after the bad one landed.
    serve(() => html(CLOUDFLARE_HTML, 502));
    expect(await api.get('/api/overview')).toEqual({ players: 412 });
    // That read started a revalidation of its own; let it land inside the test
    // rather than after it, so its report is caught by this test's spy.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('stores nothing at all for a failed first read', async () => {
    serve(() => html(CLOUDFLARE_HTML, 502));
    await failureOf(api.get('/api/overview'));

    // A cached failure would resolve without asking. This must ask again.
    let asked = 0;
    await cached('/api/overview', WORLD, async () => {
      asked++;
      return { players: 412 };
    });
    expect(asked).toBe(1);
  });
});

describe('cold start', () => {
  it('recovers on the next request, with no parser error in between', async () => {
    serve(
      () => html(CLOUDFLARE_HTML, 502),
      () => html(CLOUDFLARE_HTML, 502),
      () => json({ players: 412, leagues: 2 }),
    );

    const first = await failureOf(api.get('/api/overview'));
    assertNothingRawLeaked(first);
    expect(first.retryable).toBe(true);

    const second = await failureOf(api.get('/api/overview', { fresh: true }));
    assertNothingRawLeaked(second);

    // The worker is up. Nothing was retained from the failures, so this is the
    // first answer the app has had and it is simply the answer.
    await expect(api.get('/api/overview', { fresh: true })).resolves.toEqual({ players: 412, leagues: 2 });
  });

  it('asks exactly once per request — the boundary never retries by itself', async () => {
    const { calls } = serve(() => html(CLOUDFLARE_HTML, 502));
    await failureOf(api.get('/api/overview'));
    expect(calls).toHaveLength(1);
  });
});
