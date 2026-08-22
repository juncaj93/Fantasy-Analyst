/**
 * Trade intelligence.
 *
 * Draft scoring is dominated by the lifetime record, because a draft is a bet
 * on a whole season and an offseason of evidence is the best thing you have.
 * Trades are the opposite question: what has changed lately, and does anyone
 * else know yet. So the 30-day window leads here, the 7-day window says whether
 * it is still moving, and lifetime stays as context rather than as the verdict.
 *
 * The board answers two different questions and keeps them apart:
 *
 *   - **Trade target** — who has the strongest *sustained* recent case. Led by
 *     the 30-day window, confirmed by the 7-day one, supported by lifetime.
 *   - **Emerging target** — whose case became interesting *this week*. Led by
 *     the 7-day window and its acceleration against the 23 days before it.
 *
 * And it keeps a third question apart from both: **confidence** says how well
 * evidenced a call is, never how attractive. Nothing `confidenceOf` returns is
 * an input to `classify` or to either score. They used to share `items30`,
 * which meant a thinly sourced player could not be a trade target however
 * strong his signal — and the ledger's backfill importer, which correctly
 * carries a running tally as one row, made that a common case rather than a
 * rare one.
 *
 * Everything here runs off the evidence ledger alone. Vegas lines and usage can
 * strengthen a call when they exist, but the engine must — and does — work
 * without them, because they are the parts most likely to be missing.
 *
 * This module suggests and explains. It never proposes a specific trade, values
 * one player against another, or contacts anybody.
 */

import type { PlayerSignal } from '../evidence/types.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { InjuryState } from '../injury/model.ts';
import { NO_TRADE_INJURY, tradeInjuryContext, type TradeInjuryContext } from '../injury/trades.ts';

/** Who holds this player right now, from Sleeper's rosters. */
export type Ownership = 'mine' | 'other' | 'free';

export type TradeVerdict =
  | 'trade_target'
  | 'emerging_target'
  | 'add_waiver'
  | 'sell_high'
  | 'trade_away'
  | 'hold_mixed';

export const VERDICT_LABELS: Record<TradeVerdict, string> = {
  trade_target: 'Trade target',
  emerging_target: 'Emerging target',
  add_waiver: 'Add / waiver target',
  sell_high: 'Possible sell high',
  trade_away: 'Trade away / reduce risk',
  hold_mixed: 'Hold — mixed signal',
};

export interface TradeWindows {
  lifetime: number;
  season: number;
  last30: number;
  last7: number;
  /** Evidence items in the 30-day window, which is what confidence rests on. */
  items30: number;
  itemsLifetime: number;
}

export interface TradeSuggestion {
  playerId: string;
  name: string;
  position: string;
  team: string;
  ownership: Ownership;
  verdict: TradeVerdict;
  label: string;
  windows: TradeWindows;
  /**
   * Higher means "look at this first". Comparable within one run only, and
   * only against players in the same section — each verdict is ranked by the
   * question its label asks, so the numbers are not on one scale across groups.
   */
  urgency: number;
  /**
   * How well supported the call is. Independent of `urgency` by construction:
   * neither one is an input to the other, and a player can be the most
   * attractive row on the board with the least evidence behind him.
   */
  confidence: 'high' | 'medium' | 'low';
  /** Every term behind `urgency`. Developer-facing; no screen reads it. */
  breakdown: TradeScoreBreakdown;
  reasons: string[];
  counterpoints: string[];
  /**
   * Availability, classified by how long it lasts rather than how bad it is.
   *
   * A one-week Questionable is not a sell signal and this is where that is
   * enforced: the category, a bounded urgency adjustment, and one line for the
   * card. Never enough on its own to change the verdict, which still comes from
   * the evidence ledger.
   */
  injury: TradeInjuryContext;
}

export interface TradeCandidate {
  player: CanonicalPlayer;
  signal: PlayerSignal | null;
  ownership: Ownership;
  /** His availability, normalized. Absent means nothing is known, not healthy. */
  injury?: InjuryState | null;
  /** The season outlook, the one supported place a major recovery is named. */
  outlook?: string | null;
}

