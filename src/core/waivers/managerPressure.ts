/**
 * How much of the competition for a waiver player is *these particular people*.
 *
 * `competition.ts` answers how many rivals have a hole at the position and can
 * pay. `bidders.ts` names them and decomposes the league range across them.
 * Both read today: rosters, wallets, this season's bids. This reads the years —
 * who actually claims, who actually spends, who chases this position, who is
 * still holding budget in week 11 — and turns it into the four things the brief
 * permits and no more:
 *
 *   competition pressure · expected-cost context · urgency · confidence
 *
 * ## The boundary, and why it is drawn where it is
 *
 * **Intrinsic player value does not appear in this file.** Not the gain over a
 * starter, not the score, not the multi-week value, not `expected`,
 * `recommended` or `doNotExceed` from `core/faab/strategy.ts`. A rival who
 * spends heavily makes a player more expensive and more contested; he does not
 * make him better, and a model that let the two touch would be claiming he
 * does.
 *
 * That is why {@link WaiverManagerPressure} carries its *own* cost range rather
 * than adjusting the recommendation's. `costContext` is what a rival is likely
 * to have to beat given who is in the room; the recommendation is what this
 * roster should pay given what the player is worth. They are different
 * questions, they can honestly differ, and keeping them in different fields is
 * what stops a busy league quietly inflating every bid this app suggests.
 *
 * `core/league/bidders.ts` documents the same rule from the other side — a
 * named estimate is a decomposition of the aggregate, never an addition to it —
 * and a test asserts the three recommendation numbers are byte-identical with
 * this pass on and off.
 *
 * ## The cap is a guardrail, not a target
 *
 * Manager history moves the cost *context* by at most {@link MAX_MANAGER_COST_EFFECT}
 * either way, and every input to that factor is already shrunk toward the room
 * before it arrives. In a real league the observed movement is a few per cent;
 * the cap exists so that a manager with a strange season cannot produce a
 * strange number, not because anything is expected to reach it.
 */

import type { CompetitionAssessment } from '../league/competition.ts';
import type { PriceSummary } from '../faab/bids.ts';
import type {
  LeagueTransactionBaseline,
  ManagerTransactionProfile,
} from '../managers/transactionProfile.ts';

/**
 * The most manager history may move the expected-cost context, either way.
 *
 * A quarter. Two independent bounds already sit under it — every `relative` in
 * a transaction profile is clamped to ±40% of the room, and each is shrunk
 * toward the room by its own sample first — so reaching this cap needs several
 * rivals who all, independently and on real samples, spend well above their
 * league. That is a fact worth a quarter, and there is nothing this file could
 * learn that would be worth more.
 */
export const MAX_MANAGER_COST_EFFECT = 0.25;

/** The most manager history may move a candidate's urgency, either way. */
export const MAX_MANAGER_URGENCY_EFFECT = 0.15;

/** Rivals with usable history below which nothing is claimed at all. */
export const MIN_RIVALS_WITH_HISTORY = 2;

export type ContestLevel = 'likely_contested' | 'contested' | 'quiet' | 'unknown';

export const CONTEST_LABELS: Record<ContestLevel, string> = {
  likely_contested: 'Likely contested',
  contested: 'Some competition',
  quiet: 'Quiet wire',
  unknown: 'Rival history not known',
};

export interface WaiverManagerPressure {
  /** Rivals with a need at the position whose history is usable. */
  rivalsWithHistory: number;
  /** Of those, ones whose own history says they act more than the room does. */
  activeRivals: number;
  /** Of those, ones who spend above the room. */
  aggressiveRivals: number;
  /** Of those, ones whose adds skew toward this position specifically. */
  positionChasers: number;
  /** Rivals who have spent little of their budget early and still hold it. */
  fundedLateRivals: number;

  /**
   * The bounded factor applied to the cost *context*. 1 means "the room".
   *
   * Exposed rather than folded away so a diagnostic can show the raw factor
   * beside the range it produced, and so a test can assert the bound directly.
   */
  costFactor: number;
  /**
   * What a rival plausibly has to beat, given who is in this room.
   *
   * Context, never a recommendation. Null when the league has published no
   * winning bid to scale from — an unpriced league gets pressure and urgency
   * and no dollar figure, which is the honest degradation.
   */
  costContext: { low: number; high: number } | null;

  contested: ContestLevel;
  label: string;
  /** Added to an urgency the caller already computed. Bounded, signed. */
  urgencyDelta: number;
  confidence: 'high' | 'medium' | 'low';
  /** One sentence for a card, or null when nothing is supportable. */
  detail: string | null;
  /** Developer-facing workings. Richer than the card, on purpose. */
  notes: string[];
}

