/**
 * The other half of the same defect: what the API itself can answer with.
 *
 * Hardening the client is necessary because the layers between a phone and this
 * Worker — the edge, a proxy, the static-asset router — can all answer with a
 * page and none of them is ours. But one source of markup *was* ours, and a
 * client contract is no reason to leave it: an exception thrown by a middleware
 * used to escape the router, escape the Worker, and be answered by Cloudflare's
 * own HTML error page on a path under `/api/`.
 *
 * What is asserted here is one sentence: **every answer to an `/api/` request
 * is JSON, including the ones nobody meant to send.**
 */

import { describe, expect, it } from 'vitest';
import workerEntry from '../src/worker/index.ts';
import { Router, jsonResponse } from '../src/server/http/router.ts';
import type { WorkerEnv } from '../src/worker/index.ts';

function api(path = '/api/overview'): Request {
  return new Request(`https://app.test${path}`);
}

/** A response is JSON if it says so and if it parses. Both are checked. */
async function expectJson(res: Response): Promise<unknown> {
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  const text = await res.text();
  expect(text.trimStart().startsWith('<')).toBe(false);
  return JSON.parse(text) as unknown;
}

describe('the router', () => {
  it('answers a throwing handler with JSON', async () => {
    const router = new Router<Record<string, never>>();
    router.get('/api/boom', () => {
      throw new Error('handler exploded');
    });
    const body = await expectJson(await router.handle(api('/api/boom'), {}));
    expect(body).toEqual({ error: 'handler exploded' });
  });

  it('answers a throwing middleware with JSON rather than letting it escape', async () => {
    /*
     * The regression this file exists for. `verifySession` is `crypto.subtle`
     * work and can throw; before the fix, the middleware loop ran outside the
     * guard, so this exception left the Worker and Cloudflare answered the
     * request with `text/html`.
     */
    const router = new Router<Record<string, never>>();
    router.use(async () => {
      throw new Error('session check failed');
    });
    router.get('/api/overview', () => jsonResponse({ ok: true }));

    const res = await router.handle(api(), {});
    expect(res.status).toBe(500);
    expect(await expectJson(res)).toEqual({ error: 'session check failed' });
  });

  it('still lets a middleware answer early', async () => {
    const router = new Router<Record<string, never>>();
    router.use(async () => jsonResponse({ error: 'Unlock in Setup to make changes.' }, 401));
    router.get('/api/overview', () => jsonResponse({ ok: true }));

    const res = await router.handle(api(), {});
    expect(res.status).toBe(401);
    expect(await expectJson(res)).toEqual({ error: 'Unlock in Setup to make changes.' });
  });

  it('answers an unknown API path with JSON, not with a page', async () => {
    const router = new Router<Record<string, never>>();
    const res = await router.handle(api('/api/nope'), {});
    expect(res.status).toBe(404);
    expect(await expectJson(res)).toEqual({ error: 'not found', path: '/api/nope' });
  });
});

describe('the worker', () => {
  it('answers with JSON when the request cannot even be set up', async () => {
    /*
     * Everything the router catches, it catches after it exists. This covers
     * what happens before that — a binding that is missing or unreadable when
     * the environment is assembled. Without the guard the exception reaches
     * Cloudflare and the phone is handed `Error 1101` as a page.
     */
    const env = {
      get DB(): never {
        throw new Error('D1 binding unavailable');
      },
    } as unknown as WorkerEnv;

    const res = await workerEntry.fetch(api(), env);
    expect(res.status).toBe(500);
    expect(await expectJson(res)).toEqual({ error: 'D1 binding unavailable' });
  });

  it('does not answer for a path that is not the API', async () => {
    const served: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (request: Request) => {
          served.push(new URL(request.url).pathname);
          return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
        },
      },
    } as unknown as WorkerEnv;

    const res = await workerEntry.fetch(new Request('https://app.test/draft'), env);
    expect(res.status).toBe(200);
    expect(served).toEqual(['/draft']);
  });
});
