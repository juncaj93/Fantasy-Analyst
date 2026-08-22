/**
 * Where the season actually is, and therefore whether Draft is still a place.
 *
 * The Draft tab is the most useful thing in the app for two weeks a year and
 * dead weight for the other fifty. Hiding it is easy; hiding it *at the right
 * moment* is the whole problem, and the wrong answers are both bad in obvious
 * ways: hide it too early and the user loses their board mid-draft, hide it too
 * late and a sixth of the toolbar is a museum.
 *
 * **A completed draft is not the regular season — but it is the end of the
 * board.** Those are two different statements and this module used to conflate
 * them. The season phase is still preseason for the month between a July draft
 * and week one, and every date-shaped question here still answers accordingly;
 * what changes at the final pick is that the Draft *tab* has nothing left to
 * decide. The board exists to help make picks, the picks are made, and a sixth
 * of the most valuable strip of glass in the app is too much to spend on a
 * record of them. So `phase` ignores the draft's status and `draftVisible` does
 * not.
 *
 * The safe direction is unchanged and is the reason the rule is stated as it
 * is: the tab goes only when Sleeper has *positively said* this league's draft
 * is finished. A draft nobody has told us about, one still to open, one paused
 * mid-round — all of them keep the board. Hiding a board a user still needs
 * costs them their draft; showing one they have finished with costs a strip of
 * glass.
 *
 * Sleeper's own state is preferred over any date arithmetic. `/state/nfl` says
 * which season type is running and which week it is, which is the same answer
 * the NFL would give and needs no calendar of its own maintained here. The
 * league's `status` is the second witness, and both are allowed to be absent:
 * with nothing known this returns preseason, which keeps the tab. Showing a tab
 * that could have been hidden costs a strip of glass; hiding one that should
 * have stayed costs the user their draft.
 */

export type SeasonPhase = 'preseason' | 'regular' | 'postseason' | 'offseason';

/** The parts of Sleeper's `/state/nfl` this decision reads. */
export interface NflState {
  season: string | null;
  /** `pre`, `regular`, `post`, `off`. */
  seasonType: string | null;
  /** The week within the season type. 0 before week one starts. */
  week: number | null;
  /** Sleeper's own leg counter; kept for the record, not read here. */
  leg?: number | null;
  fetchedAt?: string | null;
}

export interface SeasonPhaseResolution {
  phase: SeasonPhase;
  /** Whether Draft belongs in primary navigation right now. */
  draftVisible: boolean;
  /** Which witness decided it, in the user's language. */
  reason: string;
  /** True when nothing was known and the safe default was taken. */
  assumed: boolean;
}

/** Sleeper league statuses that mean the regular season is running or done. */
const IN_SEASON_STATUSES = new Set(['in_season']);
const FINISHED_STATUSES = new Set(['complete', 'completed', 'post_season', 'postseason']);

/** Sleeper draft statuses, lower-cased, that mean every pick is in. */
const COMPLETE_DRAFT_STATUSES = new Set(['complete', 'completed', 'done']);

/**
 * Is every pick in?
 *
 * The lowest-level home for this, because three separate decisions turn on it
 * and they must not be able to disagree: whether the Draft tab is still a
 * destination (here), which lifecycle state the app is in (`season/lifecycle`),
 * and whether the Sleeper sync should go back for the rosters the draft
 * produced (`server/services/sleeperSync`). One of them believing `done` counts
 * while another does not is how an app ends up announcing a finished draft over
 * a roster it never fetched.
 *
 * Anything not positively a completion is false — including unknown, absent and
 * a status Sleeper has not used before. See the module docblock for why that
 * direction is the safe one.
 */
