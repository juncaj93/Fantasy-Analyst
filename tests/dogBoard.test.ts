/**
 * The DOG path, the queue's order and deeper Players — end to end.
 *
 * The pure modules are pinned in their own files. What is checked here is the
 * wiring, which is where this kind of feature actually breaks: an import route
 * that stores a ranking anyway, a board that quietly reads the Sleeper snapshot
 * when the Underdog one is missing, a reorder that does not survive a rebuild.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { AdpRepo, UNDERDOG_SOURCE } from '../src/server/repos/adp.ts';
import { PlayerFlagsRepo } from '../src/server/repos/playerFlags.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { createTestDb } from './helpers/db.ts';

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

function post(path: string, body?: unknown, cookie?: string): Request {
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

function get(path: string, cookie?: string): Request {
  return new Request(`https://app.test${path}`, { headers: cookie ? { cookie } : undefined });
}

async function login(env: AppEnv, app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app(post('/api/auth/login', { passphrase: 'correct horse battery staple' }), env);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('the DOG import route refuses anything that is not raw ADP', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
    cookie = await login(env, app);
  });

  /** Names the seed actually knows, so the rows resolve to real players. */
  async function seededNames(count: number): Promise<string[]> {
    const players = (await new PlayerRepo(db).listAll()).filter((p) => p.active);
    return players.slice(0, count).map((p) => p.fullName);
  }

  it('stores a genuine Underdog board and marks it raw ADP', async () => {
    const names = await seededNames(20);
    const rows = names.map((name, i) => ({ name, adp: Math.round((1.6 + i * 2.3) * 10) / 10 }));
    const res = await app(
      post(
        '/api/adp/import',
        {
          content: JSON.stringify(rows),
          source: UNDERDOG_SOURCE,
          provider: 'best_ball_team_builder',
          snapshotAt: new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
        },
        cookie,
      ),
      env,
    );
    expect(res.status).toBe(200);
    const stored = await new AdpRepo(db).latestForSource(UNDERDOG_SOURCE);
    expect(stored?.sourceType).toBe('raw_adp');
    expect(stored?.provider).toBe('best_ball_team_builder');
  });

  it('rejects a ranking dressed as ADP, and stores nothing', async () => {
    const repo = new AdpRepo(db);
    // The demo seed ships a genuine Underdog snapshot, so the assertion that
    // matters is that a refused import does not become the newest one — which
    // is also the real-world case, since a board is rarely empty when a bad
    // fetch lands.
    const before = await repo.latestForSource(UNDERDOG_SOURCE);
    const countBefore = (await repo.list()).filter((s) => s.source === UNDERDOG_SOURCE).length;

    const names = await seededNames(20);
    const rows = names.map((name, i) => ({ name, adp: i + 1 }));
    const res = await app(
      post('/api/adp/import', { content: JSON.stringify(rows), source: UNDERDOG_SOURCE }, cookie),
      env,
    );
    expect(res.status).toBe(422);
    expect((await res.text()).toLowerCase()).toContain('ranking');
    expect((await repo.latestForSource(UNDERDOG_SOURCE))?.id).toBe(before?.id);
    expect((await repo.list()).filter((s) => s.source === UNDERDOG_SOURCE)).toHaveLength(countBefore);
  });

  it('leaves a previously good snapshot in place when a bad one is refused', async () => {
    const names = await seededNames(20);
    await app(
      post(
        '/api/adp/import',
        {
          content: JSON.stringify(names.map((name, i) => ({ name, adp: Math.round((2 + i * 2.7) * 10) / 10 }))),
          source: UNDERDOG_SOURCE,
          provider: 'best_ball_team_builder',
        },
        cookie,
      ),
      env,
    );
    const good = await new AdpRepo(db).latestForSource(UNDERDOG_SOURCE);

    await app(
      post('/api/adp/import', { content: JSON.stringify(names.map((name, i) => ({ name, adp: i + 1 }))), source: UNDERDOG_SOURCE }, cookie),
      env,
    );
    expect((await new AdpRepo(db).latestForSource(UNDERDOG_SOURCE))?.id).toBe(good?.id);
  });

  it('imports the same Underdog board twice without duplicating it', async () => {
    const names = await seededNames(20);
    const content = JSON.stringify(names.map((name, i) => ({ name, adp: Math.round((1.9 + i * 2.1) * 10) / 10 })));
    const body = { content, source: UNDERDOG_SOURCE, provider: 'best_ball_team_builder' };
    const before = (await new AdpRepo(db).list()).filter((s) => s.source === UNDERDOG_SOURCE).length;
    const first = await app(post('/api/adp/import', body, cookie), env);
    const second = await app(post('/api/adp/import', body, cookie), env);
    expect((await first.json() as { created: boolean }).created).toBe(true);
    expect((await second.json() as { created: boolean }).created).toBe(false);
    // Exactly one new snapshot, however many times the same file arrives.
    expect((await new AdpRepo(db).list()).filter((s) => s.source === UNDERDOG_SOURCE)).toHaveLength(before + 1);
  });

  it('does not touch the Sleeper snapshot when an Underdog one lands', async () => {
    const before = await new AdpRepo(db).latest();
    const names = await seededNames(20);
    await app(
      post(
        '/api/adp/import',
        {
          content: JSON.stringify(names.map((name, i) => ({ name, adp: Math.round((1.5 + i * 2.4) * 10) / 10 }))),
          source: UNDERDOG_SOURCE,
          provider: 'best_ball_team_builder',
        },
        cookie,
      ),
      env,
    );
    // Both snapshots exist, under their own sources, with their own rows.
    const sources = (await new AdpRepo(db).list()).map((s) => s.source);
    expect(new Set(sources).size).toBeGreaterThan(1);
    expect(before).not.toBeNull();
  });
});

