/**
 * Three numbers that are not the same number.
 *
 * The whole point of this module is a distinction most waiver advice collapses:
 *
 *   - the **expected market price** is what the room will probably pay. It is a
 *     forecast about other people and has nothing to do with your roster;
 *   - the **recommended bid** is what this player is worth *to you*, given what
 *     he replaces, how long the value lasts, and what else your budget still has
 *     to buy this season. It is frequently below the market price, and that is
 *     not a mistake — it is the advice;
 *   - the **do-not-exceed ceiling** is the line past which winning is worse than
 *     losing.
 *
 * Collapse them into one figure and the tool stops being able to say the most
 * valuable sentence it has: *he will go for more than he is worth to you.*
 *
 * Everything is computed as a share of the league's own budget and only then
 * turned into dollars, so a $1,000 league and a $50 league get the same
 * reasoning. When the budget is unknown, this returns a bid-less answer rather
 * than a dollar figure — see `core/faab/budget.ts` for why that matters.
 *
 * Nothing here submits, queues or schedules a claim. It produces three numbers
 * and the sentence explaining them.
 */

import type { LeagueBudgetState, RosterBudget } from './budget.ts';
import { myBudget, standingAfterSpend } from './budget.ts';
import type { PriceSummary } from './bids.ts';
import { MIN_PRICE_SAMPLE } from './bids.ts';

/**
 * The largest share of a season budget any single player may be recommended at.
 *
 * Not a rule of thumb — an arithmetic one. Spending more than this on one week's
 * add leaves the rest of the season unable to answer an injury, and the whole
 * reason FAAB is a budget rather than a priority queue is that later weeks are
 * also weeks.
 */
export const MAX_RECOMMENDED_SHARE = 0.45;

/**
 * Weekly points of lineup upgrade treated as the top of the scale.
 *
 * Six points a week is a genuinely season-shifting add. Anchoring here rather
 * than at some notional "league winner" keeps the curve inside the range this
 * app can actually measure, and a player above it simply saturates.
 */
export const ELITE_WEEKLY_GAIN = 6;

/** How far above your own valuation you may go before winning is a loss. */
const OVERPAY_TOLERANCE = 1.2;

export type RoleStability = 'rising' | 'stable' | 'volatile' | 'unknown';
/** How long the reason this player is available is expected to last. */
export type ShelfLife = 'season' | 'multi_week' | 'one_week' | 'unknown';
export type FutureOpportunity = 'scarce' | 'normal' | 'plentiful';

export interface BidInputs {
  playerId: string;
  name: string;
  position: string;
  /** Weekly fantasy points gained over whoever currently starts that slot. */
  weeklyGain: number | null;
  /**
   * Weekly points gained over the *next best free agent*. Small means the roster
   * hole can be patched for a dollar and the bid should reflect that.
   */
  gainOverReplacement: number | null;
  roleStability: RoleStability;
  shelfLife: ShelfLife;
  futureOpportunity: FutureOpportunity;
  /**
   * Market attention, 0–1, from Sleeper's trending list. Raises the *expected
   * price* and nothing else — see `core/market/disagreement.ts`.
   */
  marketHeat: number | null;
  /** Rosters that plausibly want him and can pay. Drives expected competition. */
  rivalsWithNeed: number | null;
}

export interface SeasonContext {
  /** 1-based. */
  week: number;
  /** Last week of the fantasy regular season — the last week a bid can pay off. */
  finalWeek: number;
}

export interface BidComponent {
  key: string;
  label: string;
  /** Multiplicative, so a component is always visible as "×0.85". */
  factor: number;
  note: string;
}

export interface BidRecommendation {
  playerId: string;
  name: string;
  /** Null whenever no dollar advice can honestly be given. */
  expected: { low: number; high: number } | null;
  recommended: number | null;
  doNotExceed: number | null;
  /** `Expected $17–22 · Recommended max $19 · Preserve budget for RB depth` */
  headline: string;
  reasons: string[];
  /** The valuation, before the budget was allowed to constrain it. */
  worth: number | null;
  components: BidComponent[];
  confidence: 'none' | 'low' | 'medium' | 'high';
  /** Set whenever the answer is deliberately not a number. */
  withheld: string | null;
}

/**
 * What this player is worth to this roster, as a share of the season budget.
 *
 * Two things multiply: **how much better he makes the lineup** and **for how
 * long**. Neither alone is a valuation. A five-point upgrade for one week and a
 * one-point upgrade for ten weeks are different purchases, and a model that
 * ranks by weekly gain alone will consistently overpay for the first.
 *
 * The duration term keeps a floor: a genuine one-week rental in a week you are
 * favoured to win is still worth real money, just not most of the season.
 */
