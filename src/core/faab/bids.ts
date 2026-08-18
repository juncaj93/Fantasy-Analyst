/**
 * What bids in this league have actually won, and what they have lost.
 *
 * The honest half of FAAB advice. A recommendation built on a general sense of
 * what players "usually go for" is a recommendation built on somebody else's
 * league; the only prices that predict this league are the ones paid in it.
 *
 * Two asymmetries govern everything here, and both are limits rather than
 * features:
 *
 *   - **Winning bids are observable, losing bids largely are not.** A completed
 *     waiver transaction carries the winning bid. Sleeper publishes the user's
 *     own failed claims, and other managers' failed claims inconsistently or not
 *     at all. So the losing side is reported as a floor with an explicit
 *     completeness flag, and when nothing usable is present the answer is
 *     `unknown` — never an inferred distribution dressed up as observation.
 *   - **A price is a price for a player, not for a market.** Ten dollars in week
 *     2 for a breakout back and ten dollars in week 14 for a bye-week filler are
 *     the same number and not the same event. Every observation therefore keeps
 *     its week and its position, and the summary is computed over whatever slice
 *     the caller asks for rather than over everything at once.
 *
 * No private or undocumented endpoint is read, and none is needed: everything
 * below is derived from `/league/{id}/transactions/{week}`.
 */

import type { SleeperTransaction } from '../sleeper/types.ts';

export interface BidObservation {
  transactionId: string;
  week: number;
  rosterId: number;
  playerId: string | null;
  amount: number;
  outcome: 'won' | 'lost';
}

export interface BidHistory {
  observations: BidObservation[];
  /** Winning bids only — the reliable half. */
  won: BidObservation[];
  /**
   * Failed claims that carried a bid. A floor on what competition costs, never
   * a complete picture — see `losingBidsComplete`.
   */
  lost: BidObservation[];
  /**
   * False whenever the losing side may be partial, which in practice is always
   * unless the league genuinely had no failed claims in the window read.
   */
  losingBidsComplete: boolean;
  weeksRead: number[];
}

/**
 * Pull every bid out of a set of transactions.
 *
 * `weeksRead` is carried through rather than inferred from the rows, because a
 * week with no transactions is a real observation — "nobody bid" — and a summary
 * that cannot tell it apart from "we did not look" will overstate its own
 * coverage.
 */
export function collectBids(transactions: SleeperTransaction[], weeksRead: number[]): BidHistory {
  const observations: BidObservation[] = [];

  for (const txn of transactions) {
    if (txn.type !== 'waiver') continue;
    const amount = txn.settings?.['waiver_bid'];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) continue;

    const outcome: 'won' | 'lost' | null =
      txn.status === 'complete' ? 'won' : txn.status === 'failed' ? 'lost' : null;
    // `pending` is not yet an event. Anything else is a status this app does not
    // claim to understand, and guessing at it is how a "lost" bid becomes a
    // phantom competitor in the price model.
    if (outcome == null) continue;

    const rosterId = txn.roster_ids?.[0];
    if (typeof rosterId !== 'number') continue;

    const playerId = firstAddedPlayer(txn);
    observations.push({
      transactionId: txn.transaction_id,
      week: typeof txn.leg === 'number' ? txn.leg : 0,
      rosterId,
      playerId,
      amount: Math.round(amount),
      outcome,
    });
  }

  const won = observations.filter((o) => o.outcome === 'won');
  const lost = observations.filter((o) => o.outcome === 'lost');

  return {
    observations,
    won,
    lost,
    /*
     * The only case in which the losing side is provably whole.
     *
     * If the league bid at all and no failed claim came back, either nobody
     * lost — possible in a quiet league — or Sleeper withheld them, and there is
     * no way to tell which from here. Both are reported as incomplete, because
     * the cost of overstating this is a confidently wrong price.
     */
    losingBidsComplete: won.length === 0 && lost.length === 0,
    weeksRead: [...weeksRead].sort((a, b) => a - b),
  };
}

/** The player a waiver claim was for. A claim adds exactly one, in practice. */
function firstAddedPlayer(txn: SleeperTransaction): string | null {
  const adds = txn.adds;
  if (!adds) return null;
  for (const id of Object.keys(adds)) return id;
  return null;
}

export interface PriceSummary {
  /** How many winning bids the figures below rest on. */
  sample: number;
  median: number | null;
  /** The 25th and 75th percentiles — the "expected range" a card shows. */
  low: number | null;
  high: number | null;
  max: number | null;
  /**
   * Highest observed *failed* bid. The floor on what it takes to beat the room,
   * and null when no failed claim was visible.
   */
  highestLosing: number | null;
  losingBidsComplete: boolean;
  /** Plain English, for the card, so a thin sample is never silently thin. */
  confidence: 'none' | 'low' | 'medium' | 'high';
}

/**
 * The minimum number of winning bids before this league's own prices lead.
 *
 * Three is not a distribution and everybody knows it. It is, however, enough to
 * say whether this is a league where waivers go for two dollars or for forty,
 * which is the single most useful thing a price model can know and the thing a
 * generic prior gets most wrong.
 */
export const MIN_PRICE_SAMPLE = 3;

/**
 * Summarise what winning has cost, over whatever slice the caller selected.
 *
 * Deliberately percentile-based rather than mean-based: FAAB spending is a
 * long-tailed distribution where one $71 panic bid on a breakout back will drag
 * a mean into a range nobody has ever actually paid.
 */
export function summarisePrices(history: BidHistory, filter?: (o: BidObservation) => boolean): PriceSummary {
  const won = (filter ? history.won.filter(filter) : history.won).map((o) => o.amount).sort((a, b) => a - b);
  const lost = filter ? history.lost.filter(filter) : history.lost;
  const highestLosing = lost.length > 0 ? Math.max(...lost.map((o) => o.amount)) : null;

  if (won.length === 0) {
    return {
      sample: 0,
      median: null,
      low: null,
      high: null,
      max: null,
      highestLosing,
      losingBidsComplete: history.losingBidsComplete,
      confidence: 'none',
    };
  }

  return {
    sample: won.length,
    median: percentile(won, 0.5),
    low: percentile(won, 0.25),
    high: percentile(won, 0.75),
    max: won[won.length - 1] ?? null,
    highestLosing,
    losingBidsComplete: history.losingBidsComplete,
    confidence: won.length >= 8 ? 'high' : won.length >= MIN_PRICE_SAMPLE ? 'medium' : 'low',
  };
}

/**
 * Nearest-rank percentile on an already-sorted ascending list.
 *
 * Nearest-rank rather than interpolated, because every value here is a whole
 * number of dollars somebody really paid and $12.50 is not a bid.
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/**
 * What can honestly be said about losing bids, in one sentence.
 *
 * Section 4 of the brief asks for `unknown` when losing bids cannot be
 * reconstructed, and this is where that word is actually produced rather than
 * quietly rounded into a number.
 */
export function losingBidNote(summary: PriceSummary): string {
  if (summary.highestLosing == null) {
    return 'Losing bids: unknown — Sleeper did not publish any failed claims for this window.';
  }
  const line = `Highest losing bid seen: $${summary.highestLosing}`;
  return summary.losingBidsComplete ? `${line}.` : `${line} (other managers’ failed claims are not all published).`;
}
