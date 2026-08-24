/**
 * Who in this league actually trades, and what their deals look like.
 *
 * Derived from the same transaction ledger the waiver profiles come from — a
 * trade *is* a transaction, and re-fetching them separately would be paying
 * twice for one fact. `tradeProfile.ts` already reads trades out of a live
 * transaction list and files the result against a roster id; this does the same
 * arithmetic against the stored ledger and files it against a **Sleeper user
 * id**, which is the identity that survives a season boundary.
 *
 * ## The contract with Smart Trades, stated up front
 *
 * A trade suggestion is, and remains, a bilateral question: does this roster
 * want what that roster has, and is the value even. Nothing here participates
 * in that answer. What this can do is exactly four things, and the type
 * {@link TradePartnerContext} is shaped so that it cannot do a fifth:
 *
 *   - **order** among partners who are already similarly good fits;
 *   - **label** how plausible a conversation with this manager is at all;
 *   - **shape** the offer — one-for-one against a package, depth against a
 *     starter;
 *   - **explain**, in one sentence, from the counts.
 *
 * What it must never do: produce an acceptance probability. "68% likely to
 * accept" is a number with nothing under it — Sleeper publishes completed
 * trades, not declined offers, so the denominator of that fraction does not
 * exist and never will. `plausibility` is a four-valued label about *history*,
 * not a probability about the future, and `orderingWeight` is bounded far too
 * tightly to rescue a bad fit.
 */

import { isFinalised, type LedgerTransaction } from './ledger.ts';

export const TRADE_TENDENCY_VERSION = 1;

export const TRADE_TENDENCY = {
  /**
   * Trades at which each band begins, straight from the brief's §13.
   *
   * 0 is unknown, 1–2 very weak, 3–5 modest, 6+ stronger but still bounded.
   * Bands rather than a continuous function because the output is a four-valued
   * label a person reads, and a label that changes on the fourth trade is
   * easier to defend than a score that moves on every one.
   */
  bands: { weak: 1, modest: 3, strong: 6 },
  /** How much a season older than the newest counts. Compounding. */
  seasonDecay: 0.6,
  /**
   * The most a manager's trade history may move his position in the ordering.
   *
   * Five per cent, and the number is chosen to be too small to matter to
   * anything except a near-tie. That is the entire intent: the brief permits
   * ordering "among similarly good partners", and a weight that could reorder
   * partners who are *not* similarly good would be manager behaviour deciding a
   * bilateral question.
   */
  maxOrderingWeight: 0.05,
  /** Players in one side of a deal at or above which it is called a package. */
  packageSize: 2,
} as const;

/** How much of a conversation the history supports. Never a probability. */
export type TradePlausibility = 'plausible' | 'possible' | 'thin_history' | 'rare_trader';

/** The words a screen may print for each. Neutral by construction. */
export const PLAUSIBILITY_LABELS: Record<TradePlausibility, string> = {
  plausible: 'Plausible',
  possible: 'Possible',
  thin_history: 'Thin history',
  rare_trader: 'Rare trader',
};

export type OfferShape = 'one_for_one' | 'package' | 'depth_for_starter' | 'unknown';

export interface TradePartnerLink {
  /** The other manager's Sleeper user id. */
  userId: string;
  displayName: string | null;
  trades: number;
}

export interface ManagerTradeTendencies {
  userId: string;
  displayName: string | null;
  seasons: string[];
  /** Completed trades he took part in. The number every claim rests on. */
  sample: number;
  /** Recency-weighted trades per season he was in the league. */
  tradesPerSeason: number | null;
  /** True when the sample clears the weakest band. */
  usable: boolean;
  plausibility: TradePlausibility;

  /** Median week his trades landed in. Null when no trade carried a week. */
  medianWeek: number | null;
  /** Share of his trades made before week 1 — the pre-season dealer reading. */
  preseasonShare: number | null;

  /** Mean players he receives in a deal. */
  meanReceived: number | null;
  /** Mean players he sends. */
  meanSent: number | null;
  /** The shape his deals most often take. */
  typicalShape: OfferShape;
  /** Share of his trades where he sent two-plus and received one. */
  consolidationRate: number | null;

