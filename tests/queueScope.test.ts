/**
 * A queue belongs to the draft it was made for.
 *
 * Reported from production: a user queued players during a completed best-ball
 * draft, switched to another league, and the old shortlist was sitting in the
 * new draft's ★ list. Nothing in the app was choosing to carry it across —
 * `player_flags` was keyed by `player_id` alone, so there was only ever one
 * queue and every draft was reading it.
 *
 * The scenario is the test. Queue in A, look at B, come back to A, and reload —
 * with two drafts in the same league as well as two in different ones, because
 * a league keeps its id across seasons and league-scoping would have looked
 * correct right up until next August.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { DraftQueueRepo } from '../src/server/repos/draftQueue.ts';
import { PlayerFlagsRepo } from '../src/server/repos/playerFlags.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
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

describe('a queue belongs to one draft', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let players: string[];

  /** The best-ball draft the reported bug started in, in a league of its own. */
  const BEST_BALL = 'best-ball-draft';
  /** Next season's draft in the *same* league — the case league-scoping misses. */
  const NEXT_SEASON = 'demo-draft-2027';

  const star = (draftId: string, playerId: string, queued = true) =>
    app(post(`/api/drafts/${draftId}/queue`, { playerId, queued }, cookie), env);

  const order = async (draftId: string): Promise<string[]> =>
    ((await (await app(get(`/api/drafts/${draftId}/queue`, cookie), env)).json()) as { order: string[] }).order;

  /** What the board's ★ filter actually shows, which is the screen's answer. */
  const boardQueue = async (draftId: string): Promise<string[]> => {
    const board = await new DraftBoardService(db).build(draftId, { queuedOnly: true, limit: 50 });
    return board.recommendations.map((r) => r.playerId);
  };

  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
    cookie = (await (await app(post('/api/auth/login', { passphrase: 'correct horse battery staple' }), env)).headers
      .get('set-cookie')!)
      .split(';')[0]!;

    const leagues = new LeagueRepo(db);
    const demo = (await leagues.listLeagues()).find((l) => l.draftId === 'demo-draft')!;

    // A second league, drafting best ball. Its own league id and its own draft.
    await leagues.upsertLeague({
      id: 'best-ball-league',
      sleeperLeagueId: 'best-ball-league',
      name: 'Best Ball',
      season: '2026',
      totalRosters: 12,
      scoringSettings: demo.scoringSettings,
      rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN'],
      leagueSettings: { best_ball: 1 },
      draftId: BEST_BALL,
      lastSyncedAt: new Date().toISOString(),
    });
    for (const [id, leagueId] of [
      [BEST_BALL, 'best-ball-league'],
      // ...and a second draft inside the *first* league, which is what a league
      // running a draft every season looks like.
      [NEXT_SEASON, 'demo-league'],
    ] as const) {
      await leagues.upsertDraft({
        id,
        sleeperDraftId: id,
        leagueId,
        status: 'pre_draft',
        type: 'snake',
        season: '2027',
        rounds: 12,
        teams: 12,
        slotToRosterId: {},
        settings: {},
        lastSyncedAt: new Date().toISOString(),
      });
    }

    const board = await new DraftBoardService(db).build('demo-draft', { limit: 10 });
    players = board.recommendations.slice(0, 3).map((r) => r.playerId);
    expect(players).toHaveLength(3);
  });

  /**
   * The reported scenario, in the order it was reported in.
   *
   * A → queue players → B → empty → A → the original queue, in the original
   * order.
   */
  it('queue A never appears in draft B, and comes back intact in A', async () => {
    for (const id of players) await star('demo-draft', id);
    expect(await order('demo-draft')).toEqual(players);

    // Switch to the other league's draft: nothing follows you.
    expect(await order(BEST_BALL)).toEqual([]);
    expect(await boardQueue(BEST_BALL)).toEqual([]);

    // Queue somebody different there, and the two lists stay apart.
    await star(BEST_BALL, players[2]!);
    expect(await order(BEST_BALL)).toEqual([players[2]]);

    // Back to A, unchanged and in the reader's own order.
    expect(await order('demo-draft')).toEqual(players);
  });

  /**
   * The half a league-scoped fix would have got wrong.
   *
   * A league keeps its Sleeper id across seasons, so "one queue per league"
   * would put last August's shortlist in this August's draft — the same bug,
   * one year later, and much harder to attribute.
   */
  it('does not carry a queue into a new draft in the same league', async () => {
    for (const id of players) await star('demo-draft', id);
    expect(await order(NEXT_SEASON)).toEqual([]);
    expect(await boardQueue(NEXT_SEASON)).toEqual([]);

    // And a completed draft keeps its queue while the new one fills its own.
    await star(NEXT_SEASON, players[0]!);
    expect(await order(NEXT_SEASON)).toEqual([players[0]]);
    expect(await order('demo-draft')).toEqual(players);
  });

  /**
   * A reorder is scoped too, which is the write the client makes most often
   * while a draft is live.
   */
  it("reorders one draft's queue without touching another's", async () => {
    for (const id of players) await star('demo-draft', id);
    for (const id of players) await star(BEST_BALL, id);

    await app(post(`/api/drafts/demo-draft/queue/reorder`, { playerId: players[2], toIndex: 0 }, cookie), env);

    expect(await order('demo-draft')).toEqual([players[2], players[0], players[1]]);
    expect(await order(BEST_BALL)).toEqual(players);
  });

  /**
   * Persistence: the queue is in the database rather than in a screen, so a
   * reload is the same read the first visit made.
   */
  it('survives a reload, because nothing about it lives in the client', async () => {
    for (const id of players) await star('demo-draft', id);
    await app(post(`/api/drafts/demo-draft/queue/reorder`, { playerId: players[2], toIndex: 0 }, cookie), env);

    // A brand-new app instance over the same database is what a reload is.
    const reloaded = createApp();
    const res = await reloaded(get('/api/drafts/demo-draft/queue', cookie), makeEnv(db));
    expect(((await res.json()) as { order: string[] }).order).toEqual([players[2], players[0], players[1]]);
    expect(await boardQueue('demo-draft')).toEqual([players[2], players[0], players[1]]);
  });

  /**
   * My Guy is the other mark in this area and it deliberately did *not* move.
   *
   * It is an opinion about a player — he is still your guy in next year's
   * league — so it stays global, and scoping the queue must not have dragged it
   * along. The two are stored in different tables for exactly this reason.
   */
  it('leaves My Guy global, because it is an opinion about a player', async () => {
    await app(post(`/api/players/${players[0]}/my-guy`, { level: 3 }, cookie), env);

    for (const draftId of ['demo-draft', BEST_BALL, NEXT_SEASON]) {
      const board = await new DraftBoardService(db).build(draftId, { limit: 40 });
      const rec = board.recommendations.find((r) => r.playerId === players[0]);
      if (!rec) continue;
      expect(rec.myGuy.level, `My Guy was lost in ${draftId}`).toBe(3);
      // ...and rating him did not put him in anybody's queue.
      expect(rec.queued).toBe(false);
    }
    expect(await order('demo-draft')).toEqual([]);
  });

  /** Starring in one draft may not write a row that another draft can read. */
  it("stores one row per draft, and reads back only that draft's", async () => {
    const queue = new DraftQueueRepo(db);
    await queue.setQueued('demo-draft', players[0]!, true);
    await queue.setQueued(BEST_BALL, players[1]!, true);

    expect(await queue.order('demo-draft')).toEqual([players[0]]);
    expect(await queue.order(BEST_BALL)).toEqual([players[1]]);
    expect(await queue.queuedIds('demo-draft')).toEqual(new Set([players[0]]));

    // The old home of the queue holds nothing about it any more.
    const flags = await new PlayerFlagsRepo(db).all();
    expect([...flags.keys()]).toEqual([]);
  });
});

