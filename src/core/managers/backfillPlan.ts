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

/**
 * The datasets the ledger fills, and the checkpoint families that track them.
 *
 * `identity` earns a checkpoint of its own even though it writes no ledger
 * rows, because "we asked and the answer was nothing" and "we never asked" are
 * different states and only one of them should be retried. A season whose
 * rosters come back empty — Sleeper does return that — would otherwise be
 * re-requested every single day for ever, since the test for "identity known"
 * would be a row count that never leaves zero.
 */
export type DatasetName = 'drafts' | 'transactions' | 'identity';

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
 * How many seasons of history this app is willing to hold an opinion about.
 *
 * A product policy, and the counterpart to {@link MAX_CHAIN_DEPTH} rather than a
 * second copy of it: that one stops a cycle, this one stops a walk that would
 * terminate correctly and still not be worth taking. Sleeper keeps every season
 * a league has ever played, and a league founded in 2016 is ten chain links and
 * a fortnight of daily batches deep — for seasons the derivation has already
 * decided are nearly worthless.
 *
 * **Four, counting the current season as the first.** The number comes from the
 * weighting rather than from taste. `tradeProfile.SEASON_DECAY` and
 * `tradeTendencies.seasonDecay` are both 0.6 and compound on a season's age
 * against the newest one on record, so the four seasons in policy carry weights
 * 1, 0.6, 0.36 and 0.216 — and the fifth would arrive at 0.13, roughly an
 * eighth of a vote, in exchange for another season's worth of drafts and
 * eighteen transaction weeks. Every request that buys the fifth season buys
 * less than a tenth of what the same request buys in the first.
 *
 * The window moves with the league's current season, so it is a rolling four
 * and not a fixed floor: a chain walked to 2023 today stops at 2024 next year
 * without anything being reconfigured.
 *
 * What this does **not** do is delete. Seasons already in the ledger stay there
 * and stay readable; the policy governs what is *fetched* from here on, which
 * is where the budget is spent. There are no exceptions by league name, size or
 * age — a policy with an exception is not one a test can hold.
 */
export const MAX_HISTORY_SEASONS = 4;

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
 * The oldest season {@link MAX_HISTORY_SEASONS} still admits, as a year.
 *
 * Null when the current season is not a number this can count back from, which
 * is the one case where the policy declines to apply rather than guessing —
 * a league whose season string is unparseable falls back to the chain depth
 * guard, which is a worse bound but a real one.
 */
export function oldestSeasonInPolicy(currentSeason: string): number | null {
  const current = Number(currentSeason);
  if (!Number.isFinite(current)) return null;
  return current - (MAX_HISTORY_SEASONS - 1);
}

/**
 * Whether one season is inside the history policy.
 *
 * A season *newer* than the current one is in policy too. That is not a case
 * this app expects to see, but the alternative — a January state that still
 * reads December's season while the ledger has already seen the new one —
 * would silently refuse to fetch the league that is actually being played.
 *
 * An unknown season (a chain link discovered before its year is known) is in
 * policy: refusing what cannot be judged would stop the walk at the first link
 * whose season Sleeper had not yet told us.
 */
export function withinHistoryPolicy(season: string | null, currentSeason: string): boolean {
  if (season == null) return true;
  const floor = oldestSeasonInPolicy(currentSeason);
  if (floor == null) return true;
  const year = Number(season);
  if (!Number.isFinite(year)) return true;
  return year >= floor;
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
  /*
   * Priority order first, then the history policy, and the order of those two
   * does not matter — but the filter's position does. It is applied once, here,
   * so that every kind of unit below inherits it: a season outside the window
   * yields no identity read, no draft index, no picks and no transaction week,
   * and there is no path that quietly exempts one dataset. A season already in
   * the ledger from before the policy existed simply stops being asked about.
   */
  const ordered = prioritiseSeasons(state.seasons, state.currentSeason).filter((season) =>
    withinHistoryPolicy(season.season, state.currentSeason),
  );
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
  /*
   * The cycle guard first, and independently of the history policy.
   *
   * The two bounds answer different questions and neither implies the other.
   * Ordinarily the policy stops the walk long before twenty seasons — each link
   * is a year older than the one before it, so the fourth is the last — but
   * that reasoning rests on the chain's seasons descending, which is exactly
   * what a cycle in Sleeper's data does not do. A chain that loops back to a
   * league of the same year stays inside the window for ever, and this is what
   * ends it.
   */
  if (state.seasons.length >= MAX_CHAIN_DEPTH) return null;
  const known = new Set(state.seasons.map((s) => s.sleeperLeagueId));

  /*
   * Oldest first: the tail of the chain is where the unread link is. Seasons
   * past the window are skipped rather than walked — reading one to learn what
   * came before it would spend a request extending a chain nothing may fetch.
   */
  const oldestFirst = [...state.seasons]
    .filter((season) => withinHistoryPolicy(season.season, state.currentSeason))
    .sort((a, b) => a.season.localeCompare(b.season));
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
      const parentSeason = Number.isFinite(parentYear) ? String(parentYear - 1) : null;
      /*
       * And this is where a ten-season league stops being a ten-season league.
       *
       * The link is left unread rather than followed: the season it points at
       * is outside the window, so discovering it would cost a request to learn
       * the name of a year nothing is allowed to fetch. Returning null here
       * rather than continuing the loop is deliberate — the seasons after this
       * one in the walk are all older still.
       */
      if (!withinHistoryPolicy(parentSeason, state.currentSeason)) return null;
      return {
        kind: 'discover',
        sleeperLeagueId: season.previousLeagueId,
        season: parentSeason,
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