  /** Positions he has acquired more often than sent, strongest first. */
  acquires: string[];
  /** Positions he has sent more often than acquired. */
  sends: string[];
  /** Managers he has dealt with more than once. */
  repeatPartners: TradePartnerLink[];
  /** True when he has ever included a draft pick. */
  includesPicks: boolean;
  /** True when he has ever moved FAAB in a deal. */
  includesFaab: boolean;

  /** In [0,1]. What share of a full claim this sample supports. */
  confidence: number;
  notes: string[];
}

export interface TradeTendencyInput {
  transactions: readonly LedgerTransaction[];
  /** Which seasons each user was in the league for, for the per-season rate. */
  seasonsByUser: ReadonlyMap<string, string[]>;
  positionOf: (playerId: string) => string | null;
  displayNames?: ReadonlyMap<string, string | null>;
  /** The newest season in the ledger, for the recency weighting. */
  latestSeason?: string;
}

export interface LeagueTradeBaseline {
  seasons: string[];
  /** Completed trades in the whole ledger. */
  trades: number;
  /** Managers who have completed at least one. */
  traders: number;
  /** Trades per manager per season. The room's own rate. */
  tradesPerManagerSeason: number;
  /** Share of the room's trades that were packages rather than one-for-ones. */
  packageShare: number | null;
  /** Median week a trade lands in this room. */
  medianWeek: number | null;
}

/** Nothing known: a manager with no completed trade in the ledger. */
export function neutralTradeTendencies(
  userId: string,
  displayName: string | null = null,
): ManagerTradeTendencies {
  return {
    userId,
    displayName,
    seasons: [],
    sample: 0,
    tradesPerSeason: null,
    usable: false,
    plausibility: 'thin_history',
    medianWeek: null,
    preseasonShare: null,
    meanReceived: null,
    meanSent: null,
    typicalShape: 'unknown',
    consolidationRate: null,
    acquires: [],
    sends: [],
    repeatPartners: [],
    includesPicks: false,
    includesFaab: false,
    confidence: 0,
    notes: ['no completed trade on record for this manager'],
  };
}

/** What trading looks like in this room, so a manager can be read against it. */
export function buildLeagueTradeBaseline(input: TradeTendencyInput): LeagueTradeBaseline {
  const trades = completedTrades(input.transactions);
  const seasons = [...new Set(trades.map((t) => t.season))].sort();
  const traders = new Set<string>();
  for (const trade of trades) for (const userId of trade.userIds) traders.add(userId);

  let packages = 0;
  let shaped = 0;
  for (const trade of trades) {
    for (const list of trade.addsByUser.values()) {
      shaped += 1;
      if (list.length >= TRADE_TENDENCY.packageSize) packages += 1;
    }
  }

  const weeks = trades.map((t) => t.week).filter((w) => w > 0);
  const managerSeasons = Math.max(1, traders.size * Math.max(1, seasons.length));

  return {
    seasons,
    trades: trades.length,
    traders: traders.size,
    tradesPerManagerSeason: round2((trades.length * 2) / managerSeasons),
    packageShare: shaped > 0 ? round2(packages / shaped) : null,
    medianWeek: weeks.length > 0 ? median(weeks.sort((a, b) => a - b)) : null,
  };
}

/**
 * Every manager's trade tendencies, from the ledger.
 *
 * Only completed trades count. A failed or pending trade describes an
 * intention, and a manager who proposes ten lopsided deals and completes none
 * does have a tendency — but it is not the one the counts would suggest, and
 * Sleeper does not publish enough to measure the real one.
 */
export function buildTradeTendencies(input: TradeTendencyInput): Map<string, ManagerTradeTendencies> {
  const trades = completedTrades(input.transactions);
  const latestSeason = input.latestSeason ?? [...trades.map((t) => t.season)].sort().at(-1) ?? '';

  const byUser = new Map<string, LedgerTransaction[]>();
  for (const trade of trades) {
    for (const userId of trade.userIds) {
      const list = byUser.get(userId);
      if (list) list.push(trade);
      else byUser.set(userId, [trade]);
    }
  }

  const out = new Map<string, ManagerTradeTendencies>();
  for (const [userId, mine] of byUser) {
    out.set(userId, tendenciesFor({ userId, mine, input, latestSeason }));
  }
  return out;
}

