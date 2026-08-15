/**
 * Storage for per-game usage, and for every attempt to fetch it.
 *
 * Two reads, and they answer different questions. `weeksFor` is the one the
 * decision layer uses: a handful of players, their weeks oldest first, bounded
 * to a window — that is the shape `assessRole` needs and nothing else needs it.
 * `coverage` and `missingWeekBefore` are diagnostics: how much is here, and
 * where the holes are.
 *
 * Nothing here interprets. Which metrics a position's role is judged on lives in
 * `core/usage/role.ts`, so every screen reads the same answer rather than
 * arriving at its own.
 */

import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';
import type { ComparableUsage } from '../../core/usage/diff.ts';
import { SourceStateRepo } from './sourceState.ts';

export interface StoredUsageWeek {
  playerId: string;
  season: string;
  week: number;
  /** 'REG' or 'POST'. The read path uses REG only; see `core/usage/role.ts`. */
  seasonType: string;
  team: string | null;
  position: string | null;
  passAttempts: number | null;
  carries: number | null;
  targets: number | null;
  receptions: number | null;
  targetShare: number | null;
  wopr: number | null;
  gsisId: string | null;
  source: string;
  publishedAt: string | null;
  fetchedAt: string;
}

export interface UsageSourceRun {
  source: string;
  season: string;
  /** The week ingested, which is the file's latest unless a gap was filled. */
  week: number | null;
  latestWeek: number | null;
  fetchedAt: string;
  publishedAt: string | null;
  rowsReturned: number;
  matchedById: number;
  matchedByName: number;
  unmatched: number;
  rowsWritten: number;
  /** `ok` | `not_published` | `failed` — a preseason 404 is not a failure. */
  outcome: 'ok' | 'not_published' | 'failed';
  note: string | null;
}

/** Bound parameters per row, for D1's cap. */
const USAGE_COLUMNS = 16;

export class UsageRepo {
  constructor(private readonly db: Database) {}

  /**
   * Upsert a week of usage.
   *
   * Upsert rather than replace: re-ingesting a week must be idempotent, and a
   * later file that no longer mentions a player must not delete the game he
   * actually played. History accumulates by (player, season, week).
   */
  async saveWeeks(rows: StoredUsageWeek[]): Promise<void> {
    const perStatement = Math.floor(MAX_BOUND_PARAMS / USAGE_COLUMNS);
    for (const batch of chunk(rows, perStatement)) {
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: (string | number | null)[] = [];
      for (const row of batch) {
        binds.push(
          row.playerId,
          row.season,
          row.week,
          row.seasonType,
          row.team,
          row.position,
          row.passAttempts,
          row.carries,
          row.targets,
          row.receptions,
          row.targetShare,
          row.wopr,
          row.gsisId,
          row.source,
          row.publishedAt,
          row.fetchedAt,
        );
      }
      await this.db
        .prepare(
          `INSERT INTO player_usage_weeks
             (player_id, season, week, season_type, team, position, pass_attempts, carries,
              targets, receptions, target_share, wopr, gsis_id, source, published_at, fetched_at)
           VALUES ${values}
           ON CONFLICT(player_id, season, week) DO UPDATE SET
             season_type = excluded.season_type,
             team = excluded.team,
             position = excluded.position,
             pass_attempts = excluded.pass_attempts,
             carries = excluded.carries,
             targets = excluded.targets,
             receptions = excluded.receptions,
             target_share = excluded.target_share,
             wopr = excluded.wopr,
             gsis_id = excluded.gsis_id,
             source = excluded.source,
             published_at = excluded.published_at,
             fetched_at = excluded.fetched_at`,
        )
        .bind(...binds)
        .run();
    }
  }

