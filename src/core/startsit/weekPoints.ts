/**
 * One player's number for this week, the same everywhere it is printed.
 *
 * The rule settled in October 2026: the projection in the Compare picker, the
 * Compare score, the Team screen's Best move card and the waiver tiers come
 * from one function. This is that function's public face. It is a thin read
 * of `decisionPoints` (which the lineup, the Compare ranking and the waiver
 * tier rates already used) plus the two things a list needs on top: whether
 * the number is a full market read or a lower-confidence fallback, and an
 * order to sort by.
 *
 * "Never invent a number": a player with no market and no published week has
 * `points: null` and is drawn as a dash, last.
 */

import { decisionPoints, type DecisionBasis, type DecisionEvaluation } from './decisionPoints.ts';

export interface WeekPoints {
  /** The decision number, rounded to the cent, or null when there is none. */
  points: number | null;
  /** Where it came from. `none` when there is no number at all. */
  basis: DecisionBasis | 'none';
  /**
   * True unless every market his position is priced on was there. A
   * published week (Rotowire via Sleeper) or a partial market is a real
   * number with less behind it, and is labelled so.
   */
  lowerConfidence: boolean;
}

export function weekPoints(
  evaluation: DecisionEvaluation,
  published?: ReadonlyMap<string, number>,
): WeekPoints {
  const decision = decisionPoints(evaluation, published);
  if (decision == null || decision.basis === 'unpriced') return { points: null, basis: 'none', lowerConfidence: true };
  return { points: decision.points, basis: decision.basis, lowerConfidence: decision.basis !== 'market' };
}

/**
 * The order every list of players is drawn in: priced players by points,
 * highest first, then the lower-confidence numbers by points, then nobody's
 * number at all. Ties go to the name so the order is stable.
 */
export function byWeekPoints<T extends { name: string; week: WeekPoints }>(a: T, b: T): number {
  const tier = (w: WeekPoints) => (w.points == null ? 2 : w.lowerConfidence ? 1 : 0);
  return (
    tier(a.week) - tier(b.week) ||
    (b.week.points ?? 0) - (a.week.points ?? 0) ||
    a.name.localeCompare(b.name)
  );
}