export interface TradeOptions {
  /**
   * Evidence items in the 30-day window below which support is called thin.
   * Two items is a pattern; one is a sentence.
   *
   * This is a *confidence* threshold and nothing else. It used to decide the
   * bucket as well — which is what made a well-supported call and an attractive
   * one the same claim, and it is exactly the collapse `confidenceOf` and
   * `classify` now keep apart.
   */
  minItemsForConviction?: number;
  /** Net movement smaller than this is noise, not a signal. */
  minTrend?: number;
}

const DEFAULTS = { minItemsForConviction: 2, minTrend: 2 } as const;

/** Do the recent trend and the lifetime record point opposite ways? */
export function conflicted(windows: TradeWindows): boolean {
  return windows.lifetime !== 0 && windows.last30 !== 0 && Math.sign(windows.lifetime) !== Math.sign(windows.last30);
}

/** Does this week point against the month it sits inside? */
export function recentlyContradicted(windows: TradeWindows): boolean {
  return windows.last7 !== 0 && windows.last30 !== 0 && Math.sign(windows.last7) !== Math.sign(windows.last30);
}

/** The part of the 30-day window that is not the last 7 days: days 8–30. */
export function priorWindow(windows: TradeWindows): number {
  return round3(windows.last30 - windows.last7);
}

/**
 * How much faster the case is moving now than it was.
 *
 * The last 7 days measured against the same 7 days' worth of the 23 that came
 * before it, so the two halves of the window are compared at the same rate
 * rather than one being three times longer than the other. No new time window
 * is invented: both terms come from windows the ledger already keeps.
 *
 * Positive means the case is strengthening, negative means it is cooling.
 */
export function acceleration(windows: TradeWindows): number {
  const prior = priorWindow(windows);
  return round3(windows.last7 - prior * (7 / 23));
}

function windowsOf(signal: PlayerSignal | null): TradeWindows {
  return {
    lifetime: signal?.raw.net ?? 0,
    season: signal?.seasonToDate.net ?? 0,
    last30: signal?.last30.net ?? 0,
    last7: signal?.last7.net ?? 0,
    items30: signal?.last30.items ?? 0,
    itemsLifetime: signal?.raw.items ?? 0,
  };
}

/**
 * How much to trust the call — which is not the same question as how much to
 * want the player.
 *
 * This answers "how well supported is this", and only that. Nothing it returns
 * moves a player between buckets or up the list; `classify` and the score
 * functions never read it. That separation is the whole point: a +13 backfilled
 * from a single row is genuinely thinly sourced *and* genuinely the strongest
 * thing on the board, and the card should be able to say both.
 *
 * Breadth and consistency raise it. Magnitude never does, deliberately: one
 * emphatic sentence is not conviction, however emphatic, and the ledger's
 * backfill importer can put a whole season's tally into one row.
 */
export function confidenceOf(
  windows: TradeWindows,
  pending: number,
  opts: TradeOptions = {},
): 'high' | 'medium' | 'low' {
  const minItems = opts.minItemsForConviction ?? DEFAULTS.minItemsForConviction;

  // Evidence that disagrees with itself, in either direction, is not support.
  if (conflicted(windows)) return 'low';
  if (recentlyContradicted(windows)) return 'low';
  if (pending > 0 && windows.items30 <= pending) return 'low';

  if (windows.items30 >= minItems + 1) return 'high';
  if (windows.items30 >= minItems) return 'medium';

  /*
   * One recent item, with a longer record already saying the same thing.
   *
   * Two agreeing observations is the bar the branch above sets, and it stays
   * the bar here — the second one is just older. Never better than medium: an
   * item that has to reach outside the window for its corroboration has not
   * been confirmed *recently*, and recency is what this board trades on.
   */
  if (windows.items30 === 1 && corroboratedByLifetime(windows, minItems)) return 'medium';

  return 'low';
}

/** Items outside the 30-day window that point the same way it does. */
function corroboratedByLifetime(windows: TradeWindows, minItems: number): boolean {
  const older = windows.itemsLifetime - windows.items30;
  return (
    older >= minItems - 1 &&
    windows.lifetime !== 0 &&
    Math.sign(windows.lifetime) === Math.sign(windows.last30)
  );
}

