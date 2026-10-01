/**
 * How often each manager actually bids, and how big, measured per chance.
 *
 * `transactionProfile.ts` already describes a manager's spending, but it reads
 * only *winning* claims and measures activity per calendar week. Both choices
 * are right for what that file feeds and both are wrong for the question the
 * Competition rows ask about a named rival — *will this person bid, and what
 * do they usually put in?*
 *
 *   - **A losing bid is still a bid.** A manager who claims every Wednesday and
 *     loses most of them is an active bidder. Counting only wins makes them look
 *     as quiet as somebody who never opens the waiver screen.
 *   - **A week with no waiver run is not a pass.** Week 1 before waivers open, a
 *     bye-heavy week nobody claimed in: nobody had a chance to bid. The
 *     denominator here is the waiver runs the league actually processed, so
 *     "2 of 15" means fifteen real chances and two taken.
 *
 * ## Thin data blends toward the room, in the open
 *
 * Both readings are shrunk toward the league with the same plain rule:
 * `PRIOR_RUNS` imaginary waiver runs, and `PRIOR_BIDS` imaginary bids, at the
 * league's own average are added to the manager's real record. Four real runs
 * and the manager's own rate carries half the weight; forty and it carries
 * nine tenths. Nothing is a black box — the card shows the raw counts and the
 * blend only decides the words around them.
 *
 * ## What this is not allowed to reach
 *
 * It describes rivals. It never feeds `core/faab/strategy.ts`, the expected
 * cost or the recommended max — the double-counting rule at the top of
 * `core/league/bidders.ts` holds unchanged.
 */

import type { LedgerTransaction } from './ledger.ts';

export const BIDDING_PRIOR = {
  /**
   * Imaginary waiver runs at the league's participation rate, added to a
   * manager's own record before a rate is read off it.
   */
  runs: 4,
  /** Imaginary bids at the league's median size, for the same reason. */
  bids: 4,
} as const;

/** The furthest a manager's bid size may sit from the room, either way. Matches `MAX_TENDENCY_EFFECT`. */
export const MAX_BID_SIZE_EFFECT = 0.4;

export interface ManagerBidding {
  /** Waiver runs the manager was in the league for. The denominator. */
  opportunities: number;
  /** Of those, runs with at least one claim submitted, won or lost. */
  bidRuns: number;
  /** The same two counts for the latest season alone. */
  seasonOpportunities: number;
  seasonBidRuns: number;
  /** Earliest season the counts reach back to. Null when there are none. */
  since: string | null;
  /** Share of runs the room bids in, per manager. */
  roomRate: number;
  /** The manager's rate, blended toward the room's by {@link BIDDING_PRIOR.runs}. */
  rate: number;
  /** Claims submitted, won and lost. The bid-size sample. */
  bids: number;
  /** Median of those claims as a share of the budget. Null without bids or a budget. */
  medianBidShare: number | null;
  /** The middle manager's median claim, won and lost, as a share of the budget. */
  roomMedianBidShare: number | null;
  /**
   * Bid size against the room's, blended by {@link BIDDING_PRIOR.bids} and
   * bounded to ±{@link MAX_BID_SIZE_EFFECT}. 1 means typical. Null when the
   * league publishes no bid amounts.
   */
  sizeRelative: number | null;
  /** How much of {@link sizeRelative} is the manager's own record: `n / (n + k)`. */
  sizeWeight: number;
}

export interface BiddingInput {
  /** Every transaction in the ledger, any status, already user-resolved. */
  transactions: readonly LedgerTransaction[];
  /** Which seasons each user was in the league for. */
  seasonsByUser: ReadonlyMap<string, string[]>;
  budgetTotal: number | null;
}

/** A claim that reached a waiver run: processed, whether it won or lost. */
function isSubmittedClaim(txn: LedgerTransaction): boolean {
  return txn.type === 'waiver' && (txn.status === 'complete' || txn.status === 'failed');
}

/**
 * Every manager's bidding record, in one pass over the ledger.
 *
 * Keyed by Sleeper user id. Includes every user in `seasonsByUser`, so a
 * manager with no transactions at all comes back as "0 of 35" rather than as
 * a gap that reads like missing data.
 */
