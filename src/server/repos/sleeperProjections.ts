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
  type PublishedDefenseLine,
  type SleeperScoringKey,
  type SleeperWeeklyProjection,
} from '../../core/sleeper/weeklyProjections.ts';
import { chunk, MAX_BOUND_PARAMS, type Database } from '../db.ts';

/** How many rows go in one statement. Five bound values per row plus the key. */
const ROWS_PER_BATCH = 200;

export interface StoredWeeklyProjection {
  playerId: string;
  publisher: string | null;
  points: Record<SleeperScoringKey, number | null>;
  /** A defence's projected counts. Null for every other position. */
  defense: PublishedDefenseLine | null;
}

export interface WeeklyProjectionFreshness {
  season: string;
  week: number;
  players: number;
  /**
   * How many of those rows carry a defence's projected counts.
   *
   * Separate from `players` because a stored week can be complete by age and
   * still be missing a whole position. The feed was not asked for defences
   * until 10 September 2026, so every week stored before then holds four
   * hundred players and no defences — and the twelve-hour freshness gate would
   * have called that current and declined to refetch for half a day after the
   * fix shipped. See `SleeperProjectionService.refresh`.
   */
  defenses: number;
  /** ISO of the most recent fetch that wrote into this week. */
  fetchedAt: string | null;
  /**
   * How many of `players` that most recent fetch wrote.
   *
   * The table is upserted, never cleared, so a fetch that caught the feed
   * mid-update (30 rows, on Wednesday 7 October 2026) still moves `fetchedAt`
   * to now and leaves the other 376 rows from the day before. Read beside
   * `players` this tells a whole week from a sliver of one.
   */
  latestRows: number;
  /** What the feed called itself, when every stored row agrees. */
  publisher: string | null;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The stored defence line, or null for every row that has none.
 *
 * Unparseable is null rather than an exception. This column fills a blank on a
 * screen, and one malformed row must not be the reason a whole week of
 * projections fails to load — the defence reads as unprojected, which is the
 * state it was in before the column existed.
 */
function toDefenseLine(value: unknown): PublishedDefenseLine | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PublishedDefenseLine> | null;
    if (parsed == null || typeof parsed !== 'object') return null;
    const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    return {
      sacks: count(parsed.sacks),
      interceptions: count(parsed.interceptions),
      fumbleRecoveries: count(parsed.fumbleRecoveries),
      forcedFumbles: count(parsed.forcedFumbles),
      defensiveTds: count(parsed.defensiveTds),
      specialTeamsTds: count(parsed.specialTeamsTds),
      safeties: count(parsed.safeties),
      blockedKicks: count(parsed.blockedKicks),
      pointsAllowed: toNumber(parsed.pointsAllowed),
      yardsAllowed: toNumber(parsed.yardsAllowed),
    };
  } catch {
    return null;
  }
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
               (season, week, player_id, pts_std, pts_half_ppr, pts_ppr, publisher, fetched_at, defense_json)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(season, week, player_id) do update set
               pts_std = excluded.pts_std,
               pts_half_ppr = excluded.pts_half_ppr,
               pts_ppr = excluded.pts_ppr,
               publisher = excluded.publisher,
               fetched_at = excluded.fetched_at,
               defense_json = excluded.defense_json`,
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
            row.defense == null ? null : JSON.stringify(row.defense),
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
        `select player_id, pts_std, pts_half_ppr, pts_ppr, publisher, defense_json
           from sleeper_weekly_projections
          where season = ? and week = ?`,
      )
      .bind(season, week)
      .all<Record<string, unknown>>();
    return toStored(results);
  }

  /**
   * The figures for a few players only.
   *
   * `forWeek` reads the whole feed, which is every player Sleeper publishes
   * (hundreds of rows) to answer a question about a few dozen. This is the same
   * answer through the table's own key, `(season, week, player_id)`, so it reads
   * the rows asked for and no others. The trade check asks about two rosters and
   * a free-agent shortlist, which is where that difference is the whole cost.
   */
  async forPlayers(season: string, week: number, playerIds: readonly string[]): Promise<Map<string, StoredWeeklyProjection>> {
    const out = new Map<string, StoredWeeklyProjection>();
    for (const batch of chunk([...new Set(playerIds)], MAX_BOUND_PARAMS - 2)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(
          `select player_id, pts_std, pts_half_ppr, pts_ppr, publisher, defense_json
             from sleeper_weekly_projections
            where season = ? and week = ? and player_id in (${placeholders})`,
        )
        .bind(season, week, ...batch)
        .all<Record<string, unknown>>();
      for (const [id, row] of toStored(results)) out.set(id, row);
    }
    return out;
  }

  /**
   * The figures for a few players across several weeks, in one statement.
   *
   * For the trade check's stand-in when a player has no number this week:
   * the same keyed read as `forPlayers`, over a short list of earlier weeks
   * at once, so looking back three weeks is one statement and not three.
   */
  async forPlayersInWeeks(
    season: string,
    weeks: readonly number[],
    playerIds: readonly string[],
  ): Promise<Map<number, Map<string, StoredWeeklyProjection>>> {
    const out = new Map<number, Map<string, StoredWeeklyProjection>>();
    const wanted = [...new Set(weeks)].filter((w) => Number.isInteger(w) && w > 0);
    if (wanted.length === 0) return out;
    const weekMarks = wanted.map(() => '?').join(',');
    for (const batch of chunk([...new Set(playerIds)], MAX_BOUND_PARAMS - 1 - wanted.length)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(
          `select week, player_id, pts_std, pts_half_ppr, pts_ppr, publisher, defense_json
             from sleeper_weekly_projections
            where season = ? and week in (${weekMarks}) and player_id in (${placeholders})`,
        )
        .bind(season, ...wanted, ...batch)
        .all<Record<string, unknown>>();
      const byWeek = new Map<number, Record<string, unknown>[]>();
      for (const row of results ?? []) {
        const week = Number(row['week']);
        if (!Number.isInteger(week)) continue;
        const list = byWeek.get(week) ?? [];
        list.push(row);
        byWeek.set(week, list);
      }
      for (const [week, rows] of byWeek) {
        const into = out.get(week) ?? new Map<string, StoredWeeklyProjection>();
        for (const [id, row] of toStored(rows)) into.set(id, row);
        out.set(week, into);
      }
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
    /*
     * Grouped by fetch, so one pass over the week's rows answers both "how much
     * is stored" and "how much did the last fetch write". The same rows the
     * ungrouped count read; a handful of result rows instead of one.
     */
    const { results } = await this.db
      .prepare(
        `select fetched_at,
                count(*) as players,
                sum(case when defense_json is not null then 1 else 0 end) as defenses,
                min(coalesce(publisher, '')) as lo,
                max(coalesce(publisher, '')) as hi
           from sleeper_weekly_projections
          where season = ? and week = ?
          group by fetched_at`,
      )
      .bind(season, week)
      .all<Record<string, unknown>>();

    let players = 0;
    let defenses = 0;
    let fetchedAt: string | null = null;
    let latestRows = 0;
    const los: string[] = [];
    const his: string[] = [];
    for (const row of results ?? []) {
      const n = Number(row['players'] ?? 0) || 0;
      players += n;
      defenses += Number(row['defenses'] ?? 0) || 0;
      const at = row['fetched_at'] == null ? null : String(row['fetched_at']);
      if (at != null && (fetchedAt == null || at > fetchedAt)) {
        fetchedAt = at;
        latestRows = n;
      }
      los.push(String(row['lo'] ?? ''));
      his.push(String(row['hi'] ?? ''));
    }
    const lo = los.length === 0 ? '' : los.reduce((a, b) => (b < a ? b : a));
    const hi = his.length === 0 ? '' : his.reduce((a, b) => (b > a ? b : a));
    return {
      season,
      week,
      players,
      defenses,
      fetchedAt,
      latestRows,
      publisher: lo !== '' && lo === hi ? lo : null,
    };
  }
}

/** What the app expects the feed to call itself, for callers that want to check. */
export const EXPECTED_PUBLISHER = SLEEPER_PROJECTION_PUBLISHER;

function toStored(results: Record<string, unknown>[] | undefined): Map<string, StoredWeeklyProjection> {
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
      defense: toDefenseLine(row['defense_json']),
    });
  }
  return out;
}
