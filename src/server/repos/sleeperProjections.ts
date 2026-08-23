/**
 * Reading and writing Rotowire's published weekly projections.
 *
 * A cache of somebody else's numbers, and nothing more. Nothing in this file
 * decides anything: it stores what the feed said, hands back what it stored, and
 * the choice of whether a screen may show it lives in
 * `core/startsit/projection.ts`.
 *
 * The whole week is stored, not the roster. A roster changes between two reads
 * of the same week — a waiver claim, a trade, a different league selected — and
 * a cache keyed to the roster that happened to be current when it was filled
 * answers "nothing published" for every player added since. One fetch, one week,
 * everybody in it.
 */

import {
  SLEEPER_PROJECTION_PUBLISHER,
  type SleeperScoringKey,
  type SleeperWeeklyProjection,
} from '../../core/sleeper/weeklyProjections.ts';
import { chunk, type Database } from '../db.ts';

/** How many rows go in one statement. Four bound values per row plus the key. */
const ROWS_PER_BATCH = 200;

export interface StoredWeeklyProjection {
  playerId: string;
  publisher: string | null;
  points: Record<SleeperScoringKey, number | null>;
}

export interface WeeklyProjectionFreshness {
  season: string;
  week: number;
  players: number;
  /** ISO of the most recent fetch that wrote into this week. */
  fetchedAt: string | null;
  /** What the feed called itself, when every stored row agrees. */
  publisher: string | null;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class SleeperProjectionsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Replace what is stored for one week with what the feed just said.
   *
   * An upsert rather than a delete-then-insert: a fetch that returns fewer rows
   * than last time is far more likely to be a partial answer than a retraction,
   * and blanking the week on it would turn one bad response into a screen with
   * no projections on it.
   */
  async save(season: string, week: number, rows: SleeperWeeklyProjection[], fetchedAt: string): Promise<number> {
    if (rows.length === 0) return 0;

    let written = 0;
    for (const batch of chunk(rows, ROWS_PER_BATCH)) {
      const statements = batch.map((row) =>
        this.db
          .prepare(
            `insert into sleeper_weekly_projections
               (season, week, player_id, pts_std, pts_half_ppr, pts_ppr, publisher, fetched_at)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(season, week, player_id) do update set
               pts_std = excluded.pts_std,
               pts_half_ppr = excluded.pts_half_ppr,
               pts_ppr = excluded.pts_ppr,
               publisher = excluded.publisher,
               fetched_at = excluded.fetched_at`,
          )
          .bind(
            season,
            week,
            row.playerId,
            row.points.pts_std,
            row.points.pts_half_ppr,
            row.points.pts_ppr,
            row.publisher,
            fetchedAt,
          ),
      );
      await this.db.batch(statements);
      written += batch.length;
    }
    return written;
  }

  /** Every figure stored for one week, by player id. */
  async forWeek(season: string, week: number): Promise<Map<string, StoredWeeklyProjection>> {
    const { results } = await this.db
      .prepare(
        `select player_id, pts_std, pts_half_ppr, pts_ppr, publisher
           from sleeper_weekly_projections
          where season = ? and week = ?`,
      )
      .bind(season, week)
      .all<Record<string, unknown>>();

    const out = new Map<string, StoredWeeklyProjection>();
    for (const row of results ?? []) {
      const playerId = String(row['player_id'] ?? '');
      if (!playerId) continue;
      out.set(playerId, {
        playerId,
        publisher: row['publisher'] == null ? null : String(row['publisher']),
        points: {
          pts_std: toNumber(row['pts_std']),
          pts_half_ppr: toNumber(row['pts_half_ppr']),
          pts_ppr: toNumber(row['pts_ppr']),
        },
      });
    }
    return out;
  }

  /**
   * How much of a week is stored and how old it is.
   *
   * `publisher` is reported only when every stored row agrees on it, because
   * "the source of these numbers" is a claim about all of them — a week that
   * somehow mixed two publishers should report neither rather than the first.
   */
  async freshness(season: string, week: number): Promise<WeeklyProjectionFreshness> {
    const row = await this.db
      .prepare(
        `select count(*) as players,
                max(fetched_at) as fetched_at,
                min(coalesce(publisher, '')) as lo,
                max(coalesce(publisher, '')) as hi
           from sleeper_weekly_projections
          where season = ? and week = ?`,
      )
      .bind(season, week)
      .first<Record<string, unknown>>();

    const lo = String(row?.['lo'] ?? '');
    const hi = String(row?.['hi'] ?? '');
    return {
      season,
      week,
      players: Number(row?.['players'] ?? 0) || 0,
      fetchedAt: row?.['fetched_at'] == null ? null : String(row['fetched_at']),
      publisher: lo !== '' && lo === hi ? lo : null,
    };
  }
}

/** What the app expects the feed to call itself, for callers that want to check. */
export const EXPECTED_PUBLISHER = SLEEPER_PROJECTION_PUBLISHER;