export function worthShare(inputs: BidInputs, season: SeasonContext): { share: number; components: BidComponent[] } {
  const components: BidComponent[] = [];

  const gain = inputs.weeklyGain ?? 0;
  const gainFactor = clamp01(gain / ELITE_WEEKLY_GAIN);

  const weeksLeft = Math.max(1, season.finalWeek - season.week + 1);
  const weeksOfValue =
    inputs.shelfLife === 'season'
      ? weeksLeft
      : inputs.shelfLife === 'multi_week'
        ? Math.min(weeksLeft, 4)
        : inputs.shelfLife === 'one_week'
          ? 1
          : // Unknown is not optimism. Two weeks is the shortest span that is
            // worth more than a stream and the longest that can be assumed.
            Math.min(weeksLeft, 2);
  const durationFactor = clamp01(weeksOfValue / weeksLeft);
  const duration = 0.2 + 0.8 * durationFactor;

  let share = MAX_RECOMMENDED_SHARE * gainFactor * duration;
  components.push({
    key: 'upgrade',
    label: 'Lineup upgrade',
    factor: round3(gainFactor),
    note: inputs.weeklyGain == null ? 'no measurable upgrade' : `${gain.toFixed(1)} pts/wk over your current starter`,
  });
  components.push({
    key: 'duration',
    label: 'How long it lasts',
    factor: round3(duration),
    note: `${weeksOfValue} of ${weeksLeft} remaining week(s)`,
  });

  /*
   * What the roster could do instead, for a dollar.
   *
   * The single most expensive mistake in FAAB is paying starter money for a
   * gap that streams. If the next free agent is nearly as good, most of the
   * upgrade is available for free and the bid should collapse towards free.
   */
  if (inputs.gainOverReplacement != null && inputs.weeklyGain != null && inputs.weeklyGain > 0) {
    const exclusive = clamp01(inputs.gainOverReplacement / Math.max(inputs.weeklyGain, 0.1));
    const factor = 0.35 + 0.65 * exclusive;
    share *= factor;
    components.push({
      key: 'replacement',
      label: 'Scarcity vs the next man',
      factor: round3(factor),
      note: `${inputs.gainOverReplacement.toFixed(1)} of those points are unavailable elsewhere`,
    });
  }

  const stability =
    inputs.roleStability === 'rising'
      ? 1.1
      : inputs.roleStability === 'volatile'
        ? 0.85
        : inputs.roleStability === 'unknown'
          ? 0.92
          : 1;
  share *= stability;
  components.push({
    key: 'role',
    label: 'Role stability',
    factor: stability,
    note: `role ${inputs.roleStability}`,
  });

  const future =
    inputs.futureOpportunity === 'scarce' ? 1.12 : inputs.futureOpportunity === 'plentiful' ? 0.85 : 1;
  share *= future;
  components.push({
    key: 'future',
    label: 'Chances like this later',
    factor: future,
    note:
      inputs.futureOpportunity === 'scarce'
        ? 'few comparable adds are likely to appear'
        : inputs.futureOpportunity === 'plentiful'
          ? 'this position keeps producing adds'
          : 'a normal supply of future adds',
  });

  return { share: clamp01(share), components };
}

/**
 * How much of what is left may be spent this week without stranding the season.
 *
 * A soft constraint on the *recommendation*, never on the ceiling. Early in the
 * season most of the budget's job is still ahead of it; in week 13 there is no
 * later, and holding money back is a way of losing with a full wallet.
 */
export function spendableNow(remaining: number, season: SeasonContext): number {
  const span = Math.max(1, season.finalWeek - 1);
  const progress = clamp01((season.week - 1) / span);
  const share = 0.55 + 0.45 * progress;
  return Math.max(0, Math.floor(remaining * share));
}

/**
 * What the room is likely to pay.
 *
 * League history leads whenever there is enough of it, because a league's own
 * prices are the only prices that describe this league. Below the sample
 * threshold the fallback is an explicit share-of-budget prior scaled by demand,
 * labelled low confidence, and never presented as observation.
 */
export function expectedMarketPrice(
  prices: PriceSummary,
  budget: { total: number },
  demand: number,
): { low: number; high: number; basis: 'league_history' | 'estimate' } {
  if (prices.sample >= MIN_PRICE_SAMPLE && prices.low != null && prices.high != null) {
    /*
     * The league's own quartiles, pushed by how contested *this* player is.
     *
     * The band is anchored on the league's typical winning bid and stretched
     * rather than shifted, because a hot name does not make the cheap end of
     * the market disappear — it makes the expensive end more likely.
     */
    const low = Math.max(1, Math.round((prices.low ?? 1) * (0.8 + 0.4 * demand)));
    const high = Math.max(low + 1, Math.round((prices.high ?? 1) * (0.9 + 0.9 * demand)));
    const cap = prices.max != null ? Math.max(prices.max, high) : high;
    return { low, high: Math.min(high, cap), basis: 'league_history' };
  }

  // No usable history: a demand-scaled share of the budget, plainly labelled.
  const centre = budget.total * (0.02 + 0.22 * demand);
  return {
    low: Math.max(1, Math.round(centre * 0.7)),
    high: Math.max(2, Math.round(centre * 1.4)),
    basis: 'estimate',
  };
}

