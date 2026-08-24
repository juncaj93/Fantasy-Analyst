/**
 * What to fetch next, and when to stop.
 *
 * The scheduler for a backfill that must never approach fifty subrequests in one
 * Worker invocation and must never re-read a fact that can no longer change. It
 * is pure: state in, an ordered list of work units out, and every unit costs a
 * known number of requests before it is attempted. That is what makes "no
 * invocation exceeds the budget" a property a test can assert rather than a
 * hope.
 *
 * ## Priority, and why it is this order
 *
 * Two rules from the brief decide everything here.
 *
 * **Draft history first, across every season, before any transaction week.**
 * Draft tendencies are the cheap signal — two requests buys a whole season's
 * draft — and they are the one consumer that must not wait for a transaction
 * backfill that takes days. So every pending draft unit outranks every
 * transaction unit, regardless of season.
 *
 * **Then newest history before oldest.** Current season, then the most recent
 * completed one, then back. A partial backfill should describe the league as it
 * is now; a walk that started in 2021 would spend its first week teaching the
 * app about managers who have left.
 *
 * Within all of that, identity comes before the facts it identifies. A season's
 * picks and transactions are roster-shaped, and a roster id is meaningless
 * without that season's own roster map — so ingesting a season before mapping
 * it would store facts nobody can be held to.
 *
 * ## One unit, one request, one checkpoint
 *
 * Every unit is sized so that finishing it is worth checkpointing and abandoning
 * it costs at most one request. There is no unit that spends three requests and
 * is useless after two, which is what makes an interrupted batch resume cleanly
 * rather than half-done.
 */

/** The two datasets the ledger fills, and the two checkpoint families. */
export type DatasetName = 'drafts' | 'transactions';

/**
 * How deep the previous-league chain is followed before the walk gives up.
 *
 * A loop guard, not a history policy. Sleeper's chain is a finite linked list
 * and terminates on its own at the league's first season; this exists so that a
 * cycle in the data — which would otherwise be an infinite walk making one
 * request a day for ever — ends visibly instead. Twenty seasons is longer than
 * fantasy football has had Sleeper.
 */
export const MAX_CHAIN_DEPTH = 20;

/**
 * The last transaction leg Sleeper will answer for.
 *
 * Sleeper indexes transactions by leg, and a league's legs run to 18 in the
 * modern schedule. Weeks past the end of a league's own season answer with an
 * empty list rather than an error, which is a real observation — "nobody did
 * anything" — and is stored as one.
 */
export const MAX_TRANSACTION_WEEK = 18;

export interface SeasonDraftState {
  /**
   * True when the draft index is current: work is known from it.
   *
   * Set from "there are completed drafts still to ingest" rather than from "the
   * index has ever been read", and the difference is what makes a live draft
   * work. A season whose index is read and yields nothing pending is a season
   * whose draft has not finished yet, and re-reading the index is exactly how
   * this app notices when it does — one request a day, against a budget of
   * twenty-four, and it stops the moment the draft completes and its picks land.
   */
  indexFresh: boolean;
  /** Completed drafts whose picks are not yet in the ledger. */
  pendingDraftIds: string[];
  /** True when no draft in this season can yield anything new. */
  completed: boolean;
}

export interface SeasonTransactionState {
  /** Weeks already read and settled, so they can never change again. */
  settledWeeks: readonly number[];
  /**
   * The highest week worth reading in this season.
   *
   * The current week for a live season — a week still in play is re-read every
   * batch, because a waiver run lands between two of them — and the full
   * eighteen for a finished one.
   */
  throughWeek: number;
  completed: boolean;
}

export interface SeasonState {
  sleeperLeagueId: string;
  season: string;
  /** Sleeper's own league status, when it has been read. */
  status: string | null;
  /** The next link in the chain. Null when this is the oldest season. */
  previousLeagueId: string | null;
  /** True once this season's own `previous_league_id` has been read. */
  resolved: boolean;
  /** True once this season's roster map is stored. */
  identityKnown: boolean;
  drafts: SeasonDraftState;
  transactions: SeasonTransactionState;
}

