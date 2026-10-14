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
import { adviseBid, type BidPosture, type BidSignals, type ClaimRecord, type RivalContext, type RivalSeat, buildRivalProfiles } from './bidModel.ts';
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
  /** The other managers most likely to bid, most likely first, with the few words behind each. */
  likely: { name: string; chance: number; style: string; why?: string | null }[];
  /** How hard the bid tries: a hole, an upgrade, or a stash. Absent on older responses. */
  posture?: BidPosture;
  /** Set when the record is thin. */
  thin: string | null;
  /** When a claim clears, ISO. */
  until: string | null;
  /**
   * Everything the bid was made from, for the support snapshot and the Probe's
   * bid trace. Not drawn. Absent on a free agent and on older responses.
   */
  trace?: BidTrace;
}

export interface BidTrace {
  signals: BidSignals;
  /** The advice before the value ceiling. */
  advised: { recommended: number; low: number; high: number };
  /** FAAB left, the cap on any bid. */
  remaining: number | null;
  /** The league's claims this season that are not voided, and its targets a run. */
  validClaims: number;
  targetsPerRun: number;
  expectedBidders: number;
  /** The five most likely other bidders, with their chance and likely bid. */
  bidders: { name: string; style: string; chance: number; likelyBid: number; why?: string | null; parts?: unknown }[];
}

export interface TierRow extends TierMove {
  bid: TierBid;
  lastWeekPoints: number | null;
}

export interface WaiverTiersView {
  /** The first "Do this" move, for older readers. */
  doThis: TierRow | null;
  /** Every "Do this" move: one per starting hole, plus at most one big upgrade. Absent on older responses. */
  doThese?: TierRow[];
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
  audit: {
    playerId: string;
    name: string;
    position: string;
    gain: number;
    reason: string;
    drop: string | null;
    /** His number for each window week and its source. */
    weekNumbers: TierMove['weekNumbers'];
    /** The lineup change week by week, unweighted. */
    byWeek: number[];
    /** Preferences applied, in points. */
    prefs: number;
  }[];
  /** Each other manager's bidding profile behind the bids. */
  profiles: { name: string; style: string; source: 'seed' | 'default'; note: string | null; claimsPerRun: number; bids: number[] }[];
  /** Free agents never offered, and why (out for the season, back too late). Not drawn. */
  excluded?: WaiverTierPlan['excluded'];
  /** Each bench player's drop score, lowest first. Not drawn; the sheet shows the drop's own reason. */
  dropScores?: WaiverTierPlan['dropScores'];
  /** The rival read, per manager: record, need is per player. Not drawn. */
  bidderReads?: { name: string; rate: number; seasons: string[]; source: 'history' | 'seed'; remaining: number | null; interest: Record<string, number>; chase: number }[];
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
  /**
   * The need-aware rival read: for a position, each rival's record, need and
   * FAAB, by roster id. Absent: the old model reads every rival.
   */
  rivalsFor?: ((position: string) => ReadonlyMap<number, RivalContext>) | undefined;
}

