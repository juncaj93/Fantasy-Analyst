/**
 * From a prop line to the number of yards, catches or touchdowns a player
 * should average.
 *
 * ## Why the line is not the answer on its own
 *
 * A book sets an over/under where it expects roughly half the money on each
 * side, which puts the line near the **median** outcome, not the average. For
 * anything that cannot go far below zero but can go a long way above it (a
 * receiver's yards, a back's carries into a long run) the average sits above
 * the median, and a fantasy score is an average. Before October 2026 the line
 * was multiplied straight into points, which read every player at his median.
 *
 * Three steps, each one small and each one switchable so the backtest can
 * measure it on its own (`ConversionRules`):
 *
 *  1. **Take the cut out of the prices.** `-125 / +105` is not 55.6% / 48.8%;
 *     the two add to more than 100% because the book keeps a margin. Divided
 *     through, it is 53.2% / 46.8%: the over is the more likely side, so the
 *     median is a little above the line.
 *  2. **Move from the median to the average.** Yardage is modelled as a
 *     lognormal with a fixed spread per market (`LOG_SPREAD`), which turns
 *     "the line, and the chance of going over it" into a mean. Catches and
 *     passing touchdowns are counts, so they use a Poisson instead: the rate
 *     whose chance of clearing the line is the de-vigged over price *is* the
 *     average.
 *  3. **Touchdowns as a rate.** An anytime-touchdown price is the chance of at
 *     least one. A player at 40% averages about 0.51 touchdowns, not 0.40,
 *     because some of those weeks have two. Same Poisson.
 *
 * Every step is capped (`CAPS`) so a strange price cannot move a line far,
 * and a market with no prices on it keeps its line exactly as quoted: there
 * is nothing to de-vig and no skew to read.
 *
 * Pure. No network, no clock.
 */

import type { MarketKey } from '../vegas/types.ts';
import { americanToProbability } from '../vegas/normalize.ts';
import { anytimeChance } from './touchdownLine.ts';

/** Which of the three steps are on. The backtest switches them one at a time. */
export interface ConversionRules {
  devig: boolean;
  skew: boolean;
  tdRate: boolean;
}

/** The method before October 2026: the line, multiplied by the scoring. */
export const LINE_AS_MEDIAN: ConversionRules = { devig: false, skew: false, tdRate: false };

/**
 * The log-scale spread of a game's outcome per yardage market.
 *
 * Deliberately moderate. A pure lognormal fitted to receivers' weekly yards
 * has a spread nearer 0.6, which would add almost a fifth to every receiving
 * line; books also shade popular overs upward, so the line already sits a
 * little above the true median and the full correction would overshoot. These
 * values give an average about 2% above the line for passing yards, 5% for
 * rushing and 7% for receiving when the prices are even.
 */
export const LOG_SPREAD: Record<'pass_yards' | 'rush_yards' | 'receiving_yards', number> = {
  pass_yards: 0.2,
  rush_yards: 0.31,
  receiving_yards: 0.37,
};

export const CAPS = {
  /** The de-vigged over chance is held inside this band before it is used. */
  minOver: 0.2,
  maxOver: 0.8,
  /** The converted average may sit this far from the line, as a ratio. */
  minRatio: 0.85,
  maxRatio: 1.3,
  /** Expected touchdowns from an anytime price, at most. */
  maxTdRate: 1.6,
  /**
   * A one-sided touchdown price still carries the book's margin. Two-way
   * anytime markets run 5 to 10% over 100%; the middle of that comes out.
   */
  oneSidedOverround: 1.07,
} as const;

/** The chance of the over with the margin taken out, or null with no prices. */
export function overChance(overPrice: number | null, underPrice: number | null): number | null {
  const over = americanToProbability(overPrice);
  const under = americanToProbability(underPrice);
  if (over == null || under == null) return null;
  const total = over + under;
  if (!(total > 0)) return null;
  return clamp(over / total, CAPS.minOver, CAPS.maxOver);
}

export interface ConvertedLine {
  /** What the market is expected to average, in its own unit. */
  mean: number;
  /** The de-vigged chance of the over, when prices were there to read. */
  overChance: number | null;
  /** Which steps actually changed the number. */
  steps: ('devig' | 'skew' | 'td_rate')[];
}

/**
 * One market's average, from its line and prices.
 *
 * `line` is the consensus over/under. For `anytime_td` pass the any-touchdown
 * probability through `tdProbability` and `line` may be the quoted threshold.
 */
