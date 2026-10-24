/**
 * When the full Sleeper player list is downloaded: once per Eastern date.
 *
 * Sleeper asks apps to download `/v1/players/nfl` (about 5 MB) at most once a
 * day, and that list carries the injury statuses every screen reads. The daily
 * download runs on the 09:00 UTC tick, which is 5:00 AM Eastern until daylight
 * saving ends and 4:00 AM after. On a Sunday that is the worst time of the
 * week: inactives for the 1 PM games land about 11:30 AM, and a player ruled
 * out then stayed Questionable here until Monday's download.
 *
 * So on Sundays the morning download is skipped and the day's one download
 * runs at 11:45 AM Eastern instead, with two retries (12:15 PM and 12:30 PM)
 * that run only if nothing has succeeded that Eastern day. Every other day is
 * unchanged.
 *
 * The Sunday attempts ride the five-minute tick, which fires at both 15:45 and
 * 16:45 UTC every Sunday. Which of those is 11:45 AM is the zone database's
 * answer for that date (`core/time/zoned.ts`), so the change on 1 November
 * needs no special case and no cron line of its own: the account's five cron
 * triggers are spoken for.
 *
 * Known limit, accepted: the 9:30 AM international games and the 4 PM and night
 * games get no download of their own. The injury report, checked every five
 * minutes, still covers them, and the worse status wins (`core/injury/model.ts`).
 */

import { zonedDate, zonedParts } from '../time/zoned.ts';

export const PLAYER_LIST_ZONE = 'America/Detroit';

/** Sunday's attempts, in minutes after midnight Eastern: 11:45 AM, 12:15 PM, 12:30 PM. */
export const SUNDAY_PLAYER_LIST_MINUTES = [11 * 60 + 45, 12 * 60 + 15, 12 * 60 + 30] as const;

/** True when a download already succeeded on the Eastern date of `at`. */
export function playerListDownloadedToday(at: number, lastSuccessAt: string | null | undefined): boolean {
  if (!lastSuccessAt) return false;
  const last = Date.parse(lastSuccessAt);
  if (!Number.isFinite(last)) return false;
  return zonedDate(last, PLAYER_LIST_ZONE) === zonedDate(at, PLAYER_LIST_ZONE);
}

function isEasternSunday(at: number): boolean {
  return zonedParts(at, PLAYER_LIST_ZONE).weekday === 0;
}

/**
 * Whether the daily 09:00 UTC tick downloads the list.
 *
 * Never on an Eastern Sunday (the game-time download owns that day), and never
 * twice on one Eastern date.
 */
export function dailyPlayerListDue(at: number, lastSuccessAt: string | null | undefined): boolean {
  if (isEasternSunday(at)) return false;
  return !playerListDownloadedToday(at, lastSuccessAt);
}

/**
 * Whether this five-minute tick is one of Sunday's three attempts and should download.
 *
 * `at` is the tick's scheduled time, which Cloudflare sets to the minute.
 */
export function sundayPlayerListDue(at: number | undefined, lastSuccessAt: string | null | undefined): boolean {
  return isSundayPlayerListSlot(at) && !playerListDownloadedToday(at!, lastSuccessAt);
}

/** Whether this five-minute tick is one of Sunday's attempt slots, before asking whether one is needed. */
export function isSundayPlayerListSlot(at: number | undefined): boolean {
  if (at == null || !Number.isFinite(at)) return false;
  const p = zonedParts(at, PLAYER_LIST_ZONE);
  return p.weekday === 0 && (SUNDAY_PLAYER_LIST_MINUTES as readonly number[]).includes(p.hour * 60 + p.minute);
}