export interface BackfillState {
  /** The season the league is currently playing, from Sleeper's own state. */
  currentSeason: string;
  /** Every season discovered so far, in any order. */
  seasons: readonly SeasonState[];
}

export type WorkUnit =
  /** Read one league, for its season, its status and its previous-league link. */
  | { kind: 'discover'; sleeperLeagueId: string; season: string | null }
  /** Read one season's rosters, to map roster ids to Sleeper user ids. */
  | { kind: 'identity'; sleeperLeagueId: string; season: string }
  /** Read one season's draft list, to learn which drafts exist and finished. */
  | { kind: 'draft-index'; sleeperLeagueId: string; season: string }
  /** Read one completed draft's picks. */
  | { kind: 'draft-picks'; sleeperLeagueId: string; season: string; draftId: string }
  /** Read one week of one season's transactions. */
  | { kind: 'transactions'; sleeperLeagueId: string; season: string; week: number };

/** Every unit is exactly one Sleeper request. See the header for why. */
export const UNIT_COST = 1;

export interface BackfillPlan {
  units: WorkUnit[];
  /** True when the budget, rather than the work, ended the list. */
  budgetBound: boolean;
  /** Units that were wanted and did not fit. Diagnostics only. */
  deferred: number;
}

/**
 * Seasons in the order the brief asks for: current, then newest back.
 *
 * A string comparison rather than a numeric one, because a Sleeper season is a
 * string and always four digits — and because a season that somehow is not
 * still sorts deterministically instead of becoming NaN and floating to one end.
 */
export function prioritiseSeasons(seasons: readonly SeasonState[], currentSeason: string): SeasonState[] {
  return [...seasons].sort((a, b) => {
    if (a.season === b.season) return a.sleeperLeagueId.localeCompare(b.sleeperLeagueId);
    if (a.season === currentSeason) return -1;
    if (b.season === currentSeason) return 1;
    return b.season.localeCompare(a.season);
  });
}

/**
 * Weeks still worth fetching for one season, newest first.
 *
 * Newest first is what makes a half-finished season useful: the weeks that
 * price today's waiver run are read before week 1, and a league whose backfill
 * is three days old already knows about this month.
 */
export function weeksToFetch(state: SeasonTransactionState): number[] {
  const settled = new Set(state.settledWeeks);
  const out: number[] = [];
  for (let week = Math.min(state.throughWeek, MAX_TRANSACTION_WEEK); week >= 1; week--) {
    if (!settled.has(week)) out.push(week);
  }
  return out;
}

/**
 * The ordered work list, cut to what the budget can pay for.
 *
 * `budget` is a count of requests, not of units — they happen to be equal today
 * because every unit is one request, and `UNIT_COST` is where that assumption
 * lives so a future two-request unit changes one line rather than the whole
 * file.
 *
 * Nothing here performs I/O or mutates its input, so a caller may plan, execute
 * part of the plan, and re-plan from updated state without the two disagreeing.
 */
export function planBackfill(state: BackfillState, budget: number): BackfillPlan {
  const wanted = enumerateWork(state);
  const affordable = Math.max(0, Math.floor(budget / UNIT_COST));
  const units = wanted.slice(0, affordable);
  return {
    units,
    budgetBound: wanted.length > units.length,
    deferred: wanted.length - units.length,
  };
}

/**
 * Every unit that is wanted right now, in priority order and without a budget.
 *
 * Split out so the ordering can be tested independently of the cut, and so
 * diagnostics can report how much work is outstanding rather than only how much
 * fits in the next batch.
 */
