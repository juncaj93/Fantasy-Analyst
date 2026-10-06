/**
 * How old a game's lines must be before a manual refresh re-buys them.
 *
 * Lines barely move early in the week and move fastest close to kickoff, so the
 * wait shrinks as the game nears. Judged per game, never as one app-wide timer:
 * Thursday night, Sunday and Monday night sit in different rows at once.
 *
 *   more than 24h out   6 hours
 *   2 to 24h out        1 hour
 *   under 2h out        15 minutes
 *   kicked off          never (books have closed the line)
 *
 * An unknown kickoff is treated as far out. A game never fetched is not decided
 * here: the callers fetch it whatever this says.
 */
export function manualRefreshThresholdMinutes(hoursToKickoff: number | null): number | null {
  if (hoursToKickoff == null || !Number.isFinite(hoursToKickoff)) return 360;
  if (hoursToKickoff <= 0) return null;
  if (hoursToKickoff < 2) return 15;
  if (hoursToKickoff <= 24) return 60;
  return 360;
}