function tendenciesFor(args: {
  userId: string;
  mine: LedgerTransaction[];
  input: TradeTendencyInput;
  latestSeason: string;
}): ManagerTradeTendencies {
  const { userId, mine, input, latestSeason } = args;
  const displayName = input.displayNames?.get(userId) ?? null;
  const seasons = [...new Set(mine.map((t) => t.season))].sort();
  const sample = mine.length;

  const latest = Number(latestSeason);
  const weightOf = (season: string): number => {
    const age = Number.isFinite(latest) ? latest - Number(season) : 0;
    return Number.isFinite(age) && age > 0 ? TRADE_TENDENCY.seasonDecay ** age : 1;
  };

  const hisSeasons = input.seasonsByUser.get(userId) ?? seasons;
  const seasonCount = Math.max(1, hisSeasons.length);
  const weighted = mine.reduce((sum, t) => sum + weightOf(t.season), 0);

  const received = mine.map((t) => (t.addsByUser.get(userId) ?? []).length);
  const sent = mine.map((t) => (t.dropsByUser.get(userId) ?? []).length);
  const consolidations = mine.filter((_trade, i) => (sent[i] ?? 0) >= 2 && (received[i] ?? 0) === 1).length;

  const acquiredWeight = new Map<string, number>();
  const sentWeight = new Map<string, number>();
  for (const trade of mine) {
    const w = weightOf(trade.season);
    for (const playerId of trade.addsByUser.get(userId) ?? []) {
      const position = input.positionOf(playerId);
      if (position) acquiredWeight.set(position, (acquiredWeight.get(position) ?? 0) + w);
    }
    for (const playerId of trade.dropsByUser.get(userId) ?? []) {
      const position = input.positionOf(playerId);
      if (position) sentWeight.set(position, (sentWeight.get(position) ?? 0) + w);
    }
  }

  const bias: { position: string; net: number }[] = [];
  for (const position of new Set([...acquiredWeight.keys(), ...sentWeight.keys()])) {
    bias.push({ position, net: round2((acquiredWeight.get(position) ?? 0) - (sentWeight.get(position) ?? 0)) });
  }
  bias.sort((a, b) => b.net - a.net);

  /*
   * Who he keeps dealing with.
   *
   * Two trades with the same person is the smallest number that is not a
   * coincidence, and it is a genuinely useful fact — leagues have pairs who
   * talk. Kept as a plain count with names attached rather than as a score,
   * because "he has traded with you twice" is the whole claim.
   */
  const partnerCounts = new Map<string, number>();
  for (const trade of mine) {
    for (const other of trade.userIds) {
      if (other === userId) continue;
      partnerCounts.set(other, (partnerCounts.get(other) ?? 0) + 1);
    }
  }
  const repeatPartners: TradePartnerLink[] = [...partnerCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([partnerId, count]) => ({
      userId: partnerId,
      displayName: input.displayNames?.get(partnerId) ?? null,
      trades: count,
    }))
    .sort((a, b) => b.trades - a.trades || a.userId.localeCompare(b.userId));

  const weeks = mine.map((t) => t.week).filter((w) => w > 0);
  const meanReceived = sample > 0 ? round2(received.reduce((a, v) => a + v, 0) / sample) : null;
  const meanSent = sample > 0 ? round2(sent.reduce((a, v) => a + v, 0) / sample) : null;
  const consolidationRate = sample > 0 ? round2(consolidations / sample) : null;

  const plausibility = plausibilityFor(sample);
  const usable = sample >= TRADE_TENDENCY.bands.weak;
  const confidence = round2(sample / (sample + TRADE_TENDENCY.bands.strong));

  const tendencies: ManagerTradeTendencies = {
    userId,
    displayName,
    seasons,
    sample,
    tradesPerSeason: sample > 0 ? round2(weighted / seasonCount) : null,
    usable,
    plausibility,
    medianWeek: weeks.length > 0 ? median(weeks.sort((a, b) => a - b)) : null,
    preseasonShare: sample > 0 ? round2(mine.filter((t) => t.week <= 0).length / sample) : null,
    meanReceived,
    meanSent,
    typicalShape: shapeFor({ meanReceived, meanSent, consolidationRate, sample }),
    consolidationRate,
    /*
     * A one-sided position bias needs more than one deal behind it. The
     * *weight* floor rather than a raw count is deliberate: two acquisitions
     * three seasons ago decay below it, which is the intended behaviour.
     */
    acquires: sample >= TRADE_TENDENCY.bands.modest ? bias.filter((b) => b.net >= 1).map((b) => b.position) : [],
    sends: sample >= TRADE_TENDENCY.bands.modest ? bias.filter((b) => b.net <= -1).map((b) => b.position) : [],
    repeatPartners,
    includesPicks: mine.some((t) => t.draftPicksMoved > 0),
    includesFaab: mine.some((t) => t.faabTraded > 0),
    confidence,
    notes: [],
  };

  tendencies.notes = tendencyNotes(tendencies);
  return tendencies;
}

