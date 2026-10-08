/**
 * The tier plan as the Waivers screen draws it: each move with its bid, and the
 * instruction card.
 *
 * `tiers.ts` decides who and why; `bidModel.ts` decides what to bid. This file
 * joins the two, adds the value ceiling from the existing pricing pass (what he
 * is worth to this roster, so a bid never runs past it unnoticed), and writes
 * the claim card the screen opens on. It decides nothing itself.
 *
 * Nothing here transacts. Every line is a recommendation to act on in Sleeper.
 */

import { recommendBid } from '../faab/strategy.ts';
import type { LeagueBudgetState } from '../faab/budget.ts';
import { myBudget } from '../faab/budget.ts';
import type { PriceSummary } from '../faab/bids.ts';
import { adviseBid, type BidSignals, type ClaimRecord, type RivalSeat, buildRivalProfiles } from './bidModel.ts';
import { STYLE_PRIORS } from './managerSeeds.ts';
import type { DeadSpot, TierMove, WaiverTierPlan } from './tiers.ts';
import type { PickupState, WaiverRules } from './clearWindow.ts';
import type { WaiverClaimGroup, WaiverClaimLine, WaiverClaimPlan } from './claimPlan.ts';
import { FREE_AGENT_PHRASE } from './claimPlan.ts';
import type { StartSitEvaluation } from '../startsit/engine.ts';

export interface TierBid {
  /** `free`: first come, no bid. `claim`: on waivers, bid. `none`: this league does not bid. */
  kind: 'free' | 'claim' | 'none';
  recommended: number | null;
  low: number | null;
  high: number | null;
  /** `Nobody is likely chasing him, so $1 should win.` */
  reason: string;
  /** What he is worth to this roster, from the pricing pass. */
  ceiling: number | null;
  /** The competition probably goes above what he is worth to you. */
  overCeiling: boolean;
  /** The rivals most likely to bid, most likely first. */
  rivals: { name: string; chance: number; style: string }[];
  /** Set when the record is thin. */
  thin: string | null;
  /** When a claim clears, ISO. */
  until: string | null;
}

export interface TierRow extends TierMove {
  bid: TierBid;
  lastWeekPoints: number | null;
}

export interface WaiverTiersView {
  doThis: TierRow | null;
  consider: TierRow[];
  watch: TierRow[];
  dropReady: DeadSpot[];
  window: WaiverTierPlan['window'];
  thresholds: WaiverTierPlan['thresholds'];
  valued: number;
  unvalued: number;
  /** The week whose points the bid model read, and whether they were on record. */
  lastWeek: { week: number; known: boolean };
  /** This league's rule for a player outside the waiver window, in words. */
  freeAgentRule: string | null;
  /** Every valued free agent's best move, top 20 by gain: the audit behind the thresholds. Not drawn. */
  audit: { playerId: string; name: string; position: string; gain: number; reason: string; drop: string | null }[];
  /** The rival profiles behind the bids, for the detail sheet. */
  rivals: { name: string; style: string; source: 'seed' | 'default'; note: string | null; claimsPerRun: number; bids: number[] }[];
}

export interface TierViewInput {
  plan: WaiverTierPlan;
  pickup: Readonly<Record<string, PickupState>>;
  rules: WaiverRules | null;
  budgets: LeagueBudgetState | null;
  prices: PriceSummary | null;
  /** This season's claims, for the rival profiles. */
  claims: readonly ClaimRecord[];
  seats: readonly RivalSeat[];
  lastWeek: { week: number; points: ReadonlyMap<string, number> | null };
  trending: ReadonlyMap<string, { heat: number; rank: number | null }>;
  /** Players the room rated: drafted early or a top Sleeper add. */
  held: ReadonlyMap<string, string>;
  /** Players somebody in this league paid $3 or more for this season. */
  paidFor: ReadonlySet<string>;
  evaluations: ReadonlyMap<string, StartSitEvaluation>;
  week: number;
  finalWeek: number;
}

