/**
 * A player's points per game for the rest of the season, and where the number
 * came from.
 *
 * ## It is the Start/Sit number, not a second scorer
 *
 * The rate is the same decision number Start/Sit ranks lineups on
 * (`decisionPoints`): the Vegas market where it is complete, Sleeper's
 * published week where it is not, and then a capped group of nudges (news,
 * usage, matchup and the rest) held to 10% of that base by
 * `adjustmentBudget.ts`. This module adds nothing to it. In particular it adds
 * **no news or research-tally weighting of its own**: the engine's own capped
 * news lines are the whole of the 7-day and 30-day tally's say, so projections
 * stay about 90% of a value and soft factors stay a small nudge, exactly as in
 * Start/Sit after #330.
 *
 * One thing is taken out: the availability charge. Start/Sit subtracts points
 * for an injury because it answers "this Sunday". Over the season the injury is
 * counted as missing weeks instead (`availability.ts`), so leaving the charge
 * in would count the same injury twice.
 *
 * ## The ladder, and the rungs it refuses
 *
 *  1. `market`: a complete Vegas week. The strongest basis.
 *  2. `published`: Sleeper's published week for a player the market has not
 *     fully priced. Allowed here by this round's brief; it was display-only
 *     before.
 *  3. `season_line`: the market's season-long totals divided by the games in a
 *     season, used only when this week's number is not a real read of him: he
 *     is on a bye, he is ruled out, or nothing is priced or published.
 *  4. `none`: nothing trustworthy. His rate is null, he is never valued at
 *     zero, and a trade that moves him gets no verdict.
 *
 * A partial market (a book that posted one of four lines) is not a rung. It is
 * a fraction of a week, and treating it as a forecast is the mistake
 * `projection.ts` documents at length.
 */

import { decisionPoints } from '../startsit/decisionPoints.ts';
import type { StartSitEvaluation } from '../startsit/engine.ts';
import type { Designation } from '../injury/model.ts';
import { isOutNow, weeklyAvailability } from './availability.ts';

export type RateBasis = 'market' | 'published' | 'season_line' | 'none';

export const RATE_BASIS_LABEL: Record<RateBasis, string> = {
  market: 'Vegas week',
  published: 'Sleeper projection',
  season_line: 'season line',
  none: 'no projection',
};

/**
 * A ruled-out player's published week this small is a zero for the week, not
 * a read of him. Below it the season line is used when there is one.
 */
const OUT_PLAYER_FLOOR = 1;

export interface PlayerRate {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Points per game for the rest of the season, or null when nothing supports one. */
  rate: number | null;
  basis: RateBasis;
  /** One clause on a basis that is not the plain market, or on why there is none. */
  rateNote: string | null;
  designation: Designation;
  /** Games expected, bye and injury taken out. */
  games: number;
  /** Per-week availability, in the horizon's week order. */
  weekly: number[];
  /** The injury assumption used, when there is one. */
  injuryNote: string | null;
  byeWeek: number | null;
  /** Whether his bye is known at all. False when the schedule has no rows for his club. */
  byeKnown: boolean;
  byeInside: boolean;
  onReserve: boolean;
}

function statusPoints(evaluation: StartSitEvaluation): number {
  const status = evaluation.components.find((c) => c.key === 'status');
  return status && !status.unknown ? status.value : 0;
}

interface WeekRead {
  weekRate: number | null;
  weekBasis: RateBasis;
  out: boolean;
  /** This week's number is not a read of him: a bye, or a ruled-out player's zero. */
  unrepresentative: boolean;
  partial: boolean;
}

function readWeek(args: {
  evaluation: StartSitEvaluation;
  published?: ReadonlyMap<string, number>;
  byeThisWeek: boolean;
}): WeekRead {
  const { evaluation } = args;
  const decision = decisionPoints(evaluation, args.published);
  const out = isOutNow(evaluation.injury.designation) || evaluation.ruledOut;
  const weekOk = decision != null && (decision.basis === 'market' || decision.basis === 'published');
  const weekRate = weekOk ? Math.max(0, decision.points - statusPoints(evaluation)) : null;
  /*
   * A bye has no game to price, and a ruled-out player's week is a zero
   * published for a game he will not play. Neither is a read of him.
   */
  return {
    weekRate,
    weekBasis: decision?.basis === 'published' ? 'published' : 'market',
    out,
    unrepresentative: args.byeThisWeek || (out && (weekRate == null || weekRate < OUT_PLAYER_FLOOR)),
    partial: decision?.basis === 'partial',
  };
}