describe('the board reads the two markets separately', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  async function firstDraftId(): Promise<string> {
    const leagues = new LeagueRepo(db);
    const league = (await leagues.listLeagues()).find((l) => l.draftId) ?? null;
    return league!.draftId!;
  }

  it('blends both markets when a fresh Underdog snapshot is present', async () => {
    const board = await new DraftBoardService(db).build(await firstDraftId(), { limit: 20 });
    expect(board.dogState.available).toBe(true);
    expect(board.dogState.provider).toBe('best_ball_team_builder');
    expect(board.dogState.freshness).toBe('fresh');

    const priced = board.recommendations.filter((r) => r.dogAdp != null && r.adp != null);
    expect(priced.length).toBeGreaterThan(3);
    for (const rec of priced) {
      // The blend, at the standard weights, and never either raw number.
      expect(rec.marketBlend.sources).toEqual(['dog', 'sleeper']);
      expect(rec.marketBlend.adp).toBeCloseTo(0.6 * rec.dogAdp! + 0.4 * rec.adp!, 1);
      expect(rec.marketBlend.singleSource).toBe(false);
    }
  });

  it('renormalises to Sleeper for the players Underdog has not priced', async () => {
    const board = await new DraftBoardService(db).build(await firstDraftId(), { limit: 40 });
    // The seed deliberately leaves the deepest few players off the Underdog
    // board, which is what exercises this on a real screen.
    const unpriced = board.recommendations.filter((r) => r.dogAdp == null && r.adp != null);
    expect(unpriced.length).toBeGreaterThan(0);
    for (const rec of unpriced) {
      expect(rec.marketBlend.singleSource).toBe(true);
      expect(rec.marketBlend.sources).toEqual(['sleeper']);
      expect(rec.marketBlend.adp).toBe(rec.adp);
      // And priced by one market is still priced: not degraded.
      expect(rec.degraded).toBe(false);
    }
  });

  it('treats a snapshot that matched nobody as unavailable, with the reason', async () => {
    const repo = new AdpRepo(db);
    await repo.save(
      {
        source: UNDERDOG_SOURCE,
        label: 'unmatched underdog',
        // Newest, so it is the one the board reads.
        capturedAt: '2099-06-01T00:00:00.000Z',
        fileHash: 'unmatched-hash',
        rows: Array.from({ length: 20 }, (_, i) => ({
          rowNumber: i + 1,
          sourceName: `Nobody Atall ${i}`,
          sourceTeam: null,
          sourcePosition: null,
          adp: 1.5 + i * 2.4,
          rank: i + 1,
          raw: {},
          match: { status: 'unmatched' as const, method: null, reason: 'nobody', playerId: null, confidence: 0, candidates: [] },
          // The case this guards: a real, fresh, raw-ADP file that prices
          // nobody because every name failed to resolve.
          playerId: null,
        })),
        matchedCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 20,
        skipped: [],
      },
      { provider: '4for4', sourceType: 'raw_adp', snapshotAt: new Date().toISOString() },
    );

    const board = await new DraftBoardService(db).build(await firstDraftId(), { limit: 10 });
    expect(board.dogState.available).toBe(false);
    expect(board.dogState.matched).toBe(0);
    expect(board.dogState.reason).toContain('none of them resolved');
    expect(board.recommendations.every((r) => r.dogAdp === null)).toBe(true);
    // And the board falls back cleanly rather than half-using it.
    for (const rec of board.recommendations) {
      if (rec.adp != null) expect(rec.marketBlend.sources).toEqual(['sleeper']);
    }
  });

  it('keeps the two markets distinct rather than copying one into the other', async () => {
    const board = await new DraftBoardService(db).build(await firstDraftId(), { limit: 20 });
    const priced = board.recommendations.filter((r) => r.dogAdp != null && r.adp != null);
    // At least some players must disagree, or a board substituting one column
    // for the other would pass every other assertion in this file.
    expect(priced.some((r) => r.dogAdp !== r.adp)).toBe(true);
  });

  it('reports the blend in force and where the format came from', async () => {
    const board = await new DraftBoardService(db).build(await firstDraftId(), { limit: 5 });
    // The demo league publishes no best-ball flag, so the ordinary blend applies
    // and the board says it is not confident rather than guessing.
    expect(board.marketFormat.format).toBe('standard');
    expect(board.marketFormat.weights).toEqual({ dog: 0.6, sleeper: 0.4 });
    expect(board.marketFormat.confident).toBe(false);
  });

  it('never treats a stale Underdog snapshot as fresh', async () => {
    const players = (await new PlayerRepo(db).listAll()).filter((p) => p.active).slice(0, 20);
    const repo = new AdpRepo(db);
    /*
     * Captured in the future so it is unambiguously the newest snapshot, while
     * its *effective* time is months old. That pair is the whole trap: the file
     * arrived most recently and its numbers describe a market that no longer
     * exists, and it is the second fact that decides.
     */
    await repo.save(
      {
        source: UNDERDOG_SOURCE,
        label: 'stale underdog',
        capturedAt: '2099-01-01T00:00:00.000Z',
        fileHash: 'stale-hash',
        rows: players.map((p, i) => ({
          rowNumber: i + 1,
          sourceName: p.fullName,
          sourceTeam: p.team,
          sourcePosition: p.position,
          adp: 1.5 + i * 2.4,
          rank: i + 1,
          raw: {},
          match: {
            status: 'matched' as const,
            method: 'name_unique' as const,
            reason: 'test fixture',
            playerId: p.id,
            confidence: 1,
            candidates: [],
          },
          playerId: p.id,
        })),
        matchedCount: players.length,
        ambiguousCount: 0,
        unmatchedCount: 0,
        skipped: [],
      },
      { provider: '4for4', sourceType: 'raw_adp', snapshotAt: '2026-01-01T00:00:00.000Z' },
    );

    const board = await new DraftBoardService(db).build(await firstDraftId(), { limit: 10 });
    expect(board.dogState.available).toBe(false);
    expect(board.dogState.freshness).toBe('stale');
    expect(board.warnings.join(' ')).toContain('too old');
    // And nothing was substituted for it.
    expect(board.recommendations.every((r) => r.dogAdp === null)).toBe(true);
  });
});

