/**
 * What the waiver run actually did, once it has run.
 *
 * The named-bidder card is a forecast. This is the other half: after Wednesday,
 * who won, at what price, who lost and for how much, what it cost their wallets
 * — and, where the evidence exists, whether the rivals this app named were the
 * rivals who actually bid.
 *
 * That last part is the only self-grading in this workstream, and it is
 * deliberately narrow. Sleeper publishes the user's own failed claims reliably
 * and other managers' inconsistently, so a rival who does not appear in the
 * losing list may have bid and gone unpublished. A scorecard that read absence
 * as "we were wrong" would be marking itself against a source that does not
 * answer the question, so absence is reported as *unconfirmed* and only a
 * positive sighting counts either way.
 */

import type { BidObservation } from '../faab/bids.ts';

export interface SettledClaim {
  playerId: string | null;
  /** The roster that got him, when a claim succeeded. */
  winnerRosterId: number | null;
  winnerName: string | null;
  /** Dollars. Null when the league does not bid or the amount was not published. */
  winningBid: number | null;
  /** Losing bids that were published, biggest first. Never assumed complete. */
  losingBids: { rosterId: number; displayName: string | null; amount: number }[];
  losingBidsComplete: boolean;
}

export interface WalletChange {
  rosterId: number;
  displayName: string | null;
  spent: number;
  /** After the run, when the budget is known. */
  remaining: number | null;
}

export type PredictionOutcome = 'bid' | 'did_not_appear' | 'unconfirmed';

export interface PredictionCheck {
  rosterId: number;
  displayName: string | null;
  predictedRange: { low: number; high: number } | null;
  outcome: PredictionOutcome;
  /** What he actually put in, when it was published. */
  actualBid: number | null;
  /** True when a published amount fell inside the predicted range. */
  withinRange: boolean | null;
  note: string;
}

export interface WaiverRunReport {
  week: number;
  claims: SettledClaim[];
  wallets: WalletChange[];
  /** Empty when nothing was predicted for this week. */
  predictions: PredictionCheck[];
  /** One line per fact worth stating, safe to show. */
  notes: string[];
}

export interface WaiverRunInput {
  week: number;
  /** Bids from `collectBids`, already filtered to this week by the caller. */
  observations: BidObservation[];
  losingBidsComplete: boolean;
  /** Roster id → manager name, for anything the report prints. */
  names: Map<number, string>;
  /** Budget left per roster after the run, when known. */
  remainingByRoster?: Map<number, number | null>;
  /**
   * What this app said would happen, per player. Absent for a week nobody
   * asked about, which is the ordinary case and produces no scorecard rather
   * than an empty one.
   */
  predicted?: Map<string, { rosterId: number; estimate: { low: number; high: number } | null }[]>;
}

/**
 * Fold one week of published bids into what happened.
 *
 * Grouped by player rather than by transaction: a waiver run is a series of
 * contests, and the interesting object is the contest, not the paperwork.
 */
