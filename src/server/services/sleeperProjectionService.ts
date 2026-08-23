/**
 * Keeping one week of Rotowire's published projections in the database.
 *
 * The narrowest service in this codebase, on purpose. It fetches a week, stores
 * what it can parse, and answers "what is published for these players, in this
 * league's scoring". It holds no opinion about whether any of it should be
 * shown; `core/startsit/projection.ts` owns that, and this file would be wrong
 * to duplicate the rule.
 *
 * ## Why it is gated by age rather than by an event
 *
 * Rotowire revises through the week — a Wednesday number is not a Sunday number
 * — so there is no single moment this becomes correct and stays correct. A
 * maximum age is the honest shape for that: the crons offer a refresh, the
 * service takes it if what it holds is older than {@link MAX_AGE_HOURS}, and
 * declines cheaply otherwise. One indexed read is the cost of declining.
 *
 * ## Why a failure is silent
 *
 * This is a fallback for a column that was already empty. If the fetch fails,
 * the screen shows exactly what it showed before this existed, and the one thing
 * that must never happen — a feed for a nicety taking down the feeds a lineup
 * depends on — is prevented by the caller catching separately and by this never
 * throwing on a bad response.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { ScoringProfile } from '../../core/sleeper/scoring.ts';
import {
  parseSleeperWeeklyProjections,
  sleeperScoringKey,
  type SleeperWeeklyProjection,
} from '../../core/sleeper/weeklyProjections.ts';
import { SleeperProjectionsRepo, type WeeklyProjectionFreshness } from '../repos/sleeperProjections.ts';
import type { Database } from '../db.ts';

/**
 * How stale a stored week may be before a refresh is worth making.
 *
 * Twelve hours puts the two weekend crons — Saturday 23:00 and Sunday 15:00 UTC
 * — both inside their own window, so each of them actually refetches, while a
 * deployment that ticks more often than that does not spend a request learning
 * what it already knows.
 */
export const MAX_AGE_HOURS = 12;

export interface ProjectionRefreshReport {
  /** `fetched`, `current`, `unavailable` — the same vocabulary the other feeds use. */
  outcome: 'fetched' | 'current' | 'unavailable';
  season: string;
  week: number;
  /** Rows written. Zero on every outcome but `fetched`. */
  rows: number;
  /** One clause, safe to show a user. Null when there is nothing worth saying. */
  detail: string | null;
}

export class SleeperProjectionService {
  private readonly repo: SleeperProjectionsRepo;

  constructor(
    db: Database,
    private readonly sleeper: SleeperClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repo = new SleeperProjectionsRepo(db);
  }

  freshness(season: string, week: number): Promise<WeeklyProjectionFreshness> {
    return this.repo.freshness(season, week);
  }

  /**
   * Fetch and store one week, unless what is held is young enough.
   *
   * A week outside the regular season is declined without a request: the feed is
   * asked with `season_type=regular`, and weeks that do not exist in that type
   * answer with nothing at a cost.
   */
  async refresh(season: string, week: number, opts: { force?: boolean } = {}): Promise<ProjectionRefreshReport> {
    const base = { season, week, rows: 0 } as const;
    if (!season || !Number.isFinite(week) || week < 1) {
      return { ...base, outcome: 'unavailable', detail: 'no regular-season week to ask about' };
    }

    if (!opts.force) {
      const held = await this.repo.freshness(season, week);
      const ageHours = held.fetchedAt ? (this.now().getTime() - Date.parse(held.fetchedAt)) / 3_600_000 : null;
      if (held.players > 0 && ageHours != null && Number.isFinite(ageHours) && ageHours < MAX_AGE_HOURS) {
        return { ...base, outcome: 'current', detail: `${held.players} player(s), refreshed within the day` };
      }
    }

    let rows: SleeperWeeklyProjection[];
    try {
      rows = parseSleeperWeeklyProjections(await this.sleeper.getWeeklyProjections(season, week));
    } catch (err) {
      return {
        ...base,
        outcome: 'unavailable',
        detail: `published projections could not be read (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    if (rows.length === 0) {
      return { ...base, outcome: 'unavailable', detail: 'nothing published for this week yet' };
    }

    const written = await this.repo.save(season, week, rows, this.now().toISOString());
    return { season, week, outcome: 'fetched', rows: written, detail: `${written} player(s) published` };
  }

  /**
   * What is published for these players, in this league's scoring.
   *
   * Returns points only — the caller is handed a number it may show and nothing
   * that would let it mistake the number for this app's own. A league whose
   * scoring does not match any published total gets an empty map, which is the
   * same thing as no fallback and renders as `—`; see `sleeperScoringKey`.
   *
   * `positionOf` exists for the one case where the answer is per-player rather
   * than per-league: a tight-end premium leaves the published totals correct for
   * everybody except tight ends.
   */
  async publishedFor(opts: {
    season: string;
    week: number;
    playerIds: readonly string[];
    profile: ScoringProfile;
    positionOf?: (playerId: string) => string | null | undefined;
  }): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (opts.playerIds.length === 0) return out;

    const stored = await this.repo.forWeek(opts.season, opts.week);
    if (stored.size === 0) return out;

    for (const playerId of opts.playerIds) {
      const row = stored.get(playerId);
      if (!row) continue;
      const key = sleeperScoringKey(opts.profile, opts.positionOf?.(playerId) ?? null);
      if (!key) continue;
      const points = row.points[key];
      if (points == null) continue;
      out.set(playerId, points);
    }
    return out;
  }
}
