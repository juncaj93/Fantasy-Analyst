/**
 * Storage for the two things the expanded player card adds: last season's line
 * and this season's outlook.
 *
 * Both are caches of somebody else's data, so both record when they were taken.
 * "Unknown stays unknown" is the rule that shapes the reads: an absent row
 * returns null and the card says nothing, rather than a zero that reads as a
 * finish of last place or a season of no games.
 */

import type { SeasonStatLine } from '../../core/sleeper/seasonStats.ts';
import type { PlayerOutlook } from '../../core/sleeper/outlook.ts';
import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';
import { SlowRead } from './slowRead.ts';

export interface StoredSeasonStats {
  playerId: string;
  season: string;
  gamesPlayed: number | null;
  pointsHalfPpr: number | null;
  positionRankHalfPpr: number | null;
  position: string | null;
}

export interface StatsRun {
  season: string;
  fetchedAt: string;
  source: string;
  rowsReturned: number;
  rowsMatched: number;
  rowsUnmatched: number;
  rankDisagreements: number;
  note: string | null;
}

/** Bound parameters per row, for the D1 bound-parameter cap. */
const STAT_COLUMNS = 8;

/*
 * The season-stat count, memoised per database and per season. See
 * `slowRead.ts` — this was 13.5% of the reads on the day the allowance ran
 * out, spent entirely on a diagnostics line.
 */
const SEASON_STAT_COUNTS = new SlowRead<number>();

/** Drop the memoised season-stat counts. Exported for tests. */
export function forgetSeasonStatCounts(db: Database): void {
  SEASON_STAT_COUNTS.forget(db);
}

export class PlayerDetailRepo {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------- statistics

  /**
   * Replace a season's lines.
   *
   * Chunked against D1's bound-parameter ceiling — 100, worked around at 90 —
   * which is the trap this repository has hit before with batched writes.
   */
  async saveSeasonStats(season: string, lines: SeasonStatLine[], now: string): Promise<void> {
    const perStatement = Math.floor(MAX_BOUND_PARAMS / STAT_COLUMNS);
    for (const batch of chunk(lines, perStatement)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: (string | number | null)[] = [];
      for (const line of batch) {
        binds.push(
          line.playerId,
          season,
          line.gamesPlayed,
          line.pointsHalfPpr,
          line.positionRankHalfPpr,
          line.providerPositionRank,
          line.position,
          now,
        );
      }
      await this.db
        .prepare(
          `INSERT INTO player_season_stats
             (player_id, season, games_played, points_half_ppr, position_rank_half_ppr,
              provider_position_rank, position, updated_at)
           VALUES ${values}
           ON CONFLICT(player_id, season) DO UPDATE SET
             games_played = excluded.games_played,
             points_half_ppr = excluded.points_half_ppr,
             position_rank_half_ppr = excluded.position_rank_half_ppr,
             provider_position_rank = excluded.provider_position_rank,
             position = excluded.position,
             updated_at = excluded.updated_at`,
        )
        .bind(...binds)
        .run();
    }
    // The count this season reports has just changed; do not serve the old one.
    forgetSeasonStatCounts(this.db);
  }

  async recordStatsRun(run: StatsRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO player_season_stats_runs
           (season, fetched_at, source, rows_returned, rows_matched, rows_unmatched, rank_disagreements, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.season,
        run.fetchedAt,
        run.source,
        run.rowsReturned,
        run.rowsMatched,
        run.rowsUnmatched,
        run.rankDisagreements,
        run.note,
      )
      .run();
  }

  async latestStatsRun(): Promise<StatsRun | null> {
    const row = await this.db
      .prepare(
        `SELECT season, fetched_at, source, rows_returned, rows_matched, rows_unmatched,
                rank_disagreements, note
           FROM player_season_stats_runs ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      )
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      season: String(row['season']),
      fetchedAt: String(row['fetched_at']),
      source: String(row['source']),
      rowsReturned: Number(row['rows_returned']),
      rowsMatched: Number(row['rows_matched']),
      rowsUnmatched: Number(row['rows_unmatched']),
      rankDisagreements: Number(row['rank_disagreements'] ?? 0),
      note: row['note'] == null ? null : String(row['note']),
    };
  }

  async getSeasonStats(playerId: string, season: string): Promise<StoredSeasonStats | null> {
    const row = await this.db
      .prepare(
        `SELECT player_id, season, games_played, points_half_ppr, position_rank_half_ppr, position
           FROM player_season_stats WHERE player_id = ? AND season = ?`,
      )
      .bind(playerId, season)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      playerId: String(row['player_id']),
      season: String(row['season']),
      gamesPlayed: numberOrNull(row['games_played']),
      pointsHalfPpr: numberOrNull(row['points_half_ppr']),
      positionRankHalfPpr: numberOrNull(row['position_rank_half_ppr']),
      position: row['position'] == null ? null : String(row['position']),
    };
  }

  /**
   * How many players reached each games-played value in a season.
   *
   * The input to `fullSeasonSlate`, which turns it into the season's actual
   * regular-season length. It is read rather than assumed because the alternative
   * is a hardcoded 17 that would be wrong for a season in progress, and would
   * stay wrong silently.
   *
   * Cheap enough to ask per opened card: one grouped scan of a single season,
   * returning about twenty rows.
   */
  async gamesPlayedCounts(season: string): Promise<{ games: number; players: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT games_played AS games, COUNT(*) AS players
           FROM player_season_stats
          WHERE season = ? AND games_played IS NOT NULL
          GROUP BY games_played`,
      )
      .bind(season)
      .all<{ games: number; players: number }>();
    return (results ?? []).map((row) => ({ games: Number(row.games), players: Number(row.players) }));
  }