describe('the platform market is never the Underdog one', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  /**
   * The bug this pins, found by reading the deploy workflow rather than the
   * code: `refresh-adp.yml` imports Sleeper's ADP under the source
   * `beatadp:sleeper`, not `sleeper`. Resolving the platform snapshot by
   * matching a name would therefore have missed it in production and fallen
   * back to "the newest snapshot of anything" — which, on any day Underdog was
   * fetched last, is the Underdog board.
   *
   * The consequence would have been silent and total: Underdog's numbers in the
   * `ADP` column, behind `Val`, behind the tier ladders and behind the survival
   * model, with the `DOG` column showing the same numbers again and nothing on
   * screen able to say they were the same market twice.
   */
  it('finds a Sleeper snapshot imported under the workflow’s own source name', async () => {
    const repo = new AdpRepo(db);
    const players = (await new PlayerRepo(db).listAll()).filter((p) => p.active).slice(0, 20);

    await repo.save({
      // Exactly what .github/workflows/refresh-adp.yml sends.
      source: 'beatadp:sleeper',
      label: 'SLEEPER ADP — HALF PPR 1QB',
      capturedAt: '2099-05-01T00:00:00.000Z',
      fileHash: 'platform-hash',
      rows: players.map((p, i) => ({
        rowNumber: i + 1,
        sourceName: p.fullName,
        sourceTeam: p.team,
        sourcePosition: p.position,
        adp: 3 + i * 3.3,
        rank: i + 1,
        raw: {},
        match: {
          status: 'matched' as const,
          method: 'name_unique' as const,
          reason: 'test fixture',
          playerId: p.id,
          confidence: 1,
          candidates: [],
        },
        playerId: p.id,
      })),
      matchedCount: players.length,
      ambiguousCount: 0,
      unmatchedCount: 0,
      skipped: [],
    });

    const platform = await repo.latestPlatformSnapshot();
    expect(platform?.source).toBe('beatadp:sleeper');
    // And emphatically not the Underdog snapshot the seed also wrote.
    expect(platform?.source).not.toBe(UNDERDOG_SOURCE);
  });

  it('prefers a newer Underdog snapshot for DOG and never for ADP', async () => {
    const repo = new AdpRepo(db);
    // The seed writes Sleeper first and Underdog second, so "newest of
    // anything" is already the Underdog one — the exact trap.
    expect((await repo.latest())?.source).toBe(UNDERDOG_SOURCE);
    expect((await repo.latestPlatformSnapshot())?.source).not.toBe(UNDERDOG_SOURCE);
  });

  it('keeps the ADP and DOG columns showing different numbers on a real board', async () => {
    const draftId = (await new LeagueRepo(db).listLeagues()).find((l) => l.draftId)!.draftId!;
    const board = await new DraftBoardService(db).build(draftId, { limit: 20 });
    const both = board.recommendations.filter((r) => r.adp != null && r.dogAdp != null);
    expect(both.length).toBeGreaterThan(3);
    // If the platform snapshot had resolved to the Underdog one, every player
    // would show the same number twice.
    expect(both.every((r) => r.adp === r.dogAdp)).toBe(false);
  });
});

