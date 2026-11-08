/**
 * Round 14, the D1 budget: writes that were paid for nothing.
 *
 *   4. The daily player download wrote all ~3,300 players every day. Now a
 *      player is written only when something about him changed, and a real
 *      change (injury, team, status, a new player) is still written.
 *   5. Last season's statistics were rewritten every day (about 6,600 writes)
 *      for a season that is over. The 09:00 tick now stops once that season is
 *      on file, and the Setup button can still force a reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';
import type { SleeperClient } from '../src/core/sleeper/client.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { SourceStateRepo } from '../src/server/repos/sourceState.ts';
import type { Database } from '../src/server/db.ts';
import type { RosterRecord } from '../src/core/sleeper/types.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import { PlayerDetailService } from '../src/server/services/playerDetailService.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

let raw: NodeSqliteDatabase;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T09:00:00Z'));
  raw = await createTestDb();
});

afterEach(() => {
  vi.useRealTimers();
});

function dictionary(): CanonicalPlayer[] {
  return Array.from({ length: 40 }, (_, i) =>
    player({
      id: String(3000 + i),
      fullName: `Player ${i}`,
      position: ['QB', 'RB', 'WR', 'TE'][i % 4]!,
      team: 'KC',
      status: 'Active',
      heightInches: 72,
      age: 25,
    }),
  );
}

const row = (id: string) =>
  raw
    .prepare('SELECT team, status, active, height_inches, age, draft_rank, updated_at FROM players WHERE id = ?')
    .bind(id)
    .first<{ team: string; status: string; active: number; height_inches: number | null; age: number | null; draft_rank: number | null; updated_at: string }>();

describe('Round 14: the player download writes only what changed', () => {
  it('a first download writes every player', async () => {
    const result = await new PlayerRepo(raw).upsertMany(dictionary());
    expect(result).toEqual({ written: 40, changed: 40 });
  });

  it('the same download again writes nothing and leaves every row as it was', async () => {
    await new PlayerRepo(raw).upsertMany(dictionary());
    const before = await row('3005');
    vi.setSystemTime(new Date('2026-11-07T09:00:00Z'));
    const again = await new PlayerRepo(raw).upsertMany(dictionary());
    // `written` is what Setup shows (players in the download) and is unchanged.
    expect(again).toEqual({ written: 40, changed: 0 });
    expect(await row('3005')).toEqual(before);
  });

  it('an injury, a trade, a release and a new rank are each still written', async () => {
    await new PlayerRepo(raw).upsertMany(dictionary());
    vi.setSystemTime(new Date('2026-11-07T09:00:00Z'));
    const next = dictionary();
    next[1] = { ...next[1]!, status: 'Injured Reserve' };
    next[2] = { ...next[2]!, team: 'BUF' };
    next[3] = { ...next[3]!, active: false };
    next[4] = { ...next[4]!, searchRank: 12 };
    next.push(player({ id: '3999', fullName: 'New Signing', position: 'WR', team: 'NYJ' }));
    const result = await new PlayerRepo(raw).upsertMany(next);
    expect(result.changed).toBe(5);
    expect((await row('3001'))?.status).toBe('Injured Reserve');
    expect((await row('3002'))?.team).toBe('BUF');
    expect((await row('3003'))?.active).toBe(0);
    expect((await row('3004'))?.draft_rank).toBe(12);
    expect((await row('3001'))?.updated_at).toBe('2026-11-07T09:00:00.000Z');
    expect((await row('3010'))?.updated_at).toBe('2026-11-06T09:00:00.000Z');
  });

  it('a download that leaves a measurement out keeps it and writes nothing', async () => {
    await new PlayerRepo(raw).upsertMany(dictionary());
    const missing = dictionary().map((p) => ({ ...p, heightInches: null, age: null }));
    expect((await new PlayerRepo(raw).upsertMany(missing)).changed).toBe(0);
    expect(await row('3007')).toMatchObject({ height_inches: 72, age: 25 });
    // And a new measurement is written.
    const older = dictionary().map((p) => (p.id === '3007' ? { ...p, age: 26 } : p));
    expect((await new PlayerRepo(raw).upsertMany(older)).changed).toBe(1);
    expect((await row('3007'))?.age).toBe(26);
  });

  it('the counts Setup shows still come out right after an unchanged download', async () => {
    const repo = new PlayerRepo(raw);
    await repo.upsertMany(dictionary());
    await repo.upsertMany(dictionary());
    expect(await new PlayerRepo(raw).count()).toBe(40);
  });
});

function fakeSleeper(calls: { n: number }): SleeperClient {
  return {
    getSeasonStats: async () => {
      calls.n += 1;
      return { '3001': { gp: 17, pts_half_ppr: 210 }, '3002': { gp: 16, pts_half_ppr: 180 } };
    },
  } as unknown as SleeperClient;
}

describe("Round 14: last season's statistics stop once they are on file", () => {
  it('says not loaded before the first run, and loaded after it', async () => {
    await new PlayerRepo(raw).upsertMany(dictionary());
    const calls = { n: 0 };
    const service = new PlayerDetailService(raw, { sleeper: fakeSleeper(calls), now: () => new Date() });
    expect(await service.seasonStatsAlreadyLoaded('2025')).toEqual({ loaded: false });
    await service.refreshSeasonStats('2025');
    expect(await service.seasonStatsAlreadyLoaded('2025')).toMatchObject({ loaded: true });
    // A different (newly finished) season is not "already loaded".
    expect(await service.seasonStatsAlreadyLoaded('2026')).toEqual({ loaded: false });
  });

  it('a run that matched nobody does not count as loaded', async () => {
    const calls = { n: 0 };
    const service = new PlayerDetailService(raw, { sleeper: fakeSleeper(calls), now: () => new Date() });
    await service.refreshSeasonStats('2025'); // no players on file, so nothing matches
    expect(await service.seasonStatsAlreadyLoaded('2025')).toEqual({ loaded: false });
  });

  it('the 09:00 tick loads the season once, then stops on later days; Setup still forces it', async () => {
    await new PlayerRepo(raw).upsertMany(dictionary());
    await new SettingsRepo(raw).markPlayersSynced('2026-11-06T08:00:00.000Z');
    const realFetch = globalThis.fetch;
    let statsFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/stats/nfl/regular/')) {
        statsFetches += 1;
        return new Response(JSON.stringify({ '3001': { gp: 17, pts_half_ppr: 210 } }), { status: 200 });
      }
      return new Response('null', { status: 404 });
    }) as typeof fetch;
    try {
      for (const day of ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-10']) {
        const at = Date.parse(`${day}T14:00:00Z`);
        vi.setSystemTime(new Date(at));
        await worker.scheduled({ cron: '0 9 * * *', scheduledTime: at }, { DB: raw } as never);
      }
      expect(statsFetches, 'fetched on the first day only').toBe(1);

      // The Setup button goes straight to the refresh and is never held back.
      const calls = { n: 0 };
      await new PlayerDetailService(raw, { sleeper: fakeSleeper(calls), now: () => new Date() }).refreshSeasonStats();
      expect(calls.n).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 60_000);
});

/** A handle that writes down every statement it is asked to prepare. */
function recording(db: Database): { db: Database; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare: (text) => {
        sql.push(text.replace(/\s+/g, ' ').trim());
        return db.prepare(text);
      },
      batch: (list) => db.batch(list),
      exec: (text) => db.exec(text),
    },
  };
}