/**
 * Is this a case that only exists this week?
 *
 * The last 7 days clear the bar on their own, and the 23 days before them did
 * not. That is the whole test, and it is deliberately a statement about *when*
 * the evidence landed rather than how much of it there is.
 *
 * It used to be a statement about how many rows the ledger held, which is how a
 * player with the strongest 30-day signal on the board ended up filed under
 * "emerging" — not because his case was new, but because the backfill importer
 * had honestly compressed a season of issues into one row. Row count is a fact
 * about the importer. Recency is a fact about the player.
 */
function newThisWeek(windows: TradeWindows, minTrend: number): boolean {
  return windows.last7 >= minTrend && priorWindow(windows) < minTrend;
}

/**
 * Classify one player.
 *
 * The asymmetry between "sell high" and "trade away" is the point of the
 * distinction: both describe a player whose news is getting worse, but only one
 * of them still has value to trade on. Lifetime standing is the proxy for that,
 * which is exactly why the label says *possible* — the app has no market price
 * for a rostered player and should not pretend otherwise.
 *
 * Note what does not appear here: `items30`, and therefore confidence. How well
 * supported a call is has no bearing on which of these six things it is.
 */
export function classify(windows: TradeWindows, ownership: Ownership, opts: TradeOptions = {}): TradeVerdict {
  const minTrend = opts.minTrend ?? DEFAULTS.minTrend;

  const rising = windows.last30 >= minTrend;
  const falling = windows.last30 <= -minTrend;

  if (ownership === 'mine') {
    if (falling) return windows.lifetime > 0 ? 'sell_high' : 'trade_away';
    return 'hold_mixed';
  }

  if (rising) {
    if (ownership === 'free') return 'add_waiver';
    return newThisWeek(windows, minTrend) ? 'emerging_target' : 'trade_target';
  }

  // A player somebody else holds whose news is not moving is not a trade idea.
  return 'hold_mixed';
}

/**
 * The most a single week may be worth, and the most a career may be worth.
 *
 * Both are caps rather than weights, and they exist so the leading term keeps
 * leading. A 30-day trend of +4 should not be overtaken by one loud week, and
 * it certainly should not be overtaken by a player who was good in 2023 — half
 * a point of lifetime is enough to settle two otherwise level cases and not
 * enough to invent one.
 */
const MAX_WEEK_SWING = 2;
const MAX_LIFETIME_SUPPORT = 0.5;

/**
 * What this week does to the 30-day case.
 *
 * Signed, which is the correction: this term used to be `|last7|`, so a week
 * pointing *against* the month made a player look more urgent rather than less.
 * Agreement confirms, disagreement costs, and either way it is bounded — the
 * 30-day window leads this board and a tie-breaker that can outvote it is not a
 * tie-breaker.
 */
function confirmation(windows: TradeWindows): number {
  if (windows.last7 === 0 || windows.last30 === 0) return 0;
  const size = Math.min(Math.abs(windows.last7) * 0.5, MAX_WEEK_SWING);
  return Math.sign(windows.last7) === Math.sign(windows.last30) ? size : -size;
}

/**
 * Lifetime, as support and nothing else.
 *
 * Only ever paid to a player who is *already* moving, and capped at half a
 * point. Two conditions, both load-bearing: a quiet veteran earns nothing here
 * because `last30` is zero, and a player whose career disagrees with his month
 * earns nothing because `conflicted` is already charging him for it. Without
 * the cap this becomes the classifier and the trade board becomes a list of
 * good players.
 */
function lifetimeSupport(windows: TradeWindows): number {
  if (windows.lifetime === 0 || windows.last30 === 0) return 0;
  if (Math.sign(windows.lifetime) !== Math.sign(windows.last30)) return 0;
  return Math.min(Math.abs(windows.lifetime) * 0.05, MAX_LIFETIME_SUPPORT);
}

/** A small nudge for a call more than one item stands behind. Never decisive. */
function volumeOf(windows: TradeWindows): number {
  return Math.min(windows.items30, 5) * 0.1;
}

