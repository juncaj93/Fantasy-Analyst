/**
 * Which games count as "this week", as two timestamps.
 *
 * A leaf, and it exists because the two halves of one fact had drifted apart.
 * `buildStartSitContext` reads the week's game lines with
 * `VegasEventsRepo.between(now - 12h, now + 9d)`, so on the Tuesday of week 2
 * a week 1 fixture is correctly gone. The player props for those same games
 * were read with no window at all — `PropsRepo.latestForPlayers` is "the newest
 * snapshot per event", and a week 1 event's snapshot stays the newest snapshot
 * of that event for ever.
 *
 * So one half of the pair said "there is no game for this player this week" and
 * the other half cheerfully handed over last Sunday's line for it. Measured in
 * production on 15 September 2026: nine of ten starters carrying week 1
 * projections marked `market`, every one of them locked against a kickoff that
 * had already happened, and a matchup screen in which every player's game had
 * already finished.
 *
 * The damage was never the stale number. A stale number is not *missing*, so
 * `marketProjection` returned a figure, and the Rotowire fallback below it —
 * refreshed nine hours earlier and holding the correct week — never got a turn.
 *
 * One definition, imported by both readers, so they cannot disagree again.
 */

/**
 * How far back a game may have kicked off and still be part of this week.
 *
 * Twelve hours, which is the number the events read already used. It has to be
 * long enough to cover a game in progress and the hours after a late one — a
 * window that dropped a fixture at the final whistle would blank the Sunday
 * afternoon scoreboard this app exists to watch — and short enough that by
 * Tuesday, when Sleeper turns the week over, the whole of the previous slate
 * has left it. The gap between a Monday night final and a Thursday kickoff is
 * about seventy hours, so twelve is nowhere near either edge.
 */
export const SLATE_LOOKBACK_HOURS = 12;

/**
 * How far ahead it reaches.
 *
 * Nine days, also the events read's own number, which covers the coming week
 * plus the Monday night game and the following Thursday — the fixtures a
 * reader can still act on.
 */
export const SLATE_LOOKAHEAD_DAYS = 9;

export interface SlateWindow {
  /** ISO. Games starting before this are a week that is over. */
  from: string;
  /** ISO. Games starting after this are too far out to be this week's. */
  to: string;
}

/** The window, from one clock, for every reader that needs the same one. */
export function slateWindow(now: Date = new Date()): SlateWindow {
  return {
    from: new Date(now.getTime() - SLATE_LOOKBACK_HOURS * 3_600_000).toISOString(),
    to: new Date(now.getTime() + SLATE_LOOKAHEAD_DAYS * 86_400_000).toISOString(),
  };
}
