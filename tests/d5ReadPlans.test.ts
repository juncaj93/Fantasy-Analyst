/**
 * The betting-line and injury reads behind a lineup read this week, not the season (finding D5).
 *
 * Plans first, like `propsNewestSnapshotPlan.test.ts` and `sourceRunsIndex.test.ts`:
 * the answers were always right, and an assertion about them alone would pass
 * with the defect back in place. The test database keeps no statistics, so it
 * plans as D1 does; each plan assertion here fails on the code and schema
 * before migration 0044.
 *
 * Then answers: each rewritten statement against the statement it replaced, on
 * the same rows, so "the same answer for less" is checked rather than claimed.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { InjuryRepo, type StoredInjuryReport } from '../src/server/repos/injury.ts';
import { slateWindow } from '../src/core/nfl/slateWindow.ts';

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function planOf(db: Db, sql: string): Promise<string> {
  const params = (sql.match(/\?/g) ?? []).map(() => null);
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

const NOW = new Date('2026-10-08T16:00:00Z');

describe('the slate reads use the window and the player, not the season', () => {
  async function slateStatements(): Promise<{ db: Db; sqls: Record<string, string> }> {
    const db = await createTestDb();
    const counting = countingDb(db);
    const repo = new PropsRepo(counting.db);
    const window = slateWindow(NOW);
    const take = async (name: string, run: () => Promise<unknown>, out: Record<string, string>) => {
      const before = counting.tallies().length;
      await run();
      out[name] = counting.tallies()[before]!.sql;
    };
    const sqls: Record<string, string> = {};
    await take('latest', () => repo.latestForPlayers(['a', 'b'], window), sqls);
    await take('previous', () => repo.previousForPlayers(['a', 'b'], window), sqls);
    await take('kickoffs', () => repo.kickoffsForPlayers(['a', 'b'], window), sqls);
    return { db, sqls };
  }

  it.each(['latest', 'previous', 'kickoffs'])('%s reaches the slate through the window index', async (name) => {
    const { db, sqls } = await slateStatements();
    const plan = await planOf(db, sqls[name]!);
    expect(plan, plan).toContain('ps USING INDEX idx_prop_snapshots_window (scope=? AND game_start>? AND game_start<?)');
    expect(plan, `walking every weekly snapshot of the season: ${plan}`).not.toContain('ps USING INDEX idx_prop_snapshots_scope');
  });

  it.each(['latest', 'previous', 'kickoffs'])('%s reads only the asked-for players’ quotes', async (name) => {
    const { db, sqls } = await slateStatements();
    const plan = await planOf(db, sqls[name]!);
    expect(plan, plan).toMatch(/pp USING (COVERING )?INDEX idx_player_props_snapshot_player \(snapshot_id=\? AND player_id=\?\)/);
  });
});

describe('the latest injury report is looked up by player', () => {
  it('reads each player through the primary key, never the whole season', async () => {
    const db = await createTestDb();
    const counting = countingDb(db);
    await new InjuryRepo(counting.db).latestFor(['a', 'b'], '2026');
    const plan = await planOf(db, counting.tallies()[0]!.sql);
    expect(plan, `every report of the season read for one row a player: ${plan}`).not.toContain(
      'idx_player_injury_reports_season_week',
    );
    expect(plan.match(/sqlite_autoindex_player_injury_reports_1 \(player_id=\? AND season=\?\)/g) ?? []).toHaveLength(2);
  });
});

/* ------------------------------------------------------------ same answers */

const OLD_INJURY_LATEST = (holes: string) => `SELECT r.* FROM player_injury_reports r
   JOIN (SELECT player_id, MAX(week) AS week FROM player_injury_reports
          WHERE season = ? AND player_id IN (${holes}) GROUP BY player_id) latest
     ON latest.player_id = r.player_id AND latest.week = r.week
  WHERE r.season = ?`;

function report(playerId: string, season: string, week: number, status: string | null): StoredInjuryReport {
  return {
    playerId,
    season,
    week,
    team: 'KC',
    reportStatus: status,
    primaryInjury: status ? 'Knee' : null,
    secondaryInjury: null,
    practiceStatus: 'limited',
    practiceRaw: 'Limited Participation in Practice',
    gsisId: null,
    source: 'nflverse',
    publishedAt: null,
    fetchedAt: `2026-10-0${Math.min(week, 9)}T12:00:00.000Z`,
  };
}