/** Nothing known: no history, no rivals, or a league nobody has backfilled. */
export const NEUTRAL_PRESSURE: WaiverManagerPressure = {
  rivalsWithHistory: 0,
  activeRivals: 0,
  aggressiveRivals: 0,
  positionChasers: 0,
  fundedLateRivals: 0,
  costFactor: 1,
  costContext: null,
  contested: 'unknown',
  label: CONTEST_LABELS.unknown,
  urgencyDelta: 0,
  confidence: 'low',
  detail: null,
  notes: [],
};

export interface WaiverPressureInput {
  /** Who needs the position and can pay, from `competition.ts`. */
  competition: CompetitionAssessment;
  /**
   * Transaction profiles for the rivals, keyed by *current* roster id.
   *
   * The mapping from Sleeper user id to roster id is the caller's, and it must
   * be done against the current roster table — which is what keeps a profile
   * from following a roster slot to its next occupant.
   */
  profilesByRoster: ReadonlyMap<number, ManagerTransactionProfile>;
  baseline: LeagueTransactionBaseline | null;
  /** The league's own winning-bid summary. The range this scales. */
  prices: PriceSummary | null;
  position: string;
  /** The week now, and the last one a claim can still buy a game. */
  week: number;
  finalWeek: number;
}

/**
 * Read the room's history into pressure, cost context and urgency.
 *
 * Pure and deterministic. Returns {@link NEUTRAL_PRESSURE} whenever there is no
 * usable history — which is the correct answer for a league in its first
 * season, for a league mid-backfill, and for a player nobody else needs.
 */
export function waiverManagerPressure(input: WaiverPressureInput): WaiverManagerPressure {
  const rivals = input.competition.bidders
    .map((bidder) => ({ bidder, profile: input.profilesByRoster.get(bidder.rosterId) }))
    .filter((r): r is { bidder: (typeof input.competition.bidders)[number]; profile: ManagerTransactionProfile } =>
      r.profile != null && r.profile.usable,
    );

  if (rivals.length < MIN_RIVALS_WITH_HISTORY || !input.baseline) {
    return {
      ...NEUTRAL_PRESSURE,
      rivalsWithHistory: rivals.length,
      notes:
        rivals.length === 0
          ? ['no rival with a need has usable transaction history']
          : [`only ${rivals.length} rival with usable history — below the ${MIN_RIVALS_WITH_HISTORY} needed to claim anything`],
    };
  }

  const notes: string[] = [];
  const activeRivals = rivals.filter((r) => r.profile.activityRelative >= 1.1).length;
  const aggressiveRivals = rivals.filter((r) => (r.profile.spendRelative ?? 1) >= 1.1).length;
  const positionChasers = rivals.filter((r) => {
    const entry = r.profile.byPosition.find((p) => p.position === input.position);
    return entry?.relative != null && entry.relative >= 1.2;
  }).length;

  /*
   * Rivals who are still holding money, late.
   *
   * Only meaningful in the back half: everybody has budget in week 2, so the
   * reading is worthless there and is not taken. After the halfway point a
   * manager whose spending has historically been back-loaded is a live threat
   * that the remaining-balance column already shows — this adds the part it
   * cannot, which is whether he is the sort of manager who will actually use it.
   */
  const lateSeason = input.finalWeek > 0 && input.week > input.finalWeek / 2;
  const fundedLateRivals = lateSeason
    ? rivals.filter((r) => r.profile.earlySpendShare != null && r.profile.earlySpendShare <= 0.4).length
    : 0;

  /*
   * The cost factor: the mean of the rivals' own spending relatives, weighted
   * by how much of each is his own rather than the room's.
   *
   * A mean rather than a maximum. One rival who bids big is one rival; the
   * price of winning is set by the field, and using the maximum would let a
   * single manager with an unusual season price every claim in the league.
   */
  let weightSum = 0;
  let weighted = 0;
  for (const { profile } of rivals) {
    const relative = profile.spendRelative;
    if (relative == null) continue;
    const weight = Math.max(0.1, profile.confidence);
    weighted += relative * weight;
    weightSum += weight;
  }
  const meanRelative = weightSum > 0 ? weighted / weightSum : 1;

  /*
   * And a small addition for how many of them chase this position specifically.
   *
   * Capped at a third of the whole allowance before the final clamp, so the
   * position reading can sharpen a picture the spending reading already drew
   * and can never be the whole of it.
   */
  const positionLift =
    rivals.length > 0
      ? Math.min(MAX_MANAGER_COST_EFFECT / 3, (positionChasers / rivals.length) * (MAX_MANAGER_COST_EFFECT / 3))
      : 0;

  const costFactor = round3(
    clamp(meanRelative + positionLift, 1 - MAX_MANAGER_COST_EFFECT, 1 + MAX_MANAGER_COST_EFFECT),
  );

  const costContext =
    input.prices?.low != null && input.prices.high != null && input.prices.sample > 0
      ? {
          low: Math.max(1, Math.round(input.prices.low * costFactor)),
          high: Math.max(1, Math.round(input.prices.high * costFactor)),
        }
      : null;

  /*
   * Urgency: three signals, each worth a third of the allowance.
   *
   * Rivals who act at the waiver run rather than off the wire mean the decision
   * is due before the run, not after it. Rivals who chase this position mean it
   * will not still be there. And a high-churn room means the opposite — a
   * speculative add tends to come back around, so there is less need to reach.
   */
  const third = MAX_MANAGER_URGENCY_EFFECT / 3;
  const waiverPlanners = rivals.filter(
    (r) => (r.profile.timing.find((t) => t.window === 'waiver')?.share ?? 0) >= 0.5,
  ).length;

  let urgency = 0;
  if (rivals.length > 0) {
    urgency += third * (waiverPlanners / rivals.length);
    urgency += third * (positionChasers / rivals.length);
    const churnyRoom =
      input.baseline.churnPerWeek > 0 &&
      rivals.filter((r) => r.profile.churnPerWeek >= input.baseline!.churnPerWeek * 1.25).length / rivals.length;
    if (churnyRoom) urgency -= third * churnyRoom;
  }
  const urgencyDelta = round3(clamp(urgency, -MAX_MANAGER_URGENCY_EFFECT, MAX_MANAGER_URGENCY_EFFECT));

  const contested = contestLevel({ rivals: rivals.length, activeRivals, aggressiveRivals, positionChasers });

  /*
   * Confidence is about the *sample*, not about the answer.
   *
   * Three rivals whose profiles are mostly their own is a strong reading even
   * when the reading is "this is an ordinary wire"; two rivals whose profiles
   * are mostly the room's is a weak one even when it says something dramatic.
   */
  const meanConfidence = rivals.reduce((sum, r) => sum + r.profile.confidence, 0) / rivals.length;
  const confidence: WaiverManagerPressure['confidence'] =
    rivals.length >= 3 && meanConfidence >= 0.5 ? 'high' : meanConfidence >= 0.3 ? 'medium' : 'low';

  notes.push(
    `${rivals.length} rival(s) with usable history: ${activeRivals} more active than the room, ` +
      `${aggressiveRivals} spending above it, ${positionChasers} skewed toward ${input.position}`,
  );
  notes.push(`cost context factor ${costFactor} (capped at ±${MAX_MANAGER_COST_EFFECT})`);
  if (fundedLateRivals > 0) {
    notes.push(`${fundedLateRivals} rival(s) historically spend late and still hold budget`);
  }
  if (urgencyDelta !== 0) notes.push(`urgency ${urgencyDelta > 0 ? '+' : ''}${urgencyDelta}`);

  return {
    rivalsWithHistory: rivals.length,
    activeRivals,
    aggressiveRivals,
    positionChasers,
    fundedLateRivals,
    costFactor,
    costContext,
    contested,
    label: CONTEST_LABELS[contested],
    urgencyDelta,
    confidence,
    detail: detailFor({
      contested,
      position: input.position,
      activeRivals,
      aggressiveRivals,
      positionChasers,
      fundedLateRivals,
      costContext,
    }),
    notes,
  };
}

