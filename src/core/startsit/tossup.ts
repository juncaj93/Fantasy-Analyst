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
 *    carries his minus 1 here as everywhere (`rankingNumber`).
 *  - Under {@link TOSSUP_POINTS}: a toss-up. When the higher number is
 *    Sleeper-only (no Vegas line), under {@link UNPRICED_TOSSUP_POINTS}.
 *    The app still names its lean and shows both numbers, and says "Toss-up". It is never a Best move headline,
 *    never a lineup change, never a "Pick up and start" card.
 *  - Never a toss-up when the player being replaced is a real hole: Out, IR,
 *    suspended, Doubtful, on a bye, or a slot nobody holds. The gap there is
 *    large by construction, and the bar must not hide it.
 *
 * Inside a toss-up the lean follows the week's mode (5 November 2026,
 * {@link tossUpLean}): Floor leans to the safer player, Ceiling to the one with
 * more upside, Balanced to the higher number. Outside a toss-up the higher
 * number decides in every mode.
 *
 * Ordering is a different matter and stays where it is: the kickoff-smart
 * order for exact near-ties (`KICKOFF_TIE` in `lineup.ts`) only decides who is
 * listed first between two equal numbers, and calls no winner.
 */

import { rankingNumber } from './decisionPoints.ts';
import type { StartSitMode } from './mode.ts';
import { spreadPoints, type SpreadReading } from './spread.ts';

/** Points under which two options are a toss-up. */
export const TOSSUP_POINTS = 2.0;

/**
 * The wider bar when the pick rests on a number with no Vegas line (Round 18,
 * 11 November 2026). Under this gap, a lean whose own number is Sleeper-only
 * is a toss-up, not a pick.
 *
 * Measured on the Round 16 backtest (`docs/backtest/round16-data.json`,
 * weeks 1 to 9, `docs/backtest/ROUND18_UNPRICED.md`): after the minus 1 an
 * unpriced lead of a healthy player wins as often as a priced lead of 2.0
 * (same-confidence gap 1.96, noise up to 2.68). An unpriced lead of a
 * Questionable player needs 2.87 even when he plays (noise up to 3.50), and
 * far more when a no-show counts as zero. The bar sits at the top of that
 * range. Only the lean's own number matters: a priced lead over an unpriced
 * player keeps the 2.0 bar (it wins at least as often).
 */
export const UNPRICED_TOSSUP_POINTS = 3.5;

/** The bar a lean must clear: wider when his own number has no Vegas line. */
export function tossUpBar(lean: { borrowed?: boolean }): number {
  return lean.borrowed ? UNPRICED_TOSSUP_POINTS : TOSSUP_POINTS;
}

/** One side of a start/sit call. */
export interface TossUpSide {
  /** His decision number (`decisionPoints`), or null when there is nothing to measure (a bye). */
  points: number | null;
  /** A Sleeper-only number: ranks one point lower. */
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
  /* The higher ranking number is the pick this call rests on; the bar follows its number. */
  const pick = gap >= 0 ? lean : other;
  return gap < tossUpBar(pick) - 1e-9;
}

/**
 * A toss-up only because the pick's number has no Vegas line yet (Round 18).
 *
 * True when the call is a toss-up, the higher number is Sleeper-only, and the
 * gap would clear the ordinary 2.0 bar: the missing line is the one reason the
 * pick is shaky, and the screens say "No line yet" instead of a firm headline.
 */
export function waitsOnLine(lean: TossUpSide, other: TossUpSide): boolean {
  if (!isTossUp(lean, other)) return false;
  const gap = tossUpGap(lean, other);
  if (gap == null) return false;
  const pick = gap >= 0 ? lean : other;
  const unpriced = pick.borrowed === true;
  return unpriced && Math.abs(gap) + 1e-9 >= TOSSUP_POINTS;
}

/** Whether a whole-lineup gain clears the bar. The same bar, for gains already summed. */
export function clearsTossUp(gain: number): boolean {
  return gain >= TOSSUP_POINTS - 1e-9;
}

/** The two words a lean may carry, after "lean X". */
export type LeanTag = 'safer' | 'more upside';

/** One side of a toss-up, for the lean: his number, and how far his week swings. */
export interface LeanSide {
  points: number;
  borrowed?: boolean;
  position: string;
  spread?: SpreadReading | null;
}

export interface TossUpLean {
  /** Which side the toss-up leans to. */
  lean: 'a' | 'b';
  /** The one-word reason under Floor or Ceiling; null under Balanced. */
  tag: LeanTag | null;
}

/**
 * Which way a toss-up leans, for the week's mode (Alex's decision, 5 November
 * 2026). The one function Team and Compare both ask.
 *
 *  - **Balanced**: the higher ranking number.
 *  - **Floor**: the better bad week, his ranking number less his swing
 *    (`spread.ts`). "Safer".
 *  - **Ceiling**: the better good week, his ranking number plus his swing.
 *    "More upside".
 *
 * Only call it inside a toss-up (`isTossUp`): outside one the higher number
 * decides in every mode, and a lean that could overturn a clear call would be
 * the old 10% trim back by another door. A dead level falls back to Balanced,
 * and Balanced's own tie to side `a`.
 */
export function tossUpLean(a: LeanSide, b: LeanSide, mode: StartSitMode): TossUpLean {
  const ra = rankingNumber(a.points, a.borrowed ?? false);
  const rb = rankingNumber(b.points, b.borrowed ?? false);
  const balanced: 'a' | 'b' = rb > ra + 1e-9 ? 'b' : 'a';
  if (mode === 'balanced') return { lean: balanced, tag: null };
  const swing = (side: LeanSide) => spreadPoints(side.spread, side.points, side.position);
  const sign = mode === 'floor' ? -1 : 1;
  const ea = ra + sign * swing(a);
  const eb = rb + sign * swing(b);
  const lean: 'a' | 'b' = Math.abs(ea - eb) < 1e-9 ? balanced : eb > ea ? 'b' : 'a';
  return { lean, tag: mode === 'floor' ? 'safer' : 'more upside' };
}
