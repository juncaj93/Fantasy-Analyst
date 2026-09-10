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
  scorePublishedDefense,
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
      /*
       * Young *and* whole. Age alone was not enough.
       *
       * The feed was not asked for defences until 10 September 2026, so the
       * week already in the database when that shipped was hours old, complete
       * by every measure this gate had, and missing all thirty-two of them —
       * which would have left the defence on Team showing the same dash the fix
       * was for until the stored week aged past twelve hours. A week with no
       * defence rows in it is a week fetched under the old question, whatever
       * its timestamp says, and is refetched.
       *
       * The cost of being wrong about this is bounded and small. Only the crons
       * and the Refresh tap reach here, both on a clock, so a week the feed
       * genuinely publishes no defences for costs one extra fetch per tick —
       * four hundred upserts on a table that holds one week — and cannot loop.
       */
      const whole = held.players > 0 && held.defenses > 0;
      if (whole && ageHours != null && Number.isFinite(ageHours) && ageHours < MAX_AGE_HOURS) {
        return { ...base, outcome: 'current', detail: `${held.players} player(s), refreshed within the day` };
      }
    }

    let rows: SleeperWeeklyProjection[];
    try {
      rows = parseSleeperWeeklyProjections(await this.sleeper.getWeeklyProjections(season, week));
    } catch (err) {
      /*
       * The exception is logged; it is not the `detail`.
       *
       * `detail` is documented directly above as one clause safe to show a
       * user, and this branch was interpolating whatever the transport threw —
       * which is the request URL on a Sleeper failure, and would be whatever a
       * future client chose to put in a message. That value now reaches a
       * support surface and a support snapshot through the cron run record, so
       * "safe to show a user" has to be true rather than intended. The
       * operator's copy goes to the log, where a user cannot read it.
       */
      console.error('published projection fetch failed', err);
      return { ...base, outcome: 'unavailable', detail: 'published projections could not be read' };
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
   * `positionOf` is what makes the answer per-player rather than per-league, and
   * a caller that omits it is not being cautious, it is being refused. An
   * unknown position is checked against every setting the feed assumes, so in a
   * league that has changed any one of them — six-point passing touchdowns, say
   * — *every* player comes back with no fallback. That is what emptied the
   * opponent's column on Matchup in production on 10 September 2026: the source
   * bag there passed no positions on purpose, and the league pays six for a
   * passing touchdown, so a rule about quarterbacks silenced the whole feed.
   * Two positions are per-player rather than per-league in their own right: a
   * tight-end premium leaves the totals correct for everybody but tight ends,
   * and a defence reads no total at all.
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
      const position = opts.positionOf?.(playerId) ?? null;

      /*
       * A defence is computed, not quoted.
       *
       * `sleeperScoringKey` answers null for a defence in every league, because
       * the three published totals are somebody else's defensive rules applied
       * to somebody else's table. What is quotable is the projected stat line
       * beside them, scored here under this league's own settings — so a league
       * paying nothing for a shutout and a league paying ten both get a number
       * that is right for them. See `core/sleeper/weeklyProjections.ts`.
       */
      const pos = String(position ?? '').trim().toUpperCase();
      if (pos === 'DEF' || pos === 'DST') {
        if (!row.defense) continue;
        const points = scorePublishedDefense(row.defense, opts.profile.dst);
        if (points == null) continue;
        out.set(playerId, points);
        continue;
      }

      const key = sleeperScoringKey(opts.profile, position);
      if (!key) continue;
      const points = row.points[key];
      if (points == null) continue;
      out.set(playerId, points);
    }
    return out;
  }
}
