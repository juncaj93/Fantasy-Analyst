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
 * which season type is running, which week it is, and which day week one kicks
 * off, which is the same answer the NFL would give and needs no calendar of its
 * own maintained here. The league's `status` is the second witness, and both are
 * allowed to be absent: with nothing known this returns preseason, which keeps
 * the tab. Showing a tab that could have been hidden costs a strip of glass;
 * hiding one that should have stayed costs the user their draft.
 *
 * ## `season_type: regular` does not mean the season has started
 *
 * This module used to believe it did, with one guard against it: that Sleeper
 * reports `week: 0` through the gap between flipping the type and week one
 * actually starting. **It does not, and never did.** Read on 2026-08-30, eleven
 * days before kickoff and while leagues were still drafting, `/state/nfl`
 * answered:
 *
 * ```json
 * { "week": 1, "leg": 1, "season": "2026", "season_type": "regular",
 *   "display_week": 1, "season_start_date": "2026-09-09" }
 * ```
 *
 * So `type === 'regular' && week >= 1` was true for a season that had not
 * kicked off, and the guard written to cover exactly that gap never fired
 * once. The board vanished out from under every league that had not finished
 * drafting by the last week of August — which is most of the in-person ones,
 * because they draft on a Saturday in September.
 *
 * The field that actually separates the two is `season_start_date`, published
 * on the same object, and it is what week one is now checked against. Week two
 * and later need no date at all: games have been played by then, and a stored
 * state from a build older than this one has no kickoff day to read, so week
 * one with nothing to compare against keeps the board rather than guessing.
 *
 * ## A draft that has not finished outranks the calendar
 *
 * The stronger witness, and the one that makes the failure above impossible to
 * repeat whatever Sleeper does with its season type next August: a draft
 * Sleeper positively describes as *not finished* — waiting to open, paused, or
 * taking picks — is proof this league has not drafted, and a league that has
 * not drafted still needs its board. `resolveLifecycle` has always held that
 * for a draft mid-pick; the state it did not hold it for is `pre_draft`, which
 * is where an untimed draft sits for its whole life. A league drafting in
 * person on a Saturday afternoon has no start time in Sleeper, is never
 * `drafting`, and was therefore the one case with nothing standing between it
 * and the calendar.
 */

export type SeasonPhase = 'preseason' | 'regular' | 'postseason' | 'offseason';

