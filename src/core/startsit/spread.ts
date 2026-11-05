/**
 * Safe or upside: how far one player's week can swing (Alex's decision,
 * 5 November 2026; review S3).
 *
 * One shared function, read only by a toss-up's lean (`tossup.ts`): Floor
 * leans to the better bad week, Ceiling to the better good week. It never
 * changes a player's number.
 *
 * In plain English, two readings averaged:
 *
 *  - **His season.** How much his weekly points have bounced around in the
 *    games he played this season, in this league's scoring (the stored row
 *    `sleeper.seasonPoints.<season>`). A player with only a few games is
 *    pulled toward the usual bounce for his position
 *    ({@link SPREAD.priorGames} games' worth of it), so two big weeks do not
 *    make a boom player of anybody.
 *  - **His betting lines this week**, when they are stored. Few catches for
 *    big yards, or a week that leans on a touchdown, swing more than many
 *    short catches.
 *
 * Measured as a share of his week (a receiver's bad or good week is about half
 * his number away), so it scales to this week's number at the moment of the
 * call. No new lookups: everything here is already loaded.
 */

import { POSITION_VOLATILITY, DEFAULT_VOLATILITY } from '../matchup/distribution.ts';
import type { VegasExpectation } from './expectation.ts';

export const SPREAD = {
  /** Games of the position's usual bounce mixed into his own, so a few games do not mislead. */
  priorGames: 4,
  /** Below this many points a game, a share of nothing is noise; the position's bounce stands. */
  minMean: 3,
  /** The betting lines' share of the reading when there are any. */
  propsWeight: 0.5,
  /** Bounds, so neither reading can define a player. */
  minShare: 0.15,
  maxShare: 1.2,
} as const;

export type SpreadBasis = 'season' | 'lines' | 'season and lines' | 'position';

export interface SpreadReading {
  /** His week's ordinary swing as a share of his number: one standard deviation over the mean. */
  share: number;
  /** His own games this season that went into it. */
  games: number;
  basis: SpreadBasis;
}

/** The usual bounce for a position, as a share of the week. */
export function positionShare(position: string): number {
  return POSITION_VOLATILITY[(position ?? '').toUpperCase()] ?? DEFAULT_VOLATILITY;
}

/**
 * The games he played this season, from the stored weekly row.
 *
 * The row has a zero for every week he did not score, which is a bye, a game
 * missed or (rarely) a played game worth exactly nothing. Only weeks with
 * points count; a true zero is left out with the byes, which can only make a
 * boom-or-bust player look a little steadier than he is.
 */
export function gamesPlayed(weeks: readonly number[] | null | undefined): number[] {
  return (weeks ?? []).filter((v) => Number.isFinite(v) && Math.abs(v) >= 0.05);
}

/** His season's swing as a share, shrunk toward his position's. Null with no games. */
function seasonShare(position: string, games: readonly number[]): number | null {
  if (games.length === 0) return null;
  const prior = positionShare(position);
  const mean = games.reduce((a, b) => a + b, 0) / games.length;
  if (mean < SPREAD.minMean || games.length < 2) {
    return prior;
  }
  const variance = games.reduce((a, v) => a + (v - mean) ** 2, 0) / (games.length - 1);
  const own = Math.sqrt(variance) / mean;
  return (games.length * own + SPREAD.priorGames * prior) / (games.length + SPREAD.priorGames);
}

/**
 * His betting lines' swing as a share of what they add up to. Null without a priced week.
 *
 * Each market's own bounce, in fantasy points, added as variances:
 *
 *  - catches and receiving yards together: each catch is worth its point plus
 *    its yards, and a catch's yards vary about as much as their average, so
 *    few long catches swing more than many short ones;
 *  - rushing yards: about eleven yards' worth of variance per yard of line;
 *  - passing yards: a passer's yards vary by about a quarter of his line;
 *  - touchdowns (anytime, or passing): a count, so the variance is the
 *    expected count times the points squared.
 */
export function linesShare(expectation: Pick<VegasExpectation, 'points' | 'contributions'> | null | undefined): number | null {
  const total = expectation?.points;
  if (total == null || !(total >= SPREAD.minMean)) return null;
  const by = new Map(expectation!.contributions.map((c) => [c.market, c] as const));
  const meanOf = (market: string): number | null => {
    const c = by.get(market as never);
    const v = c?.mean ?? c?.line ?? null;
    return v != null && Number.isFinite(v) && v > 0 ? v : null;
  };
  const per = (market: string, mean: number | null): number => {
    const c = by.get(market as never);
    return c && mean ? c.points / mean : 0;
  };

  let variance = 0;
  let any = false;

  const catches = meanOf('receptions');
  const recYards = meanOf('receiving_yards');
  if (recYards != null) {
    const n = catches ?? recYards / 11;
    const perCatch = per('receptions', catches);
    const perYard = per('receiving_yards', recYards);
    const yardsPerCatch = recYards / n;
    variance += n * (perCatch ** 2 + 2 * perCatch * perYard * yardsPerCatch + 2 * (perYard * yardsPerCatch) ** 2);
    any = true;
  } else if (catches != null) {
    variance += catches * per('receptions', catches) ** 2;
    any = true;
  }

  const rush = meanOf('rush_yards');
  if (rush != null) {
    variance += rush * 11.4 * per('rush_yards', rush) ** 2;
    any = true;
  }

  const pass = meanOf('pass_yards');
  if (pass != null) {
    variance += (0.28 * pass * per('pass_yards', pass)) ** 2;
    any = true;
  }

  const passTds = meanOf('pass_tds');
  if (passTds != null) {
    variance += passTds * per('pass_tds', passTds) ** 2;
    any = true;
  }

  const td = by.get('anytime_td');
  const chance = td?.probability ?? null;
  if (td && chance != null && chance > 0 && chance < 1) {
    const expected = -Math.log(1 - chance);
    const perTd = td.points / chance;
    variance += expected * perTd ** 2;
    any = true;
  }

  if (!any) return null;
  return Math.sqrt(variance) / total;
}

/**
 * One player's reading. Always answers: with nothing of his own, it is his
 * position's usual bounce.
 */
export function readSpread(opts: {
  position: string;
  /** This season's points by week, week 1 first, zero where he did not score. */
  seasonPoints?: readonly number[] | null;
  expectation?: Pick<VegasExpectation, 'points' | 'contributions'> | null;
}): SpreadReading {
  const games = gamesPlayed(opts.seasonPoints);
  const season = seasonShare(opts.position, games);
  const lines = linesShare(opts.expectation);
  const clamp = (v: number) => Math.round(Math.min(SPREAD.maxShare, Math.max(SPREAD.minShare, v)) * 1000) / 1000;
  if (season != null && lines != null) {
    return { share: clamp((1 - SPREAD.propsWeight) * season + SPREAD.propsWeight * lines), games: games.length, basis: 'season and lines' };
  }
  if (season != null) return { share: clamp(season), games: games.length, basis: 'season' };
  if (lines != null) {
    /* No season of his own: the lines, still shrunk halfway to the position. */
    return { share: clamp(0.5 * positionShare(opts.position) + 0.5 * lines), games: 0, basis: 'lines' };
  }
  return { share: clamp(positionShare(opts.position)), games: 0, basis: 'position' };
}

/** His swing in points this week: the share times his number. Zero for a number at or below zero. */
export function spreadPoints(reading: SpreadReading | null | undefined, points: number, position: string): number {
  const share = reading?.share ?? positionShare(position);
  return Math.max(0, points) * share;
}
