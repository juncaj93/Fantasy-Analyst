/**
 * Storage for last season's injuries, and for the walk that builds it.
 *
 * Deliberately a separate file from `repos/injury.ts`, and deliberately never
 * imported by anything that resolves a current designation. The separation is
 * not a convention here, it is the safety property: `resolveInjury` decides
 * whether a player can play on Sunday, and it must be impossible for a 2025
 * knee to reach it. Keeping the reads in a different module makes an accidental
 * import visible in a diff.
 */

import { chunk, MAX_BOUND_PARAMS, parseJson, toJson, type Database } from '../db.ts';
import type { HistoryRow, InjuryEpisode, Significance } from '../../core/injury/history.ts';

export interface StoredPlayerHistory {
  playerId: string;
  season: string;
  significance: Significance;
  gamesMissed: number;
  note: string;
  episodes: InjuryEpisode[];
  source: string;
  derivedAt: string;
}

export type BackfillPhase = 'weeks' | 'players' | 'done';

export interface BackfillProgress {
  source: string;
  season: string;
  phase: BackfillPhase;
  nextWeek: number;
  lastWeek: number | null;
  afterPlayerId: string | null;
  rowsSeen: number;
  playersWritten: number;
  significantPlayers: number;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  note: string | null;
}

/** Bound parameters per history row, for D1's cap. */
const HISTORY_COLUMNS = 8;

export class InjuryHistoryRepo {
  constructor(private readonly db: Database) {}

  /**
   * Upsert the derived summaries for a batch of players.
   *
   * Upsert rather than insert so re-deriving a player is idempotent: the
   * backfill can be re-run over a season it has already summarized and the
   * result is the same rows, not duplicates.
   */
  async save(rows: StoredPlayerHistory[]): Promise<void> {
    if (rows.length === 0) return;
    const perStatement = Math.floor(MAX_BOUND_PARAMS / HISTORY_COLUMNS);
    for (const batch of chunk(rows, perStatement)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: (string | number | null)[] = [];
      for (const row of batch) {
        binds.push(
          row.playerId,
          row.season,
          row.significance,
          row.gamesMissed,
          row.note,
          toJson(row.episodes),
          row.source,
          row.derivedAt,
        );
      }
      await this.db
        .prepare(
          `INSERT INTO player_injury_history
             (player_id, season, significance, games_missed, note, episodes, source, derived_at)
           VALUES ${values}
           ON CONFLICT(player_id, season) DO UPDATE SET
             significance = excluded.significance,
             games_missed = excluded.games_missed,
             note = excluded.note,
             episodes = excluded.episodes,
             source = excluded.source,
             derived_at = excluded.derived_at`,
        )
        .bind(...binds)
        .run();
    }
  }

