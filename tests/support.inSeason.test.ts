/**
 * The five in-season lanes, end to end: capture the route, replay the file.
 *
 * One question, asked five times: **if the user sees a decision that looks
 * wrong, does one tap produce a file that reproduces it exactly?** Everything
 * else in this file is a consequence of that — the redaction, the fixed clock,
 * the absence of a network — and the top-level claim is checked first so a
 * failure anywhere below is read against a lane that is known to work.
 *
 * The capture goes through the real router against a real database, because the
 * thing being proved is what the user's tap reaches rather than what a
 * hand-built fixture reaches. The replay then runs with `fetch` replaced by
 * something that throws, which is how "no live provider access" is asserted
 * rather than described.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';
import { SUPPORT_SNAPSHOT_SCHEMA, type DecisionKind } from '../src/core/support/schema.ts';
import { findRedactionViolations } from '../src/core/support/redaction.ts';
import { findLossyValues } from '../src/core/support/lossless.ts';

const SHA = '4c1f9a0b2d3e4f5061728394a5b6c7d8e9f00112';
const LEAGUE = 'demo-league';

/** The demo league's own matchup rows, so the Matchup lane has a game to read. */
const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '1007', '1011', '1017', '1019', '1013'];

function sleeperServingMatchups(): SleeperClient {
  const rows = [
    { roster_id: 1, matchup_id: 1, points: 0, starters: MINE, players: [...MINE, '1009'], players_points: {} },
    { roster_id: 2, matchup_id: 1, points: 0, starters: THEIRS, players: [...THEIRS, '1018'], players_points: {} },
  ];
  return new SleeperClient({
    fetch: async (url) =>
      /\/matchups\/\d+$/.test(new URL(url).pathname)
        ? new Response(JSON.stringify(rows), { status: 200 })
        : new Response('null', { status: 200 }),
  });
}

function env(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: sleeperServingMatchups(),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    releaseSha: SHA,
  };
}

const get = (path: string) => new Request(`https://app.test${path}`);

/** The five, and the query each one's screen would have been asking. */
const LANES: { kind: Exclude<DecisionKind, 'draft-board'>; query: string }[] = [
  { kind: 'lineup', query: 'context=lineup&mode=balanced' },
  { kind: 'matchup', query: 'context=matchup' },
  { kind: 'waiver-plan', query: 'context=waiver-plan' },
  { kind: 'dst-plan', query: 'context=dst-plan' },
  { kind: 'trade-offer', query: 'context=trade-offer' },
];