export function buildTiersView(input: TierViewInput): WaiverTiersView {
  const usesFaab = input.budgets?.rule.usesFaab ?? input.rules?.usesFaab ?? true;
  const remaining = input.budgets ? (myBudget(input.budgets)?.remaining ?? null) : null;
  const { profiles, targetsPerRun, validClaims } = buildRivalProfiles({ seats: input.seats, claims: input.claims });

  const rowFor = (m: TierMove): TierRow => {
    const pickup = input.pickup[m.playerId] ?? null;
    const lastWeekPoints = input.lastWeek.points ? (input.lastWeek.points.get(m.playerId) ?? 0) : null;
    if (!usesFaab) {
      return { ...m, lastWeekPoints, bid: emptyBid('none', 'This league does not bid for waivers.', pickup) };
    }
    if (pickup?.state === 'free') {
      return {
        ...m,
        lastWeekPoints,
        bid: emptyBid('free', 'Free agent: first come, no bid', pickup),
      };
    }
    const trend = input.trending.get(m.playerId);
    const role = input.evaluations.get(m.playerId)?.role.trend;
    const signals: BidSignals = {
      lastWeekPoints,
      trendHeat: trend?.heat ?? null,
      trendRank: trend?.rank ?? null,
      roleRising: role === 'rising_high' || role === 'rising_moderate',
      freshDrop: pickup?.state === 'waivers' && pickup.reason === 'dropped' && (input.held.has(m.playerId) || input.paidFor.has(m.playerId)),
    };
    const advice = adviseBid({ signals, profiles, targetsPerRun, validClaims, remaining });
    const ceiling = ceilingFor(m, input);
    const overCeiling = ceiling != null && advice.recommended > ceiling;
    const recommended = overCeiling ? ceiling : advice.recommended;
    return {
      ...m,
      lastWeekPoints,
      bid: {
        kind: 'claim',
        recommended,
        low: Math.min(advice.low, recommended ?? advice.low),
        high: overCeiling ? ceiling : advice.high,
        reason: overCeiling
          ? `${advice.reason.replace(/, so bid \$\d+\.$/, '')}. That is more than he is worth to you ($${ceiling}), so bid $${ceiling} only if you want him anyway.`
          : advice.reason,
        ceiling,
        overCeiling,
        rivals: advice.rivals
          .filter((r) => r.chance >= 0.1)
          .slice(0, 3)
          .map((r) => ({ name: r.name, chance: r.chance, style: STYLE_PRIORS[r.style].label })),
        thin: advice.thin,
        until: pickup?.until ?? null,
      },
    };
  };

  return {
    doThis: input.plan.doThis ? rowFor(input.plan.doThis) : null,
    consider: input.plan.consider.map(rowFor),
    watch: input.plan.watch.map(rowFor),
    dropReady: input.plan.dropReady,
    window: input.plan.window,
    thresholds: input.plan.thresholds,
    valued: input.plan.valued,
    unvalued: input.plan.unvalued,
    lastWeek: { week: input.lastWeek.week, known: input.lastWeek.points != null },
    audit: input.plan.all.slice(0, 20).map((m) => ({
      playerId: m.playerId,
      name: m.name,
      position: m.position,
      gain: m.gain,
      reason: m.reason,
      drop: m.drop?.name ?? null,
    })),
    freeAgentRule: input.rules ? freeAgentRule(input.rules) : null,
    rivals: profiles.map((p) => ({
      name: p.name,
      style: STYLE_PRIORS[p.style].label,
      source: p.styleSource,
      note: p.seedNote,
      claimsPerRun: p.claimsPerRun,
      bids: p.bids,
    })),
  };
}

/** What he is worth to this roster, from the pricing pass's valuation. */
function ceilingFor(m: TierMove, input: TierViewInput): number | null {
  if (!input.budgets || !input.prices) return null;
  const weights = input.plan.window.weights.reduce((a, b) => a + b, 0) || 1;
  const role = input.evaluations.get(m.playerId)?.role;
  const rec = recommendBid({
    inputs: {
      playerId: m.playerId,
      name: m.name,
      position: m.position,
      weeklyGain: Math.max(0, m.gain / weights),
      gainOverReplacement: null,
      roleStability: role && role.games > 0 ? (role.trend.startsWith('rising') ? 'rising' : role.trend === 'stable' ? 'stable' : 'volatile') : 'unknown',
      shelfLife: 'unknown',
      futureOpportunity: 'normal',
      marketHeat: null,
      rivalsWithNeed: null,
    },
    budgetState: input.budgets,
    prices: input.prices,
    season: { week: input.week, finalWeek: input.finalWeek },
  });
  return rec.doNotExceed == null ? null : Math.max(1, rec.doNotExceed);
}