  /**
   * The recent weeks for a set of players, oldest first.
   *
   * Bounded by `limit` per player in code rather than in SQL: a per-player
   * `LIMIT` needs a window function or one query each, and the honest size here
   * is a lineup — a dozen players and a season of weeks, which is one small
   * indexed read.
   */
  async weeksFor(playerIds: string[], season: string, limit = 8): Promise<Map<string, StoredUsageWeek[]>> {
    const out = new Map<string, StoredUsageWeek[]>();
    if (playerIds.length === 0) return out;

    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT * FROM player_usage_weeks
            WHERE season = ? AND player_id IN (${holes})
         ORDER BY player_id, week`,
        )
        .bind(season, ...batch)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const week = toUsageWeek(row);
        const list = out.get(week.playerId);
        if (list) list.push(week);
        else out.set(week.playerId, [week]);
      }
    }

    for (const [playerId, weeks] of out) {
      if (weeks.length > limit) out.set(playerId, weeks.slice(-limit));
    }
    return out;
  }

  /**
   * The stored rows an incoming ingest would overwrite, keyed for the diff.
   *
   * Reads only the (player, week) pairs the file actually contains, so the
   * comparison costs one read of roughly the size of the ingest rather than a
   * scan of the season.
   */
  async comparableFor(keys: { playerId: string; week: number }[], season: string): Promise<Map<string, ComparableUsage>> {
    const out = new Map<string, ComparableUsage>();
    if (keys.length === 0) return out;

    const ids = [...new Set(keys.map((k) => k.playerId))];
    const weeks = [...new Set(keys.map((k) => k.week))];
    for (const batch of chunk(ids, Math.max(1, MAX_BOUND_PARAMS - weeks.length - 1))) {
      const idHoles = batch.map(() => '?').join(', ');
      const weekHoles = weeks.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(
          `SELECT player_id, season, week, pass_attempts, carries, targets, receptions,
                  target_share, wopr
             FROM player_usage_weeks
            WHERE season = ? AND player_id IN (${idHoles}) AND week IN (${weekHoles})`,
        )
        .bind(season, ...batch, ...weeks)
        .all<Record<string, unknown>>();
      for (const row of results ?? []) {
        const item: ComparableUsage = {
          playerId: String(row['player_id']),
          season: String(row['season']),
          week: Number(row['week']),
          passAttempts: numberOrNull(row['pass_attempts']),
          carries: numberOrNull(row['carries']),
          targets: numberOrNull(row['targets']),
          receptions: numberOrNull(row['receptions']),
          targetShare: numberOrNull(row['target_share']),
          wopr: numberOrNull(row['wopr']),
        };
        out.set(`${item.playerId}:${item.season}:${item.week}`, item);
      }
    }
    return out;
  }

  /** How many players and weeks the store holds for a season. */
  async coverage(season: string): Promise<{ players: number; weeks: number; latestWeek: number | null; rows: number }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT week) AS weeks,
                MAX(week) AS latest_week, COUNT(*) AS rows_stored
           FROM player_usage_weeks WHERE season = ?`,
      )
      .bind(season)
      .first<Record<string, unknown>>();
    return {
      players: Number(row?.['players'] ?? 0),
      weeks: Number(row?.['weeks'] ?? 0),
      latestWeek: row?.['latest_week'] == null ? null : Number(row['latest_week']),
      rows: Number(row?.['rows_stored'] ?? 0),
    };
  }

  /** Players with at least this many regular-season games stored. */
  async playersWithGames(season: string, games: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
            SELECT player_id FROM player_usage_weeks
             WHERE season = ? AND season_type = 'REG'
          GROUP BY player_id HAVING COUNT(*) >= ?)`,
      )
      .bind(season, Math.max(1, games))
      .first<Record<string, unknown>>();
    return Number(row?.['n'] ?? 0);
  }

  /** How many rows the store holds for a season, for the anomaly guard. */
  async storedCount(season: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM player_usage_weeks WHERE season = ?`)
      .bind(season)
      .first<Record<string, unknown>>();
    return Number(row?.['n'] ?? 0);
  }

  /**
   * The oldest week below `through` that has no stored rows at all.
   *
   * A hole means a stretch when nothing ran, and it matters more here than it
   * does for injuries: the detector reads a *run* of games, so a missing week
   * silently shortens every series that spans it and changes the answer with
   * nothing looking wrong.
   *
   * The scan starts at week 1 rather than at the oldest week stored, which is
   * the one deliberate difference from the injury version. An app first
   * deployed in week 10 has no earlier weeks at all, and treating "before
   * anything we have" as "not a gap" would mean waiting six more weeks for the
   * detector to say anything about anybody. Every week below the file's latest
   * has been played, so every one of them is fillable.
   *
   * Returns null when there is no gap, which is the ordinary case and the one
   * this has to answer cheaply.
   */
  async missingWeekBefore(season: string, through: number): Promise<number | null> {
    if (!Number.isFinite(through) || through <= 1) return null;
    const { results } = await this.db
      .prepare(`SELECT DISTINCT week FROM player_usage_weeks WHERE season = ? AND week <= ? ORDER BY week`)
      .bind(season, through)
      .all<{ week: number }>();
    const present = new Set((results ?? []).map((r) => Number(r.week)));
    if (present.size === 0) return null;
    for (let week = 1; week < through; week++) {
      if (!present.has(week)) return week;
    }
    return null;
  }

  async recordRun(run: UsageSourceRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage_source_runs
           (source, season, week, latest_week, fetched_at, published_at, rows_returned,
            matched_by_id, matched_by_name, unmatched, rows_written, outcome, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.source,
        run.season,
        run.week,
        run.latestWeek,
        run.fetchedAt,
        run.publishedAt,
        run.rowsReturned,
        run.matchedById,
        run.matchedByName,
        run.unmatched,
        run.rowsWritten,
        run.outcome,
        run.note,
      )
      .run();
  }

  async latestRun(): Promise<UsageSourceRun | null> {
    const row = await this.db
      .prepare(`SELECT * FROM usage_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1`)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      source: String(row['source']),
      season: String(row['season']),
      week: row['week'] == null ? null : Number(row['week']),
      latestWeek: row['latest_week'] == null ? null : Number(row['latest_week']),
      fetchedAt: String(row['fetched_at']),
      publishedAt: row['published_at'] == null ? null : String(row['published_at']),
      rowsReturned: Number(row['rows_returned'] ?? 0),
      matchedById: Number(row['matched_by_id'] ?? 0),
      matchedByName: Number(row['matched_by_name'] ?? 0),
      unmatched: Number(row['unmatched'] ?? 0),
      rowsWritten: Number(row['rows_written'] ?? 0),
      outcome: String(row['outcome']) as UsageSourceRun['outcome'],
      note: row['note'] == null ? null : String(row['note']),
    };
  }
}

