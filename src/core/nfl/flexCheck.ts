/**
 * When the schedule is asked again because the league may have just flexed games.
 *
 * ## What the app can read, and what it cannot
 *
 * The app reads one thing about the schedule: nflverse's `games.csv`, with a
 * conditional GET. It cannot read the league's own announcement, and nfl.com is
 * not reachable from the build environment, so this is a decision about when
 * to ask a file that follows the announcement rather than a reading of it. The
 * file's `Last-Modified` was 13:06 Eastern on Tuesday 6 October 2026, which says
 * it is rebuilt on weekdays and not only on weekends.
 *
 * ## The cadence it follows
 *
 * The league's flex rules, as published: Sunday and Monday night games can be
 * moved with 12 days' notice (6 days for Sunday night from week 14), and
 * Thursday night with 28. Decisions are announced on Tuesdays. So the check
 * that matters happens on Tuesday evening and the following day, which is what
 * the three windows below cover. Between them the ordinary daily check (see
 * `SCHEDULE_CHECK_INTERVAL_MINUTES`) catches anything announced off-pattern.
 *
 * Each window is one five-minute tick, and each check is a conditional GET that
 * comes back 304 and no bytes on every week the league flexes nothing. Three of
 * them a week is about one extra request a day.
 *
 * Wall-clock Eastern, by zone rules rather than a fixed UTC hour: 21:00 Eastern
 * is 01:00 UTC until the first Sunday of November and 02:00 UTC after it.
 */

import { zonedParts } from '../time/zoned.ts';

export const FLEX_CHECK_ZONE = 'America/New_York';

/** Weekday (0 = Sunday) and Eastern hour of each post-announcement check. */
export const FLEX_CHECK_WINDOWS: readonly { readonly weekday: number; readonly hour: number }[] = [
  { weekday: 2, hour: 21 },
  { weekday: 3, hour: 9 },
  { weekday: 3, hour: 15 },
] as const;

/** True on the one five-minute tick that opens each window. */
export function scheduleFlexCheckDue(scheduledTime: number | undefined): boolean {
  if (scheduledTime == null || !Number.isFinite(scheduledTime)) return false;
  const p = zonedParts(scheduledTime, FLEX_CHECK_ZONE);
  if (p.minute >= 5) return false;
  return FLEX_CHECK_WINDOWS.some((w) => w.weekday === p.weekday && w.hour === p.hour);
}
