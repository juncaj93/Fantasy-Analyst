/**
 * Where the season is, at the resolution features actually need.
 *
 * `resolveSeasonPhase` answers one question well — should the Draft tab exist —
 * and four phases is exactly enough for that. It is not enough for anything
 * else. "Preseason" covers the week a draft is scheduled but has not opened,
 * the hours it is live, and the month afterwards when the roster is set and the
 * board is a reference; those are three different apps, and screens that wanted
 * to tell them apart were reaching for the draft's `status` string or, worse,
 * the date.
 *
 * So this is the same decision at higher resolution: eight states, derived from
 * the same witnesses, with the phase kept alongside so nothing that already
 * depends on the four-state answer has to change. The draft-shaped states are
 * the reason this exists, and they come from Sleeper's own draft status rather
 * than from a start time, because a draft that was scheduled for eight o'clock
 * and started at ten past is `pre_draft` for those ten minutes and the app
 * should say so.
 *
 * **Nothing here is time arithmetic.** Every state is read off a field a
 * provider published. That is what makes it survive a rollover: 2027 needs no
 * new dates written down, because no dates were written down.
 */

import { resolveSeasonPhase, type NflState, type SeasonPhase } from '../sleeper/phase.ts';

/**
 * The eight states, in the order a season passes through them.
 *
 * `offseason` sits first because it is where a season both ends and begins: the
 * February after a season completes is the same calendar as the February before
 * the next one, and the thing that separates them is which season the league
 * belongs to, not which state it is in.
 */
export type SeasonLifecycle =
  /** No league for the current season yet, or the league's season has passed. */
  | 'offseason'
  /** Current-season league exists; no draft is scheduled or open. */
  | 'preseason'
  /** A draft exists and is open for entry — Sleeper's `pre_draft`. */
  | 'draft_open'
  /** Picks are being made right now — Sleeper's `drafting`. */
  | 'draft_live'
  /** The draft is complete and week one has not kicked off. */
  | 'post_draft'
  /** The regular season is under way. */
  | 'regular_season'
  /** The NFL is in its postseason. */
  | 'playoffs'
  /** This league's season is finished. */
  | 'season_complete';

export interface LifecycleResolution {
  lifecycle: SeasonLifecycle;
  /** The four-state phase, unchanged, for everything that already reads it. */
  phase: SeasonPhase;
  /** Whether Draft belongs in primary navigation right now. */
  draftVisible: boolean;
  /**
   * Whether Matchup belongs in primary navigation right now.
   *
   * The mirror image of `draftVisible`, and deliberately computed here beside
   * it: a head-to-head has nothing to say until a draft is finished — every
   * lineup is empty and every projection is zero — and from that moment on it is
   * the screen an in-season reader opens first. The two facts are one decision
   * about where the season is, and answering them in two places is how a bar
   * ends up showing both or neither.
   *
   * A *live* draft deliberately does not qualify. Picks are still being made,
   * the roster is half a roster, and a matchup built from it would be a
   * projection of a team that does not exist yet.
   */
  matchupVisible: boolean;
  /** True while picks are being made — the only state that justifies fast polling. */
  draftLive: boolean;
  /** Which witness decided it, in the user's language. */
  reason: string;
  /** True when nothing was known and the safe default was taken. */
  assumed: boolean;
}

export interface LifecycleInput {
  state?: NflState | null;
  league?: { season?: string | null; status?: string | null } | null;
  draft?: { status?: string | null; season?: string | null } | null;
}

/** Sleeper draft statuses, lower-cased, that mean picks are being made. */
const LIVE_DRAFT_STATUSES = new Set(['drafting', 'in_progress', 'live']);
/** Statuses that mean a draft exists and is waiting to start. */
const OPEN_DRAFT_STATUSES = new Set(['pre_draft', 'predraft', 'paused']);
const COMPLETE_DRAFT_STATUSES = new Set(['complete', 'completed', 'done']);

/**
 * Is every pick in?
 *
 * Exported because two very different pieces of code have to agree on it, and a
 * disagreement between them is not a cosmetic bug. This module reads it to move
 * the app into `post_draft` — which takes Team out of draft mode and puts
 * Matchup in the bar — and the Sleeper sync reads it to decide that the rosters
 * the draft produced are now worth fetching. If one of them thought `done` was
 * a completed draft and the other did not, the navigation would announce a
 * finished draft over a roster the app had never gone back for, which is exactly
 * the split this predicate exists to make impossible.
 */