describe('the queue keeps the order the reader gave it', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let ids: string[];

  /** The draft the demo seed attaches to a league. */
  async function draftId(): Promise<string> {
    return (await new LeagueRepo(db).listLeagues()).find((l) => l.draftId)!.draftId!;
  }

  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
    cookie = await login(env, app);
    /*
     * Players the board will actually show.
     *
     * Taking the first four rows of the player table queues players who have
     * already been drafted in the seed, so the queue filter returns two of them
     * and every ordering assertion is really about a two-item list. Reading the
     * board first means the four ids are four rows the reader could see.
     */
    const board = await new DraftBoardService(db).build(await draftId(), { limit: 10 });
    ids = board.recommendations.slice(0, 4).map((r) => r.playerId);
    expect(ids).toHaveLength(4);
    for (const id of ids) await app(post(`/api/players/${id}/queue`, { queued: true }, cookie), env);
  });

  it('appends newly queued players in the order they were starred', async () => {
    const res = await app(get('/api/queue', cookie), env);
    expect((await res.json() as { order: string[] }).order).toEqual(ids);
  });

  it('moves a player and persists it', async () => {
    const res = await app(post('/api/queue/reorder', { playerId: ids[0], toIndex: 2 }, cookie), env);
    const moved = (await res.json() as { order: string[] }).order;
    expect(moved).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    // Read back from storage, not from the response.
    expect(await new PlayerFlagsRepo(db).queueOrder()).toEqual(moved);
  });

  it('survives a board rebuild', async () => {
    await app(post('/api/queue/reorder', { playerId: ids[3], toIndex: 0 }, cookie), env);
    const board = await new DraftBoardService(db).build(await draftId(), { queuedOnly: true, limit: 50 });
    expect(board.recommendations.map((r) => r.playerId)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
  });

  it('changes the order and not one Draft Score', async () => {
    const id = await draftId();
    const before = await new DraftBoardService(db).build(id, { queuedOnly: true, limit: 50 });
    const scoresBefore = new Map(before.recommendations.map((r) => [r.playerId, r.score]));
    const totalsBefore = new Map(before.recommendations.map((r) => [r.playerId, r.total]));

    await app(post('/api/queue/reorder', { playerId: ids[0], toIndex: 3 }, cookie), env);

    const after = await new DraftBoardService(db).build(id, { queuedOnly: true, limit: 50 });
    for (const rec of after.recommendations) {
      expect(rec.score).toBe(scoresBefore.get(rec.playerId));
      expect(rec.total).toBe(totalsBefore.get(rec.playerId));
    }
    // The order did change, which is the other half of the claim.
    expect(after.recommendations.map((r) => r.playerId)).toEqual([ids[1], ids[2], ids[3], ids[0]]);
    expect(before.recommendations.map((r) => r.playerId)).toEqual(ids);
  });

  it('drops a removed player without disturbing the rest', async () => {
    await app(post('/api/queue/reorder', { playerId: ids[3], toIndex: 0 }, cookie), env);
    await app(post(`/api/players/${ids[1]}/queue`, { queued: false }, cookie), env);
    const order = (await (await app(get('/api/queue', cookie), env)).json() as { order: string[] }).order;
    expect(order).toEqual([ids[3], ids[0], ids[2]]);
  });

  /**
   * Un-starring a player deletes his row, rank and all — the invariant that
   * "unflagged" has exactly one representation in `player_flags`. So re-starring
   * appends him, exactly as starring him the first time did, rather than
   * restoring a position nobody is flagged at any more.
   */
  it('appends a re-queued player rather than restoring his old place', async () => {
    await app(post('/api/queue/reorder', { playerId: ids[3], toIndex: 0 }, cookie), env);
    await app(post(`/api/players/${ids[3]}/queue`, { queued: false }, cookie), env);
    await app(post(`/api/players/${ids[3]}/queue`, { queued: true }, cookie), env);
    const order = (await (await app(get('/api/queue', cookie), env)).json() as { order: string[] }).order;
    expect(order).toEqual([ids[0], ids[1], ids[2], ids[3]]);
  });

  it('is idempotent: starring an already-queued player does not move him', async () => {
    await app(post('/api/queue/reorder', { playerId: ids[3], toIndex: 0 }, cookie), env);
    await app(post(`/api/players/${ids[3]}/queue`, { queued: true }, cookie), env);
    const order = (await (await app(get('/api/queue', cookie), env)).json() as { order: string[] }).order;
    expect(order[0]).toBe(ids[3]);
  });

  it('refuses a reorder without a session', async () => {
    const res = await app(post('/api/queue/reorder', { playerId: ids[0], toIndex: 2 }), env);
    expect(res.status).toBe(401);
  });
});