/**
 * How contested this add is, 0–1.
 *
 * Two independent readings, averaged when both exist: how many rivals could use
 * him and can pay, and how hard the wider market is chasing him. The second is
 * global attention and the first is local money; a player can easily be hot
 * everywhere and uncontested here, which is exactly the bargain this is for.
 */
export function demandLevel(inputs: BidInputs, budgetState: LeagueBudgetState): number {
  const readings: number[] = [];

  const rivals = inputs.rivalsWithNeed;
  if (rivals != null) {
    const funded = budgetState.rosters.filter((r) => !r.isMine && (r.remaining ?? 0) > 0).length;
    if (funded > 0) readings.push(clamp01(rivals / funded));
  }
  if (inputs.marketHeat != null) readings.push(clamp01(inputs.marketHeat));

  if (readings.length === 0) return 0.4; // no information is not "uncontested".
  return round3(readings.reduce((a, b) => a + b, 0) / readings.length);
}

/**
 * The three numbers, and the sentence.
 *
 * Order is guaranteed and tested: `recommended <= doNotExceed`, and neither ever
 * exceeds the money actually left. The recommendation may sit below the expected
 * market band — that is a valid, and often the correct, answer.
 */
export function recommendBid(opts: {
  inputs: BidInputs;
  budgetState: LeagueBudgetState;
  prices: PriceSummary;
  season: SeasonContext;
  /** What the budget is being saved for, if anything. One short phrase. */
  reserveFor?: string | null;
}): BidRecommendation {
  const { inputs, budgetState, prices, season } = opts;
  const mine = myBudget(budgetState);

  const withheld = withholdReason(budgetState, mine);
  if (withheld) {
    return {
      playerId: inputs.playerId,
      name: inputs.name,
      expected: null,
      recommended: null,
      doNotExceed: null,
      headline: withheld,
      reasons: budgetState.notes,
      worth: null,
      components: [],
      confidence: 'none',
      withheld,
    };
  }

  const total = budgetState.rule.total as number;
  const remaining = mine?.remaining as number;

  const demand = demandLevel(inputs, budgetState);
  const { share, components } = worthShare(inputs, season);
  const worth = Math.round(total * share);
  const expected = expectedMarketPrice(prices, { total }, demand);

  /*
   * The recommendation is the smaller of what he is worth and what this week is
   * allowed to spend — but never below a dollar when he is worth anything at
   * all, because $0 is not a bid and "he is worth something, bid nothing" is
   * not advice.
   */
  const disciplined = Math.min(worth, spendableNow(remaining, season));
  const recommended = Math.max(worth > 0 ? 1 : 0, Math.min(disciplined, remaining));

  /*
   * The ceiling is your own valuation plus a bounded tolerance, capped by the
   * money that exists. It is deliberately not "the market price plus one": the
   * market being willing to pay $40 is a reason to lose the player, not a reason
   * to pay $40.
   */
  const doNotExceed = Math.max(recommended, Math.min(remaining, Math.round(worth * OVERPAY_TOLERANCE)));

  const reasons = buildReasons(inputs, expected, recommended, worth, demand, prices, season);
  const reserveFor = opts.reserveFor ?? null;
  if (reserveFor && recommended < worth) {
    reasons.push(`Held below his value to ${reserveFor}.`);
  }

  const headline = [
    `Expected $${expected.low}–${expected.high}`,
    `Recommended max $${recommended}`,
    reserveFor && recommended < worth ? `Preserve budget for ${reserveFor}` : null,
  ]
    .filter((p): p is string => p != null)
    .join(' · ');

  return {
    playerId: inputs.playerId,
    name: inputs.name,
    expected: { low: expected.low, high: expected.high },
    recommended,
    doNotExceed,
    headline,
    reasons,
    worth,
    components,
    confidence: expected.basis === 'league_history' ? prices.confidence : 'low',
    withheld: null,
  };
}

/** The cases where a dollar figure would be an invention. */
function withholdReason(state: LeagueBudgetState, mine: RosterBudget | null): string | null {
  if (!state.rule.usesFaab) return 'This league does not bid for waivers, so there is no budget advice to give.';
  if (state.rule.total == null) return 'Sleeper does not publish this league’s waiver budget, so no bid is suggested.';
  if (mine == null) return 'No roster in this league is marked as yours, so there is no budget to advise on.';
  if (mine.remaining == null) return 'Your remaining waiver budget is unknown, so no bid is suggested.';
  if (mine.remaining <= 0) return 'Your waiver budget is spent. Any claim this week has to be a $0 claim.';
  return null;
}

