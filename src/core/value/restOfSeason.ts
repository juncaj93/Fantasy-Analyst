/**
 * A player's value for the rest of the season, and how much each remaining
 * week counts. The one definition the trade tools and Waivers share (review
 * T1, T9, November 2026; Waivers since round 6, W4 and W9).
 *
 * ## The problem it replaces
 *
 * A player's trade rate used to be this week's number carried to week 17. One
 * matchup, one shootout total or one injury-boosted role set nine weeks of
 * value: the November probe had Bryce Young starting over Jordan Love 10 weeks
 * of 10 while Love averaged 23.6 a game and Young 16.9.
 *
 * ## The rate, in plain English
 *
 * Three quarters of it is what he is projected to score: this week's number
 * (the betting line, or Sleeper's week) averaged with Sleeper's projections for
 * the next three weeks, skipping his bye. The other quarter is what he has
 * actually scored per game this season in this league's scoring, counting only
 * games he played. With fewer than {@link REST_OF_SEASON.fullAt} games played,
 * his projection counts for more, so two games cannot outweigh a role.
 *
 * Why 75/25: it was 50/50 until Round 17. In October the season average and
 * this week's number predicted later weeks equally well (error 4.18 against
 * 4.18 on weeks 3 and 4; `docs/AUDIT_2026-10.md`, T2). The Round 16 backtest
 * (weeks 3 to 8 against what players then scored, `docs/backtest/`) found more
 * projection weight misses less in every version it ran: 0.11 to 0.26 points a
 * game less per player at 75/25 than at 50/50, beyond the noise. Season
 * average alone was clearly worse. Alex chose 75/25 on 11 November 2026.
 *
 * ## The weeks
 *
 * The weeks he plays come from `availability.ts` (byes, injuries, IR time).
 * Each remaining week counts once, and a playoff week counts
 * {@link REST_OF_SEASON.weights}.playoff times: Alex is a contender, and a
 * playoff week is win or go home.
 *
 * Pure.
 */

import type { TradeHorizon } from '../tradeValue/weeks.ts';

export const REST_OF_SEASON = {
  /**
   * Share of the rate from what he has actually scored (his season average),
   * once he has played {@link fullAt} games. The rest, 75 percent, is his
   * projection. The one setting for the blend; nothing else restates it.
   */
  productionShare: 0.25,
  /** Games played before his season average carries its full share. */
  fullAt: 4,
  /** Fewest games played for a season average to stand on its own, with no projection at all. */
  productionOnlyMin: 2,
  /** Weeks of Sleeper's projection read after this one. */
  aheadWeeks: 3,
  /**
   * How much each remaining week counts. A playoff week 1.5 times a regular
   * one: worth more to a contender, and further away, so less certain.
   */
  weights: { regular: 1, playoff: 1.5 },
} as const;

/** One weight per horizon week, in the horizon's order. */
export function seasonWeights(horizon: Pick<TradeHorizon, 'weeks' | 'playoffWeeks'>): number[] {
  const playoff = new Set(horizon.playoffWeeks);
  return horizon.weeks.map((week) => (playoff.has(week) ? REST_OF_SEASON.weights.playoff : REST_OF_SEASON.weights.regular));
}

/** The sum of the weights: how many regular weeks the rest of the season is worth. */
export function totalWeight(horizon: Pick<TradeHorizon, 'weeks' | 'playoffWeeks'>): number {
  return seasonWeights(horizon).reduce((a, b) => a + b, 0);
}

export interface BlendedRate {
  /** Points per game for the rest of the season, or null when nothing supports one. */
  rate: number | null;
  /** The average of his projections, or null with none. */
  projection: number | null;
  /** How many weekly projections went into it. */
  projectionWeeks: number;
  /** His points per game played this season, or null with no game. */
  production: number | null;
  games: number;
  /** The share of the rate taken from `production`. */
  productionShare: number;
}

/**
 * Three quarters projection, one quarter production, as the header says.
 *
 * `projections` are his healthy weekly projections (this week and the weeks
 * ahead), already cleared of byes and of zeros published for games he will
 * miss. `production` is his points in each game he played this season.
 */