describe('Players goes deeper than the old sixty', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
  });

  it('serves a page of a hundred by default', async () => {
    const res = await app(get('/api/players'), env);
    const body = (await res.json()) as { players: unknown[]; hasMore: boolean; total: number };
    expect(body.players.length).toBeLessThanOrEqual(100);
    expect(typeof body.hasMore).toBe('boolean');
    expect(body.total).toBeGreaterThan(0);
  });

  it('pages without repeating or skipping a player', async () => {
    const first = (await (await app(get('/api/players?limit=25&offset=0'), env)).json()) as {
      players: { id: string }[];
      hasMore: boolean;
    };
    const second = (await (await app(get('/api/players?limit=25&offset=25'), env)).json()) as {
      players: { id: string }[];
    };
    const ids = [...first.players, ...second.players].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says when the list has genuinely ended', async () => {
    const body = (await (await app(get('/api/players?limit=200&offset=5000'), env)).json()) as {
      players: unknown[];
      hasMore: boolean;
    };
    expect(body.players).toHaveLength(0);
    expect(body.hasMore).toBe(false);
  });
});

describe('the local-team prior is set on a league and reaches Next% alone', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
    cookie = await login(env, app);
  });

  async function selectedLeague() {
    return (await new LeagueRepo(db).listLeagues()).find((l) => l.draftId)!;
  }

  it('stores the teams, normalised', async () => {
    const league = await selectedLeague();
    const res = await app(post(`/api/leagues/${league.id}/local-teams`, { teams: [' det ', 'DET', 'gb'] }, cookie), env);
    expect(res.status).toBe(200);
    expect((await res.json() as { localTeams: string[] }).localTeams).toEqual(['DET', 'GB']);
  });

  it('refuses a code that is not an NFL team', async () => {
    const league = await selectedLeague();
    const res = await app(post(`/api/leagues/${league.id}/local-teams`, { teams: ['XYZ'] }, cookie), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('XYZ');
  });

  it('clears the prior when given an empty list', async () => {
    const league = await selectedLeague();
    await app(post(`/api/leagues/${league.id}/local-teams`, { teams: ['DET'] }, cookie), env);
    await app(post(`/api/leagues/${league.id}/local-teams`, { teams: [] }, cookie), env);
    expect((await new LeagueRepo(db).getLeague(league.id))!.localTeams).toEqual([]);
  });

  it('requires a session', async () => {
    const league = await selectedLeague();
    expect((await app(post(`/api/leagues/${league.id}/local-teams`, { teams: ['DET'] }), env)).status).toBe(401);
  });

  /**
   * The claim the whole feature stands on: setting a prior changes what the
   * model expects other managers to do, and changes nothing about how good a
   * player is. Measured on a real board rather than argued.
   */
  it('moves no Score, Val or tier when it is turned on', async () => {
    const league = await selectedLeague();
    const service = new DraftBoardService(db);

    const before = await service.build(league.draftId!, { limit: 60 });
    await app(post(`/api/leagues/${league.id}/local-teams`, { teams: ['DET'] }, cookie), env);
    const after = await service.build(league.draftId!, { limit: 60 });

    const beforeById = new Map(before.recommendations.map((r) => [r.playerId, r]));
    let lions = 0;
    for (const rec of after.recommendations) {
      const was = beforeById.get(rec.playerId);
      if (!was) continue;
      if (rec.team === 'DET') lions++;
      // Objective quality: identical, Lion or not.
      expect(rec.adp).toBe(was.adp);
      expect(rec.adpValue).toBe(was.adpValue);
      expect(rec.dogAdp).toBe(was.dogAdp);
      expect(rec.marketBlend.adp).toBe(was.marketBlend.adp);
      expect(rec.tierCliff.severity).toBe(was.tierCliff.severity);
      expect(rec.tierCliff.tierIndex).toBe(was.tierCliff.tierIndex);
      // The market component — the price — is untouched too.
      const priceOf = (r: typeof rec) => r.components.find((c) => c.key === 'market_value')!.contribution;
      expect(priceOf(rec)).toBe(priceOf(was));
    }
    expect(lions).toBeGreaterThan(0);
    // And the board reports what it applied, so the effect can be audited.
    expect(after.nextPickModel.localTeams).toEqual(['DET']);
  });

  it('reports the measured survival effect rather than only the multiplier', async () => {
    const league = await selectedLeague();
    await app(post(`/api/leagues/${league.id}/local-teams`, { teams: ['DET'] }, cookie), env);
    const board = await new DraftBoardService(db).build(league.draftId!, { limit: 60 });

    const prior = board.nextPickModel.teamPrior;
    expect(prior).not.toBeNull();
    expect(prior!.multipliers['DET']).toBeGreaterThan(1);

    // The diagnostic the brief asks for: what it actually did to survival, in
    // percentage points, for the local players against everybody else on the
    // same board.
    const effect = prior!.survivalEffect;
    if (effect) {
      expect(effect.sample).toBeGreaterThan(0);
      expect(Number.isFinite(effect.difference)).toBe(true);
      expect(effect.difference).toBeCloseTo(effect.local - effect.others, 5);
    }
  });

  it('reports no prior at all for a league that has named no local team', async () => {
    const league = await selectedLeague();
    const board = await new DraftBoardService(db).build(league.draftId!, { limit: 20 });
    expect(board.nextPickModel.localTeams).toEqual([]);
    // `readTeamPrior` still runs and still says "nothing to say", which is a
    // different and more useful answer than not running at all.
    expect(board.nextPickModel.teamPrior?.basis ?? 'none').toBe('none');
    expect(board.nextPickModel.teamPrior?.survivalEffect ?? null).toBeNull();
  });
});
