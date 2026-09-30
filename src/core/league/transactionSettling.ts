/**
 * When a week of league transactions can never change again.
 *
 * ## The bug this exists to end
 *
 * Both readers of league transactions used to mark a week settled the moment
 * the NFL week number moved past it. That is wrong by a day and a half, and the
 * day and a half is exactly when the money moves.
 *
 * Sleeper flips its week on Tuesday. The waiver run for the week that just
 * ended processes on Tuesday night and its claims post at about **07:10 UTC on
 * Wednesday**, filed under the *previous* week (`leg`). Measured on this
 * league's own transactions: week 2's paid claims all carry 23 Sep 07:10 and
 * week 3's carry 30 Sep 07:10. So a week read on Tuesday — after the flip,
 * before the run — was stored without its waiver claims and then locked, and
 * the Wednesday claims were never read at all.
 *
 * On 30 September 2026 that left the price model holding one winning bid (a $0
 * claim) against the seventeen paid winning bids Sleeper publishes for weeks
 * 1–3, which is why every Waivers card showed a blank cost.
 *
 * ## The rule
 *
 * A finished season is settled. In a live season:
 *
 *   - the current week is never settled (it is still being played);
 *   - the week just before it stays open on **Tuesday and Wednesday UTC**, so a
 *     read after the Wednesday-morning run replaces the Tuesday one. From
 *     Thursday it is settled, and the daily 09:00 UTC read that Thursday is the
 *     first one allowed to lock it;
 *   - every older week is settled.
 *
 * Read by day of week rather than by "hours since the flip", because the flip
 * time is not something this app records and the run's own time is fixed to
 * the day. Thursday leaves a full day of margin after a 07:10 Wednesday post,
 * which is also the margin a delayed run would need.
 */

/** UTC days on which last week's waiver claims may still be arriving. 2 = Tuesday, 3 = Wednesday. */
export const WAIVER_RUN_OPEN_DAYS: ReadonlySet<number> = new Set([2, 3]);

export function isTransactionWeekSettled(opts: {
  week: number;
  /** The week being played now, per Sleeper's state. */
  currentWeek: number;
  /** A finished season never changes. */
  finishedSeason: boolean;
  now: Date;
}): boolean {
  if (opts.finishedSeason) return true;
  if (opts.week >= opts.currentWeek) return false;
  if (opts.week === opts.currentWeek - 1) return !WAIVER_RUN_OPEN_DAYS.has(opts.now.getUTCDay());
  return true;
}
