/**
 * What a manager has actually done, as opposed to what he says he does.
 *
 * Sleeper keeps every completed trade a league has ever made, and across a
 * league's previous-season chain that is often several years of behaviour. It is
 * the only source in this app that describes *people* rather than players, and
 * it is correspondingly easy to abuse.
 *
 * Three rules keep it honest, and they are enforced here rather than left to
 * whoever reads the profile:
 *
 *   - **a sample below the threshold is not a tendency.** Two trades is two
 *     trades. Every field carries the count it rests on, `confident` is false
 *     until the threshold is met, and consumers are expected to say "based on 3
 *     trades" rather than "prefers 2-for-1";
 *   - **recency is weighted, not filtered.** A manager who traded picks
 *     constantly in 2023 and not once since has changed, and a flat average over
 *     three seasons will keep describing the 2023 version of him. Older seasons
 *     count for less rather than being thrown away, because throwing them away
 *     is how a sample gets too small to use;
 *   - **the profile is descriptive.** It says what happened. It does not predict,
 *     score, rank, or recommend, and nothing downstream may treat "trades often"
 *     as "will accept your offer".
 */

import type { SleeperTransaction } from '../sleeper/types.ts';

/** Below this many observed trades, nothing is called a tendency. */
export const MIN_TRADE_SAMPLE = 4;

/** How much a season older than the newest one counts. Compounding. */
export const SEASON_DECAY = 0.6;

export interface TradeEvent {
  transactionId: string;
  season: string;
  week: number;
  /** Every roster that took part. */
  rosterIds: number[];
  /** The roster that created the offer, when Sleeper says. */
  initiatorRosterId: number | null;
  /** roster id -> players received. */
  received: Map<number, string[]>;
  /** roster id -> players sent. */
  sent: Map<number, string[]>;
  /** Draft picks that moved, by receiving roster. */
  picksMoved: number;
  /** FAAB that changed hands, in dollars. */
  faabMoved: number;
}

export type NegotiationStyle = 'counters_often' | 'accepts_or_declines' | 'unknown';

export interface ManagerTradeProfile {
  rosterId: number;
  ownerName: string | null;
  /** Weighted trade count. The raw count is `sample`. */
  sample: number;
  minSample: number;
  /** True only when the sample clears the threshold. Read this before the rest. */
  confident: boolean;
  /** Share of his trades he started, 0–1. Null below the threshold. */
  initiationRate: number | null;
  /** Trades per season, recency-weighted. Null below the threshold. */
  tradesPerSeason: number | null;
  /** Has historically sent two-plus and received one. */
  prefersConsolidation: boolean;
  /** Includes draft picks in deals. */
  tradesPicks: boolean;
  /** Has moved FAAB in a trade. */
  tradesFaab: boolean;
  /** Positions he has acquired more often than he has sent, strongest first. */
  acquiresPositions: string[];
  /** Positions he has sent more often than he has acquired. */
  sendsPositions: string[];
  negotiation: NegotiationStyle;
  /** One or two plain sentences, or empty when there is nothing supportable. */
  notes: string[];
  seasonsObserved: string[];
}

/**
 * Pull the trades out of a league's transaction stream.
 *
 * Only `complete` trades count. A failed or pending trade describes an
 * intention, and intentions are exactly the thing this module refuses to model —
 * a manager who proposes ten lopsided deals and completes none has a tendency,
 * but it is not the one the counts would suggest.
 */
export function collectTrades(
  transactions: SleeperTransaction[],
  season: string,
  rosterIdByUserId?: Map<string, number>,
): TradeEvent[] {
  const out: TradeEvent[] = [];

  for (const txn of transactions) {
    if (txn.type !== 'trade' || txn.status !== 'complete') continue;

    const received = new Map<number, string[]>();
    const sent = new Map<number, string[]>();
    for (const [playerId, rosterId] of Object.entries(txn.adds ?? {})) {
      push(received, rosterId, playerId);
    }
    for (const [playerId, rosterId] of Object.entries(txn.drops ?? {})) {
      push(sent, rosterId, playerId);
    }

    const faabMoved = (txn.waiver_budget ?? []).reduce((sum, m) => sum + (Number(m.amount) || 0), 0);

    out.push({
      transactionId: txn.transaction_id,
      season,
      week: typeof txn.leg === 'number' ? txn.leg : 0,
      rosterIds: txn.roster_ids ?? [],
      /*
       * `creator` is a user id, not a roster id, and the mapping is only
       * available when the caller has the league's users. Without it the
       * initiator is unknown — which is a fact, and better than attributing the
       * trade to whoever happens to be first in `roster_ids`.
       */
      initiatorRosterId:
        txn.creator && rosterIdByUserId ? (rosterIdByUserId.get(txn.creator) ?? null) : null,
      received,
      sent,
      picksMoved: (txn.draft_picks ?? []).length,
      faabMoved,
    });
  }

  return out;
}