export function buildBiddingProfiles(input: BiddingInput): Map<string, ManagerBidding> {
  const claims = input.transactions.filter(isSubmittedClaim);

  // Waiver runs: the weeks of each season in which the league processed a claim.
  const runsBySeason = new Map<string, Set<number>>();
  for (const txn of claims) {
    const set = runsBySeason.get(txn.season) ?? new Set<number>();
    set.add(txn.week);
    runsBySeason.set(txn.season, set);
  }
  const latestSeason = [...runsBySeason.keys()].sort().at(-1) ?? null;

  const users = new Set<string>(input.seasonsByUser.keys());
  for (const txn of claims) for (const userId of txn.userIds) users.add(userId);

  const bidRunKeys = new Map<string, Set<string>>();
  const amounts = new Map<string, number[]>();
  for (const txn of claims) {
    for (const userId of txn.userIds) {
      const keys = bidRunKeys.get(userId) ?? new Set<string>();
      keys.add(`${txn.season}:${txn.week}`);
      bidRunKeys.set(userId, keys);
      if (txn.waiverBid != null) {
        const list = amounts.get(userId) ?? [];
        list.push(txn.waiverBid);
        amounts.set(userId, list);
      }
    }
  }

  // Raw counts first, so the room's rate is the pooled rate of the people in it.
  const raw = new Map<string, { opportunities: number; bidRuns: number; seasonOpp: number; seasonBid: number; since: string | null }>();
  let roomOpp = 0;
  let roomBid = 0;
  for (const userId of users) {
    const seasons = input.seasonsByUser.get(userId) ?? [...new Set(claims.filter((t) => t.userIds.includes(userId)).map((t) => t.season))];
    const keys = bidRunKeys.get(userId) ?? new Set<string>();
    let opportunities = 0;
    let bidRuns = 0;
    let seasonOpp = 0;
    let seasonBid = 0;
    let since: string | null = null;
    for (const season of seasons) {
      const runs = runsBySeason.get(season);
      if (!runs || runs.size === 0) continue;
      if (since == null || season < since) since = season;
      let taken = 0;
      for (const week of runs) if (keys.has(`${season}:${week}`)) taken += 1;
      opportunities += runs.size;
      bidRuns += taken;
      if (season === latestSeason) {
        seasonOpp = runs.size;
        seasonBid = taken;
      }
    }
    raw.set(userId, { opportunities, bidRuns, seasonOpp, seasonBid, since });
    roomOpp += opportunities;
    roomBid += bidRuns;
  }

  const roomRate = roomOpp > 0 ? roomBid / roomOpp : 0;
  const budget = input.budgetTotal && input.budgetTotal > 0 ? input.budgetTotal : null;
  /*
   * The room's typical bid is the middle *manager's* typical bid.
   *
   * Not the median of every claim: one manager who files two hundred $0
   * claims a season would set the room at $0 on their own, and then anybody
   * who bids real money reads as maximally aggressive. Each manager counts once.
   */
  const managerMedians = [...amounts.values()].filter((list) => list.length > 0).map((list) => median(list));
  const roomMedian = managerMedians.length > 0 ? median(managerMedians) : null;

  const out = new Map<string, ManagerBidding>();
  for (const [userId, r] of raw) {
    const mine = amounts.get(userId) ?? [];
    const myMedian = mine.length > 0 ? median(mine) : null;
    const sizeWeight = mine.length / (mine.length + BIDDING_PRIOR.bids);
    out.set(userId, {
      opportunities: r.opportunities,
      bidRuns: r.bidRuns,
      seasonOpportunities: r.seasonOpp,
      seasonBidRuns: r.seasonBid,
      since: r.since,
      roomRate: round3(roomRate),
      rate: round3((r.bidRuns + BIDDING_PRIOR.runs * roomRate) / (r.opportunities + BIDDING_PRIOR.runs)),
      bids: mine.length,
      medianBidShare: myMedian != null && budget ? round3(myMedian / budget) : null,
      roomMedianBidShare: roomMedian != null && budget ? round3(roomMedian / budget) : null,
      sizeRelative: sizeRelativeFor(myMedian, roomMedian, sizeWeight),
      sizeWeight: round3(sizeWeight),
    });
  }
  return out;
}

/**
 * A manager's typical bid against the room's, blended toward 1 by the size of his sample.
 *
 * In dollars plus one rather than as a plain ratio, because some rooms bid $0
 * constantly: a room median of $0 makes every ratio infinite, and the
 * dollar of smoothing is the smallest change that keeps "$5 against a $1 room"
 * readable as "bids above the room" without dividing by nothing.
 */
function sizeRelativeFor(myMedian: number | null, roomMedian: number | null, weight: number): number | null {
  if (roomMedian == null) return null;
  const personal = myMedian == null ? 1 : (myMedian + 1) / (roomMedian + 1);
  const blended = weight * personal + (1 - weight) * 1;
  return round3(Math.min(1 + MAX_BID_SIZE_EFFECT, Math.max(1 - MAX_BID_SIZE_EFFECT, blended)));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
