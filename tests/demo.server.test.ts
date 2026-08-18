/**
 * The server refuses writes from a browser in Demo Mode.
 *
 * The demo serves its own data in the browser, so in ordinary use the server
 * never hears from it. This is about the request that reaches the server
 * anyway: one typed into a console, replayed from history, or fired by a screen
 * that forgot to disable a control. §2 asks that a mutation be refused below
 * the UI as well as in it, and these are the proofs that it is — against the
 * real router, real auth middleware and a real database.
 *
 * The most important case is the last one: **an unlocked session is not
 * permission to mutate during a demo.**
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES, seedDemoData } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const PASSPHRASE = 'correct horse battery staple';

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: PASSPHRASE,
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

function request(path: string, opts: { method?: string; cookies?: string[]; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookies?.length) headers['cookie'] = opts.cookies.join('; ');
  return new Request(`https://app.test${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  });
}

describe('the demo marker makes the server read-only', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let demoCookie: string;
  let sessionCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();

    const login = await app(request('/api/auth/login', { method: 'POST', body: { passphrase: PASSPHRASE } }), env);
    sessionCookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const enter = await app(request('/api/demo/enter', { method: 'POST' }), env);
    expect(enter.status).toBe(200);
    demoCookie = enter.headers.get('set-cookie')!.split(';')[0]!;
    expect(demoCookie).toBe('fa_demo=1');
  });

  it('reports whether a request is in Demo Mode', async () => {
    const on = await app(request('/api/demo/status', { cookies: [demoCookie] }), env);
    expect(await on.json()).toEqual({ demo: true });
    const off = await app(request('/api/demo/status'), env);
    expect(await off.json()).toEqual({ demo: false });
  });

  it('still serves every read, because reading is the whole point', async () => {
    for (const path of ['/api/overview', '/api/leagues', '/api/players', '/api/setup/status']) {
      const res = await app(request(path, { cookies: [demoCookie] }), env);
      expect(res.status, path).toBe(200);
    }
  });

  /**
   * Every write the router exposes, read off the router itself rather than
   * listed here — so an endpoint added tomorrow is covered by this test on the
   * day it lands rather than on the day somebody remembers to add it.
   */
  const writes = [
    '/api/sleeper/connect',
    '/api/sleeper/sync-players',
    '/api/leagues/demo-league/select',
    '/api/leagues/demo-league/sync',
    '/api/leagues/demo-league/strategy/refresh',
    '/api/leagues/demo-league/managers/refresh',
    '/api/drafts/demo-draft/sync',
    '/api/drafts/demo-draft/adp-snapshot',
    '/api/adp/import',
    '/api/players/1001/my-guy',
    '/api/players/1001/queue',
    '/api/players/season-stats/refresh',
    '/api/injuries/refresh',
    '/api/usage/refresh',
    '/api/newsletter/ingest',
    '/api/newsletter/tally-import',
    '/api/newsletter/sources',
    '/api/review/evidence/x',
    '/api/review/identity/1',
    '/api/repair/backfill',
    '/api/repair/assign',
    '/api/vegas/refresh',
    '/api/vegas/season/refresh',
    '/api/startsit/refresh',
    '/api/setup/newsletter',
  ];

  it('refuses every write, even with a valid session', async () => {
    for (const path of writes) {
      const res = await app(
        request(path, { method: 'POST', cookies: [demoCookie, sessionCookie], body: {} }),
        env,
      );
      expect(res.status, `POST ${path}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('Demo Mode is read-only');
    }
  });

  /*
   * The app has no PUT, PATCH or DELETE handler anywhere, so those verbs reach
   * no route at all and are refused with a 404 before any middleware runs.
   * That is a refusal too — nothing happened — and it is asserted here so that
   * the day one of those verbs *is* routed, this test starts insisting the demo
   * guard covers it.
   */
  it('has nothing for the verbs it does not serve', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await app(request('/api/players/1001/my-guy', { method, cookies: [demoCookie] }), env);
      expect([403, 404], `${method} must not be served`).toContain(res.status);
    }
  });

  it('changes nothing in the database while it refuses', async () => {
    const read = async () => {
      const body = (await (await app(request('/api/players/1001'), env)).json()) as {
        myGuy: { level: number };
        queued: boolean;
      };
      return { myGuy: body.myGuy.level, queued: body.queued };
    };

    const before = await read();
    await app(
      request('/api/players/1001/my-guy', { method: 'POST', cookies: [demoCookie, sessionCookie], body: { level: 3 } }),
      env,
    );
    await app(
      request('/api/players/1001/queue', { method: 'POST', cookies: [demoCookie, sessionCookie], body: { queued: true } }),
      env,
    );
    expect(await read()).toEqual(before);
  });

  it('lets go the moment the demo is left, and the same write then succeeds', async () => {
    const exit = await app(request('/api/demo/exit', { method: 'POST', cookies: [demoCookie] }), env);
    expect(exit.status).toBe(200);
    expect(exit.headers.get('set-cookie')).toContain('Max-Age=0');

    const res = await app(
      request('/api/players/1001/my-guy', { method: 'POST', cookies: [sessionCookie], body: { level: 2 } }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('can always be left, even with no passphrase configured at all', async () => {
    const lockedDown = { ...env, APP_PASSPHRASE: undefined, SESSION_SECRET: undefined } as AppEnv;
    const res = await app(request('/api/demo/exit', { method: 'POST', cookies: [demoCookie] }), lockedDown);
    expect(res.status).toBe(200);
  });

  it('is session-scoped: the cookie outlives no browser', async () => {
    const enter = await app(request('/api/demo/enter', { method: 'POST' }), env);
    const header = enter.headers.get('set-cookie')!;
    expect(header).not.toContain('Max-Age');
    expect(header).not.toContain('Expires');
  });
});

describe('without the demo marker nothing changes', () => {
  it('a write with a session still works exactly as before', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const env = makeEnv(db);
    const app = createApp();
    const login = await app(request('/api/auth/login', { method: 'POST', body: { passphrase: PASSPHRASE } }), env);
    const session = login.headers.get('set-cookie')!.split(';')[0]!;

    const res = await app(
      request('/api/players/1001/my-guy', { method: 'POST', cookies: [session], body: { level: 1 } }),
      env,
    );
    expect(res.status).toBe(200);
  });
});