describe('Round 14: the three-hourly league read leaves identical rosters alone', () => {
  const LEAGUE = 'L1';
  const rosters = (): RosterRecord[] => [
    { leagueId: LEAGUE, rosterId: 1, ownerId: 'me', ownerName: 'Alex', playerIds: ['3001', '3002'], starterIds: ['3001'], starterSlotIds: ['3001'], reserveIds: [], isMine: true, settings: { wins: 6 } },
    { leagueId: LEAGUE, rosterId: 2, ownerId: 'r2', ownerName: 'Rival', playerIds: ['3003'], starterIds: ['3003'], reserveIds: [], isMine: false, settings: null },
  ];
  const seedLeague = () =>
    new LeagueRepo(raw).upsertLeague({
      id: LEAGUE, sleeperLeagueId: LEAGUE, name: 'Test', season: '2026', totalRosters: 2,
      scoringSettings: {}, rosterPositions: [], leagueSettings: {}, draftId: null, lastSyncedAt: '2026-11-06T09:00:00.000Z',
    } as never);

  it('writes nothing when Sleeper says what is already stored', async () => {
    await seedLeague();
    await new LeagueRepo(raw).replaceRosters(LEAGUE, rosters());
    const handle = recording(raw);
    await new LeagueRepo(handle.db).replaceRosters(LEAGUE, rosters());
    expect(handle.sql.some((q) => /^DELETE FROM rosters/.test(q))).toBe(false);
    expect(handle.sql.some((q) => /^INSERT INTO rosters/.test(q))).toBe(false);
    expect(await new LeagueRepo(raw).listRosters(LEAGUE)).toHaveLength(2);
  });

  it.each([
    ['a pickup', (r: RosterRecord[]) => { r[1]!.playerIds = ['3003', '3004']; }],
    ['a lineup move', (r: RosterRecord[]) => { r[0]!.starterIds = ['3002']; }],
    ['a new win', (r: RosterRecord[]) => { r[0]!.settings = { wins: 7 }; }],
    ['an IR move', (r: RosterRecord[]) => { r[0]!.reserveIds = ['3002']; }],
    ['a team leaving', (r: RosterRecord[]) => { r.pop(); }],
  ])('still replaces the rosters on %s', async (_label, change) => {
    await seedLeague();
    await new LeagueRepo(raw).replaceRosters(LEAGUE, rosters());
    const next = rosters();
    change(next);
    await new LeagueRepo(raw).replaceRosters(LEAGUE, next);
    const stored = await new LeagueRepo(raw).listRosters(LEAGUE);
    expect(stored.map((r) => ({ id: r.rosterId, players: r.playerIds, starters: r.starterIds, reserve: r.reserveIds, settings: r.settings })))
      .toEqual(next.map((r) => ({ id: r.rosterId, players: r.playerIds, starters: r.starterIds, reserve: r.reserveIds, settings: r.settings ?? {} })));
  });
});