function emptyBid(kind: TierBid['kind'], reason: string, pickup: PickupState | null): TierBid {
  return { kind, recommended: null, low: null, high: null, reason, ceiling: null, overCeiling: false, rivals: [], thin: null, until: pickup?.until ?? null };
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** This league's own rule, from its settings. */
export function freeAgentRule(rules: WaiverRules): string {
  const day = DAYS[rules.runDay] ?? 'the run day';
  return `In this league a dropped player is on waivers for ${rules.clearDays} day${rules.clearDays === 1 ? '' : 's'}, and a player whose game has started waits for the ${day} run; anyone else is an instant add.`;
}

/**
 * The instruction card: the "Do this" move, as a claim to type into Sleeper.
 *
 * The same shape the screen has always drawn (`WaiverPlanCard`), so the
 * no-control guarantee and the daily production check keep reading one card.
 * Empty when nothing is a must-do this week.
 */
export function tierClaimPlan(view: WaiverTiersView, generatedAt: string): WaiverClaimPlan {
  const m = view.doThis;
  const dropHints = [view.doThis, ...view.consider, ...view.watch]
    .filter((r): r is TierRow => r != null && r.drop != null)
    .map((r) => ({ addPlayerId: r.playerId, dropName: r.drop!.name, label: `Drop ${r.drop!.name}` }));
  if (!m) {
    return {
      surface: false,
      state: view.consider.length > 0 || view.watch.length > 0 ? 'no_move' : 'no_targets',
      headline: 'No must-do move this week',
      instruction: null,
      groups: [],
      claims: [],
      note: null,
      mechanics: null,
      outcomes: [],
      relationships: [],
      protectedPlayers: [],
      budget: null,
      dropHints,
      generatedAt,
    };
  }
  const free = m.bid.kind === 'free';
  const bidText = m.bid.kind === 'claim' && m.bid.recommended != null ? `bid $${m.bid.recommended}` : null;
  const claim: WaiverClaimLine = {
    rank: 1,
    claimId: `${m.playerId}>${m.drop?.playerId ?? 'none'}`,
    group: 1,
    addPlayerId: m.playerId,
    addName: m.name,
    addPosition: m.position,
    addTeam: m.team,
    dropPlayerId: m.drop?.playerId ?? null,
    dropName: m.drop?.name ?? null,
    bid: m.bid.kind === 'claim' ? m.bid.recommended : null,
    bidRange:
      m.bid.kind === 'claim' && m.bid.low != null && m.bid.high != null
        ? m.bid.low === m.bid.high
          ? `$${m.bid.low}`
          : `$${m.bid.low}–${m.bid.high}`
        : null,
    headline: [`Add ${m.name}`, free ? FREE_AGENT_PHRASE : bidText].filter(Boolean).join(' · '),
    detail: `${m.reason} · +${m.gain.toFixed(1)} pts`,
    qualifier: null,
    relation: 'primary',
    why: [m.reason, m.bid.reason],
    pickup: null,
  };
  const group: WaiverClaimGroup = {
    index: 1,
    drop: m.drop ? { playerId: m.drop.playerId, name: m.drop.name } : null,
    headline: m.drop ? `Drop ${m.drop.name}` : 'Open roster spot: this one needs no drop',
    keep: [],
    keepNote: null,
    formNote: null,
    firstRank: 1,
    lastRank: 1,
  };
  return {
    surface: true,
    state: 'plan',
    headline: 'Do this',
    instruction: null,
    groups: [group],
    claims: [claim],
    note: null,
    mechanics: null,
    outcomes: [],
    relationships: [],
    protectedPlayers: [],
    budget: null,
    dropHints,
    generatedAt,
  };
}
