/**
 * One rule for "this number fell back to Sleeper", for every screen that
 * prints the Start/Sit number (15 October 2026).
 *
 * The rule itself is the engine's, not this file's: a player whose betting
 * market is incomplete is ranked on Sleeper's whole-week projection instead
 * (`decisionPoints`, basis `published`). What this file owns is how that looks,
 * so Compare, the Team rows, Best move and Matchup cannot drift apart:
 *
 *  - the number is marked italic with a thin dotted underline
 *    (`SLEEPER_NUM_CLASS`), the look the Matchup screen gave borrowed figures
 *    first (16 October 2026, replacing a grey colour and a "Sleeper" word). It
 *    keeps the number's place and size, so rows stay aligned;
 *  - a visually hidden "Sleeper projection" says it to a screen reader.
 *
 * Compare also greys it. Posted market lines keep their normal colour; a
 * missing one is a grey dash.
 */

import type { WeekPoints } from '../core/startsit/weekPoints.ts';

/** The class that marks a number built on Sleeper's week. */
export const SLEEPER_NUM_CLASS = 'num-sleeper';

/** The words a screen reader hears after the number. */
export const SLEEPER_SPOKEN = 'Sleeper projection';

/**
 * Whether a number's source is Sleeper's week. Takes whichever word the
 * surface already carries: the engine's `published` basis, the Team row's
 * `sleeper` source, or Matchup's `projectionBorrowed`.
 */
export function isSleeperSource(source: string | boolean | null | undefined): boolean {
  return source === true || source === 'published' || source === 'sleeper';
}

/** The same rule on a `WeekPoints`: a number that is there, not Out, built on Sleeper's week. */
export function weekIsSleeper(week: WeekPoints | null | undefined): boolean {
  return week != null && !week.out && week.points != null && isSleeperSource(week.basis);
}

/** `className` plus the grey when the rule holds. */
export function sleeperClass(base: string, sleeper: boolean): string {
  return sleeper ? `${base} ${SLEEPER_NUM_CLASS}` : base;
}
