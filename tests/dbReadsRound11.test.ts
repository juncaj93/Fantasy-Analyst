/**
 * Round 11 (database reads, part 2).
 *
 *   1. The odds freshness count is kept with a stamp the odds store writes, so a
 *      screen load no longer walks every weekly snapshot about six times.
 *   2. Every player's position (the list last season's statistics are matched
 *      against) is kept for the current download stamp, and the 09:00 tick
 *      starts that work at most once a day.
 *   3. The evidence lookup seeks the asked-for players on the player index
 *      instead of walking every approved row.
 *
 * Each cache must answer exactly what a fresh read answers, never anything
 * older than the last refresh, and the new answer right after one. Every test
 * here also pins the saving, so each fails on the code before this round.
 *
 * "Worker" is a separate handle on the same database: the in-memory memos are
 * keyed on the handle, exactly as each real Worker isolate has its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index.ts';
import type { Database } from '../src/server/db.ts';
import type { CachedSnapshot } from '../src/core/vegas/cache.ts';
import type { SleeperClient } from '../src/core/sleeper/client.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';
import { meterDatabase } from '../src/server/meter.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { POSITIONS_KEY, VERSION_CHECK_MS } from '../src/server/repos/playerListCache.ts';
import {
  PROPS_FRESHNESS_KEY,
  PROPS_STAMP_KEY,
  STAMP_CHECK_MS,
  STORED_MAX_AGE_MS,
  STORED_RECOUNT_MS,
} from '../src/server/repos/propsFreshness.ts';
import { PlayerDetailService, SEASON_STATS_ATTEMPT_MS } from '../src/server/services/playerDetailService.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

/** Another Worker on the same database: its own memory, the same rows. */
function anotherWorker(raw: Database): Database {
  return {
    prepare: (sql) => raw.prepare(sql),
    batch: (list) => raw.batch(list),
    exec: (sql) => raw.exec(sql),
  };
}

/** A handle that writes down every statement it is asked to prepare. */
function recording(raw: Database): { db: Database; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare: (text) => {
        sql.push(text.replace(/\s+/g, ' ').trim());
        return raw.prepare(text);
      },
      batch: (list) => raw.batch(list),
      exec: (text) => raw.exec(text),
    },
  };
}

const LIVE_ODDS = /COUNT\(DISTINCT event_id\) AS events FROM prop_snapshots/;
const FULL_POSITIONS = /^SELECT id, position FROM players$/;

let raw: NodeSqliteDatabase;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T23:00:00Z'));
  raw = await createTestDb();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ odds */

function snapshot(eventId: string, fetchedAt: string, provider = 'sportsgameodds'): CachedSnapshot {
  return {
    provider,
    eventId,
    gameStart: '2026-11-08T18:00:00Z',
    fetchedAt,
    raw: { provider, eventId, gameStart: '2026-11-08T18:00:00Z', fetchedAt, quotes: [], raw: null },
  };
}

/** The old query, on a handle with no memory and no stored copy in play. */
const freshOdds = (db: Database) => new PropsRepo(anotherWorker(db)).freshnessLive();

const MUTATING = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const tick = (db: Database) => new PropsRepo(db).refreshStoredFreshness();