describe('the rewritten reads answer exactly as before', () => {
  it('latest injury report: the same row for every player, across gaps, seasons and absences', async () => {
    const db = await createTestDb();
    const repo = new InjuryRepo(db);
    await repo.saveReports([
      report('gap', '2026', 1, 'Questionable'),
      report('gap', '2026', 3, null),
      report('gap', '2026', 5, 'Out'),
      report('early', '2026', 2, 'Doubtful'),
      report('early', '2025', 17, 'Out'),
      report('lastSeasonOnly', '2025', 9, 'Questionable'),
      report('one', '2026', 4, null),
    ]);
    const ids = ['gap', 'early', 'lastSeasonOnly', 'one', 'never'];

    const rewritten = await repo.latestFor(ids, '2026');
    const { results } = await db
      .prepare(OLD_INJURY_LATEST(ids.map(() => '?').join(', ')))
      .bind('2026', ...ids, '2026')
      .all<Record<string, unknown>>();
    const old = new Map(results.map((r) => [String(r['player_id']), Number(r['week'])]));

    expect(new Map([...rewritten].map(([id, r]) => [id, r.week]))).toEqual(old);
    expect(old).toEqual(new Map([['gap', 5], ['early', 2], ['one', 4]]));
    expect(rewritten.get('gap')?.reportStatus).toBe('Out');
  });

  it('kickoffs: the newest snapshot’s kickoff per player, as the unhinted sort gave', async () => {
    const db = await createTestDb();
    const window = slateWindow(NOW);
    const snapshot = async (eventId: string, gameStart: string, fetchedAt: string, players: string[]) => {
      const { meta } = await db
        .prepare(
          "INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope) VALUES ('sgo', ?, ?, ?, '{}', 'week')",
        )
        .bind(eventId, gameStart, fetchedAt)
        .run();
      const id = Number(meta.last_row_id);
      for (const p of players) {
        for (const market of ['rec_yds', 'anytime_td']) {
          await db
            .prepare(
              "INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, scope) VALUES (?, ?, ?, ?, 1.5, 'week')",
            )
            .bind(id, p, p, market)
            .run();
        }
      }
    };
    await db.exec('PRAGMA foreign_keys = OFF');
    // Last week's game: outside the window, must not answer.
    await snapshot('w4', '2026-10-04T17:00:00Z', '2026-10-03T09:00:00Z', ['a', 'b']);
    // This week's game, fetched twice; the second fetch carries a flexed kickoff.
    await snapshot('w5', '2026-10-11T17:00:00Z', '2026-10-07T09:00:00Z', ['a', 'b']);
    await snapshot('w5', '2026-10-11T20:25:00Z', '2026-10-08T09:00:00Z', ['a']);
    // A Thursday game for c.
    await snapshot('w5thu', '2026-10-09T00:15:00Z', '2026-10-08T10:00:00Z', ['c']);

    const ids = ['a', 'b', 'c', 'nobody'];
    const rewritten = await new PropsRepo(db).kickoffsForPlayers(ids, window);
    const { results } = await db
      .prepare(
        `SELECT pp.player_id AS player_id, ps.game_start AS game_start FROM player_props pp
           JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
          WHERE pp.player_id IN (?, ?, ?, ?) AND ps.scope = 'week'
            AND ps.game_start >= ? AND ps.game_start <= ?
          ORDER BY ps.fetched_at ASC`,
      )
      .bind(...ids, window.from, window.to)
      .all<Record<string, unknown>>();
    const old = new Map<string, string>();
    for (const r of results) old.set(String(r['player_id']), String(r['game_start']));

    expect(rewritten).toEqual(old);
    expect(rewritten).toEqual(
      new Map([
        ['a', '2026-10-11T20:25:00Z'],
        ['b', '2026-10-11T17:00:00Z'],
        ['c', '2026-10-09T00:15:00Z'],
      ]),
    );
  });
});