/**
 * How strong the sustained case is. What Trade Target — and both sell
 * verdicts — rank on.
 *
 * The 30-day window is the leading term and everything else is bounded well
 * below it, so the ordering a reader sees is the ordering of the number on the
 * card. A +13 sits above a +10 unless something nameable intervenes, and the
 * only things that can intervene are worth at most about two points between
 * them.
 */
export function sustainedScore(windows: TradeWindows): number {
  const trend = Math.abs(windows.last30);
  const penalty = conflicted(windows) ? 0.5 : 0;
  return round3(trend + confirmation(windows) + volumeOf(windows) + lifetimeSupport(windows) - penalty);
}

/**
 * How much the case strengthened this week. What Emerging ranks on.
 *
 * Acceleration leads rather than `last30`, because inside this bucket the
 * 30-day total is mostly just this week counted a second time — an emerging
 * player is one whose preceding 23 days were quiet. Volume and lifetime stay as
 * the same bounded context they are everywhere else.
 */
export function emergingScore(windows: TradeWindows): number {
  const penalty = conflicted(windows) ? 0.5 : 0;
  return round3(acceleration(windows) + volumeOf(windows) + lifetimeSupport(windows) - penalty);
}

/**
 * Ordering within the list.
 *
 * Each group is ranked by the question its label asks, which is the point of
 * having two labels. Ordering across groups is not meaningful and is not read:
 * the screen groups first, and `groupByVerdict` preserves this order inside
 * each section.
 */
export function urgencyOf(windows: TradeWindows, verdict?: TradeVerdict): number {
  return verdict === 'emerging_target' ? emergingScore(windows) : sustainedScore(windows);
}

/**
 * Every term that produced the score, for a person auditing a row.
 *
 * Developer-facing on purpose — no screen reads this. It exists so "why is he
 * above him" has an arithmetic answer rather than an argument, which is the
 * failure this whole module is being corrected for.
 */
export interface TradeScoreBreakdown {
  /** Which question the score answered, and therefore which group it ranks in. */
  basis: 'sustained' | 'emerging';
  last30: number;
  last7: number;
  /** Days 8–30, the baseline acceleration is measured against. */
  prior23: number;
  acceleration: number;
  lifetime: number;
  /** Signed contribution of the 7-day window. */
  confirmation: number;
  lifetimeSupport: number;
  volume: number;
  conflictPenalty: number;
  injury: number;
  total: number;
}

export function explainScore(
  windows: TradeWindows,
  verdict: TradeVerdict,
  injuryDelta = 0,
): TradeScoreBreakdown {
  const emerging = verdict === 'emerging_target';
  return {
    basis: emerging ? 'emerging' : 'sustained',
    last30: windows.last30,
    last7: windows.last7,
    prior23: priorWindow(windows),
    acceleration: acceleration(windows),
    lifetime: windows.lifetime,
    confirmation: emerging ? 0 : round3(confirmation(windows)),
    lifetimeSupport: round3(lifetimeSupport(windows)),
    volume: round3(volumeOf(windows)),
    conflictPenalty: conflicted(windows) ? 0.5 : 0,
    injury: injuryDelta,
    total: round3(urgencyOf(windows, verdict) + injuryDelta),
  };
}

