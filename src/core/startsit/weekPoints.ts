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
 * `points: null` and is drawn as a dash, last. A ruled-out player is drawn as
 * "Out".
 */

import { decisionPoints, type DecisionBasis, type DecisionEvaluation, type DecisionPoints } from './decisionPoints.ts';

export interface WeekPoints {
  /**
   * The decision number, rounded to the cent, or null when there is none to
   * print: nobody priced him, only part of a market did and nothing is
   * published (a fragment is not a week), or he is ruled out.
   */
  points: number | null;
  /** Where it came from. `none` when there is no number at all. */
  basis: DecisionBasis | 'none';
  /**
   * True unless every market his position is priced on was there. A
   * published week (Rotowire via Sleeper) is a real number with less behind
   * it, and is labelled so.
   */
  lowerConfidence: boolean;
  /**
   * Ruled out: Out, IR, PUP or suspended. Drawn as "Out", never as the
   * engine's internal gate value (13 October 2026: Best move printed -97.0).
   */
  out: boolean;
}

export interface WeekPointsSource extends DecisionEvaluation {
  ruledOut?: boolean | null;
}

export function weekPoints(evaluation: WeekPointsSource, published?: ReadonlyMap<string, number>): WeekPoints {
  return weekPointsFrom(decisionPoints(evaluation, published), evaluation.ruledOut === true);
}

/**
 * The same reading from a decision the server already made. What a screen
 * calls: the evaluation it was handed carries `decision`, and recomputing it
 * without the published week would answer a different question. Pass
 * `ruledOut` so a gated player reads as Out rather than as his gate.
 */
export function weekPointsFrom(decision: DecisionPoints | null | undefined, ruledOut = false): WeekPoints {
  if (ruledOut) return { points: null, basis: decision?.basis ?? 'none', lowerConfidence: true, out: true };
  /*
   * A partial market with nothing published is a fragment of a week (Tre'
   * Harris, 13 October 2026: 1.6 points from one touchdown price). The waiver
   * tiers already refuse it (`tradeValue/rate.ts`) and the Team row already
   * drew a dash; every other screen now does too.
   */
  if (decision == null || decision.basis === 'unpriced' || decision.basis === 'partial') {
    return { points: null, basis: 'none', lowerConfidence: true, out: false };
  }
  /* Never below zero: a Doubtful 5 is 0 here, as on Team's row (`rowFigure`). */
  return { points: Math.max(0, decision.points), basis: decision.basis, lowerConfidence: decision.basis !== 'market', out: false };
}

/** The same reading straight off an evaluation a screen was handed. */
export function weekPointsOf(evaluation: { decision?: DecisionPoints | null; ruledOut?: boolean | null } | null | undefined): WeekPoints {
  return weekPointsFrom(evaluation?.decision, evaluation?.ruledOut === true);
}

/**
 * The figure a Team row starts from: the week number before the availability
 * charge, so `rowFigure` can show a Doubtful player's discount and an Out
 * player's "if he played" figure from the same arithmetic Compare uses.
 */
export function weekPointsBeforeStatus(
  evaluation: {
    decision?: DecisionPoints | null;
    ruledOut?: boolean | null;
    components?: readonly { key: string; value: number; unknown?: boolean }[];
  } | null | undefined,
): number | null {
  const decision = evaluation?.decision;
  if (decision == null || decision.basis === 'unpriced' || decision.basis === 'partial') return null;
  const status = evaluation?.components?.find((c) => c.key === 'status' && !c.unknown)?.value ?? 0;
  return Math.round((decision.points - Math.min(0, status)) * 100) / 100;
}

/**
 * The order every list of players is drawn in: strictly by the number,
 * highest first, whether it is a full market read or a published week (a
 * "lower confidence" tag is a label, not a sort key). Players with no number,
 * and players who are out, go last. Ties go to the name so the order is stable.
 */
export function byWeekPoints<T extends { name: string; week: WeekPoints }>(a: T, b: T): number {
  const last = (w: WeekPoints) => (w.points == null || w.out ? 1 : 0);
  return (
    last(a.week) - last(b.week) ||
    (b.week.points ?? 0) - (a.week.points ?? 0) ||
    a.name.localeCompare(b.name)
  );
}
