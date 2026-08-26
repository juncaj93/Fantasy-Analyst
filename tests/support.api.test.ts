/**
 * The capture route, over the real router and a real database.
 *
 * `tests/support.snapshot.test.ts` proves the capture reproduces its board;
 * this proves the thing the user's tap actually reaches. Three claims that only
 * exist at this layer: the route reports the deployment's own revision from the
 * same plumbing `/api/health` reports, it is a read that needs no session and
 * changes nothing, and the file it returns replays with no live provider
 * anywhere in the process.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { DRAFT_ENGINE_VERSION } from '../src/core/draft/version.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';
import { SUPPORT_SNAPSHOT_SCHEMA } from '../src/core/support/schema.ts';
import type { DraftBoard } from '../src/web/api.ts';

const SHA = '4c1f9a0b2d3e4f5061728394a5b6c7d8e9f00112';
const DRAFT = 'demo-draft';

function env(db: NodeSqliteDatabase, overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    releaseSha: SHA,
    ...overrides,
  };
}

const get = (path: string, cookie?: string) =>
  new Request(`https://app.test${path}`, { headers: cookie ? { cookie } : undefined });

describe('GET /api/drafts/:id/support-snapshot', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    app = createApp();
  });

  const capture = async (appEnv = env(db)): Promise<Record<string, unknown>> => {
    const res = await app(get(`/api/drafts/${DRAFT}/support-snapshot`), appEnv);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  it('is a public read, like every other read in this app', async () => {
    const res = await app(get(`/api/drafts/${DRAFT}/support-snapshot`), env(db));
    expect(res.status).toBe(200);
  });

  it('reports the deployed revision the health endpoint reports', async () => {
    const snapshot = await capture();
    const health = (await (await app(get('/api/health'), env(db))).json()) as {
      release: { gitSha: string };
    };

    expect((snapshot['release'] as { gitSha: string }).gitSha).toBe(SHA);
    expect((snapshot['release'] as { gitSha: string }).gitSha).toBe(health.release.gitSha);
    expect((snapshot['release'] as { engineVersion: string }).engineVersion).toBe(DRAFT_ENGINE_VERSION);
    expect(snapshot['schema']).toBe(SUPPORT_SNAPSHOT_SCHEMA);
  });

  /**
   * A local server, or a hand-run `wrangler deploy`, injects no revision.
   *
   * `unknown` rather than an empty string, for the reason `reportedGitSha`
   * gives: a snapshot claiming `""` could be read as matching anything, and a
   * support conversation that cannot tell "this build was never stamped" from
   * "this build is the one you are looking at" is worse off than one that is
   * simply told.
   */
  it('says `unknown` rather than inventing a revision it was not given', async () => {
    const snapshot = await capture(env(db, { releaseSha: null }));
    expect((snapshot['release'] as { gitSha: string }).gitSha).toBe('unknown');
  });

  it('changes nothing it looked at', async () => {
    const board = async () =>
      (await (await app(get(`/api/drafts/${DRAFT}/board?limit=40`), env(db))).json()) as DraftBoard;

    const before = await board();
    await capture();
    const after = await board();

    expect(after.recommendations.map((r) => r.playerId)).toEqual(before.recommendations.map((r) => r.playerId));
    expect(after.recommendations.map((r) => r.total)).toEqual(before.recommendations.map((r) => r.total));
    expect(after.warnings).toEqual(before.warnings);
    expect(after.poolHealth).toEqual(before.poolHealth);
  });

  it('replays to the board it captured, from the file alone', async () => {
    const snapshot = readSnapshot(await capture());
    const report = await replayDraftSnapshot(snapshot);
    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
  });

  /**
   * The determinism claim, made where it can actually be broken.
   *
   * Replay is handed sources built out of Maps, so there is nothing in the
   * object that *could* reach a provider — but "could not" is worth proving
   * against the environment rather than against the type. `fetch` is replaced
   * with something that throws for the duration, so any request at all fails
   * the test rather than quietly succeeding on a machine that happens to have
   * a network.
   */
  it('replays with the network taken away', async () => {
    const snapshot = readSnapshot(await capture());

    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('a replay must not make a request');
    }) as typeof fetch;
    try {
      const report = await replayDraftSnapshot(snapshot);
      expect(report.outcome).toBe('reproduced');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('captures the same file twice from an unchanged draft', async () => {
    /*
     * Byte-identical, which is stronger than "reproduces".
     *
     * A capture that shuffled a key order or a map iteration between two runs
     * would still replay — and would make every committed fixture a churning
     * diff, and two snapshots of the same complaint impossible to compare. The
     * clock is the one field that legitimately moves, and it does not here
     * because the board has not been rebuilt against a later instant within a
     * single test.
     */
    const first = await capture();
    const second = await capture();
    const strip = (s: Record<string, unknown>) => {
      const copy = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
      delete copy['capturedAt'];
      ((copy['decision'] as Record<string, unknown>)['inputs'] as Record<string, unknown>)['now'] = null;
      return JSON.stringify(copy);
    };
    expect(strip(second)).toBe(strip(first));
  });

  it('404s for a draft that does not exist, rather than emitting an empty file', async () => {
    const res = await app(get('/api/drafts/no-such-draft/support-snapshot'), env(db));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('narrows to the position or the queue when asked, and says which it was', async () => {
    const res = await app(get(`/api/drafts/${DRAFT}/support-snapshot?position=WR&queued=1`), env(db));
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as { decision: { request: Record<string, unknown> } };
    expect(snapshot.decision.request['position']).toBe('WR');
    expect(snapshot.decision.request['queuedOnly']).toBe(true);
  });
});
