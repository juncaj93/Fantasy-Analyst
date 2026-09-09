/**
 * What the diagnostics screens cost to draw.
 *
 * Setup and Data Health are the two screens whose whole job is to answer "is
 * anything wrong?", and the D1 quota is one of the things that can be. That
 * makes them a place where an expensive read hides especially well: nobody
 * profiles the page they open when they are already worried about something
 * else, and both of them are now somewhere Alex has a reason to visit often.
 *
 * Measured at week 10, one `/api/data-health` cost roughly 23,000 rows and one
 * `/api/setup/status` roughly 26,000, and three quarters of both were aggregates
 * over a season of stored rows to display counts that change once a day.
 *
 * As in `sourceRunsIndex.test.ts`, these assert the plan and the read count
 * rather than the answer. Both would pass with every one of these queries
 * walking its whole table.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { InjurySourceRepo } from '../src/server/repos/injury.ts';
import { PlayerDetailRepo, forgetSeasonStatCounts } from '../src/server/repos/playerDetail.ts';
import { UsageRepo, type StoredUsageWeek } from '../src/server/repos/usage.ts';
import { UsageService, forgetUsageDerivations } from '../src/server/services/usageService.ts';
import type { Database } from '../src/server/db.ts';

const RECENT_EVENTS =
  'SELECT player_id, season, week, kind, from_value, to_value, detected_at ' +
  'FROM injury_events ORDER BY detected_at DESC, event_key DESC LIMIT 6';

async function planOf(db: Database, sql: string): Promise<string> {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

describe('the recent-events read', () => {
  it('takes six rows from an index instead of sorting the whole log', async () => {
    const db = await createTestDb();
    const plan = await planOf(db, RECENT_EVENTS);

    expect(
      plan,
      'a temp B-tree here means the whole event log is read to display six rows — the #248 defect, on a third table',
    ).not.toContain('TEMP B-TREE');
    expect(plan).toContain('idx_injury_events_recent');
  });

  /**
   * The tie-break changed from `rowid` to `event_key` to make the index
   * possible, and an ingest stamps every event it writes with one
   * `detected_at` — so the tie-break decides the order of most of this list,
   * not an occasional collision.
   */
  it('still returns the newest events, newest first, with a total order in a tie', async () => {
    const db = await createTestDb();
    const repo = new InjurySourceRepo(db);
    const at = '2026-09-08T12:00:00.000Z';
    const older = '2026-09-07T12:00:00.000Z';
    const meta = { source: 'nflverse', sourceModifiedAt: null };
    await repo.recordEvents(
      [
        { eventKey: 'k-b', playerId: 'p2', season: '2026', week: 1, kind: 'designation', from: null, to: 'Out' },
        { eventKey: 'k-a', playerId: 'p1', season: '2026', week: 1, kind: 'designation', from: null, to: 'Questionable' },
      ],
      { ...meta, detectedAt: at },
    );
    await repo.recordEvents(
      [{ eventKey: 'k-c', playerId: 'p3', season: '2026', week: 1, kind: 'practice', from: null, to: 'DNP' }],
      { ...meta, detectedAt: older },
    );

    const events = await repo.recentEvents(6);
    expect(events.map((e) => e.playerId), 'newest first, then event_key descending').toEqual(['p2', 'p1', 'p3']);
  });
});