/**
 * Whether this player's rate has to come from the season line.
 *
 * Asked before the season lines are read, so the read can be limited to the
 * players who need one instead of everybody on two rosters.
 */
export function needsSeasonLine(args: {
  evaluation: StartSitEvaluation;
  published?: ReadonlyMap<string, number>;
  byeThisWeek: boolean;
}): boolean {
  const week = readWeek(args);
  return week.weekRate == null || week.unrepresentative;
}

export function resolveRate(args: {
  evaluation: StartSitEvaluation;
  published?: ReadonlyMap<string, number>;
  /** The market's season total over a season of games, in this league's scoring. */
  seasonLine: number | null;
  /** True when this week's number is not a read of him (bye week). */
  byeThisWeek: boolean;
}): { rate: number | null; basis: RateBasis; note: string | null } {
  const { seasonLine } = args;
  const week = readWeek(args);
  const season = seasonLine != null && Number.isFinite(seasonLine) && seasonLine > 0 ? seasonLine : null;

  if (week.weekRate != null && !week.unrepresentative) {
    return {
      rate: round2(week.weekRate),
      basis: week.weekBasis,
      note:
        week.weekBasis === 'published'
          ? 'no complete Vegas week, so Sleeper\u2019s published projection is the base'
          : null,
    };
  }
  if (season != null) {
    const why = args.byeThisWeek
      ? 'on a bye this week, so this week has no number for him'
      : week.out
        ? 'out this week, so this week\u2019s number is not a read of him'
        : 'no complete Vegas week and nothing published for him';
    return { rate: round2(season), basis: 'season_line', note: `${why}; valued on the market\u2019s season line` };
  }
  if (week.weekRate != null && week.weekRate >= OUT_PLAYER_FLOOR) {
    // A bye week with a real published figure and no season line: it is the only
    // number there is, and it says so.
    return { rate: round2(week.weekRate), basis: week.weekBasis, note: 'this week\u2019s number is the only one available' };
  }
  const reason = args.byeThisWeek
    ? 'on a bye and no season line is stored for him'
    : week.out
      ? 'ruled out and no season line is stored for him'
      : week.partial
        ? 'only part of his Vegas week is priced and nothing else covers him'
        : 'no market, no published projection and no season line';
  return { rate: null, basis: 'none', note: reason };
}

/** Everything about one player the trade model needs, built once. */
export function buildPlayerRate(args: {
  evaluation: StartSitEvaluation;
  published?: ReadonlyMap<string, number>;
  seasonLine: number | null;
  weeks: readonly number[];
  byeWeek: number | null;
  byeKnown: boolean;
  onReserve?: boolean;
}): PlayerRate {
  const { evaluation } = args;
  const designation = evaluation.injury.designation;
  const byeThisWeek = args.byeWeek != null && args.weeks.length > 0 && args.byeWeek === args.weeks[0];
  const resolved = resolveRate({
    evaluation,
    ...(args.published ? { published: args.published } : {}),
    seasonLine: args.seasonLine,
    byeThisWeek,
  });
  const availability = weeklyAvailability({
    designation,
    onReserve: args.onReserve === true,
    weeks: args.weeks,
    byeWeek: args.byeWeek,
  });
  return {
    playerId: evaluation.playerId,
    name: evaluation.name,
    position: evaluation.position,
    team: evaluation.team,
    rate: resolved.rate,
    basis: resolved.basis,
    rateNote: resolved.note,
    designation,
    games: round2(availability.games),
    weekly: availability.weekly,
    injuryNote: availability.note,
    byeWeek: args.byeWeek,
    byeKnown: args.byeKnown,
    byeInside: availability.byeInside,
    onReserve: args.onReserve === true,
  };
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