/**
 * The band, from the count alone.
 *
 * `rare_trader` and `thin_history` are different claims and the distinction is
 * the useful part: a manager with one trade in four seasons has been measured
 * and is genuinely unlikely to deal, while a manager with one trade in his
 * first season has not been measured at all. The caller supplies the seasons to
 * tell them apart — see {@link partnerContext}.
 */
export function plausibilityFor(sample: number, seasonsObserved = 0): TradePlausibility {
  if (sample >= TRADE_TENDENCY.bands.strong) return 'plausible';
  if (sample >= TRADE_TENDENCY.bands.modest) return 'possible';
  if (sample === 0 && seasonsObserved >= 2) return 'rare_trader';
  return 'thin_history';
}

function shapeFor(args: {
  meanReceived: number | null;
  meanSent: number | null;
  consolidationRate: number | null;
  sample: number;
}): OfferShape {
  if (args.sample < TRADE_TENDENCY.bands.modest) return 'unknown';
  if ((args.consolidationRate ?? 0) >= 0.5) return 'depth_for_starter';
  const both = Math.max(args.meanReceived ?? 0, args.meanSent ?? 0);
  if (both >= TRADE_TENDENCY.packageSize) return 'package';
  return 'one_for_one';
}

function tendencyNotes(t: ManagerTradeTendencies): string[] {
  if (t.sample === 0) return ['no completed trade on record'];
  const notes: string[] = [`${t.sample} completed trade(s) across ${t.seasons.length} season(s)`];
  if (t.tradesPerSeason != null) notes.push(`${t.tradesPerSeason} trade(s) per season, recency-weighted`);
  if (t.typicalShape !== 'unknown') notes.push(`deals usually take the ${t.typicalShape.replace(/_/g, ' ')} shape`);
  if (t.acquires.length > 0) notes.push(`has been acquiring ${t.acquires.join(', ')}`);
  if (t.sends.length > 0) notes.push(`has been sending ${t.sends.join(', ')}`);
  if (t.repeatPartners.length > 0) {
    notes.push(`repeat partner(s): ${t.repeatPartners.map((p) => p.displayName ?? p.userId).join(', ')}`);
  }
  if (t.includesPicks) notes.push('willing to include draft picks');
  if (t.includesFaab) notes.push('has moved FAAB in a deal');
  return notes;
}

// ------------------------------------------------------ the Smart Trades API --

/**
 * What a Smart Trades caller is allowed to know about a partner.
 *
 * Deliberately narrow. Every field is either a label, a sentence, or a weight
 * bounded to ±5% — there is no probability, no score and no recommendation,
 * because those are the outputs the bilateral engine owns and this must not be
 * able to imitate.
 */
export interface TradePartnerContext {
  userId: string;
  displayName: string | null;
  plausibility: TradePlausibility;
  /** The word a screen prints. */
  label: string;
  /** How to open: one-for-one, a package, depth for a starter. */
  suggestedShape: OfferShape;
  /**
   * A tiebreak, in [-0.05, 0.05], to be *added* to an already-computed fit.
   *
   * Bounded so far below the resolution of a fit score that it can only ever
   * separate two partners who were already level. A caller that multiplies by
   * this, or that lets it decide whether to show a suggestion at all, is using
   * it wrongly.
   */
  orderingWeight: number;
  /** One neutral sentence, or null when there is nothing supportable to say. */
  explanation: string | null;
  /** Trades behind all of it, so a caller can say "based on 4 trades". */
  sample: number;
  seasons: number;
  /** True when this manager has dealt with the asking manager before. */
  hasTradedWithYou: boolean;
}

/**
 * Turn one manager's tendencies into the bounded context Smart Trades may read.
 *
 * `wantPosition` is what the asking manager would be trying to acquire *from*
 * him, which is the only position-shaped claim the history can honestly speak
 * to: "he has been selling running backs" is relevant when you want his running
 * back and irrelevant otherwise.
 */