describe('the usage health panel', () => {
  async function seeded(): Promise<Database> {
    const db = await createTestDb();
    const rows: StoredUsageWeek[] = [];
    for (let week = 1; week <= 6; week++) {
      for (let p = 0; p < 20; p++) {
        rows.push({
          playerId: `p${p}`, season: '2026', week, seasonType: 'REG', team: 'KC', position: 'WR',
          opponent: 'BUF', passAttempts: null, carries: 2, targets: 6, receptions: 4,
          targetShare: 0.2, wopr: 0.4, passYards: null, passTds: null, rushYards: 10, rushTds: 0,
          recYards: 50, recTds: 0, receivingAirYards: 60, airYardsShare: 0.3, gsisId: null,
          source: 'nflverse', publishedAt: null, fetchedAt: '2026-09-08T09:00:00.000Z',
        } as StoredUsageWeek);
      }
    }
    await new UsageRepo(db).saveWeeks(rows);
    return db;
  }

  it('counts the season once, not once per screen', async () => {
    const counted = countingDb(await seeded());
    const service = new UsageService(counted.db);

    await service.health('2026');
    const first = counted.callsMatching('COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT week)');
    counted.reset();
    await service.health('2026');

    expect(first, 'the first read counts them').toBe(1);
    expect(
      counted.callsMatching('COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT week)'),
      'Data Health and Setup ask this within seconds of each other; it is one answer',
    ).toBe(0);
    expect(counted.callsMatching('HAVING COUNT(*) >='), 'and the readiness count is the same fact').toBe(0);
  });

  it('re-reads the freshness every time, memo or no memo', async () => {
    const counted = countingDb(await seeded());
    const service = new UsageService(counted.db);
    await service.health('2026');
    counted.reset();
    await service.health('2026');

    expect(
      counted.callsMatching('FROM usage_source_runs'),
      'when a feed last succeeded is the one thing a diagnostics screen may never serve from a memo',
    ).toBe(1);
    expect(counted.callsMatching('FROM usage_source_state')).toBe(1);
  });

  it('counts again after an ingest', async () => {
    const db = await seeded();
    const counted = countingDb(db);
    const service = new UsageService(counted.db);
    await service.health('2026');
    forgetUsageDerivations(counted.db);
    counted.reset();
    await service.health('2026');

    expect(counted.callsMatching('COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT week)')).toBe(1);
  });

  it('reports the same numbers it did before the memo', async () => {
    const db = await seeded();
    const service = new UsageService(db);
    const held = await service.health('2026');
    forgetUsageDerivations(db);
    const fresh = await service.health('2026');
    expect(held.players).toBe(fresh.players);
    expect(held.weeks).toBe(fresh.weeks);
    expect(held.latestWeek).toBe(fresh.latestWeek);
    expect(held.rows).toBe(fresh.rows);
    expect(held.playersWithEnoughGames).toBe(fresh.playersWithEnoughGames);
    expect(fresh.players, 'a seeded season has players in it').toBeGreaterThan(0);
  });
});

/**
 * The single largest query on the account, and the note that hid it.
 *
 * `gamesPlayedCounts` read 760,347 rows across 189 calls in the 24 hours to
 * 03:00 on 9 September — 15.2% of a day's allowance — to answer how many games
 * a full season is. Its own comment called it cheap "returning about twenty
 * rows", which is true and is not what D1 bills: the `GROUP BY` walks every row
 * the season holds, 4,023 of them, to produce those twenty.
 *
 * Its sibling `countSeasonStats` reads the same table for the same kind of
 * reason and was memoised for exactly this. Only one of the two was held.
 */
describe('the season slate on a player card', () => {
  async function seeded(): Promise<Database> {
    const db = await createTestDb();
    const lines = Array.from({ length: 40 }, (_, i) => ({
      playerId: `p${i}`,
      position: 'WR',
      gamesPlayed: 10 + (i % 8),
      pointsHalfPpr: 100 + i,
      positionRankHalfPpr: i + 1,
      providerPositionRank: i + 1,
    }));
    await new PlayerDetailRepo(db).saveSeasonStats('2026', lines, '2026-09-09T09:00:00.000Z');
    return db;
  }

  it('walks the season once, not once per opened card', async () => {
    const counted = countingDb(await seeded());
    const repo = new PlayerDetailRepo(counted.db);

    await repo.gamesPlayedCounts('2026');
    await repo.gamesPlayedCounts('2026');
    await repo.gamesPlayedCounts('2026');

    expect(
      counted.callsMatching('SELECT games_played AS games, COUNT(*) AS players'),
      'three cards opened in an hour is one read of the season, not three',
    ).toBe(1);
  });

  it('asks again for a different season', async () => {
    const counted = countingDb(await seeded());
    const repo = new PlayerDetailRepo(counted.db);
    await repo.gamesPlayedCounts('2026');
    await repo.gamesPlayedCounts('2025');
    expect(counted.callsMatching('SELECT games_played AS games, COUNT(*) AS players')).toBe(2);
  });

  it('asks again once new stats land', async () => {
    const db = await seeded();
    const counted = countingDb(db);
    const repo = new PlayerDetailRepo(counted.db);
    await repo.gamesPlayedCounts('2026');
    forgetSeasonStatCounts(counted.db);
    counted.reset();
    await repo.gamesPlayedCounts('2026');
    expect(
      counted.callsMatching('SELECT games_played AS games, COUNT(*) AS players'),
      'the 09:00 refresh and a manual import both forget it, so a new week is visible at once',
    ).toBe(1);
  });

  it('returns the same histogram it did before the memo', async () => {
    const db = await seeded();
    const repo = new PlayerDetailRepo(db);
    const held = await repo.gamesPlayedCounts('2026');
    forgetSeasonStatCounts(db);
    const fresh = await repo.gamesPlayedCounts('2026');
    expect(held).toEqual(fresh);
    expect(fresh.length, 'a seeded season has a slate to report').toBeGreaterThan(0);
  });
});
