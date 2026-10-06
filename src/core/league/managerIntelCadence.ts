/**
 * When the weekly manager-tendencies refresh runs.
 *
 * Wednesday midday, Detroit time. Waivers have run by then, so a rival's claim
 * or drop from the overnight round is in Sleeper's transactions, and the week
 * still in play has a full midweek's moves in it. It used to ride the 09:00 UTC
 * daily tick on whatever subrequests the other feeds left over, which in
 * practice meant a one-or-two-request touch every morning and a backfill that
 * was deferred more often than it ran.
 *
 * ## The clock is Detroit's, not UTC's
 *
 * Noon in Detroit is 16:00 UTC until the first Sunday of November and 17:00 UTC
 * after it. A cron expression is UTC, so it would be an hour out for half the
 * season; the five-minute tick asks the zone database instead, via
 * {@link zonedParts}, and the changeover needs no special case.
 *
 * ## A window, not a tick
 *
 * Two hours of five-minute ticks, 12:00 to 13:55. The first one does the work;
 * a later one runs again only when the first stopped because it ran out of its
 * allowance with history still to read, so a league whose four seasons are
 * still arriving finishes in one Wednesday rather than in four. The marker that
 * says "done for this Wednesday" is the Detroit date, so it needs no clearing.
 */

import { zonedDate, zonedParts } from '../time/zoned.ts';

export const MANAGER_INTEL_ZONE = 'America/Detroit';
/** Wednesday. */
export const MANAGER_INTEL_WEEKDAY = 3;
/** Local hours the window covers: [12, 14). */
export const MANAGER_INTEL_FROM_HOUR = 12;
export const MANAGER_INTEL_TO_HOUR = 14;

/**
 * The Detroit date of the window the tick falls in, or null outside it.
 *
 * Keyed on the scheduled time, like the other tick windows, so a tick the
 * platform delivers a minute late still lands in the window it was meant for.
 */
export function managerIntelWindow(scheduledTime: number | undefined): string | null {
  if (scheduledTime == null || !Number.isFinite(scheduledTime)) return null;
  const p = zonedParts(scheduledTime, MANAGER_INTEL_ZONE);
  if (p.weekday !== MANAGER_INTEL_WEEKDAY) return null;
  if (p.hour < MANAGER_INTEL_FROM_HOUR || p.hour >= MANAGER_INTEL_TO_HOUR) return null;
  return zonedDate(scheduledTime, MANAGER_INTEL_ZONE);
}