export function blendRate(args: { projections: readonly number[]; production: readonly number[] }): BlendedRate {
  const projections = args.projections.filter((v) => Number.isFinite(v));
  const production = args.production.filter((v) => Number.isFinite(v));
  const projection = projections.length > 0 ? mean(projections) : null;
  const games = production.length;
  const perGame = games > 0 ? mean(production) : null;

  if (projection == null) {
    const alone = perGame != null && games >= REST_OF_SEASON.productionOnlyMin;
    return {
      rate: alone ? round2(Math.max(0, perGame)) : null,
      projection: null,
      projectionWeeks: 0,
      production: perGame == null ? null : round2(perGame),
      games,
      productionShare: alone ? 1 : 0,
    };
  }
  const share = perGame == null ? 0 : REST_OF_SEASON.productionShare * Math.min(1, games / REST_OF_SEASON.fullAt);
  const rate = (1 - share) * projection + share * (perGame ?? 0);
  return {
    rate: round2(Math.max(0, rate)),
    projection: round2(projection),
    projectionWeeks: projections.length,
    production: perGame == null ? null : round2(perGame),
    games,
    productionShare: round2(share),
  };
}

/**
 * The projections a rest-of-season rate averages, and the blend itself.
 *
 * `thisWeek` is this week's number and whether it is a real read of him (not
 * a bye, not a ruled-out zero, not an earlier week standing in). `ahead` is
 * Sleeper's projection for each later week, in this league's scoring. A later
 * week counts only inside `weeks`, never on his bye and never under `floor` (a
 * zero published for a game he will miss). A stand-in for this week is used
 * only when no later week is published for him.
 *
 * Trade values (`tradeValue/rate.ts`) and the waiver tiers call this one
 * function, so a player has the same season value on both screens.
 */
export function restOfSeasonBlend(args: {
  thisWeek: { rate: number | null; fromThisWeek: boolean };
  ahead: ReadonlyMap<number, number> | null | undefined;
  production: readonly number[] | null | undefined;
  /** The horizon's weeks, this week first. */
  weeks: readonly number[];
  byeWeek: number | null;
  floor: number;
}): { blend: BlendedRate; laterWeeks: number } {
  const later: number[] = [];
  for (const [week, points] of args.ahead ?? []) {
    if (week <= (args.weeks[0] ?? 0) || !args.weeks.includes(week) || week === args.byeWeek) continue;
    if (Number.isFinite(points) && points >= args.floor) later.push(points);
  }
  const { rate, fromThisWeek } = args.thisWeek;
  const projections = fromThisWeek && rate != null ? [rate, ...later] : later.length > 0 ? later : rate != null ? [rate] : [];
  return { blend: blendRate({ projections, production: args.production ?? [] }), laterWeeks: later.length };
}

/** Positions whose season average is read. A defence and a kicker keep their weekly number. */
export const PRODUCTION_POSITIONS: ReadonlySet<string> = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * His points in each game he played this season, oldest first.
 *
 * Points are the league's own (`sleeper.seasonPoints.<season>`, every stat
 * times this league's value for it). A week counts as played when the stored
 * usage shows him on the field or the league scored him; a bye or a week out
 * hurt is neither, so it is not a zero in his average.
 */
export function productionGames(args: {
  /** League points by week, index 0 is week 1. Null when the season row is not stored. */
  leaguePoints: readonly number[] | null | undefined;
  /** The last week the season row covers. */
  through: number;
  /** Weeks the usage store has him playing, regular season. */
  playedWeeks: ReadonlySet<number>;
}): number[] {
  const points = args.leaguePoints;
  if (!points || args.through < 1) return [];
  const out: number[] = [];
  for (let week = 1; week <= args.through; week++) {
    const value = points[week - 1];
    const scored = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (scored !== 0 || args.playedWeeks.has(week)) out.push(scored);
  }
  return out;
}

/** The weeks the usage store has him on the field, regular season only. */
export function playedWeeksOf(
  weeks: readonly {
    week: number;
    seasonType?: string | null;
    passAttempts?: number | null;
    carries?: number | null;
    targets?: number | null;
    receptions?: number | null;
  }[]
    | null
    | undefined,
): Set<number> {
  const out = new Set<number>();
  for (const w of weeks ?? []) {
    if ((w.seasonType ?? 'REG').toUpperCase() !== 'REG') continue;
    /* A row with anything recorded is a game he played, the rule `arbitrage.ts` keeps. */
    if ([w.passAttempts, w.carries, w.targets, w.receptions].some((v) => v != null)) out.add(w.week);
  }
  return out;
}

/**
 * His expected points in an average remaining week, a playoff week counted at
 * its weight: the rate times the share of the weighted weeks he plays. The
 * per-week number the trade ideas search ranks lineups on.
 */
export function perWeekValue(rate: number, weekly: readonly number[], weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0) || weekly.length === 0) return rate;
  const played = weekly.reduce((sum, share, i) => sum + share * (weights[i] ?? 1), 0);
  return round2((rate * played) / total);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