function push(map: Map<number, string[]>, key: number, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Build one manager's profile from every trade he has been part of.
 *
 * `positionOf` is injected rather than looked up, because this module has no
 * database and a position map is the caller's to own. A player whose position is
 * unknown simply does not contribute to the position bias, which keeps a
 * half-resolved roster from producing a confident and wrong "prefers running
 * backs".
 */
export function buildTradeProfile(opts: {
  rosterId: number;
  ownerName?: string | null;
  trades: TradeEvent[];
  positionOf: (playerId: string) => string | null;
  /** Newest season in the data, for the recency weighting. */
  latestSeason: string;
  minSample?: number;
}): ManagerTradeProfile {
  const minSample = opts.minSample ?? MIN_TRADE_SAMPLE;
  const mine = opts.trades.filter((t) => t.rosterIds.includes(opts.rosterId));
  const seasons = [...new Set(mine.map((t) => t.season))].sort();

  const latest = Number(opts.latestSeason);
  const weightOf = (season: string): number => {
    const age = Number.isFinite(latest) ? latest - Number(season) : 0;
    return Number.isFinite(age) && age > 0 ? SEASON_DECAY ** age : 1;
  };

  const weighted = mine.reduce((sum, t) => sum + weightOf(t.season), 0);
  const confident = mine.length >= minSample;

  const base: ManagerTradeProfile = {
    rosterId: opts.rosterId,
    ownerName: opts.ownerName ?? null,
    sample: mine.length,
    minSample,
    confident,
    initiationRate: null,
    tradesPerSeason: null,
    prefersConsolidation: false,
    tradesPicks: false,
    tradesFaab: false,
    acquiresPositions: [],
    sendsPositions: [],
    negotiation: 'unknown',
    notes: [],
    seasonsObserved: seasons,
  };

  if (mine.length === 0) {
    base.notes.push('No completed trades on record for this manager.');
    return base;
  }

  /*
   * Everything below is computed whatever the sample size, but only *published*
   * as a tendency once the threshold is met. Computing it either way keeps the
   * numbers available for a caller who wants to say "1 of 2 trades" honestly.
   */
  const known = mine.filter((t) => t.initiatorRosterId != null);
  const initiated = known.filter((t) => t.initiatorRosterId === opts.rosterId).length;
  const initiationRate = known.length > 0 ? round2(initiated / known.length) : null;

  const consolidations = mine.filter((t) => {
    const got = t.received.get(opts.rosterId)?.length ?? 0;
    const gave = t.sent.get(opts.rosterId)?.length ?? 0;
    return gave >= 2 && got === 1;
  }).length;

  const acquired = new Map<string, number>();
  const surrendered = new Map<string, number>();
  for (const trade of mine) {
    const w = weightOf(trade.season);
    for (const id of trade.received.get(opts.rosterId) ?? []) {
      const pos = opts.positionOf(id);
      if (pos) acquired.set(pos, (acquired.get(pos) ?? 0) + w);
    }
    for (const id of trade.sent.get(opts.rosterId) ?? []) {
      const pos = opts.positionOf(id);
      if (pos) surrendered.set(pos, (surrendered.get(pos) ?? 0) + w);
    }
  }

  const bias: { position: string; net: number }[] = [];
  for (const pos of new Set([...acquired.keys(), ...surrendered.keys()])) {
    bias.push({ position: pos, net: round2((acquired.get(pos) ?? 0) - (surrendered.get(pos) ?? 0)) });
  }
  bias.sort((a, b) => b.net - a.net);

  const profile: ManagerTradeProfile = {
    ...base,
    initiationRate: confident ? initiationRate : null,
    tradesPerSeason: confident && seasons.length > 0 ? round2(weighted / seasons.length) : null,
    prefersConsolidation: confident && consolidations / mine.length >= 0.5,
    tradesPicks: mine.some((t) => t.picksMoved > 0),
    tradesFaab: mine.some((t) => t.faabMoved > 0),
    /*
     * A one-sided position bias needs more than one trade behind it. The weight
     * floor rather than a raw count is deliberate: two acquisitions three
     * seasons ago decay below it, which is the intended behaviour.
     */
    acquiresPositions: confident ? bias.filter((b) => b.net >= 1).map((b) => b.position) : [],
    sendsPositions: confident ? bias.filter((b) => b.net <= -1).map((b) => b.position) : [],
    negotiation: 'unknown',
    notes: [],
    seasonsObserved: seasons,
  };

  profile.notes = tradeNotes(profile, mine.length);
  return profile;
}

/**
 * The sentences a card may show, and only those that are supported.
 *
 * Below the threshold there is exactly one sentence, and it is about the sample
 * rather than about the manager.
 */
function tradeNotes(p: ManagerTradeProfile, rawSample: number): string[] {
  if (!p.confident) {
    return [`Only ${rawSample} completed trade(s) on record — not enough to describe a tendency.`];
  }
  const notes: string[] = [];
  if (p.initiationRate != null && p.initiationRate >= 0.6) notes.push('Usually starts the conversation.');
  if (p.initiationRate != null && p.initiationRate <= 0.25) notes.push('Rarely initiates; responds rather than proposes.');
  if (p.prefersConsolidation) notes.push('Has a history of sending two players for one.');
  if (p.tradesPicks) notes.push('Willing to include draft picks.');
  if (p.tradesFaab) notes.push('Has traded FAAB as part of a deal.');
  if (p.acquiresPositions.length > 0) notes.push(`Has been buying ${p.acquiresPositions.join(', ')}.`);
  if (p.sendsPositions.length > 0) notes.push(`Has been selling ${p.sendsPositions.join(', ')}.`);
  notes.push(`Based on ${rawSample} trade(s) across ${p.seasonsObserved.length} season(s).`);
  return notes;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
