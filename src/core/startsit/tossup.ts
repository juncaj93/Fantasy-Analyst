/**
 * One bar for every start/sit call: under two points it is a toss-up
 * (Alex's decision, 4 November 2026; review finding X1 and S5).
 *
 * Weekly projections miss by about 4.9 points on average, so a gap of half a
 * point between two players is noise. Until this rule the app called winners
 * on four different margins, all of them inside that noise: a Team swap at
 * 0.75, Compare's tie line at 0.6 and its "close call" at 0.75, and "Pick up
 * and start" at 0.5. The two swaps Team would have flagged on Alex's weeks 1 to
 * 8 lineups both lost (minus 10.3 points).
 *
 * The rule, used by Team (Best move and the swap rows), Compare and "Pick up
 * and start":
 *
 *  - The gap is measured on the ranking number, so a Sleeper-only player
 *    carries his minus 2 here as everywhere (`rankingNumber`).
 *  - Under {@link TOSSUP_POINTS}: a toss-up. The app still names its lean and
 *    shows both numbers, and says "Toss-up". It is never a Best move headline,
 *    never a lineup change, never a "Pick up and start" card.
 *  - Never a toss-up when the player being replaced is a real hole: Out, IR,
 *    suspended, Doubtful, on a bye, or a slot nobody holds. The gap there is
 *    large by construction, and the bar must not hide it.
 *
 * Ordering is a different matter and stays where it is: the kickoff-smart
 * order for exact near-ties (`KICKOFF_TIE` in `lineup.ts`) only decides who is
 * listed first between two equal numbers, and calls no winner.
 */

import { rankingNumber } from './decisionPoints.ts';

/** Points under which two options are a toss-up. */
export const TOSSUP_POINTS = 2.0;

/** One side of a start/sit call. */
export interface TossUpSide {
  /** His decision number (`decisionPoints`), or null when there is nothing to measure (a bye). */
  points: number | null;
  /** A Sleeper-only number: ranks two points lower. */
  borrowed?: boolean;
  /** Out, IR, suspended, Doubtful, on a bye, or an empty slot. See {@link isRealHole}. */
  hole?: boolean;
}

/** Whether a player is a real hole in the lineup, from the facts every screen has. */
export function isRealHole(p: {
  ruledOut?: boolean | null;
  onReserve?: boolean | null;
  onBye?: boolean | null;
  designation?: string | null;
}): boolean {
  if (p.ruledOut || p.onReserve || p.onBye) return true;
  return (p.designation ?? '').toLowerCase() === 'doubtful';
}

/** The lean's lead over the other option, on ranking numbers. Null when either has no number. */
export function tossUpGap(lean: TossUpSide, other: TossUpSide): number | null {
  if (lean.points == null || other.points == null) return null;
  return rankingNumber(lean.points, lean.borrowed ?? false) - rankingNumber(other.points, other.borrowed ?? false);
}

/**
 * Whether the call between the lean and the other option is a toss-up.
 *
 * False when the other option is a real hole or has no number at all (nothing
 * to measure against is a hole too), and false when the lean has no number.
 */
export function isTossUp(lean: TossUpSide, other: TossUpSide): boolean {
  if (other.hole || other.points == null || lean.points == null) return false;
  const gap = tossUpGap(lean, other)!;
  return gap < TOSSUP_POINTS - 1e-9;
}

/** Whether a whole-lineup gain clears the bar. The same bar, for gains already summed. */
export function clearsTossUp(gain: number): boolean {
  return gain >= TOSSUP_POINTS - 1e-9;
}