/**
 * The queue that existed before any of this, and belongs to no draft.
 *
 * There is no correct migration for those rows: an entry records that somebody
 * starred a player and nothing anywhere records which draft they were looking
 * at. Assigning them to the currently selected draft would be inventing the one
 * fact the whole repair is about — and would reproduce the reported bug once
 * more, in a migration, where it would look like data rather than a defect.
 *
 * So 0028 retires them: copied into a table nothing reads, and cleared from the
 * live one. This is the test that says the failure is safe rather than silent.
 */
describe('the legacy global queue is retired rather than guessed at', () => {
  /**
   * The database as it was: `player_flags` rows carrying `queued`, one of them
   * also carrying a My Guy level, applied through every migration in order.
   */
  async function legacyDatabase(): Promise<NodeSqliteDatabase> {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');

    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const cutover = files.indexOf('0028_queue_belongs_to_a_draft.sql');
    expect(cutover, 'the migration under test is missing').toBeGreaterThan(0);

    const db = new NodeSqliteDatabase(':memory:');
    for (const f of files.slice(0, cutover)) await db.exec(readFileSync(join(dir, f), 'utf8'));

    const now = new Date().toISOString();
    for (const [id, name] of [
      ['p1', 'Queued Only'],
      ['p2', 'Queued And Rated'],
      ['p3', 'Rated Only'],
    ]) {
      await db
        .prepare(
          `INSERT INTO players (id, full_name, normalized_name, external_ids_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(id, name, name!.toLowerCase(), '{}', now, now)
        .run();
    }
    await db
      .prepare('INSERT INTO player_flags (player_id, level, queued, queue_order, updated_at) VALUES (?,?,?,?,?)')
      .bind('p1', 0, 1, 1000, now)
      .run();
    await db
      .prepare('INSERT INTO player_flags (player_id, level, queued, queue_order, updated_at) VALUES (?,?,?,?,?)')
      .bind('p2', 2, 1, 2000, now)
      .run();
    await db
      .prepare('INSERT INTO player_flags (player_id, level, queued, queue_order, updated_at) VALUES (?,?,?,?,?)')
      .bind('p3', 3, 0, null, now)
      .run();

    // ...and then the migration under test.
    await db.exec(readFileSync(join(dir, files[cutover]!), 'utf8'));
    return db;
  }

  it('assigns the old queue to no draft at all', async () => {
    const db = await legacyDatabase();
    const rows = await db.prepare('SELECT draft_id, player_id FROM draft_queue').all<{ draft_id: string }>();
    expect(rows.results, 'a legacy entry was given a draft it never had').toEqual([]);
  });

  it("leaves every draft with an empty queue rather than somebody else's", async () => {
    const db = await legacyDatabase();
    const queue = new DraftQueueRepo(db);
    for (const draftId of ['demo-draft', 'some-other-draft', '']) {
      expect(await queue.order(draftId)).toEqual([]);
    }
  });

  it('keeps My Guy, which was never draft-scoped and is not lost', async () => {
    const db = await legacyDatabase();
    const flags = await new PlayerFlagsRepo(db).all();
    expect(flags.get('p2')?.level).toBe(2);
    expect(flags.get('p3')?.level).toBe(3);
  });

  /**
   * A row that held nothing but a star is deleted, because "unflagged" has
   * exactly one representation in that table and a cleared star leaves nothing
   * behind. A row that also held a rating stays, carrying only the rating.
   */
  it('clears the retired columns and drops the rows that held nothing else', async () => {
    const db = await legacyDatabase();
    const rows = await db
      .prepare('SELECT player_id, level, queued, queue_order FROM player_flags ORDER BY player_id')
      .all<{ player_id: string; level: number; queued: number; queue_order: number | null }>();
    expect(rows.results).toEqual([
      { player_id: 'p2', level: 2, queued: 0, queue_order: null },
      { player_id: 'p3', level: 3, queued: 0, queue_order: null },
    ]);
  });

  /**
   * Not destroyed, either. The entries are archived verbatim so that "where did
   * my stars go?" has an answer with player ids in it — and the archive is
   * write-once and read-never, so nothing can be seeded from it by accident.
   */
  it('archives what it retired, for the support question that follows a deploy', async () => {
    const db = await legacyDatabase();
    const rows = await db
      .prepare('SELECT player_id, queue_order FROM retired_global_queue ORDER BY player_id')
      .all<{ player_id: string; queue_order: number | null }>();
    expect(rows.results).toEqual([
      { player_id: 'p1', queue_order: 1000 },
      { player_id: 'p2', queue_order: 2000 },
    ]);
  });

  /** Applying it twice must not double-archive or resurrect anything. */
  it('is safe to run again', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const db = await legacyDatabase();
    const sql = readFileSync(fileURLToPath(new URL('../migrations/0028_queue_belongs_to_a_draft.sql', import.meta.url)), 'utf8');
    await db.exec(sql);

    const archived = await db.prepare('SELECT COUNT(*) AS n FROM retired_global_queue').first<{ n: number }>();
    expect(Number(archived?.n)).toBe(2);
    const live = await db.prepare('SELECT COUNT(*) AS n FROM player_flags').first<{ n: number }>();
    expect(Number(live?.n)).toBe(2);
  });
});