export function convertLine(
  market: MarketKey,
  line: number | null,
  prices: { overPrice: number | null; underPrice: number | null },
  rules: ConversionRules,
): ConvertedLine | null {
  if (line == null || !Number.isFinite(line)) return null;
  if (line <= 0) return { mean: Math.max(0, line), overChance: null, steps: [] };
  const q = rules.devig ? overChance(prices.overPrice, prices.underPrice) : null;

  switch (market) {
    case 'pass_yards':
    case 'rush_yards':
    case 'receiving_yards': {
      const s = LOG_SPREAD[market];
      /*
       * ln(median) sits `s * z` above ln(line), where z is the standard normal
       * quantile of the over chance; the mean of a lognormal is its median
       * times exp(s^2 / 2). With neither step on this returns the line.
       */
      const z = q == null ? 0 : inverseNormal(q);
      const medianRatio = Math.exp(s * z);
      const meanRatio = rules.skew ? medianRatio * Math.exp((s * s) / 2) : medianRatio;
      const ratio = clamp(meanRatio, CAPS.minRatio, CAPS.maxRatio);
      const steps: ConvertedLine['steps'] = [];
      if (q != null && Math.abs(z) > 1e-9) steps.push('devig');
      if (rules.skew) steps.push('skew');
      return { mean: line * ratio, overChance: q, steps };
    }
    case 'receptions':
    case 'pass_tds': {
      /*
       * A count. The Poisson rate whose chance of clearing the line equals the
       * over chance is the average; with no prices the over is taken as even,
       * which is the definition of a line. Without the skew step the line is
       * returned unchanged, so the two switches stay independent.
       */
      if (!rules.skew) {
        if (q == null) return { mean: line, overChance: null, steps: [] };
        // De-vig alone: the median moves, measured on the same Poisson.
        const rate = rateFor(line, q);
        const evenRate = rateFor(line, 0.5);
        const ratio = clamp(rate / evenRate, CAPS.minRatio, CAPS.maxRatio);
        return { mean: line * ratio, overChance: q, steps: ['devig'] };
      }
      const rate = rateFor(line, q ?? 0.5);
      const ratio = clamp(rate / line, CAPS.minRatio, CAPS.maxRatio);
      const steps: ConvertedLine['steps'] = q == null ? ['skew'] : ['devig', 'skew'];
      return { mean: line * ratio, overChance: q, steps };
    }
    case 'anytime_td':
      return null;
  }
}

/**
 * The line whose converted average is `mean`, at even prices.
 *
 * The inverse of {@link convertLine} for a yardage market with no lean in the
 * prices, which is what a fixture needs to land a player on a chosen number.
 */
export function lineForMean(
  market: 'pass_yards' | 'rush_yards' | 'receiving_yards',
  mean: number,
  rules: ConversionRules,
): number {
  const s = LOG_SPREAD[market];
  const ratio = rules.skew ? clamp(Math.exp((s * s) / 2), CAPS.minRatio, CAPS.maxRatio) : 1;
  return mean / ratio;
}

/**
 * Expected touchdowns from an anytime (or "two or more") price.
 *
 * `impliedProbability` is what the consensus stored: de-vigged when both sides
 * were quoted, the raw over chance when only one was. `twoSided` says which,
 * so a one-sided price can have the margin taken out here.
 */
export function touchdownRate(
  line: number | null,
  impliedProbability: number | null,
  twoSided: boolean,
  rules: ConversionRules,
): { probability: number; expected: number; steps: ConvertedLine['steps'] } | null {
  if (impliedProbability == null || !Number.isFinite(impliedProbability)) return null;
  const quoted = rules.devig && !twoSided ? impliedProbability / CAPS.oneSidedOverround : impliedProbability;
  const probability = anytimeChance(line, quoted);
  if (probability == null) return null;
  const steps: ConvertedLine['steps'] = rules.devig && !twoSided ? ['devig'] : [];
  if (!rules.tdRate) return { probability, expected: probability, steps };
  const p = Math.min(probability, 0.995);
  const expected = Math.min(-Math.log(1 - p), CAPS.maxTdRate);
  return { probability, expected, steps: [...steps, 'td_rate'] };
}

/** The Poisson rate whose chance of finishing over `line` is `q`. */
export function rateFor(line: number, q: number): number {
  const target = clamp(q, 0.001, 0.999);
  let lo = 0;
  let hi = Math.max(10, line * 4 + 10);
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (poissonOver(line, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * P(X > line) for a Poisson. A whole-number line can push, and a push is a
 * refund rather than a loss, so the over chance is read with the push removed.
 */
export function poissonOver(line: number, rate: number): number {
  const whole = Number.isInteger(line);
  const k = Math.floor(line);
  let term = Math.exp(-rate);
  let atMost = term;
  for (let i = 1; i <= k; i += 1) {
    term *= rate / i;
    atMost += term;
  }
  const over = Math.max(0, 1 - atMost);
  if (!whole) return over;
  const push = term;
  return push >= 1 ? 0 : over / (1 - push);
}

/**
 * The standard normal quantile (Acklam's rational approximation, relative
 * error below 1.2e-9), which is all the precision a prop line needs.
 */
export function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
