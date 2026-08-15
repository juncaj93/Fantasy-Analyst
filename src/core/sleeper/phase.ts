/**
 * Where the season actually is, and therefore whether Draft is still a place.
 *
 * The Draft tab is the most useful thing in the app for two weeks a year and
 * dead weight for the other fifty. Hiding it is easy; hiding it *at the right
 * moment* is the whole problem, and the wrong answers are both bad in obvious
 * ways: hide it too early and the user loses their board mid-draft, hide it too
 * late and a sixth of the toolbar is a museum.
 *
 * **A completed draft is not the regular season.** That is the tempting signal
 * and it is wrong — leagues finish drafting in July and then wait a month, and
 * during that month the board is still what people open the app for. So the
 * draft's own status is used only to rule the transition *out*, never in.
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
        draftVisible: true,
        reason: 'the regular season has not started yet',
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
   * Everything else is preseason, including a finished draft.
   *
   * Named explicitly rather than left to the fall-through, because "the draft is
   * done, so hide the board" is the mistake this module exists to not make.
   */
  const draftStatus = (input.draft?.status ?? '').trim().toLowerCase();
  if (draftStatus === 'complete') {
    return {
      phase: 'preseason',
      draftVisible: true,
      reason: 'the draft is finished, but the regular season has not started',
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
