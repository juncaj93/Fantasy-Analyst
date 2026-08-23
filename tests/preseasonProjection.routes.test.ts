/**
 * The last mile: a paste reaching the board over HTTP.
 *
 * The parser, the identity ladder, the scoring-profile identity and the
 * storage were all proven before this existed. What was missing was any way to
 * reach them from a browser, which meant the feature was correct and unusable
 * — so these are about the route surface rather than about football.
 *
 * Three properties carry it: preview writes nothing, apply requires the
 * ordinary authenticated write path, and the league's own scoring decides what
 * the numbers mean rather than anything the paste says about itself.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES, seedDemoData } from '../src/devserver/seed.ts';
import { PreseasonProjectionsRepo } from '../src/server/repos/preseasonProjections.ts';
import { createTestDb } from './helpers/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';

const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures', 'startwho-sample.txt'), 'utf8');
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

describe('the preseason projection routes', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let session: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
    const login = await app(request('/api/auth/login', { method: 'POST', body: { passphrase: PASSPHRASE } }), env);
    session = login.headers.get('set-cookie')!.split(';')[0]!;
  });

  const post = (path: string, body: unknown, cookies: string[] = [session]) =>
    app(request(path, { method: 'POST', cookies, body }), env);

  const status = async () => {
    const res = await app(request('/api/preseason-projection', { cookies: [session] }), env);
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      season: string;
      scoringKey: string | null;
      scoringLabel: string | null;
      current: { id: number; label: string; rows: number; players: number } | null;
      others: { id: number; scoringKey: string }[];
    }>;
  };

  it('reports nothing imported before anything is', async () => {
    const before = await status();
    expect(before.current).toBeNull();
    expect(before.others).toEqual([]);
    // And it still says which rules a snapshot would have to match.
    expect(before.scoringKey).toBeTruthy();
    expect(before.scoringLabel).toBeTruthy();
  });

  it('previews without writing anything', async () => {
    const res = await post('/api/preseason-projection/preview', { content: SAMPLE });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as { committed: boolean; counts: { parsed: number; matched: number } };
    expect(preview.committed).toBe(false);
    expect(preview.counts.parsed).toBeGreaterThan(0);

    // The only claim that matters here: the database is untouched.
    expect(await new PreseasonProjectionsRepo(db).list('2026')).toEqual([]);
    expect((await status()).current).toBeNull();
  });

  it('applies, and the same paste then reads back as the current snapshot', async () => {
    const res = await post('/api/preseason-projection/apply', { content: SAMPLE });
    expect(res.status).toBe(200);
    const applied = (await res.json()) as {
      committed: boolean;
      source: string;
      capturedAt: string;
      counts: { parsed: number; matched: number };
    };
    expect(applied.committed).toBe(true);
    expect(applied.source).toBe('StartWho');

    const after = await status();
    expect(after.current).not.toBeNull();
    expect(after.current!.rows).toBe(applied.counts.parsed);
    expect(after.current!.players).toBe(applied.counts.matched);
  });

  it('previews exactly what applying would do', async () => {
    // The two are one method behind a boolean, and this is where that is
    // checked rather than assumed: a preview believed and then contradicted is
    // worse than no preview.
    const preview = (await (await post('/api/preseason-projection/preview', { content: SAMPLE })).json()) as Record<
      string,
      unknown
    >;
    const applied = (await (await post('/api/preseason-projection/apply', { content: SAMPLE })).json()) as Record<
      string,
      unknown
    >;
    expect(applied['counts']).toEqual(preview['counts']);
    expect(applied['rejected']).toEqual(preview['rejected']);
    expect(applied['needsReview']).toEqual(preview['needsReview']);
    expect(applied['scoringKey']).toEqual(preview['scoringKey']);
    expect(applied['capturedAt']).toEqual(preview['capturedAt']);
  });

  it('re-importing the same capture replaces it rather than stacking', async () => {
    await post('/api/preseason-projection/apply', { content: SAMPLE });
    await post('/api/preseason-projection/apply', { content: SAMPLE });
    const all = await new PreseasonProjectionsRepo(db).list('2026');
    expect(all).toHaveLength(1);
  });

  it('refuses an empty paste with something a reader can act on', async () => {
    const res = await post('/api/preseason-projection/preview', { content: '   ' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/paste/i);
  });

  it('refuses a paste that is not a projection table', async () => {
    const res = await post('/api/preseason-projection/preview', { content: 'hello\nthere\nfriend' });
    expect(res.status).toBe(400);
  });

  it('forgets a snapshot on request, and only one that exists', async () => {
    await post('/api/preseason-projection/apply', { content: SAMPLE });
    const id = (await status()).current!.id;

    const missing = await post('/api/preseason-projection/remove', { id: id + 999 });
    expect(missing.status).toBe(404);

    const gone = await post('/api/preseason-projection/remove', { id });
    expect(gone.status).toBe(200);
    expect((await status()).current).toBeNull();
  });
});

describe('applying is an ordinary authenticated write', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
  });

  /*
   * Both are POSTs and both are therefore gated — preview because it carries a
   * body, not because it changes anything. What must never happen is a write
   * path that is reachable without the passphrase, so it is checked here at the
   * router rather than trusted from the shape of the handler.
   */
  it('refuses preview and apply without a session', async () => {
    for (const path of ['/api/preseason-projection/preview', '/api/preseason-projection/apply']) {
      const res = await app(request(path, { method: 'POST', body: { content: SAMPLE } }), env);
      expect(res.status, path).toBe(401);
    }
    expect(await new PreseasonProjectionsRepo(db).list('2026')).toEqual([]);
  });

  it('serves the status to a reader who cannot write', async () => {
    // Reading what is loaded is not a privilege; changing it is.
    const res = await app(request('/api/preseason-projection'), env);
    expect(res.status).toBe(200);
  });
});