  /**
   * How many players a season actually covers, for the Setup diagnostics.
   *
   * One number on a diagnostics screen, and a full pass over a season of
   * `player_season_stats` to produce it: 3,305 rows a call, 204 calls, 13.5%
   * of the day the D1 allowance ran out. Memoised per season — the table is
   * written by the 09:00 tick and by a stats import, and both call
   * {@link forgetSeasonStatCounts}.
   */
  async countSeasonStats(season: string): Promise<number> {
    return SEASON_STAT_COUNTS.get(this.db, season, async () => {
      const row = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM player_season_stats WHERE season = ?`)
        .bind(season)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    });
  }

  // ---------------------------------------------------------------- outlook

  async getOutlook(playerId: string, season: string): Promise<(PlayerOutlook & { fetchedAt: string }) | null> {
    const row = await this.db
      .prepare(
        `SELECT player_id, season, title, body, source, fetched_at
           FROM player_outlooks WHERE player_id = ? AND season = ?`,
      )
      .bind(playerId, season)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      playerId: String(row['player_id']),
      season: String(row['season']),
      title: row['title'] == null ? null : String(row['title']),
      body: String(row['body']),
      source: row['source'] == null ? null : String(row['source']),
      fetchedAt: String(row['fetched_at']),
    };
  }

  /**
   * Outlook text for many players, from the cache and only from the cache.
   *
   * The trade board reads this to find out whether a major injury is *named*
   * in supported prose. It must never fetch: sixty cards is sixty requests to
   * a third party for a screen nobody asked to refresh, and a player with no
   * cached outlook honestly has no named history rather than an unknown one.
   */
  async cachedOutlooks(playerIds: string[], season: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT player_id, body FROM player_outlooks WHERE season = ? AND player_id IN (${holes})`)
        .bind(season, ...batch)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) out.set(String(row['player_id']), String(row['body']));
    }
    return out;
  }

  async saveOutlook(outlook: PlayerOutlook, now: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO player_outlooks (player_id, season, title, body, source, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id, season) DO UPDATE SET
           title = excluded.title, body = excluded.body,
           source = excluded.source, fetched_at = excluded.fetched_at`,
      )
      .bind(outlook.playerId, outlook.season, outlook.title, outlook.body, outlook.source, now)
      .run();
    await this.db
      .prepare(`DELETE FROM player_outlook_misses WHERE player_id = ? AND season = ?`)
      .bind(outlook.playerId, outlook.season)
      .run();
  }

  /** When the provider was last asked about a player it has nothing on. */
  async getOutlookMiss(playerId: string, season: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT checked_at FROM player_outlook_misses WHERE player_id = ? AND season = ?`)
      .bind(playerId, season)
      .first<{ checked_at: string }>();
    return row ? String(row.checked_at) : null;
  }

  async recordOutlookMiss(playerId: string, season: string, now: string, reason: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO player_outlook_misses (player_id, season, checked_at, reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(player_id, season) DO UPDATE SET checked_at = excluded.checked_at, reason = excluded.reason`,
      )
      .bind(playerId, season, now, reason)
      .run();
  }

  /** Cache size, for the Setup diagnostics. */
  async outlookCoverage(season: string): Promise<{ stored: number; misses: number; newestAt: string | null }> {
    const stored = await this.db
      .prepare(`SELECT COUNT(*) AS n, MAX(fetched_at) AS newest FROM player_outlooks WHERE season = ?`)
      .bind(season)
      .first<{ n: number; newest: string | null }>();
    const misses = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM player_outlook_misses WHERE season = ?`)
      .bind(season)
      .first<{ n: number }>();
    return {
      stored: Number(stored?.n ?? 0),
      misses: Number(misses?.n ?? 0),
      newestAt: stored?.newest ?? null,
    };
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