function contestLevel(counts: {
  rivals: number;
  activeRivals: number;
  aggressiveRivals: number;
  positionChasers: number;
}): ContestLevel {
  const engaged = Math.max(counts.activeRivals, counts.aggressiveRivals, counts.positionChasers);
  if (engaged >= 3 || (engaged >= 2 && counts.positionChasers >= 2)) return 'likely_contested';
  if (engaged >= 1) return 'contested';
  return 'quiet';
}

/**
 * The card's sentence, from counts and neutral verbs only.
 *
 * "Several active managers historically spend aggressively on RB waivers" is
 * the shape the brief asks for, and it is assembled from three integers. No
 * manager is characterised, nobody is named here — `bidders.ts` owns naming,
 * and it does it from wallets and needs rather than from habits.
 */
function detailFor(args: {
  contested: ContestLevel;
  position: string;
  activeRivals: number;
  aggressiveRivals: number;
  positionChasers: number;
  fundedLateRivals: number;
  costContext: { low: number; high: number } | null;
}): string | null {
  const clauses: string[] = [];
  if (args.positionChasers >= 2) {
    clauses.push(`${args.positionChasers} rivals historically spend a larger share of their adds on ${args.position.toUpperCase()}`);
  } else if (args.aggressiveRivals >= 2) {
    clauses.push(`${args.aggressiveRivals} rivals historically bid above this room`);
  } else if (args.activeRivals >= 2) {
    clauses.push(`${args.activeRivals} rivals are historically more active than this room`);
  } else if (args.contested === 'quiet') {
    clauses.push('the rivals who need him are historically quiet on the wire');
  }
  if (args.fundedLateRivals >= 2) clauses.push(`${args.fundedLateRivals} of them historically save budget for later`);
  if (clauses.length === 0) return null;
  return `${clauses.join('; ')}.`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
