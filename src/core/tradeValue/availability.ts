/**
 * How many of the remaining weeks a player is actually there for.
 *
 * Start/Sit charges an injured player points for being injured, and that is the
 * right tool for one Sunday. Over thirteen weeks it is the wrong one: a player
 * who is Out this week is not 99 points worse for the season, he is missing a
 * few games. So this model takes the availability charge back out of his rate
 * (see `rate.ts`) and counts the games instead.
 *
 * ## Two things that remove a week
 *
 * - **A bye** removes exactly one week and costs nothing else. It is a count,
 *   not a discount, the same rule `core/value/multiWeek.ts` keeps.
 * - **An injury** removes the weeks a designation implies. Sleeper and the
 *   practice report give a designation and never a return date, so these are
 *   stated assumptions, kept in one table where they can be argued with. A
 *   designation never makes a player worse once he is back; it only takes weeks
 *   away.
 *
 * Each week is a fraction between 0 and 1, so a Questionable player is worth a
 * little less this week and nothing less afterwards. The fractions multiply his
 * rate in the lineup, which makes the lineup an expected-points lineup.
 *
 * Nothing here predicts a future injury. A healthy player is available every
 * week that is not his bye, and no durability opinion is attached to anybody.
 */

import type { Designation } from '../injury/model.ts';

/**
 * Expected availability by designation, as fractions of a week from now.
 *
 * `fromNow[k]` is the week `k` weeks ahead; anything past the end of the array
 * is `after`. Return dates are unknown, so these are deliberately plain:
 *
 *  - Questionable plays about four times in five.
 *  - Doubtful plays about one time in four.
 *  - Out this week is assumed to be out about two weeks.
 *  - IR, PUP and a suspension are assumed to be out four weeks (the NFL's own
 *    minimum for an IR return), and back at 85% after that, because "back" is
 *    not the same as "back at full speed" and some do not come back at all.
 *
 * A player the injury layer knows nothing about is treated as healthy. That is
 * a statement about missing data and the card says so only when it matters.
 */
export const AVAILABILITY_POLICY: Record<Designation, { fromNow: number[]; after: number; note: string | null }> = {
  healthy: { fromNow: [], after: 1, note: null },
  unknown: { fromNow: [], after: 1, note: null },
  questionable: { fromNow: [0.8], after: 1, note: 'Questionable this week' },
  doubtful: { fromNow: [0.25], after: 1, note: 'Doubtful this week' },
  out: { fromNow: [0, 0.5], after: 1, note: 'Out; no return date, counted as about two weeks' },
  ir: { fromNow: [0, 0, 0, 0], after: 0.85, note: 'On injured reserve; no return date, counted out four weeks' },
  pup: { fromNow: [0, 0, 0, 0], after: 0.85, note: 'On PUP; no return date, counted out four weeks' },
  suspended: { fromNow: [0, 0, 0, 0], after: 1, note: 'Suspended; length unknown, counted as four weeks' },
};

/** Designations that rule a player out of this week's lineup. */
export function isOutNow(designation: Designation): boolean {
  return designation === 'out' || designation === 'ir' || designation === 'pup' || designation === 'suspended';
}

export interface WeeklyAvailability {
  /** One fraction per horizon week, same order as the horizon. */
  weekly: number[];
  /** Sum of `weekly`: games expected, with the bye and the injury taken out. */
  games: number;
  /** One clause naming the injury assumption, when one was used. */
  note: string | null;
  /** Whether his bye falls inside the horizon. */
  byeInside: boolean;
}

export function weeklyAvailability(opts: {
  designation: Designation;
  /** Sitting in an injured-reserve slot, whatever the designation says. */
  onReserve?: boolean;
  weeks: readonly number[];
  byeWeek: number | null;
}): WeeklyAvailability {
  const designation: Designation =
    opts.onReserve && !isOutNow(opts.designation) ? 'out' : opts.designation;
  const policy = AVAILABILITY_POLICY[designation] ?? AVAILABILITY_POLICY.healthy;
  const first = opts.weeks[0] ?? 0;

  const weekly = opts.weeks.map((week) => {
    if (opts.byeWeek != null && week === opts.byeWeek) return 0;
    const k = week - first;
    return policy.fromNow[k] ?? policy.after;
  });
  return {
    weekly,
    games: weekly.reduce((a, b) => a + b, 0),
    note: policy.note,
    byeInside: opts.byeWeek != null && opts.weeks.includes(opts.byeWeek),
  };
}