/** The parts of Sleeper's `/state/nfl` this decision reads. */
export interface NflState {
  season: string | null;
  /** `pre`, `regular`, `post`, `off`. */
  seasonType: string | null;
  /**
   * The week within the season type.
   *
   * Emphatically *not* 0 before week one starts — Sleeper reports week 1 for
   * the whole of the gap. See the module docblock.
   */
  week: number | null;
  /**
   * The day week one kicks off, `YYYY-MM-DD`, as Sleeper publishes it.
   *
   * Absent on a state stored by a build older than this one, and absent is read
   * as "cannot tell yet", which keeps the board.
   */
  seasonStartDate?: string | null;
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
 * Sleeper draft statuses, lower-cased, that mean this league has not drafted.
 *
 * Every state a draft object can be in that is not a completion — set up and
 * waiting, paused between rounds, or taking picks right now. `pre_draft` is the
 * one that matters most and the one that used to be missing: an untimed draft,
 * the kind a league that meets in a room enters by hand, sits there from the
 * day the league is created until somebody marks it done. It is never
 * `drafting`, so the mid-pick protection elsewhere never covered it.
 *
 * Deliberately a list of things Sleeper positively says rather than "anything
 * that is not complete": an absent draft, an unknown status and a status nobody
 * has seen before are all *silence*, and silence is already handled by the
 * default at the bottom of `resolveSeasonPhase`. This set exists to outrank a
 * witness that would otherwise win, which is a stronger claim and needs a
 * positive statement behind it.
 */
const PENDING_DRAFT_STATUSES = new Set(['pre_draft', 'predraft', 'paused', 'drafting', 'in_progress', 'live']);

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

/**
 * Has Sleeper positively said this league still has a draft ahead of it?
 *
 * The mirror of `isDraftComplete`, and not its negation: both are false for
 * silence. See `PENDING_DRAFT_STATUSES` for why the difference matters.
 */
export function isDraftPending(status: string | null | undefined): boolean {
  return PENDING_DRAFT_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

/**
 * Has week one actually kicked off?
 *
 * `season_type` alone cannot answer this and never could — see the module
 * docblock. Week two and later are unambiguous without a date; week one is the
 * whole of the ambiguity, and it is settled against the kickoff day Sleeper
 * publishes beside it. With no kickoff day to read the answer is "not yet",
 * which is the direction that keeps the board.
 */
function regularSeasonUnderWay(
  type: string,
  week: number | null,
  seasonStartDate: string | null | undefined,
  today: string,
): boolean {
  if (type !== 'regular') return false;
  if ((week ?? 0) < 1) return false;
  if ((week ?? 0) >= 2) return true;
  const kickoff = String(seasonStartDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(kickoff)) return false;
  return today >= kickoff;
}

/**
 * Today, as a `YYYY-MM-DD` day in UTC.
 *
 * Compared as a string against Sleeper's own `season_start_date`, which is the
 * same shape, so the two are never parsed into instants and no timezone
 * arithmetic happens anywhere. A day's imprecision either side of a Thursday
 * night kickoff is immaterial: by kickoff day every draft in the league has
 * long finished, and a draft that somehow has not is held by
 * `isDraftPending` regardless of what any date says.
 */
function utcDay(now: Date | string | null | undefined): string {
  const date = now == null ? new Date() : now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function resolveSeasonPhase(input: {
  state?: NflState | null;
  league?: { season?: string | null; status?: string | null } | null;
  draft?: { status?: string | null } | null;
  /**
   * The clock, injectable so this stays testable.
   *
   * Read for one comparison only — today against Sleeper's published kickoff
   * day — and never to derive a season, a week or a phase. Callers on a request
   * path pass their own `now`; everything else takes the real one.
   */
  now?: Date | string | null;
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
   * Whether Sleeper has positively said this league still has a draft to hold.
   *
   * Read here beside the completion for the same reason: one answer, used by
   * every branch that could otherwise take the board away over a calendar.
   */
  const draftPending = isDraftPending(input.draft?.status);
  const today = utcDay(input.now);

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

  /*
   * A draft this league has not held yet, which outranks every calendar.
   *
   * Placed *after* the stale-season check and before everything else: a league
   * the NFL has moved past is over whatever its draft row still says, and a
   * draft row left at `pre_draft` on a 2024 league must not resurrect a board
   * for it. Everything below this line is a statement about the calendar, and
   * none of them can be right about a league that has not drafted.
   *
   * This is the belt to `regularSeasonUnderWay`'s braces. The kickoff date
   * fixes the specific way the calendar was wrong in 2026; this makes the
   * *class* of failure impossible, because no answer Sleeper gives about the
   * season can take the board away from somebody whose picks have not been
   * made.
   */
  if (draftPending) {
    return {
      phase: 'preseason',
      draftVisible: true,
      reason: 'your draft has not finished yet',
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
     * Week one, kicked off — and only once it actually has.
     *
     * Sleeper flips `season_type` to `regular` well over a week before week one
     * and reports `week: 1` from that moment, so neither field can date the
     * kickoff on its own; `season_start_date`, published beside them, can. See
     * the module docblock for the read that proves it.
     */
    if (regularSeasonUnderWay(type, week, state?.seasonStartDate, today)) {
      return {
        phase: 'regular',
        draftVisible: false,
        reason: `the regular season is under way (week ${week})`,
        assumed: false,
      };
    }
    if (type === 'pre' || type === 'regular') {
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