function buildReasons(
  inputs: BidInputs,
  expected: { low: number; high: number; basis: 'league_history' | 'estimate' },
  recommended: number,
  worth: number,
  demand: number,
  prices: PriceSummary,
  season: SeasonContext,
): string[] {
  const reasons: string[] = [];

  reasons.push(
    expected.basis === 'league_history'
      ? `Priced off ${prices.sample} winning bid(s) in this league.`
      : 'No usable bid history in this league yet, so the expected price is an estimate rather than an observation.',
  );

  if (recommended < expected.low) {
    reasons.push('He is likely to cost more than he is worth to this roster. Losing him at that price is fine.');
  } else if (recommended >= expected.high) {
    reasons.push('Worth more to you than the room is likely to pay.');
  }

  if (inputs.gainOverReplacement != null && inputs.gainOverReplacement < 1) {
    reasons.push('Most of the upgrade is available from a free agent nobody will bid on.');
  }
  if (inputs.shelfLife === 'one_week') reasons.push('A one-week rental — the window closes when the starter returns.');
  if (inputs.shelfLife === 'season') reasons.push('The role looks like it holds for the rest of the season.');
  if (inputs.roleStability === 'volatile') reasons.push('The role has moved around, which is priced in.');
  if (demand >= 0.66) reasons.push('Contested: several funded rosters can use him.');
  if (demand <= 0.2) reasons.push('Barely contested in this league, whatever the wider market is doing.');
  if (season.week >= season.finalWeek - 2 && worth > 0) {
    reasons.push('Late enough that unspent budget has almost no remaining use.');
  }
  return reasons;
}

export interface OpportunityCost {
  spend: number;
  remainingAfter: number;
  /** `still above 6/10 managers`, or the names it drops you below. */
  line: string;
  above: number;
  comparable: number;
  /**
   * Managers you currently out-money and would not after this bid.
   *
   * Deliberately not "everybody richer than you afterwards": being below the
   * league leader before and after a bid is not something the bid did, and a
   * card that blames it on the bid is measuring the wrong thing.
   */
  droppedBelow: string[];
}

/**
 * What a bid costs you in leverage, not in dollars.
 *
 * `$24` means nothing on its own. `$24 leaves you $41, still ahead of six of
 * ten` is a decision. Returns null rather than a fabricated comparison whenever
 * the budgets it would compare are not actually known.
 */
export function simulateOpportunityCost(state: LeagueBudgetState, spend: number): OpportunityCost | null {
  const mine = myBudget(state);
  if (mine?.remaining == null) return null;
  const standing = standingAfterSpend(state, spend);
  if (standing == null) return null;

  const remainingAfter = Math.max(0, mine.remaining - spend);

  /*
   * The interesting number is what the bid *changes*, not where you end up.
   *
   * Sitting below the league's richest manager before and after a $24 bid is
   * not a cost of the bid. Crossing below three managers you were ahead of an
   * hour ago is, and it is the only version of this line worth reading.
   */
  const wasAbove = new Set(
    state.rosters
      .filter((r) => !r.isMine && r.remaining != null && (mine.remaining as number) > (r.remaining as number))
      .map((r) => r.ownerName ?? `Roster ${r.rosterId}`),
  );
  const droppedBelow = standing.below.filter((name) => wasAbove.has(name));

  /*
   * Which half of the sentence leads.
   *
   * Dropping below two managers while still out-funding five is not the
   * headline — "still above 5/9" is, and it is the reassuring truth. Dropping
   * into the bottom half is the headline, and then the names matter. Report the
   * drop by name only when the list is short enough to read: falling below one
   * or two specific managers is a fact about those managers and worth naming;
   * falling below seven is a fact about you, and the count says it better.
   */
  const relegated = droppedBelow.length > 0 && standing.above * 2 < standing.comparable;
  const line =
    relegated
      ? `Bid $${spend} → $${remainingAfter} remaining · falls below ${
          droppedBelow.length <= 3 ? droppedBelow.join(', ') : `${droppedBelow.length} managers`
        }`
      : standing.comparable === 0
        ? `Bid $${spend} → $${remainingAfter} remaining`
        : standing.above === standing.comparable
          ? `Bid $${spend} → $${remainingAfter} remaining · still the richest budget in the league`
          : `Bid $${spend} → $${remainingAfter} remaining · still above ${standing.above}/${standing.comparable} managers`;

  return {
    spend,
    remainingAfter,
    line,
    above: standing.above,
    comparable: standing.comparable,
    droppedBelow,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