  /**
   * A player whose season stopped being significant must lose his row.
   *
   * Re-deriving is not purely additive: a correction to the source, or a
   * change to the thresholds, can take a player below the bar. Leaving the old
   * row would keep a note on a card that nothing generates any more.
   */
  async forget(playerIds: string[], season: string): Promise<void> {
    if (playerIds.length === 0) return;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      await this.db
        .prepare(`DELETE FROM player_injury_history WHERE season = ? AND player_id IN (${holes})`)
        .bind(season, ...batch)
        .run();
    }
  }

  /** The notes for these players, in one round trip. Absent means nothing to say. */
  async forPlayers(playerIds: string[], season: string): Promise<Map<string, StoredPlayerHistory>> {
    const out = new Map<string, StoredPlayerHistory>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT * FROM player_injury_history WHERE season = ? AND player_id IN (${holes})`)
        .bind(season, ...batch)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const stored = toHistory(row);
        out.set(stored.playerId, stored);
      }
    }
    return out;
  }

  /**
   * Every stored week for these players, grouped.
   *
   * The whole season per player, not a recent window: an episode is only
   * visible when its weeks are all present, and a summary built from the last
   * three would call a nine-game absence a three-game one.
   */
  async reportsFor(playerIds: string[], season: string): Promise<Map<string, HistoryRow[]>> {
    const out = new Map<string, HistoryRow[]>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT player_id, week, report_status, primary_injury, secondary_injury, practice_raw, practice_status
             FROM player_injury_reports
            WHERE season = ? AND player_id IN (${holes})
            ORDER BY player_id, week`,
        )
        .bind(season, ...batch)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const id = String(row.player_id);
        const list = out.get(id) ?? [];
        list.push({
          week: Number(row.week),
          reportStatus: row.report_status == null ? null : String(row.report_status),
          primaryInjury: row.primary_injury == null ? null : String(row.primary_injury),
          secondaryInjury: row.secondary_injury == null ? null : String(row.secondary_injury),
          /*
           * The raw practice string, not the normalized one. `practice_status`
           * was normalized on the way in and `normalizePractice` is idempotent
           * over its own output, but the raw value is what the source wrote and
           * it is the one an audit can be traced back to.
           */
          practiceStatus: row.practice_raw == null ? (row.practice_status == null ? null : String(row.practice_status)) : String(row.practice_raw),
        });
        out.set(id, list);
      }
    }
    return out;
  }

  async countBySignificance(season: string): Promise<{ strong: number; moderate: number }> {
    const { results } = await this.db
      .prepare(`SELECT significance, COUNT(*) AS n FROM player_injury_history WHERE season = ? GROUP BY significance`)
      .bind(season)
      .all<{ significance: string; n: number }>();
    let strong = 0;
    let moderate = 0;
    for (const row of results ?? []) {
      if (row.significance === 'strong') strong = Number(row.n);
      if (row.significance === 'moderate') moderate = Number(row.n);
    }
    return { strong, moderate };
  }

  // ------------------------------------------------------------- the walk

  async progress(source: string, season: string): Promise<BackfillProgress | null> {
    const row = await this.db
      .prepare(`SELECT * FROM injury_backfill_progress WHERE source = ? AND season = ?`)
      .bind(source, season)
      .first<Record<string, unknown>>();
    return row ? toProgress(row) : null;
  }

  /**
   * Write the cursor.
   *
   * Takes the whole row rather than a patch. A partial update here was a quiet
   * source of corruption: the columns are NOT NULL with defaults, so a caller
   * that only wanted to change the note also sent `next_week = 1`, and the
   * progress row silently claimed the walk was back at the start of the season.
   * The caller always holds the current progress, so it can hand over what the
   * row should now say and there is nothing left to infer.
   */
  async saveProgress(next: BackfillProgress): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO injury_backfill_progress
           (source, season, phase, next_week, last_week, after_player_id, rows_seen, players_written,
            significant_players, started_at, completed_at, updated_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, season) DO UPDATE SET
           phase = excluded.phase,
           next_week = excluded.next_week,
           last_week = excluded.last_week,
           after_player_id = excluded.after_player_id,
           rows_seen = excluded.rows_seen,
           players_written = excluded.players_written,
           significant_players = excluded.significant_players,
           started_at = COALESCE(started_at, excluded.started_at),
           completed_at = excluded.completed_at,
           updated_at = excluded.updated_at,
           note = excluded.note`,
      )
      .bind(
        next.source,
        next.season,
        next.phase,
        next.nextWeek,
        next.lastWeek,
        next.afterPlayerId,
        next.rowsSeen,
        next.playersWritten,
        next.significantPlayers,
        next.startedAt,
        next.completedAt,
        next.updatedAt,
        next.note,
      )
      .run();
  }

  /**
   * The next page of players who have any stored report for this season.
   *
   * Ordered by id and resumed with a strict `>` so the walk is stable across
   * invocations without keeping a list in memory between them.
   */
  async playersWithReports(season: string, afterPlayerId: string | null, limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT player_id FROM player_injury_reports
          WHERE season = ? AND player_id > ?
          ORDER BY player_id
          LIMIT ?`,
      )
      .bind(season, afterPlayerId ?? '', limit)
      .all<{ player_id: string }>();
    return (results ?? []).map((r) => r.player_id);
  }
}

function toHistory(row: Record<string, unknown>): StoredPlayerHistory {
  return {
    playerId: String(row.player_id),
    season: String(row.season),
    significance: String(row.significance) as Significance,
    gamesMissed: Number(row.games_missed ?? 0),
    note: String(row.note ?? ''),
    episodes: parseJson<InjuryEpisode[]>(row.episodes as string, []),
    source: String(row.source ?? ''),
    derivedAt: String(row.derived_at ?? ''),
  };
}

function toProgress(row: Record<string, unknown>): BackfillProgress {
  return {
    source: String(row.source),
    season: String(row.season),
    phase: String(row.phase) as BackfillPhase,
    nextWeek: Number(row.next_week ?? 1),
    lastWeek: row.last_week == null ? null : Number(row.last_week),
    afterPlayerId: row.after_player_id == null ? null : String(row.after_player_id),
    rowsSeen: Number(row.rows_seen ?? 0),
    playersWritten: Number(row.players_written ?? 0),
    significantPlayers: Number(row.significant_players ?? 0),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    updatedAt: String(row.updated_at ?? ''),
    note: row.note == null ? null : String(row.note),
  };
}