describe('the odds freshness count', () => {
  it('answers what a fresh count answers, and a cold Worker reads two settings rows for it', async () => {
    await new PropsRepo(raw).put(snapshot('g1', '2026-11-06T20:00:00Z'));
    await new PropsRepo(raw).put(snapshot('g2', '2026-11-06T21:00:00Z', 'other'));
    await new PropsRepo(raw).put(snapshot('g2', '2026-11-06T21:30:00Z'));
    expect(await tick(anotherWorker(raw))).toEqual({ outcome: 'written', events: 2 });

    const cold = recording(anotherWorker(raw));
    const metered = meterDatabase(cold.db);
    const answer = await new PropsRepo(metered.db).freshness();
    expect(answer).toEqual(await freshOdds(raw));
    expect(answer).toEqual({ fetchedAt: '2026-11-06T21:30:00Z', provider: 'sportsgameodds', events: 2 });
    expect(cold.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(0);
    expect(metered.cost()).toMatchObject({ statements: 1, rowsReturned: 2 });
  });

  it('a screen asking six times counts at most once, and a read never writes', async () => {
    await new PropsRepo(raw).put(snapshot('g1', '2026-11-06T20:00:00Z'));
    // Before the tick has stored anything: this Worker counts once for the stamp.
    const handle = recording(anotherWorker(raw));
    for (let i = 0; i < 6; i++) expect(await new PropsRepo(handle.db).freshness()).toEqual(await freshOdds(raw));
    expect(handle.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(1);
    expect(handle.sql).toHaveLength(2); // one stamp check, one count
    // Later checks of the same stamp do not count again.
    vi.setSystemTime(new Date(Date.now() + STAMP_CHECK_MS + 1));
    await new PropsRepo(handle.db).freshness();
    expect(handle.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(1);
    expect(handle.sql.filter((s) => MUTATING.test(s))).toHaveLength(0);
  });

  it('shows a new odds refresh at once on the Worker that stored it, and within seconds everywhere else', async () => {
    await new PropsRepo(raw).put(snapshot('g1', '2026-11-06T20:00:00Z'));
    await tick(raw);
    const reader = recording(anotherWorker(raw));
    expect((await new PropsRepo(reader.db).freshness()).events).toBe(1);
    expect(reader.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(0);

    // The refresh runs on another Worker (the Vegas cron's).
    const cron = anotherWorker(raw);
    await new PropsRepo(cron).put(snapshot('g9', '2026-11-06T23:00:00Z'));
    expect(await new PropsRepo(cron).freshness()).toEqual({ fetchedAt: '2026-11-06T23:00:00Z', provider: 'sportsgameodds', events: 2 });

    // Within seconds, before the tick has stored the new count: counted live, never the old answer.
    vi.setSystemTime(new Date(Date.now() + STAMP_CHECK_MS + 1));
    expect(await new PropsRepo(reader.db).freshness()).toEqual(await freshOdds(raw));
    expect(reader.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(1);

    // After the next tick a cold Worker reads the new count from the two rows.
    expect(await tick(raw)).toEqual({ outcome: 'written', events: 2 });
    const cold = recording(anotherWorker(raw));
    expect(await new PropsRepo(cold.db).freshness()).toEqual(await freshOdds(raw));
    expect(cold.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(0);
  });

  it('never keeps a count taken before a refresh under the refresh stamp', async () => {
    await new PropsRepo(raw).put(snapshot('g1', '2026-11-06T20:00:00Z'));
    const stampBefore = (await raw.prepare('SELECT value_json FROM settings WHERE key = ?').bind(PROPS_STAMP_KEY).first<{ value_json: string }>())!.value_json;

    // The tick reads the stamp, then a refresh lands while it is counting.
    let raced = false;
    const racing: Database = {
      ...anotherWorker(raw),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        if (!raced && LIVE_ODDS.test(sql.replace(/\s+/g, ' '))) {
          raced = true;
          return {
            bind: (...v: unknown[]) => stmt.bind(...v),
            first: async <T,>(c?: string) => {
              const row = await stmt.first<T>(c);
              await new PropsRepo(anotherWorker(raw)).put(snapshot('g5', '2026-11-06T22:59:00Z'));
              return row;
            },
            all: async <T,>() => stmt.all<T>(),
            run: async () => stmt.run(),
          };
        }
        return stmt;
      },
    };
    expect(await tick(racing)).toEqual({ outcome: 'written', events: 1 });

    // The stale count went in under the old stamp, which nobody uses any more.
    const stored = JSON.parse((await raw.prepare('SELECT value_json FROM settings WHERE key = ?').bind(PROPS_FRESHNESS_KEY).first<{ value_json: string }>())!.value_json);
    expect(JSON.stringify(stored.stamp)).toBe(stampBefore);
    const after = recording(anotherWorker(raw));
    expect(await new PropsRepo(after.db).freshness()).toEqual({ fetchedAt: '2026-11-06T22:59:00Z', provider: 'sportsgameodds', events: 2 });
    expect(after.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(1);
    // And the next tick puts it right.
    expect(await tick(raw)).toEqual({ outcome: 'written', events: 2 });
  });

  it('serves nothing older than an hour, for a change made outside the app', async () => {
    await new PropsRepo(raw).put(snapshot('g1', '2026-11-06T20:00:00Z'));
    await tick(raw);
    const handle = recording(anotherWorker(raw));
    expect((await new PropsRepo(handle.db).freshness()).events).toBe(1);
    // A hand-run cleanup removes the snapshot without going through the app.
    await raw.prepare('DELETE FROM prop_snapshots').run();
    // No stamp can see that: inside the hour the stored count stands, and nothing is re-counted.
    vi.setSystemTime(new Date(Date.now() + STAMP_CHECK_MS + 1));
    expect((await new PropsRepo(handle.db).freshness()).events).toBe(1);
    expect(handle.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(0);
    vi.setSystemTime(new Date(Date.now() + STORED_MAX_AGE_MS));
    expect(await new PropsRepo(handle.db).freshness()).toEqual({ fetchedAt: null, provider: null, events: 0 });
    // The tick re-counts before the hour is up, so readers rarely get that far.
    expect(await tick(raw)).toEqual({ outcome: 'written', events: 0 });
    expect(await tick(raw)).toEqual({ outcome: 'fresh' });
    vi.setSystemTime(new Date(Date.now() + STORED_RECOUNT_MS));
    expect(await tick(raw)).toEqual({ outcome: 'written', events: 0 });
  });

  it('works before the first refresh on this release (no stamp yet)', async () => {
    // Odds stored by the previous release: a snapshot row and no stamp.
    await raw
      .prepare(
        `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope) VALUES ('sportsgameodds','g1','',?,'{}','week')`,
      )
      .bind('2026-11-06T20:00:00Z')
      .run();
    expect(await tick(raw)).toEqual({ outcome: 'written', events: 1 });
    const cold = recording(anotherWorker(raw));
    expect(await new PropsRepo(cold.db).freshness()).toEqual(await freshOdds(raw));
    expect(cold.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(0);

    // The first refresh on this release writes the stamp and is seen.
    await new PropsRepo(raw).put(snapshot('g2', '2026-11-06T22:00:00Z'));
    vi.setSystemTime(new Date(Date.now() + STAMP_CHECK_MS + 1));
    expect((await new PropsRepo(cold.db).freshness()).events).toBe(2);
  });

  it('is stored by the five-minute tick', async () => {
    await new PropsRepo(raw).put(snapshot('g1', '2026-11-06T20:00:00Z'));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('null', { status: 404 })) as typeof fetch;
    try {
      // Friday 6:02 PM ET.
      const at = '2026-11-06T23:02:00Z';
      vi.setSystemTime(new Date(at));
      await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.parse(at) }, { DB: raw } as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    const row = await raw.prepare('SELECT value_json FROM settings WHERE key = ?').bind(PROPS_FRESHNESS_KEY).first<{ value_json: string }>();
    expect(JSON.parse(row!.value_json).value).toEqual(await freshOdds(raw));
    const cold = recording(anotherWorker(raw));
    expect(await new PropsRepo(cold.db).freshness()).toEqual(await freshOdds(raw));
    expect(cold.sql.filter((s) => LIVE_ODDS.test(s))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- positions */

function dictionary(position: (i: number) => string = (i) => ['QB', 'RB', 'WR', 'TE', 'DEF'][i % 5]!): CanonicalPlayer[] {
  const out: CanonicalPlayer[] = [];
  for (let i = 1; i <= 60; i++) {
    out.push(player({ id: String(2000 + i), fullName: `Player ${i}`, position: position(i), active: i % 4 !== 0 }));
  }
  out.push(player({ id: '9999', fullName: 'Some Kicker', position: 'K' }));
  return out;
}

async function download(db: Database, players: CanonicalPlayer[], at: string): Promise<void> {
  await new PlayerRepo(db).upsertMany(players);
  await new SettingsRepo(db).markPlayersSynced(at);
}

async function freshPositions(db: Database): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT id, position FROM players').all<{ id: string; position: string }>();
  return new Map(results.map((r) => [r.id, r.position]));
}

describe("every player's position", () => {
  it('answers what the full read answers, retired players included, in two rows', async () => {
    await download(raw, dictionary(), '2026-11-06T10:00:00.000Z');
    expect(await new PlayerRepo(anotherWorker(raw)).positionsById()).toEqual(await freshPositions(raw));

    const cold = recording(anotherWorker(raw));
    const metered = meterDatabase(cold.db);
    const stored = await new PlayerRepo(metered.db).positionsById();
    expect(stored).toEqual(await freshPositions(raw));
    expect([...stored.keys()]).toEqual([...(await freshPositions(raw)).keys()]);
    expect(stored.get('2004')).toBe('DEF'); // inactive, still matched
    expect(stored.get('9999')).toBe('K');
    expect(cold.sql.filter((s) => FULL_POSITIONS.test(s))).toHaveLength(0);
    expect(metered.cost()).toMatchObject({ statements: 2, rowsReturned: 2 });
  });

  it('never serves pairs kept for an older download (and stores none before the first download)', async () => {
    // Before any download is recorded (every dev and test database): the table, as before, and nothing stored.
    await new PlayerRepo(raw).upsertMany(dictionary());
    expect(await new PlayerRepo(anotherWorker(raw)).positionsById()).toEqual(await freshPositions(raw));
    expect(await raw.prepare('SELECT 1 FROM settings WHERE key = ?').bind(POSITIONS_KEY).first()).toBeNull();

    await download(raw, dictionary(), '2026-11-06T10:00:00.000Z');
    const reader = anotherWorker(raw);
    expect((await new PlayerRepo(reader).positionsById()).get('2001')).toBe('RB');

    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
    await download(anotherWorker(raw), dictionary(() => 'WR'), '2026-11-07T10:00:00.000Z');
    vi.setSystemTime(new Date(Date.now() + VERSION_CHECK_MS + 1));
    const after = recording(reader);
    const positions = await new PlayerRepo(after.db).positionsById();
    expect(positions.get('2001')).toBe('WR');
    expect(positions).toEqual(await freshPositions(raw));
    expect(after.sql.filter((s) => FULL_POSITIONS.test(s))).toHaveLength(1);

    // And the next Worker takes the pairs kept for the new download.
    const next = recording(anotherWorker(raw));
    expect(await new PlayerRepo(next.db).positionsById()).toEqual(await freshPositions(raw));
    expect(next.sql.filter((s) => FULL_POSITIONS.test(s))).toHaveLength(0);
  });

});

/* -------------------------------------------- last season's statistics */

function fakeSleeper(calls: { n: number }): SleeperClient {
  return {
    getSeasonStats: async () => {
      calls.n += 1;
      return { '2001': { gp: 17, pts_half_ppr: 210 }, '2002': { gp: 16, pts_half_ppr: 180 }, TEAM_KC: { gp: 17 } };
    },
  } as unknown as SleeperClient;
}

describe("last season's statistics on the 09:00 tick", () => {
  it('a second run of the tick the same day does not fetch or read the position list again', async () => {
    await download(raw, dictionary(), '2026-11-06T09:00:00.000Z');
    const calls = { n: 0 };
    const handle = recording(anotherWorker(raw));
    const service = () => new PlayerDetailService(handle.db, { sleeper: fakeSleeper(calls), now: () => new Date() });

    const first = await service().refreshSeasonStatsDaily();
    expect(first).toMatchObject({ ran: true, matched: 2 });
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1_000));
      expect((await service().refreshSeasonStatsDaily()).ran).toBe(false);
    }
    expect(calls.n).toBe(1);
    expect(handle.sql.filter((s) => FULL_POSITIONS.test(s))).toHaveLength(1);

    // The Setup button is never held back, and reads the stored pairs, not the table.
    expect(await service().refreshSeasonStats()).toMatchObject({ matched: 2 });
    expect(calls.n).toBe(2);
    expect(handle.sql.filter((s) => FULL_POSITIONS.test(s))).toHaveLength(1);

    // Tomorrow's 09:00 runs as usual, and the same stats land.
    vi.setSystemTime(new Date(Date.parse('2026-11-06T23:00:00Z') + SEASON_STATS_ATTEMPT_MS + 1));
    expect(await service().refreshSeasonStatsDaily()).toMatchObject({ ran: true, matched: 2 });
    expect(calls.n).toBe(3);
  });


  it('the 09:00 cron, run twice, fetches last season once', async () => {
    await download(raw, dictionary(), '2026-11-06T09:00:00.000Z');
    const realFetch = globalThis.fetch;
    let statsFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/stats/nfl/regular/')) {
        statsFetches += 1;
        return new Response(JSON.stringify({ '2001': { gp: 17, pts_half_ppr: 210 } }), { status: 200 });
      }
      return new Response('null', { status: 404 });
    }) as typeof fetch;
    try {
      const at = Date.parse('2026-11-06T09:00:00Z');
      vi.setSystemTime(new Date(at));
      await worker.scheduled({ cron: '0 9 * * *', scheduledTime: at }, { DB: raw } as never);
      vi.setSystemTime(new Date(at + 7 * 60 * 1_000));
      await worker.scheduled({ cron: '0 9 * * *', scheduledTime: at }, { DB: raw } as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(statsFetches).toBe(1);
  }, 60_000);
});

/* -------------------------------------------------------------- evidence */

describe('the evidence lookup', () => {
  it('seeks the asked-for players on the player index, with the same rows', async () => {
    const handle = recording(raw);
    await new EvidenceRepo(handle.db).getSignals(['2001', '2002', '2003', '2004']);
    const lookup = handle.sql.find((s) => /FROM evidence_items WHERE player_id IN/.test(s));
    expect(lookup).toBeDefined();
    const plan = await raw
      .prepare(`EXPLAIN QUERY PLAN ${lookup}`)
      .bind('2001', '2002', '2003', '2004')
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(' | ');
    expect(details).toContain('idx_evidence_player');
    expect(details).not.toContain('idx_evidence_review');

    // The same rows the old text returned, for a ledger with every status in it.
    await new PlayerRepo(raw).upsertMany(dictionary());
    const statuses = ['auto_applied', 'accepted', 'corrected', 'pending', 'rejected'];
    let n = 0;
    for (const pid of ['2001', '2002', '2003', '2004', '2005', '2006']) {
      for (const status of statuses) {
        n += 1;
        await raw
          .prepare(
            `INSERT INTO evidence_items (dedupe_key, player_id, source_type, source_name, source_date, excerpt,
               polarity, magnitude, confidence, confidence_score, review_status, created_at, updated_at)
             VALUES (?,?,'newsletter','Test',?,'x','positive',?,'high',?,?,?,?)`,
          )
          .bind(`k${n}`, pid, '2026-11-0' + ((n % 5) + 1), (n % 3) + 1, (n % 7) / 7, status, '2026-11-06', '2026-11-06')
          .run();
      }
    }
    const ids = ['2001', '2002', '2003', '2004'];
    const old = await raw
      .prepare(`SELECT * FROM evidence_items WHERE player_id IN (?,?,?,?) AND review_status IN ('auto_applied','accepted','corrected')`)
      .bind(...ids)
      .all<{ id: number }>();
    const now = await raw.prepare(lookup!).bind(...ids).all<{ id: number }>();
    const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
    expect(now.results.length).toBe(12);
    expect([...now.results].sort(byId)).toEqual([...old.results].sort(byId));
  });
});