/**
 * The fingerprint, the lease, the failure counter and the write ledger, against
 * the usage tables. Every mechanism is inherited: `usage_source_state` is
 * column-for-column what `injury_source_state` is, on purpose.
 */
export class UsageSourceRepo extends SourceStateRepo {
  constructor(db: Database) {
    super(db, 'usage_source_state', 'usage_write_budget');
  }
}

function toUsageWeek(row: Record<string, unknown>): StoredUsageWeek {
  const text = (key: string) => (row[key] == null ? null : String(row[key]));
  return {
    playerId: String(row['player_id']),
    season: String(row['season']),
    week: Number(row['week']),
    seasonType: String(row['season_type'] ?? 'REG'),
    team: text('team'),
    position: text('position'),
    passAttempts: numberOrNull(row['pass_attempts']),
    carries: numberOrNull(row['carries']),
    targets: numberOrNull(row['targets']),
    receptions: numberOrNull(row['receptions']),
    targetShare: numberOrNull(row['target_share']),
    wopr: numberOrNull(row['wopr']),
    gsisId: text('gsis_id'),
    source: String(row['source']),
    publishedAt: text('published_at'),
    fetchedAt: String(row['fetched_at']),
  };
}

/** A stored NULL stays null. It means the source was silent, not that it was zero. */
function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
