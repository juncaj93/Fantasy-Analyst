/**
 * Trade intelligence.
 *
 * Draft scoring is dominated by the lifetime record, because a draft is a bet
 * on a whole season and an offseason of evidence is the best thing you have.
 * Trades are the opposite question: what has changed lately, and does anyone
 * else know yet. So the 30-day window leads here, the 7-day window says whether
 * it is still moving, and lifetime stays as context rather than as the verdict.
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
  /** Higher means "look at this first". Comparable within one run only. */
  urgency: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  counterpoints: string[];
}

export interface TradeCandidate {
  player: CanonicalPlayer;
  signal: PlayerSignal | null;
  ownership: Ownership;
}

export interface TradeOptions {
  /**
   * Evidence items in the 30-day window below which a positive trend is called
   * "emerging" rather than acted on. Two items is a pattern; one is a sentence.
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
 * How much to trust the call.
 *
 * Volume raises it, contradiction and unreviewed items lower it. A single
 * emphatic sentence is not conviction, however emphatic.
 */
export function confidenceOf(windows: TradeWindows, pending: number): 'high' | 'medium' | 'low' {
  if (conflicted(windows)) return 'low';
  if (pending > 0 && windows.items30 <= pending) return 'low';
  if (windows.items30 >= 3) return 'high';
  if (windows.items30 === 2) return 'medium';
  return 'low';
}

/**
 * Classify one player.
 *
 * The asymmetry between "sell high" and "trade away" is the point of the
 * distinction: both describe a player whose news is getting worse, but only one
 * of them still has value to trade on. Lifetime standing is the proxy for that,
 * which is exactly why the label says *possible* — the app has no market price
 * for a rostered player and should not pretend otherwise.
 */
export function classify(windows: TradeWindows, ownership: Ownership, opts: TradeOptions = {}): TradeVerdict {
  const minItems = opts.minItemsForConviction ?? DEFAULTS.minItemsForConviction;
  const minTrend = opts.minTrend ?? DEFAULTS.minTrend;

  const rising = windows.last30 >= minTrend;
  const falling = windows.last30 <= -minTrend;
  const thin = windows.items30 < minItems;

  if (ownership === 'mine') {
    if (falling) return windows.lifetime > 0 ? 'sell_high' : 'trade_away';
    return 'hold_mixed';
  }

  if (rising) {
    if (ownership === 'free') return 'add_waiver';
    return thin ? 'emerging_target' : 'trade_target';
  }

  // A player somebody else holds whose news is not moving is not a trade idea.
  return 'hold_mixed';
}

/**
 * Ordering within the list.
 *
 * The 30-day trend leads, the 7-day window breaks ties in favour of things
 * still moving, and volume breaks the rest. Lifetime deliberately contributes
 * nothing to ordering: it is context for the reader, not a discovery driver,
 * or every trade list would just be a list of good players.
 */
export function urgencyOf(windows: TradeWindows): number {
  const trend = Math.abs(windows.last30);
  const acceleration = Math.abs(windows.last7) * 0.5;
  const volume = Math.min(windows.items30, 5) * 0.1;
  const penalty = conflicted(windows) ? 0.5 : 0;
  return Math.round((trend + acceleration + volume - penalty) * 1000) / 1000;
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

  if (windows.last7 !== 0 && Math.sign(windows.last7) === Math.sign(windows.last30)) {
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
    counterpoints.push('small sample — worth watching before paying for it');
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

    out.push({
      playerId: candidate.player.id,
      name: candidate.player.fullName,
      position: candidate.player.position,
      team: candidate.player.team,
      ownership: candidate.ownership,
      verdict,
      label: VERDICT_LABELS[verdict],
      windows,
      urgency: urgencyOf(windows),
      confidence: confidenceOf(windows, pending),
      reasons,
      counterpoints,
    });
  }

  return out.sort(
    (a, b) => b.urgency - a.urgency || b.windows.items30 - a.windows.items30 || a.name.localeCompare(b.name),
  );
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
