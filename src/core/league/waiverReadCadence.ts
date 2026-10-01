/**
 * When the five-minute tick re-reads the league's rosters and transactions.
 *
 * Every three hours, at a quarter past: 00:15, 03:15, … 21:15 UTC. Asked for
 * on 1 October 2026: a rival's drop has a two-day waiver window, and reading
 * the league once a day at 09:00 UTC meant a drop could be most of a day old
 * before the Waivers screen saw it. Three hours keeps that to a fraction of
 * the window for about eight Sleeper calls a read (the league, its rosters,
 * users and drafts, the state check, and two weeks of transactions).
 *
 * A quarter past rather than on the hour, so it never shares a tick with the
 * on-the-hour work, and clear of the nflverse windows at 09:30–09:45
 * (`core/nflverse/cadence.ts`). Both reads are needed: a dropped player stays
 * "rostered" in this app until the rosters are re-read, so transactions alone
 * would not put him on the board.
 */

export const WAIVER_READ_EVERY_HOURS = 3;
export const WAIVER_READ_MINUTE = 15;

export function waiverReadDue(scheduledTime: number | undefined): boolean {
  if (scheduledTime == null || !Number.isFinite(scheduledTime)) return false;
  const at = new Date(scheduledTime);
  const minute = at.getUTCMinutes();
  return at.getUTCHours() % WAIVER_READ_EVERY_HOURS === 0 && minute >= WAIVER_READ_MINUTE && minute < WAIVER_READ_MINUTE + 5;
}