export function isDraftComplete(status: string | null | undefined): boolean {
  return COMPLETE_DRAFT_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

export function resolveLifecycle(input: LifecycleInput): LifecycleResolution {
  const phase = resolveSeasonPhase({
    state: input.state,
    league: input.league,
    draft: input.draft ? { status: input.draft.status } : null,
  });

  const draftStatus = (input.draft?.status ?? '').trim().toLowerCase();

  /*
   * A live draft outranks every other witness.
   *
   * Not a stylistic preference — a correctness one. Sleeper flips
   * `season_type` to `regular` a little before week one, and leagues that draft
   * late are still drafting when it does. If the regular-season witness won
   * there, the board would vanish out from under a user mid-pick, which is the
   * single worst thing this app can do. A draft that is actively taking picks
   * is proof the draft has not happened yet, whatever the calendar says.
   */
  if (LIVE_DRAFT_STATUSES.has(draftStatus)) {
    return {
      lifecycle: 'draft_live',
      phase: 'preseason',
      draftVisible: true,
      matchupVisible: false,
      draftLive: true,
      reason: 'your draft is live',
      assumed: false,
    };
  }

  // The season is over: nothing about a draft is interesting any more.
  if (phase.phase === 'offseason') {
    return {
      lifecycle: 'offseason',
      phase: phase.phase,
      draftVisible: false,
      matchupVisible: false,
      draftLive: false,
      reason: phase.reason,
      assumed: phase.assumed,
    };
  }

  if (phase.phase === 'postseason') {
    /*
     * Two different endings.
     *
     * The NFL being in its postseason and *this league* having finished are not
     * the same fact — a league whose Sleeper status says `complete` is done
     * whatever the NFL is doing, and its user has nothing left to decide. The
     * league's own word is therefore preferred where it exists.
     */
    const leagueStatus = (input.league?.status ?? '').trim().toLowerCase();
    const finished = leagueStatus === 'complete' || leagueStatus === 'completed';
    return {
      lifecycle: finished ? 'season_complete' : 'playoffs',
      phase: phase.phase,
      draftVisible: false,
      // A finished league has no next matchup; a league in the NFL postseason
      // may still be playing its own, so the screen stays reachable.
      matchupVisible: !finished,
      draftLive: false,
      reason: finished ? 'this league has finished its season' : phase.reason,
      assumed: phase.assumed,
    };
  }

  if (phase.phase === 'regular') {
    return {
      lifecycle: 'regular_season',
      phase: phase.phase,
      draftVisible: false,
      matchupVisible: true,
      draftLive: false,
      reason: phase.reason,
      assumed: phase.assumed,
    };
  }

  // Preseason, split three ways by what the draft is doing.
  if (isDraftComplete(draftStatus)) {
    return {
      lifecycle: 'post_draft',
      phase: phase.phase,
      draftVisible: true,
      matchupVisible: true,
      draftLive: false,
      reason: 'your draft is done — the season has not started',
      assumed: phase.assumed,
    };
  }
  if (OPEN_DRAFT_STATUSES.has(draftStatus)) {
    return {
      lifecycle: 'draft_open',
      phase: phase.phase,
      draftVisible: true,
      matchupVisible: false,
      draftLive: false,
      reason: 'your draft is set up and has not started',
      assumed: phase.assumed,
    };
  }

  return {
    lifecycle: 'preseason',
    phase: phase.phase,
    draftVisible: true,
    matchupVisible: false,
    draftLive: false,
    reason: phase.reason,
    assumed: phase.assumed,
  };
}

/**
 * How often the draft may be polled in this state, in seconds; 0 means never.
 *
 * Kept here rather than in the refresh controller because it is a fact about
 * the season, not about the network: there is no cadence at which polling a
 * finished draft is correct. The controller still owns backoff and the
 * on-the-clock case — this is the ceiling those work underneath.
 */
export function pollBudgetSeconds(lifecycle: SeasonLifecycle): number {
  switch (lifecycle) {
    case 'draft_live':
      return 5;
    case 'draft_open':
      return 30;
    case 'preseason':
    case 'post_draft':
      return 300;
    default:
      return 0;
  }
}