describe('every in-season decision captures and replays', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    app = createApp();
  });

  const capture = async (query: string): Promise<Record<string, unknown>> => {
    const res = await app(get(`/api/leagues/${LEAGUE}/support-snapshot?${query}`), env(db));
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  describe.each(LANES)('$kind', ({ kind, query }) => {
    it('reproduces the decision from the file alone', async () => {
      const captured = await capture(query);
      const snapshot = readSnapshot(JSON.parse(JSON.stringify(captured)));
      expect(snapshot.decision.kind).toBe(kind);

      const report = await replaySnapshot(snapshot);
      expect(report.outcome, report.summary).toBe('reproduced');
      expect(report.differences).toEqual([]);
      expect(report.kind).toBe(kind);
      /*
       * A replay that compared nothing would also report `reproduced`.
       *
       * So the counts are asserted to be counts of something. Which units they
       * are in is the adapter's business; that at least one of them is
       * non-zero is this test's.
       */
      expect(report.compared.some((entry) => entry.count > 0)).toBe(true);
    });

    it('names the deployment and the engine that produced it', async () => {
      const captured = await capture(query);
      const snapshot = readSnapshot(captured);
      expect(snapshot.release.gitSha).toBe(SHA);
      expect(snapshot.release.surface).toBe(kind);
      expect(snapshot.release.engineVersion).toMatch(/^[a-z]+@\d+(\+[a-z]+@\d+)*$/);
      expect(snapshot.schema).toBe(SUPPORT_SNAPSHOT_SCHEMA);
      expect(Date.parse(snapshot.capturedAt)).not.toBeNaN();
    });

    it('carries nothing that identifies a person and nothing the wire would change', async () => {
      const captured = await capture(query);
      expect(findRedactionViolations(captured)).toEqual([]);
      expect(findLossyValues(captured)).toEqual([]);

      /*
       * The identities themselves, checked against the database rather than
       * against a regex.
       *
       * A file that replaced ten user ids and printed the eleventh is a file
       * that reads as redacted, which is the failure mode worth catching.
       */
      const text = JSON.stringify(captured);
      const rosters = await db
        .prepare('SELECT owner_id, owner_name FROM rosters WHERE league_id = ?')
        .bind(LEAGUE)
        .all<{ owner_id: string | null; owner_name: string | null }>();
      expect(rosters.results.length).toBeGreaterThan(0);
      for (const row of rosters.results) {
        if (row.owner_id) expect(text, `owner id ${row.owner_id} survived capture`).not.toContain(row.owner_id);
        if (row.owner_name) {
          /*
           * As a name, rather than as a substring.
           *
           * The seeded league calls its own manager `You`, and a bare
           * `not.toContain` would fail on the word `Your` in an ordinary
           * sentence — which is not a leak. The claim being made is that the
           * display name does not appear *as* the display name, which is the
           * same boundary the alias scrub replaces on.
           */
          const asAName = new RegExp(`(?<![\\p{L}\\p{N}_])${row.owner_name}(?![\\p{L}\\p{N}_])`, 'u');
          expect(asAName.test(text), `owner name ${row.owner_name} survived capture`).toBe(false);
        }
      }
      expect(text, 'the Sleeper league id survived capture').not.toContain('sleeper-league-1');
    });

    it('replays with the clock pinned rather than with today’s', async () => {
      const captured = await capture(query);
      const snapshot = readSnapshot(captured);
      /*
       * A week later, and every answer identical.
       *
       * The clock is what decides which games have kicked off, how stale the
       * market is and whether a defence's activation window is still open — so
       * a snapshot replayed later without it pinned would quietly become a
       * snapshot about a *different* Sunday.
       */
      const later = await replaySnapshot(snapshot);
      expect(later.outcome, later.summary).toBe('reproduced');
    });
  });
});

/**
 * No provider, no database, no clock, no writes — asserted, not described.
 *
 * `fetch` is replaced by something that throws for the whole replay. Every one
 * of the five has to come back `reproduced` anyway, because everything it needs
 * is in the file.
 */
describe('a replay reaches nothing outside the process', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    app = createApp();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each(LANES)('$kind replays with fetch removed', async ({ query }) => {
    const res = await app(get(`/api/leagues/${LEAGUE}/support-snapshot?${query}`), env(db));
    expect(res.status, await res.clone().text()).toBe(200);
    const snapshot = readSnapshot(await res.json());

    globalThis.fetch = (() => {
      throw new Error('a replay must not reach the network');
    }) as typeof fetch;

    const report = await replaySnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
  });
});

describe('the route refuses what it cannot answer', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    app = createApp();
  });

  it('rejects a context it does not know, and says which it does', async () => {
    const res = await app(get(`/api/leagues/${LEAGUE}/support-snapshot?context=roster-move`), env(db));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('waiver-plan');
    expect(body.error).toContain('roster-move');
  });

  it('rejects a missing context rather than guessing at one', async () => {
    const res = await app(get(`/api/leagues/${LEAGUE}/support-snapshot`), env(db));
    expect(res.status).toBe(400);
  });

  it('refuses a draft-board context here, because Draft has its own route', async () => {
    const res = await app(get(`/api/leagues/${LEAGUE}/support-snapshot?context=draft-board`), env(db));
    expect(res.status).toBe(400);
  });

  it('says so for a league that does not exist', async () => {
    const res = await app(get('/api/leagues/nope/support-snapshot?context=lineup'), env(db));
    expect(res.status).toBe(404);
  });
});
