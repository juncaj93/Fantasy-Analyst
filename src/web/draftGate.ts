/**
 * Whether the Draft screen is drawn, and therefore whether its code and its
 * board are fetched at all.
 *
 * Pure and separate from `App.tsx` so the rule can be tested against the
 * season resolver it depends on — see `tests/seasonPhase.test.ts`.
 *
 * **There is no draft-completion check in here, on purpose.** `draftVisible` is
 * `resolveSeasonPhase` on the server, the same answer that puts the tab in the
 * bar, and it is the one that was hardened after the 30 August 2026 incident: a
 * `pre_draft`, paused or live draft keeps the board against every calendar
 * witness, and only a draft Sleeper positively calls complete, or a season under
 * way, takes it away. A second, local reading of the draft's status is exactly
 * how two answers start to disagree.
 */
export function shouldDrawDraftScreen(input: {
  /** The overview has answered, or failed to. Either way the app stops waiting. */
  seasonKnown: boolean;
  /**
   * `overview.season.draftVisible`, with an absent field already read as true —
   * an older deployment that says nothing keeps the board.
   */
  draftVisible: boolean;
  /** The reader tapped a destination themselves. What they asked for stays. */
  chosen: boolean;
}): boolean {
  if (input.chosen) return true;
  /*
   * Before the overview answers, nothing is drawn. The app lands on Draft by
   * default, and drawing it for the one render before the season is known was
   * enough to fetch the screen's code and a board nobody could act on, on every
   * page load of the season. The overview arrives in the same round trip as the
   * league list the board needs anyway, so a reader mid-draft waits for nothing.
   */
  if (!input.seasonKnown) return false;
  return input.draftVisible;
}