describe('Round 14: a healthy injury check does not rewrite a zero', () => {
  const repo = () => new SourceStateRepo(raw, 'injury_source_state', 'injury_write_budget');
  const seed = () =>
    repo().recordCheck('src', '2026', { checkedAt: '2026-11-06T09:00:00.000Z', outcome: 'not_modified', note: null });

  it('clears a run of failures, then writes nothing on the next healthy check', async () => {
    await seed();
    await repo().recordIngestFailure('src', '2026', '2026-11-06T09:05:00.000Z', 'boom');
    expect((await repo().get('src', '2026'))?.consecutiveFailures).toBe(1);

    await repo().recordIngestSuccess('src', '2026', null);
    expect((await repo().get('src', '2026'))?.consecutiveFailures).toBe(0);
    expect((await repo().get('src', '2026'))?.failingSince ?? null).toBeNull();

  });

  it('still moves the caught-up week forward', async () => {
    await seed();
    await repo().recordIngestSuccess('src', '2026', 9);
    expect((await repo().get('src', '2026'))?.caughtUpThrough).toBe(9);
    await repo().recordIngestSuccess('src', '2026', null);
    expect((await repo().get('src', '2026'))?.caughtUpThrough).toBe(9);
  });

  it('the real method changes no row on a healthy check', async () => {
    await seed();
    const handle = recording(raw);
    let changes = -1;
    const counting: Database = {
      ...handle.db,
      prepare: (text) => {
        const stmt = handle.db.prepare(text);
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return { ...bound, run: async () => { const r = await bound.run(); changes = Number(r.meta.changes ?? 0); return r; } } as typeof bound;
          },
        } as typeof stmt;
      },
    };
    await new SourceStateRepo(counting, 'injury_source_state', 'injury_write_budget').recordIngestSuccess('src', '2026', null);
    expect(changes).toBe(0);
  });
});