export function buildTiersView(input: TierViewInput): WaiverTiersView {
  const usesFaab = input.budgets?.rule.usesFaab ?? input.rules?.usesFaab ?? true;
  const remaining = input.budgets ? (myBudget(input.budgets)?.remaining ?? null) : null;
  const { profiles, targetsPerRun, validClaims } = buildRivalProfiles({ seats: input.seats, claims: input.claims });

  const postureOf = (m: TierMove): BidPosture =>
    m.tier === 'do_this' ? 'do_this' : m.tier === 'consider' && m.reasonCode !== 'ir_stash' ? 'consider' : 'stash';
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
    const posture = postureOf(m);
    const advice = adviseBid({
      signals,
      profiles,
      targetsPerRun,
      validClaims,
      remaining,
      rivals: input.rivalsFor?.(m.position),
      position: m.position,
      posture: input.rivalsFor ? posture : undefined,
    });
    const ceiling = posture === 'stash' ? null : ceilingFor(m, input);
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
          ? `${advice.why}. He is worth about $${ceiling} to you, less than the $${advice.recommended} it likely takes, so bid $${ceiling} only if you want him anyway.`
          : advice.reason,
        ceiling,
        overCeiling,
        likely: advice.rivals
          .filter((r) => r.chance >= 0.1)
          .slice(0, 3)
          .map((r) => ({ name: r.name, chance: r.chance, style: STYLE_PRIORS[r.style].label, ...(r.why !== undefined ? { why: r.why } : {}) })),
        ...(input.rivalsFor ? { posture } : {}),
        thin: advice.thin,
        until: pickup?.until ?? null,
        trace: {
          signals,
          advised: { recommended: advice.recommended, low: advice.low, high: advice.high },
          remaining,
          validClaims,
          targetsPerRun,
          expectedBidders: advice.expectedRivals,
          bidders: advice.rivals.slice(0, 5).map((r) => ({
            name: r.name,
            style: r.style,
            chance: r.chance,
            likelyBid: r.likelyBid,
            ...(r.why !== undefined ? { why: r.why } : {}),
            ...(r.parts ? { parts: r.parts } : {}),
          })),
        },
      },
    };
  };

  const doThese = (input.plan.doThese ?? (input.plan.doThis ? [input.plan.doThis] : [])).map(rowFor);
  return {
    doThis: doThese[0] ?? null,
    doThese,
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
      weekNumbers: m.weekNumbers,
      byWeek: m.byWeek.map((w) => w.change),
      prefs: m.prefs.reduce((s, p) => s + p.points, 0),
    })),
    freeAgentRule: input.rules ? freeAgentRule(input.rules) : null,
    profiles: profiles.map((p) => ({
      name: p.name,
      style: STYLE_PRIORS[p.style].label,
      source: p.styleSource,
      note: p.seedNote,
      claimsPerRun: p.claimsPerRun,
      bids: p.bids,
    })),
    excluded: input.plan.excluded ?? [],
    dropScores: input.plan.dropScores ?? [],
    ...(input.rivalsFor
      ? {
          bidderReads: profiles.map((p) => {
            const c = input.rivalsFor!('QB').get(p.rosterId);
            return {
              name: p.name,
              rate: c?.tendency.rate ?? 0,
              seasons: c?.tendency.seasons ?? [],
              source: c?.tendency.source ?? 'seed',
              remaining: c?.remaining ?? null,
              interest: c?.tendency.interest ?? {},
              chase: c?.tendency.chase ?? 1,
            };
          }),
        }
      : {}),
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
  return { kind, recommended: null, low: null, high: null, reason, ceiling: null, overCeiling: false, likely: [], thin: null, until: pickup?.until ?? null };
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
  const moves = view.doThese && view.doThese.length > 0 ? view.doThese : view.doThis ? [view.doThis] : [];
  const dropHints = [...moves, ...view.consider, ...view.watch]
    .filter((r): r is TierRow => r != null && r.drop != null)
    .map((r) => ({ addPlayerId: r.playerId, dropName: r.drop!.name, label: r.drop!.viaReserve ? `Move ${r.drop!.name} to IR` : `Drop ${r.drop!.name}` }));
  if (moves.length === 0) {
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
  /* One claim per move, each under its own drop: two holes are two claims, never one drop twice. */
  const claims: WaiverClaimLine[] = [];
  const groups: WaiverClaimGroup[] = [];
  moves.forEach((m, i) => {
    const rank = i + 1;
    const free = m.bid.kind === 'free';
    const bidText = m.bid.kind === 'claim' && m.bid.recommended != null ? `bid $${m.bid.recommended}` : null;
    claims.push({
      rank,
      claimId: `${m.playerId}>${m.drop?.playerId ?? 'none'}`,
      group: rank,
      addPlayerId: m.playerId,
      addName: m.name,
      addPosition: m.position,
      addTeam: m.team,
      dropPlayerId: m.drop && !m.drop.viaReserve ? m.drop.playerId : null,
      dropName: m.drop && !m.drop.viaReserve ? m.drop.name : null,
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
    });
    groups.push({
      index: rank,
      drop: m.drop && !m.drop.viaReserve ? { playerId: m.drop.playerId, name: m.drop.name } : null,
      headline: m.needsSpot
        ? `Pick your drop: ${m.needsSpot.map((c) => `${c.name} (${c.reason})`).join('; ')}`
        : m.drop?.viaReserve
        ? `Move ${m.drop.name} to IR, then claim ${m.name}`
        : m.drop
          ? `Drop ${m.drop.name}`
          : 'Open roster spot: this one needs no drop',
      keep: [],
      keepNote: null,
      formNote: null,
      firstRank: rank,
      lastRank: rank,
    });
  });
  return {
    surface: true,
    state: 'plan',
    headline: 'Do this',
    instruction: null,
    groups,
    claims,
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
