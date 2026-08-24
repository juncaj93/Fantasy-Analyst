/**
 * Storage for the NFL fixture list.
 *
 * Nothing here interprets. What a bye is, how a kickoff string is built and
 * which weeks a playoff run covers all live in `core/nfl/schedule.ts`, so every
 * reader arrives at the same answer rather than building its own — the same
 * split `repos/nflverse.ts` keeps between storing a snap count and deciding what
 * one means.
 *
 * The state this ingest keeps — validators, lease, failure count, write ledger —
 * lives in `nflverse_source_state` under a `source` key of its own, because
 * that table is column-for-column the generic one and a fifth copy of it would
 * be a fifth place for the lease arithmetic to be wrong.
 *
 * It is reached through {@link ScheduleSourceRepo} here rather than by importing
 * `repos/nflverse.ts`, and the distinction is not cosmetic. That module is
 * Projection v2's, and `tests/projectionV2.boundary.test.ts` enforces that
 * nothing outside that phase imports it — a boundary this ingest has no
 * business crossing, since what it actually shares with the nflverse feeds is
 * `SourceStateRepo`, the generic mechanism, and not one line of Projection v2.
 * Sharing a *table* is not the same as depending on a *subsystem*.
 */

import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';
import { SourceStateRepo } from './sourceState.ts';
import type { ScheduleTeamWeek } from '../../core/nfl/schedule.ts';

/** Columns in one stored row, for the bound-parameter arithmetic below. */
const SCHEDULE_COLUMNS = 8;

/**
 * Statements sent to D1 in one round trip.
 *
 * A full season is 272 games and therefore 544 rows; at 90 bound parameters and
 * eight columns that is eleven rows a statement and fifty statements. Awaited
 * one at a time inside a cron that is fifty round trips for a job with no reason
 * to take more than a couple. The figure matches `repos/nflverse.ts` rather than
 * being chosen again.
 */
const STATEMENTS_PER_BATCH = 40;

export class NflScheduleRepo {
  constructor(private readonly db: Database) {}

  /**
   * Write the fixture list, idempotently.
   *
   * Upsert on `(season, week, team)` rather than delete-and-insert, and the
   * distinction is the whole reliability story of this ingest: a re-read of an
   * unchanged file rewrites identical values over identical keys and changes
   * nothing, and a *partial* read — a truncated body, a season the source has
   * only half-published — leaves every row it did not mention exactly as it was.
   * Delete-first would turn one bad morning into a schedule with holes in it,
   * and a hole is indistinguishable from a bye to everything downstream.
   */
  async save(rows: readonly ScheduleTeamWeek[], fetchedAt: string): Promise<number> {
    if (rows.length === 0) return 0;
    const perStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / SCHEDULE_COLUMNS));
    const statements = chunk([...rows], perStatement).map((batch) => {
      const values = batch.map(() => `(${new Array(SCHEDULE_COLUMNS).fill('?').join(', ')})`).join(', ');
      const binds: (string | number | null)[] = [];
      for (const row of batch) {
        binds.push(
          row.season,
          row.week,
          row.team,
          row.opponent,
          row.home ? 1 : 0,
          row.kickoff,
          row.roof,
          fetchedAt,
        );
      }
      return this.db
        .prepare(
          `INSERT INTO nfl_schedule
             (season, week, team, opponent, home, kickoff, roof, fetched_at)
           VALUES ${values}
           ON CONFLICT(season, week, team) DO UPDATE SET
             opponent = excluded.opponent,
             home = excluded.home,
             kickoff = excluded.kickoff,
             roof = excluded.roof,
             fetched_at = excluded.fetched_at`,
        )
        .bind(...binds);
    });
    for (const group of chunk(statements, STATEMENTS_PER_BATCH)) await this.db.batch(group);
    return rows.length;
  }

  /** One season's whole fixture list, in week then team order. */
  async season(season: string): Promise<ScheduleTeamWeek[]> {
    const result = await this.db
      .prepare(
        `SELECT season, week, team, opponent, home, kickoff, roof
           FROM nfl_schedule WHERE season = ? ORDER BY week, team`,
      )
      .bind(season)
      .all<Record<string, unknown>>();
    return (result.results ?? []).map(toRow);
  }

  /** One team's season, in week order — the read the index exists for. */
  async forTeam(season: string, team: string): Promise<ScheduleTeamWeek[]> {
    const result = await this.db
      .prepare(
        `SELECT season, week, team, opponent, home, kickoff, roof
           FROM nfl_schedule WHERE season = ? AND team = ? ORDER BY week`,
      )
      .bind(season, team.toUpperCase())
      .all<Record<string, unknown>>();
    return (result.results ?? []).map(toRow);
  }

  /** How much of a season is stored, for the health line and for the tests. */
  async coverage(season: string): Promise<{ rows: number; weeks: number; teams: number; fetchedAt: string | null }> {
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) AS rows, COUNT(DISTINCT week) AS weeks,
                COUNT(DISTINCT team) AS teams, MAX(fetched_at) AS fetched_at
           FROM nfl_schedule WHERE season = ?`,
      )
      .bind(season)
      .first<Record<string, unknown>>();
    return {
      rows: Number(result?.['rows'] ?? 0),
      weeks: Number(result?.['weeks'] ?? 0),
      teams: Number(result?.['teams'] ?? 0),
      fetchedAt: result?.['fetched_at'] == null ? null : String(result['fetched_at']),
    };
  }
}

function toRow(row: Record<string, unknown>): ScheduleTeamWeek {
  return {
    season: String(row['season']),
    week: Number(row['week']),
    team: String(row['team']),
    opponent: row['opponent'] == null ? null : String(row['opponent']),
    home: Number(row['home']) === 1,
    kickoff: row['kickoff'] == null ? null : String(row['kickoff']),
    roof: row['roof'] == null ? null : String(row['roof']),
  };
}

/**
 * The schedule ingest's slice of the shared source-state table.
 *
 * Two rows' worth of state — the validators and the lease for one season — in a
 * table four other feeds already use, keyed apart by `source`. Nothing is
 * overridden: the mechanisms are the ones the injury, usage and nflverse
 * pipelines proved in production, and inheriting them unchanged is the point.
 */
export class ScheduleSourceRepo extends SourceStateRepo {
  constructor(db: Database) {
    super(db, 'nflverse_source_state', 'nflverse_write_budget');
  }
}