export function settleWaiverRun(input: WaiverRunInput): WaiverRunReport {
  const notes: string[] = [];
  const byPlayer = new Map<string, BidObservation[]>();
  for (const observation of input.observations) {
    const key = observation.playerId ?? '(unknown player)';
    const list = byPlayer.get(key) ?? [];
    list.push(observation);
    byPlayer.set(key, list);
  }

  const claims: SettledClaim[] = [];
  for (const [playerId, observations] of byPlayer) {
    const winner = observations.find((o) => o.outcome === 'won') ?? null;
    const losers = observations
      .filter((o) => o.outcome === 'lost')
      .sort((a, b) => b.amount - a.amount)
      .map((o) => ({
        rosterId: o.rosterId,
        displayName: input.names.get(o.rosterId) ?? null,
        amount: o.amount,
      }));

    claims.push({
      playerId: playerId === '(unknown player)' ? null : playerId,
      winnerRosterId: winner?.rosterId ?? null,
      winnerName: winner ? (input.names.get(winner.rosterId) ?? null) : null,
      winningBid: winner?.amount ?? null,
      losingBids: losers,
      losingBidsComplete: input.losingBidsComplete,
    });
  }

  claims.sort((a, b) => (b.winningBid ?? -1) - (a.winningBid ?? -1));

  /*
   * What the run cost each wallet.
   *
   * Only winning bids are spend — a failed claim carries an amount and costs
   * nothing, and counting it would have every busy manager looking broke.
   */
  const spentByRoster = new Map<number, number>();
  for (const observation of input.observations) {
    if (observation.outcome !== 'won') continue;
    spentByRoster.set(observation.rosterId, (spentByRoster.get(observation.rosterId) ?? 0) + observation.amount);
  }
  const wallets: WalletChange[] = [...spentByRoster.entries()]
    .map(([rosterId, spent]) => ({
      rosterId,
      displayName: input.names.get(rosterId) ?? null,
      spent,
      remaining: input.remainingByRoster?.get(rosterId) ?? null,
    }))
    .sort((a, b) => b.spent - a.spent);

  if (!input.losingBidsComplete && claims.some((c) => c.losingBids.length > 0)) {
    notes.push('losing bids are whatever Sleeper published, which is rarely all of them');
  }

  const predictions = checkPredictions(input, byPlayer);
  if (predictions.length > 0) {
    const confirmed = predictions.filter((p) => p.outcome === 'bid').length;
    const unconfirmed = predictions.filter((p) => p.outcome === 'unconfirmed').length;
    notes.push(
      `${confirmed} of ${predictions.length} named rivals were seen bidding` +
        (unconfirmed > 0 ? `; ${unconfirmed} cannot be confirmed either way` : ''),
    );
  }

  return { week: input.week, claims, wallets, predictions, notes };
}

/**
 * Did the rivals this app named actually bid?
 *
 * The asymmetry is the whole design. A rival who appears in the published bids
 * is a confirmed sighting and counts. A rival who does not appear has either
 * not bid or has bid unpublished, and Sleeper will not say which — so he is
 * `unconfirmed`, and only becomes `did_not_appear` when the losing side is
 * known to be complete. Marking an unpublished bid as a miss would score this
 * app against a question the source declines to answer.
 */
function checkPredictions(
  input: WaiverRunInput,
  byPlayer: Map<string, BidObservation[]>,
): PredictionCheck[] {
  if (!input.predicted || input.predicted.size === 0) return [];

  const out: PredictionCheck[] = [];
  for (const [playerId, predicted] of input.predicted) {
    const observations = byPlayer.get(playerId) ?? [];
    for (const prediction of predicted) {
      const seen = observations.find((o) => o.rosterId === prediction.rosterId) ?? null;
      const displayName = input.names.get(prediction.rosterId) ?? null;

      if (seen) {
        const withinRange =
          prediction.estimate == null
            ? null
            : seen.amount >= prediction.estimate.low && seen.amount <= prediction.estimate.high;
        out.push({
          rosterId: prediction.rosterId,
          displayName,
          predictedRange: prediction.estimate,
          outcome: 'bid',
          actualBid: seen.amount,
          withinRange,
          note:
            withinRange == null
              ? `bid $${seen.amount}; no range had been estimated`
              : withinRange
                ? `bid $${seen.amount}, inside the estimate`
                : `bid $${seen.amount}, outside the estimate`,
        });
        continue;
      }

      out.push({
        rosterId: prediction.rosterId,
        displayName,
        predictedRange: prediction.estimate,
        outcome: input.losingBidsComplete ? 'did_not_appear' : 'unconfirmed',
        actualBid: null,
        withinRange: null,
        note: input.losingBidsComplete
          ? 'did not bid'
          : 'no bid published for him, which Sleeper does not distinguish from not bidding',
      });
    }
  }

  return out;
}
