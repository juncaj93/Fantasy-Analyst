/**
 * Counts kept in the settings table, and the capture list read by seeks
 * (cleanup round, October 2026).
 *
 * These guard how many times a question is asked of the database, and which
 * index answers it, not only the answer: each of these was a right answer
 * bought too many times.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { PlayerDetailRepo, forgetSeasonStatCounts } from '../src/server/repos/playerDetail.ts';
import { DepthChartRepo } from '../src/server/repos/nflverse.ts';

describe('priced player count', () => {
  it('counts once per snapshot state, then reads one settings row', async () => {
    const db = await createTestDb();
    const counting = countingDb(db);
    const repo = new PropsRepo(counting.db);
    const live = 'COUNT(DISTINCT pp.player_id)';

    expect(await repo.pricedPlayerCount('t1|3')).toBe(0);
    expect(await repo.pricedPlayerCount('t1|3')).toBe(0);
    expect(await repo.pricedPlayerCount('t1|3')).toBe(0);
    expect(counting.callsMatching(live)).toBe(1);

    // A new snapshot changes the anchor, so the count is taken again.
    await repo.pricedPlayerCount('t2|4');
    expect(counting.callsMatching(live)).toBe(2);
  });

  it('still counts live when no anchor is given', async () => {
    const db = await createTestDb();
    const counting = countingDb(db);
    const repo = new PropsRepo(counting.db);
    await repo.pricedPlayerCount();
    await repo.pricedPlayerCount();
    expect(counting.callsMatching('COUNT(DISTINCT pp.player_id)')).toBe(2);
  });
});

describe('season stats count', () => {
  it('survives a cold isolate and is dropped by a write', async () => {
    const db = await createTestDb();
    const counting = countingDb(db);
    const repo = new PlayerDetailRepo(counting.db);
    const sql = 'COUNT(*) AS n FROM player_season_stats';

    expect(await repo.countSeasonStats('2025')).toBe(0);
    forgetSeasonStatCounts(counting.db); // a new isolate has an empty memo
    expect(await repo.countSeasonStats('2025')).toBe(0);
    expect(counting.callsMatching(sql)).toBe(1);

    await repo.saveSeasonStats(
      '2025',
      [
        {
          playerId: 'p1',
          gamesPlayed: 17,
          pointsHalfPpr: 200,
          positionRankHalfPpr: 1,
          providerPositionRank: 1,
          position: 'WR',
        } as never,
      ],
      '2026-10-13T00:00:00Z',
    );
    expect(await repo.countSeasonStats('2025')).toBe(1);
    expect(counting.callsMatching(sql)).toBe(2);
  });
});

describe('depth chart captures', () => {
  async function seeded() {
    const db = await createTestDb();
    const rows: [string, string, string][] = [];
    for (const at of ['2026-08-20T07:00:00Z', '2026-08-22T07:00:00Z', '2026-08-21T07:00:00Z']) {
      for (let i = 0; i < 40; i++) rows.push(['2026', at, `00-${String(i).padStart(7, '0')}`]);
    }
    rows.push(['2025', '2025-12-01T00:00:00Z', '00-0000001']);
    for (const [season, at, gsis] of rows) {
      await db
        .prepare(
          `INSERT INTO depth_chart_entries (season, captured_at, gsis_id, team, position, pos_rank, schema_version, source, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(season, at, gsis, 'KC', 'WR', 1, 'timestamped', 't', at)
        .run();
    }
    return db;
  }

  it('lists the same captures, newest first, as the DISTINCT scan did', async () => {
    const db = await seeded();
    const old = await db
      .prepare('SELECT DISTINCT captured_at FROM depth_chart_entries WHERE season = ? ORDER BY captured_at DESC')
      .bind('2026')
      .all<{ captured_at: string }>();
    const now = await new DepthChartRepo(db).captures('2026');
    expect(now).toEqual(old.results.map((r) => r.captured_at));
    expect(now).toEqual(['2026-08-22T07:00:00Z', '2026-08-21T07:00:00Z', '2026-08-20T07:00:00Z']);
    expect(await new DepthChartRepo(db).captures('2024')).toEqual([]);
  });

  it('reads one index row per capture, never the whole season', async () => {
    const db = await seeded();
    const counting = countingDb(db);
    await new DepthChartRepo(counting.db).captures('2026');
    const tally = counting.tallies().find((t) => t.sql.includes('depth_chart_entries'))!;
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${tally.sql}`)
      .bind('2026', '2026')
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join(' | ');
    expect(plan).toContain('idx_depth_chart_entries_season');
    expect(plan).not.toMatch(/SCAN depth_chart_entries/);
  });
});
