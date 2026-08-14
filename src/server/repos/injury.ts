/**
 * Storage for the published injury report, and for every attempt to fetch it.
 *
 * Two reads, and they are different questions. `latestFor` answers "what is the
 * most recent report about these players", which is what a card and a Start/Sit
 * comparison want. `weeksFor` answers "what has the last few weeks looked like",
 * which is the only way this source can say anything about a direction.
 *
 * Nothing here interprets. Normalization and conflict resolution live in
 * `core/injury/model.ts`, so every screen reads one interpretation rather than
 * arriving at its own.
 */

import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';
import { normalizePractice, type PracticeStatus } from '../../core/injury/model.ts';

export interface StoredInjuryReport {
  playerId: string;
  season: string;
  week: number;
  team: string | null;
  reportStatus: string | null;
  primaryInjury: string | null;
  secondaryInjury: string | null;
  practiceStatus: PracticeStatus;
  practiceRaw: string | null;
  gsisId: string | null;
  source: string;
  publishedAt: string | null;
  fetchedAt: string;
}

export interface InjurySourceRun {
  source: string;
  season: string;
  latestWeek: number | null;
  fetchedAt: string;
  publishedAt: string | null;
  rowsReturned: number;
  matchedById: number;
  matchedByName: number;
  unmatched: number;
  /** `ok` | `not_published` | `failed` — a preseason 404 is not a failure. */
  outcome: 'ok' | 'not_published' | 'failed';
  note: string | null;
}

/** Bound parameters per row, for D1's cap. */
const REPORT_COLUMNS = 13;

export class InjuryRepo {
  constructor(private readonly db: Database) {}

  /**
   * Upsert a week's reports.
   *
   * Upsert rather than replace: re-ingesting the same week must be idempotent,
   * and a later file that drops a player must not delete the last thing anyone
   * knew about him. History accumulates by (player, season, week).
   */
  async saveReports(rows: StoredInjuryReport[]): Promise<void> {
    const perStatement = Math.floor(MAX_BOUND_PARAMS / REPORT_COLUMNS);
    for (const batch of chunk(rows, perStatement)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: (string | number | null)[] = [];
      for (const row of batch) {
        binds.push(
          row.playerId,
          row.season,
          row.week,
          row.team,
          row.reportStatus,
          row.primaryInjury,
          row.secondaryInjury,
          row.practiceStatus,
          row.practiceRaw,
          row.gsisId,
          row.source,
          row.publishedAt,
          row.fetchedAt,
        );
      }
      await this.db
        .prepare(
          `INSERT INTO player_injury_reports
             (player_id, season, week, team, report_status, primary_injury, secondary_injury,
              practice_status, practice_raw, gsis_id, source, published_at, fetched_at)
           VALUES ${values}
           ON CONFLICT(player_id, season, week) DO UPDATE SET
             team = excluded.team,
             report_status = excluded.report_status,
             primary_injury = excluded.primary_injury,
             secondary_injury = excluded.secondary_injury,
             practice_status = excluded.practice_status,
             practice_raw = excluded.practice_raw,
             gsis_id = excluded.gsis_id,
             source = excluded.source,
             published_at = excluded.published_at,
             fetched_at = excluded.fetched_at`,
        )
        .bind(...binds)
        .run();
    }
  }

  /** The most recent report for each of these players, in one round trip. */
  async latestFor(playerIds: string[], season: string): Promise<Map<string, StoredInjuryReport>> {
    const out = new Map<string, StoredInjuryReport>();
    if (playerIds.length === 0) return out;

    // One bound parameter per id plus the season, chunked against D1's cap.
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT r.* FROM player_injury_reports r
             JOIN (SELECT player_id, MAX(week) AS week
                     FROM player_injury_reports
                    WHERE season = ? AND player_id IN (${holes})
                 GROUP BY player_id) latest
               ON latest.player_id = r.player_id AND latest.week = r.week
            WHERE r.season = ?`,
        )
        .bind(season, ...batch, season)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const report = toReport(row);
        out.set(report.playerId, report);
      }
    }
    return out;
  }

  /**
   * The last few weeks for one player, oldest first.
   *
   * Used to say which way a practice status is heading — and only ever for one
   * player at a time, because it is read on an opened card rather than for
   * forty rows of a board.
   */
  async weeksFor(playerId: string, season: string, weeks = 3): Promise<StoredInjuryReport[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM player_injury_reports
          WHERE player_id = ? AND season = ?
       ORDER BY week DESC LIMIT ?`,
      )
      .bind(playerId, season, Math.max(1, weeks))
      .all<Record<string, unknown>>();
    return (results ?? []).map(toReport).reverse();
  }

  async recordRun(run: InjurySourceRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO injury_source_runs
           (source, season, latest_week, fetched_at, published_at, rows_returned,
            matched_by_id, matched_by_name, unmatched, outcome, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.source,
        run.season,
        run.latestWeek,
        run.fetchedAt,
        run.publishedAt,
        run.rowsReturned,
        run.matchedById,
        run.matchedByName,
        run.unmatched,
        run.outcome,
        run.note,
      )
      .run();
  }

  async latestRun(): Promise<InjurySourceRun | null> {
    const row = await this.db
      .prepare(`SELECT * FROM injury_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1`)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      source: String(row['source']),
      season: String(row['season']),
      latestWeek: row['latest_week'] == null ? null : Number(row['latest_week']),
      fetchedAt: String(row['fetched_at']),
      publishedAt: row['published_at'] == null ? null : String(row['published_at']),
      rowsReturned: Number(row['rows_returned'] ?? 0),
      matchedById: Number(row['matched_by_id'] ?? 0),
      matchedByName: Number(row['matched_by_name'] ?? 0),
      unmatched: Number(row['unmatched'] ?? 0),
      outcome: String(row['outcome']) as InjurySourceRun['outcome'],
      note: row['note'] == null ? null : String(row['note']),
    };
  }

  /** How many players the store currently holds a report for, this season. */
  async coverage(season: string): Promise<{ players: number; latestWeek: number | null }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT player_id) AS players, MAX(week) AS latest_week
           FROM player_injury_reports WHERE season = ?`,
      )
      .bind(season)
      .first<Record<string, unknown>>();
    return {
      players: Number(row?.['players'] ?? 0),
      latestWeek: row?.['latest_week'] == null ? null : Number(row['latest_week']),
    };
  }
}

function toReport(row: Record<string, unknown>): StoredInjuryReport {
  return {
    playerId: String(row['player_id']),
    season: String(row['season']),
    week: Number(row['week']),
    team: row['team'] == null ? null : String(row['team']),
    reportStatus: row['report_status'] == null ? null : String(row['report_status']),
    primaryInjury: row['primary_injury'] == null ? null : String(row['primary_injury']),
    secondaryInjury: row['secondary_injury'] == null ? null : String(row['secondary_injury']),
    practiceStatus: normalizePractice(row['practice_status'] == null ? null : String(row['practice_status'])),
    practiceRaw: row['practice_raw'] == null ? null : String(row['practice_raw']),
    gsisId: row['gsis_id'] == null ? null : String(row['gsis_id']),
    source: String(row['source']),
    publishedAt: row['published_at'] == null ? null : String(row['published_at']),
    fetchedAt: String(row['fetched_at']),
  };
}
