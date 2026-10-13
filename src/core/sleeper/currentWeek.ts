/**
 * The one answer to "which NFL week is it", for every screen and every job.
 *
 * Sleeper's own `week` from `/state/nfl`, so the app flips exactly when
 * Sleeper does. Measured on Tuesday 13 October 2026 at 19:47 UTC, after
 * Monday night's game: `week: 6, leg: 6, display_week: 5`. `week` is the week
 * Sleeper's lineup screen edits (Alex's app showed his Week 6 lineup), so it
 * is the one used here; `display_week` lags it for the scores tab and is not.
 *
 * Before 13 October the same rule lived in four shapes: `resolveWeek` in the
 * Matchup build, `currentWeekOf` in the trade service, and a dozen raw
 * `state.week ?? 1` reads that skipped the preseason rule. They agreed in the
 * regular season and disagreed around its edges; now they are this function.
 *
 * Preseason and the off-season have no current week to show, and the honest
 * answer is week one, the first week that will be played. `post` keeps
 * Sleeper's count (fantasy weeks run through the NFL postseason).
 */

export interface WeekState {
  week?: number | null;
  seasonType?: string | null;
}

/** Season types with no regular-season week in them. */
export const NO_REGULAR_WEEK = new Set(['pre', 'off']);

export function currentWeek(state: WeekState | null | undefined): number {
  if (NO_REGULAR_WEEK.has(String(state?.seasonType ?? '').trim().toLowerCase())) return 1;
  const week = state?.week;
  const now = week != null && Number.isFinite(week) ? Math.floor(week) : 1;
  return Math.min(22, Math.max(1, now));
}