export function partnerContext(opts: {
  tendencies: ManagerTradeTendencies | null;
  /** The asking manager, for the repeat-partner reading. */
  askingUserId?: string | null;
  /** The position the asking manager would be acquiring. */
  wantPosition?: string | null;
  /** Seasons this manager has been in the league, to tell rare from unmeasured. */
  seasonsObserved?: number;
}): TradePartnerContext {
  const t = opts.tendencies;
  const seasons = opts.seasonsObserved ?? t?.seasons.length ?? 0;

  if (!t || t.sample === 0) {
    const plausibility = plausibilityFor(0, seasons);
    return {
      userId: t?.userId ?? '',
      displayName: t?.displayName ?? null,
      plausibility,
      label: PLAUSIBILITY_LABELS[plausibility],
      suggestedShape: 'unknown',
      orderingWeight: 0,
      explanation:
        plausibility === 'rare_trader'
          ? `No completed trade in ${seasons} season(s) of history.`
          : null,
      sample: 0,
      seasons,
      hasTradedWithYou: false,
    };
  }

  const hasTradedWithYou =
    !!opts.askingUserId && t.repeatPartners.some((p) => p.userId === opts.askingUserId);

  /*
   * The weight, assembled from the three things the brief names and nothing
   * else: how often he trades, whether he has dealt with you before, and
   * whether he has been selling the position you want. Each term is a fraction
   * of the cap, and the sum is clamped to it — so three agreeing signals reach
   * the cap and no combination can exceed it.
   */
  const cap = TRADE_TENDENCY.maxOrderingWeight;
  let weight = 0;
  if (t.sample >= TRADE_TENDENCY.bands.strong) weight += cap * 0.5;
  else if (t.sample >= TRADE_TENDENCY.bands.modest) weight += cap * 0.25;
  if (hasTradedWithYou) weight += cap * 0.25;
  if (opts.wantPosition && t.sends.includes(opts.wantPosition)) weight += cap * 0.25;
  /*
   * And down, for a manager who has been measured and does not deal. Symmetric
   * with the top so the feature cannot only ever promote.
   */
  if (t.sample <= 1 && seasons >= 2) weight -= cap * 0.5;

  return {
    userId: t.userId,
    displayName: t.displayName,
    plausibility: t.plausibility,
    label: PLAUSIBILITY_LABELS[t.plausibility],
    suggestedShape: t.typicalShape,
    orderingWeight: round3(Math.min(cap, Math.max(-cap, weight))),
    explanation: explanationFor(t, { hasTradedWithYou, wantPosition: opts.wantPosition ?? null }),
    sample: t.sample,
    seasons,
    hasTradedWithYou,
  };
}

/**
 * One sentence, built from counts and nothing else.
 *
 * Neutral vocabulary throughout — "tends to", "has historically", "limited
 * history". No manager in this app is ever described as bad at this, and the
 * sentences are assembled here rather than in a screen so that rule has one
 * place to live.
 */
function explanationFor(
  t: ManagerTradeTendencies,
  ctx: { hasTradedWithYou: boolean; wantPosition: string | null },
): string | null {
  if (t.sample < TRADE_TENDENCY.bands.weak) return null;

  const parts: string[] = [];
  if (t.sample < TRADE_TENDENCY.bands.modest) {
    parts.push(`${t.sample} completed trade(s) on record`);
  } else if (t.tradesPerSeason != null) {
    parts.push(`trades about ${t.tradesPerSeason} time(s) a season`);
  }
  if (ctx.wantPosition && t.sends.includes(ctx.wantPosition)) {
    parts.push(`has historically sent ${ctx.wantPosition}`);
  } else if (t.acquires.length > 0) {
    parts.push(`has historically traded for ${t.acquires.join(' and ')} help`);
  }
  if (t.typicalShape === 'depth_for_starter') parts.push('usually sends depth for a starter');
  else if (t.typicalShape === 'package' && t.sample >= TRADE_TENDENCY.bands.modest) parts.push('usually deals in packages');
  if (ctx.hasTradedWithYou) parts.push('has dealt with you before');

  return parts.length > 0 ? `${capitalise(parts.join('; '))}.` : null;
}

function completedTrades(transactions: readonly LedgerTransaction[]): LedgerTransaction[] {
  return transactions.filter((t) => t.type === 'trade' && isFinalised(t.status));
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