function explain(
  windows: TradeWindows,
  verdict: TradeVerdict,
  ownership: Ownership,
  pending: number,
): { reasons: string[]; counterpoints: string[] } {
  const reasons: string[] = [];
  const counterpoints: string[] = [];
  const sign = (n: number) => `${n > 0 ? '+' : ''}${n}`;

  if (windows.last30 !== 0) {
    const direction = windows.last30 > 0 ? 'improving' : 'deteriorating';
    reasons.push(`${direction} over 30 days (${sign(windows.last30)} from ${windows.items30} item(s))`);
  } else {
    counterpoints.push('nothing in the last 30 days');
  }

  /*
   * What the week says, in the terms the verdict was reached in.
   *
   * An emerging call was made *because* of the split between the week and the
   * 23 days before it, so it says so with both numbers. Everywhere else the
   * week is a confirmation and one number is enough.
   */
  if (verdict === 'emerging_target') {
    reasons.push(
      `new this week — ${sign(windows.last7)} in 7 days against ${sign(priorWindow(windows))} over the 23 before`,
    );
  } else if (windows.last7 !== 0 && Math.sign(windows.last7) === Math.sign(windows.last30)) {
    reasons.push(`still moving this week (${sign(windows.last7)})`);
  } else if (windows.last7 !== 0) {
    counterpoints.push(`this week points the other way (${sign(windows.last7)})`);
  }

  if (windows.lifetime !== 0) {
    const agrees = Math.sign(windows.lifetime) === Math.sign(windows.last30);
    const line = `lifetime ${sign(windows.lifetime)} across ${windows.itemsLifetime} item(s)`;
    if (agrees) reasons.push(`${line}, which agrees`);
    else counterpoints.push(`${line}, which does not`);
  }

  if (verdict === 'sell_high') {
    counterpoints.push('no market price is available, so "high" is inferred from the lifetime record, not observed');
  }
  if (verdict === 'emerging_target') {
    // Not "small sample" any more — that was the old classifier describing its
    // own bug. The case may be well evidenced; what it is not yet is durable.
    counterpoints.push('one week of evidence — the case is new rather than established');
  }
  if (verdict === 'add_waiver' && ownership === 'free') {
    reasons.push('nobody rosters them, so no trade is needed');
  }
  if (pending > 0) counterpoints.push(`${pending} news item(s) still awaiting your review`);

  return { reasons, counterpoints };
}

/**
 * Rank every candidate into trade ideas.
 *
 * Players with nothing to say are dropped rather than listed as "hold": a list
 * of six hundred players who have not been in the news is not intelligence.
 */
export function rankTrades(candidates: TradeCandidate[], opts: TradeOptions = {}): TradeSuggestion[] {
  const out: TradeSuggestion[] = [];

  for (const candidate of candidates) {
    const windows = windowsOf(candidate.signal);
    if (windows.items30 === 0 && windows.itemsLifetime === 0) continue;

    const verdict = classify(windows, candidate.ownership, opts);
    // A "hold" with no recent movement is not worth a row.
    if (verdict === 'hold_mixed' && windows.last30 === 0 && windows.last7 === 0) continue;

    const pending = candidate.signal?.pendingCount ?? 0;
    const { reasons, counterpoints } = explain(windows, verdict, candidate.ownership, pending);
    const injury = candidate.injury
      ? tradeInjuryContext(candidate.injury, { outlook: candidate.outlook })
      : NO_TRADE_INJURY;

    out.push({
      playerId: candidate.player.id,
      name: candidate.player.fullName,
      position: candidate.player.position,
      team: candidate.player.team,
      ownership: candidate.ownership,
      verdict,
      label: VERDICT_LABELS[verdict],
      windows,
      urgency: round3(urgencyOf(windows, verdict) + injury.urgencyDelta),
      confidence: confidenceOf(windows, pending, opts),
      breakdown: explainScore(windows, verdict, injury.urgencyDelta),
      reasons: injury.note ? [...reasons, injury.note] : reasons,
      counterpoints,
      injury,
    });
  }

  return out.sort(
    (a, b) => b.urgency - a.urgency || b.windows.items30 - a.windows.items30 || a.name.localeCompare(b.name),
  );
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Group ranked suggestions into the sections the screen shows. */
export function groupByVerdict(suggestions: TradeSuggestion[]): { verdict: TradeVerdict; label: string; players: TradeSuggestion[] }[] {
  // Fixed order so the screen does not reshuffle as the evidence changes.
  const order: TradeVerdict[] = [
    'trade_target',
    'emerging_target',
    'add_waiver',
    'sell_high',
    'trade_away',
    'hold_mixed',
  ];
  return order
    .map((verdict) => ({
      verdict,
      label: VERDICT_LABELS[verdict],
      players: suggestions.filter((s) => s.verdict === verdict),
    }))
    .filter((section) => section.players.length > 0);
}