export function enumerateWork(state: BackfillState): WorkUnit[] {
  const ordered = prioritiseSeasons(state.seasons, state.currentSeason);
  const units: WorkUnit[] = [];

  /*
   * Identity and drafts, season by season, in priority order.
   *
   * Both in the same pass because a season's drafts are unusable without its
   * roster map: `picked_by` covers most picks, but the map is what rescues the
   * rest, and a season ingested before it is mapped would store the picks it
   * could not attribute as permanently anonymous.
   */
  for (const season of ordered) {
    if (!season.identityKnown) {
      units.push({ kind: 'identity', sleeperLeagueId: season.sleeperLeagueId, season: season.season });
    }
    if (season.drafts.completed) continue;
    if (!season.drafts.indexFresh) {
      units.push({ kind: 'draft-index', sleeperLeagueId: season.sleeperLeagueId, season: season.season });
      // The draft ids are not known until the index is read, so this season's
      // picks cannot be planned in the same round. The next one gets them.
      continue;
    }
    for (const draftId of season.drafts.pendingDraftIds) {
      units.push({ kind: 'draft-picks', sleeperLeagueId: season.sleeperLeagueId, season: season.season, draftId });
    }
  }

  /*
   * Extending the chain, after the drafts of everything already known.
   *
   * One link per round, because a link is only discoverable once the league
   * before it has been read. Placed here rather than first so that a league
   * with six seasons of history does not spend its first batch learning that
   * 2021 exists while the current season's draft — the signal that actually
   * reaches `Next%` this week — waits behind it.
   */
  const tail = unresolvedChainLink(state);
  if (tail) units.push(tail);

  /*
   * Transactions last, and only for seasons whose identity is already known.
   *
   * A transaction is a fact about people. Storing a week before the season's
   * roster map exists would file every claim in it against nobody, and the
   * derivation would have to be re-run rather than the week re-fetched — which
   * is recoverable, but only by re-reading the ledger for no reason.
   */
  for (const season of ordered) {
    if (season.transactions.completed || !season.identityKnown) continue;
    for (const week of weeksToFetch(season.transactions)) {
      units.push({ kind: 'transactions', sleeperLeagueId: season.sleeperLeagueId, season: season.season, week });
    }
  }

  return units;
}

/**
 * The one league the chain can be extended by, if any.
 *
 * The oldest known season that names a previous league nobody has read yet.
 * Returns nothing when the chain is fully walked — which is the ordinary
 * steady state, and the reason a maintained league costs no discovery requests
 * at all.
 */
export function unresolvedChainLink(state: BackfillState): WorkUnit | null {
  if (state.seasons.length >= MAX_CHAIN_DEPTH) return null;
  const known = new Set(state.seasons.map((s) => s.sleeperLeagueId));

  // Oldest first: the tail of the chain is where the unread link is.
  const oldestFirst = [...state.seasons].sort((a, b) => a.season.localeCompare(b.season));
  for (const season of oldestFirst) {
    if (!season.resolved) {
      return { kind: 'discover', sleeperLeagueId: season.sleeperLeagueId, season: season.season };
    }
    if (season.previousLeagueId && !known.has(season.previousLeagueId)) {
      /*
       * The season this link points at, derived rather than guessed.
       *
       * Sleeper's chain is strictly one season per link, so the previous
       * league's season is this one minus one — that is a property of the data
       * structure, not an assumption about the league. It is carried on the
       * unit so that a league which cannot be read at all (deleted, or made
       * private) can still be filed against the right year and marked
       * unavailable, instead of being retried for ever with no season to
       * record it under.
       */
      const parentYear = Number(season.season);
      return {
        kind: 'discover',
        sleeperLeagueId: season.previousLeagueId,
        season: Number.isFinite(parentYear) ? String(parentYear - 1) : null,
      };
    }
  }
  return null;
}

/**
 * Whether anything is left to fetch. The answer diagnostics report as "done".
 *
 * A live season is never done — its current week is always re-readable — so
 * this is `true` only for a league whose every season is finished and stored.
 */
export function backfillComplete(state: BackfillState): boolean {
  return enumerateWork(state).length === 0;
}