export function isDraftComplete(status: string | null | undefined): boolean {
  return COMPLETE_DRAFT_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

export function resolveSeasonPhase(input: {
  state?: NflState | null;
  league?: { season?: string | null; status?: string | null } | null;
  draft?: { status?: string | null } | null;
}): SeasonPhaseResolution {
  const state = input.state ?? null;
  const leagueSeason = numeric(input.league?.season);
  const stateSeason = numeric(state?.season);
  const type = (state?.seasonType ?? '').trim().toLowerCase();
  const week = typeof state?.week === 'number' && Number.isFinite(state.week) ? state.week : null;
  /*
   * Whether this league's draft is finished.
   *
   * Read once here rather than at each return, because it modifies exactly one
   * field — `draftVisible` — in exactly one phase. Every branch that already
   * hides the tab hides it for a stronger reason than this and is untouched.
   */
  const draftDone = isDraftComplete(input.draft?.status);
  /** Preseason with the board still worth opening. */
  const preseasonDraftVisible = !draftDone;

  /*
   * A league from a season the NFL has moved past.
   *
   * Its regular season started long ago and finished; the tab has nothing left
   * to offer, and this is checked first because Sleeper reports the *current*
   * season's type, which would otherwise be read as if it described the old
   * league.
   */
  if (leagueSeason != null && stateSeason != null && stateSeason > leagueSeason) {
    return {
      phase: 'offseason',
      draftVisible: false,
      reason: `this league's ${leagueSeason} season is over — the NFL is in ${stateSeason}`,
      assumed: false,
    };
  }

  // Sleeper's state is only about this league when the seasons agree. A league
  // in a *future* season (a dynasty rolled forward early) has not started.
  const stateApplies = state != null && (leagueSeason == null || stateSeason == null || stateSeason === leagueSeason);

  if (stateApplies) {
    if (type === 'post') {
      return {
        phase: 'postseason',
        draftVisible: false,
        reason: 'the NFL regular season has finished',
        assumed: false,
      };
    }
    /*
     * Week one, kicked off.
     *
     * Sleeper flips `season_type` to `regular` a little before week one and
     * reports `week: 0` until it actually starts, so the week is checked too —
     * that gap is precisely the window in which a user still wants their board.
     */
    if (type === 'regular' && (week ?? 0) >= 1) {
      return {
        phase: 'regular',
        draftVisible: false,
        reason: `the regular season is under way (week ${week})`,
        assumed: false,
      };
    }
    if (type === 'pre' || (type === 'regular' && (week ?? 0) < 1)) {
      return {
        phase: 'preseason',
        draftVisible: preseasonDraftVisible,
        reason: draftDone
          ? 'your draft is finished — the board has nothing left to decide'
          : 'the regular season has not started yet',
        assumed: false,
      };
    }
  }

  // Second witness: the league's own status, which Sleeper flips to
  // `in_season` at the same moment. Used when `/state/nfl` was never read —
  // a fresh install, or an offline stretch — and it is never used to *keep* the
  // tab, only to take it away.
  const leagueStatus = (input.league?.status ?? '').trim().toLowerCase();
  if (FINISHED_STATUSES.has(leagueStatus)) {
    return { phase: 'postseason', draftVisible: false, reason: 'this league has finished its season', assumed: false };
  }
  if (IN_SEASON_STATUSES.has(leagueStatus)) {
    return { phase: 'regular', draftVisible: false, reason: 'Sleeper reports this league in season', assumed: false };
  }

  /*
   * A finished draft, with nothing known about the season.
   *
   * Still preseason — the phase is a fact about the calendar and a draft ending
   * does not start a season. The board goes, though, and this branch is named
   * explicitly rather than left to the fall-through so the two halves of that
   * sentence are visible together.
   */
  if (draftDone) {
    return {
      phase: 'preseason',
      draftVisible: false,
      reason: 'your draft is finished — the board has nothing left to decide',
      assumed: false,
    };
  }

  return {
    phase: 'preseason',
    draftVisible: true,
    reason: 'the season state is not known yet',
    assumed: true,
  };
}

function numeric(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}
