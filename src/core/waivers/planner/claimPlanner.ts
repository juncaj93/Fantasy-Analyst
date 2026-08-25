/**
 * Three claims that are not three independent recommendations.
 *
 * A waiver run is not a ranked list. Sleeper processes the claims in the order
 * they were entered, each one changes the roster the next one is evaluated
 * against, and a claim whose drop has already been spent simply does not
 * execute. That is a real mechanism with real consequences, and the plan that
 * exploits it looks nothing like the plan that ignores it:
 *
 *     1. Add A — drop C
 *     2. Add B — drop C
 *     3. Add B — drop D
 *
 * Read as a list this is nonsense: it claims one player twice and one drop
 * twice. Read as a machine it is exactly right. If claim 1 lands, C is gone and
 * claim 2 cannot execute, so B is only pursued through claim 3 and only at the
 * cost of a second drop. If claim 1 fails, claim 2 is the preferred way to land
 * B, and claim 3 never comes up because claim 2 already took him.
 *
 * The user should not have to work that out, and this module is the reason they
 * do not have to.
 *
 * ## How the plan is built
 *
 * Two passes, and the order of the two is the whole trick.
 *
 * **The spine** is the world where everything lands. Greedily: the best pair on
 * the roster as it stands, then the best pair on the roster *after that claim
 * succeeded*, and so on. The spine is the best case, and — this is the part
 * that matters — the second spine claim's drop is already different from the
 * first's, because the first one spent it.
 *
 * **The fallbacks** are the worlds where a spine claim fails. For every target
 * whose best move needs a drop an earlier claim would have consumed, that move
 * is inserted directly beneath the claim that would consume it. It is
 * unreachable when that claim succeeds — which is what makes it safe to enter —
 * and it is the preferred path when that claim fails.
 *
 * A fallback is only ever generated for a move that is genuinely blocked. A
 * move that would execute in *both* worlds is not a fallback, it is a second
 * claim, and it belongs on the spine or nowhere.
 *
 * ## What is deliberately not modelled
 *
 * **The chance of winning a claim.** This app has no defensible probability
 * model for a waiver bid — it has an observed price distribution, which is a
 * different thing — so nothing here multiplies by one. Every outcome below is a
 * *contingency*, reachable or not, and never a percentage. §10 of the brief is
 * explicit about this and it is the single easiest place in the feature to
 * invent a number that reads as knowledge.
 *
 * **The bid.** Taken whole from the existing FAAB pass, per target, and the
 * same for every claim on that target. Two claims for one player at two prices
 * would be two different opinions about what he is worth, and the difference
 * between them would be a fact about claim ordering rather than about football.
 */

import { pairsForTarget, viablePairs } from './pairs.ts';
import { applyClaims, type RosterSimulation } from './rosterState.ts';
import type {
  AddDropPair,
  ClaimRelation,
  DropCost,
  PlannerBid,
  TargetRelation,
  TargetRelationship,
  WaiverClaimRecommendation,
  WaiverPlannerLimits,
  WaiverReason,
} from './types.ts';

/**
 * Where the four target relationships sit on one ratio.
 *
 * The ratio is what the second target is still worth once the first has been
 * acquired, over what it was worth on its own. It is a simulation result, not a
 * label: nothing in this app declares two players to be substitutes, and the
 * same two players are substitutes on one roster and complements on another.
 */
export const RELATION_BANDS = { redundant: 0.15, substitute: 0.6 } as const;

export interface PlannedClaims {
  claims: WaiverClaimRecommendation[];
  relationships: TargetRelationship[];
  dropRanking: { addPlayerId: string; drops: DropCost[] }[];
  reasons: WaiverReason[];
  pairsEvaluated: number;
}

interface Candidate {
  playerId: string;
  bid: PlannerBid | null;
  boardRank: number | null;
}

interface SpineStep {
  pair: AddDropPair;
  /** The roster the pair was measured against. */
  rosterIds: readonly string[];
}

export function planClaims(opts: {
  simulation: RosterSimulation;
  candidates: readonly Candidate[];
  limits: WaiverPlannerLimits;
  budget?: { remaining: number | null; usesFaab: boolean } | null;
}): PlannedClaims {
  const { simulation, limits } = opts;
  const reasons: WaiverReason[] = [];
  const dropRanking: { addPlayerId: string; drops: DropCost[] }[] = [];
  let pairsEvaluated = 0;

  /*
   * Which targets are looked at at all.
   *
   * The caller's own board order when it has one, because that ranking already
   * contains league-specific intelligence this module has no access to;
   * otherwise the comparable start/sit score, which is free — every target was
   * evaluated when the simulation was built. Either way the list is cut to
   * {@link WaiverPlannerLimits.maxTargets} *before* any pair arithmetic runs,
   * which is what makes the bound a bound rather than an aspiration.
   */
  const considered = [...opts.candidates]
    .filter((c) => {
      if (!simulation.unscored.has(c.playerId)) return true;
      reasons.push({ code: 'target_not_scorable', playerId: c.playerId });
      return false;
    })
    .sort((a, b) => {
      if (a.boardRank != null && b.boardRank != null && a.boardRank !== b.boardRank) return a.boardRank - b.boardRank;
      if (a.boardRank != null && b.boardRank == null) return -1;
      if (a.boardRank == null && b.boardRank != null) return 1;
      const av = simulation.valueOf.get(a.playerId) ?? 0;
      const bv = simulation.valueOf.get(b.playerId) ?? 0;
      if (av !== bv) return bv - av;
      return (simulation.nameOf.get(a.playerId) ?? '').localeCompare(simulation.nameOf.get(b.playerId) ?? '');
    })
    .slice(0, limits.maxTargets);

  const bidOf = new Map(considered.map((c) => [c.playerId, c.bid ?? null]));

  /* Every target's best move on the roster as it stands. Used everywhere. */
  const baselineBest = new Map<string, AddDropPair>();
  const baselineAll = new Map<string, AddDropPair[]>();
  const baselineRanking = new Map<string, DropCost[]>();
  for (const candidate of considered) {
    const result = pairsForTarget({ simulation, addPlayerId: candidate.playerId, limits });
    pairsEvaluated += result.pairsEvaluated;
    dropRanking.push({ addPlayerId: candidate.playerId, drops: result.ranking });
    baselineAll.set(candidate.playerId, result.pairs);
    baselineRanking.set(candidate.playerId, result.ranking);
    const viable = viablePairs(result.pairs, limits);
    if (viable.length > 0) baselineBest.set(candidate.playerId, viable[0] as AddDropPair);
  }

  /**
   * Whether a claim would still be a good move if every claim above it failed.
   *
   * The question a spine claim below the first has to answer, and the reason it
   * is asked here rather than assumed: Sleeper does not know a claim was
   * conditional. Claim three is entered, and if claims one and two lose their
   * bids it executes anyway, against today's roster rather than the improved
   * one it was measured on. A claim that is excellent in the first world and a
   * bad trade in the second is a trap, and the only safe plan is one where
   * every claim clears the bar in both.
   *
   * The protection check is the sharper half. A drop that is free after an
   * earlier claim displaced him from the lineup is a *starter* if that claim
   * failed, and no waiver plan should be able to cut one by accident.
   */
  const standaloneOk = (pair: AddDropPair): boolean => {
    if (pair.dropPlayerId == null) return true;
    const ranking = baselineRanking.get(pair.addPlayerId) ?? [];
    const atBaseline = ranking.find((drop) => drop.playerId === pair.dropPlayerId);
    if (atBaseline == null || atBaseline.protection != null || atBaseline.cost == null) return false;

    const base = simulation.baseline.playerIds;
    const withAdd = simulation.after({ add: [pair.addPlayerId] });
    const addValue = simulation.utility(withAdd) - simulation.utility(base);
    return addValue - atBaseline.cost >= limits.minNetGain;
  };

  /*
   * The spine: the sequence in which everything lands.
   *
   * Greedy, and greedy is not an approximation here — each step is the best
   * single move on the roster the previous steps produced, which is what a
   * manager entering claims in order is actually choosing between. Searching
   * over orderings would optimise a quantity nobody experiences.
   */
  const spine: SpineStep[] = [];
  const taken = new Set<string>();
  let rosterIds = simulation.baseline.playerIds;

  while (spine.length < limits.maxClaims) {
    let best: AddDropPair | null = null;
    for (const candidate of considered) {
      if (taken.has(candidate.playerId)) continue;
      const standalonePair = baselineBest.get(candidate.playerId);
      /*
       * A move that is only good in one branch is not entered.
       *
       * A spine claim below the first executes whether or not the claims above
       * it succeeded — Sleeper does not know it was conditional. So it has to
       * clear the bar in both worlds: measured against the roster the spine
       * produced, and measured against the roster as it stands today. Without
       * this, a plan can hand somebody a third claim that is excellent if the
       * first two land and a bad trade if they do not.
       */
      if (standalonePair == null) continue;

      const result =
        spine.length === 0
          ? { pairs: baselineAll.get(candidate.playerId) ?? [], pairsEvaluated: 0 }
          : pairsForTarget({ simulation, addPlayerId: candidate.playerId, rosterIds, limits });
      pairsEvaluated += result.pairsEvaluated;
      const viable = viablePairs(result.pairs, limits).filter((pair) => spine.length === 0 || standaloneOk(pair));
      if (viable.length === 0) continue;
      const pair = viable[0] as AddDropPair;
      if (best == null || pair.netGain > best.netGain) best = pair;
    }
    if (best == null) break;
    spine.push({ pair: best, rosterIds });
    taken.add(best.addPlayerId);
    rosterIds = applyClaims(rosterIds, [best]);
  }

  if (spine.length === 0) {
    return { claims: [], relationships: [], dropRanking, reasons, pairsEvaluated };
  }

  /*
   * Fallbacks, hung beneath the claim that would block them.
   *
   * A target's best move on today's roster is a fallback exactly when the drop
   * it wants is a drop an earlier claim would spend. Anything else either made
   * the spine or is a move that would execute in both worlds, and a claim that
   * executes in both worlds is not a contingency — it is a second acquisition,
   * and it belongs on the spine where its incremental value was measured.
   */
  interface Slot {
    pair: AddDropPair;
    relation: ClaimRelation;
    blockedBy: string[];
    dependsOn: string[];
  }
  const ordered: Slot[] = [];

  const idOf = (pair: AddDropPair) => `${pair.addPlayerId}>${pair.dropPlayerId ?? 'none'}`;
  const spineIds = spine.map((step) => idOf(step.pair));

  for (const [index, step] of spine.entries()) {
    ordered.push({
      pair: step.pair,
      relation: index === 0 ? 'primary' : 'compatible',
      blockedBy: [],
      dependsOn: spineIds.slice(0, index),
    });

    const consumed = step.pair.dropPlayerId;
    if (consumed == null) continue;

    const fallbacks: AddDropPair[] = [];
    for (const candidate of considered) {
      const pair = baselineBest.get(candidate.playerId);
      if (pair == null || pair.dropPlayerId !== consumed) continue;
      /* The claim above it is the same move; it cannot be its own fallback. */
      if (idOf(pair) === idOf(step.pair)) continue;
      fallbacks.push(pair);
    }
    fallbacks.sort((a, b) => b.netGain - a.netGain || a.addName.localeCompare(b.addName));

    for (const pair of fallbacks) {
      ordered.push({
        pair,
        relation: 'fallback',
        blockedBy: [idOf(step.pair)],
        dependsOn: spineIds.slice(0, index),
      });
    }
  }

  /*
   * The claim budget, spent on the spine first.
   *
   * A fallback is worth less than the claim above it by construction — it only
   * exists in the branch where that claim failed — so when the list is too long
   * the fallbacks go first, from the bottom.
   */
  let claimSlots = [...ordered];
  while (claimSlots.length > limits.maxClaims) {
    const lastFallback = findLastIndex(claimSlots, (slot) => slot.relation === 'fallback');
    claimSlots.splice(lastFallback >= 0 ? lastFallback : claimSlots.length - 1, 1);
  }

  /* Money, read from the pricing pass and never recomputed. */
  claimSlots = applyBudget({ slots: claimSlots, bidOf, budget: opts.budget ?? null, reasons, idOf });

  /*
   * A league that does not bid does not get dollar figures, whatever it passed.
   *
   * The FAAB pass already withholds in a priority league — "this league does
   * not bid for waivers, so there is no budget advice to give" — so a caller
   * arriving here with both a price and `usesFaab: false` has contradicted
   * itself somewhere upstream. Printing the number anyway would put a bid on a
   * screen belonging to a league that has no bids, which is the one outcome
   * worse than saying nothing.
   */
  const priced = opts.budget == null || opts.budget.usesFaab;

  const claims: WaiverClaimRecommendation[] = claimSlots.map((slot, index) => {
    const bid = priced ? (bidOf.get(slot.pair.addPlayerId) ?? null) : null;
    const present = new Set(claimSlots.map((s) => idOf(s.pair)));
    const claimReasons: WaiverReason[] = [...slot.pair.reasons];

    for (const blocker of slot.blockedBy) {
      claimReasons.push({ code: 'blocked_by_earlier_claim', claimId: blocker });
      claimReasons.push({ code: 'fallback_for_earlier_claim', claimId: blocker });
    }
    if (slot.relation === 'compatible' && index > 0) {
      claimReasons.push({ code: 'independent_of_earlier_claim', claimId: spineIds[0] });
    }
    if (bid?.recommended != null) {
      claimReasons.push({ code: 'bid_reused_from_pricing', playerId: slot.pair.addPlayerId, value: bid.recommended });
    } else {
      claimReasons.push({ code: 'bid_unavailable', playerId: slot.pair.addPlayerId, value: null });
    }

    return {
      id: idOf(slot.pair),
      rank: index + 1,
      addPlayerId: slot.pair.addPlayerId,
      addName: slot.pair.addName,
      addPosition: slot.pair.addPosition,
      dropPlayerId: slot.pair.dropPlayerId,
      dropName: slot.pair.dropName,
      bid: bid?.recommended ?? null,
      doNotExceed: bid?.doNotExceed ?? null,
      bidHeadline: bid?.headline ?? bid?.withheld ?? null,
      netGain: slot.pair.netGain,
      relation: slot.relation,
      dependsOn: slot.dependsOn.filter((id) => present.has(id)),
      /*
       * Every earlier claim that would spend this one's drop, not just the one
       * it was hung beneath.
       *
       * Two targets can want the same cheap drop, in which case the plan holds
       * three claims against it — the spine claim and two fallbacks — and the
       * second fallback is unreachable if *either* of the two above it lands.
       * Deriving this from the final order rather than from the pass that built
       * it means the declared dependencies cannot fall behind the list.
       */
      blockedBy: claimSlots
        .slice(0, index)
        .filter((other) => other.pair.dropPlayerId != null && other.pair.dropPlayerId === slot.pair.dropPlayerId)
        .map((other) => idOf(other.pair))
        .filter((id) => present.has(id)),
      mutuallyExclusiveWith: claimSlots
        .filter((other) => other !== slot && other.pair.addPlayerId === slot.pair.addPlayerId)
        .map((other) => idOf(other.pair))
        .filter((id) => present.has(id)),
      reasons: claimReasons,
      pair: slot.pair,
    };
  });

  const relationships = describeRelationships({
    simulation,
    considered: considered.map((c) => c.playerId),
    spine,
    baselineBest,
    limits,
  });

  for (const relationship of relationships) {
    if (relationship.relation !== 'redundant') continue;
    reasons.push({
      code: 'redundant_after_earlier_claim',
      playerId: relationship.secondPlayerId,
      value: relationship.incrementalGain,
    });
  }

  return { claims, relationships, dropRanking, reasons, pairsEvaluated };
}

/**
 * Trim the plan to a spend the wallet can actually stand.
 *
 * The constraint is deliberately conservative, and the reason is §13 of the
 * brief rather than timidity. Nothing in this repository establishes what
 * Sleeper does with a set of pending claims that together exceed the budget —
 * whether it rejects them at entry, deducts sequentially and fails the last, or
 * something else — and the FAAB layer was built and tested against constructed
 * transactions rather than against a watched live waiver run. Guessing would
 * put a plan in front of somebody that the platform might reject wholesale.
 *
 * So the plan is held to the one condition that is safe under every possible
 * semantics: **no set of claims that could all succeed may total more than the
 * budget.** Mutually exclusive claims never both land and never both count, so
 * a fallback is free — which is the property that makes the A/B/C/D structure
 * affordable in the first place.
 *
 * Bids themselves are never altered here. A bid is the pricing pass's answer
 * and lowering one to fit a plan would be this module quietly disagreeing with
 * it about what a player is worth.
 */
function applyBudget<T extends { pair: AddDropPair; relation: ClaimRelation }>(args: {
  slots: T[];
  bidOf: ReadonlyMap<string, PlannerBid | null>;
  budget: { remaining: number | null; usesFaab: boolean } | null;
  reasons: WaiverReason[];
  idOf: (pair: AddDropPair) => string;
}): T[] {
  const { budget, bidOf, reasons } = args;
  if (budget == null || !budget.usesFaab || budget.remaining == null) return args.slots;

  const slots = [...args.slots];
  const spendOf = (slot: T) => bidOf.get(slot.pair.addPlayerId)?.recommended ?? 0;

  /* The spine is the only set in which every claim can land together. */
  const simultaneous = () =>
    slots.filter((s) => s.relation !== 'fallback').reduce((total, slot) => total + spendOf(slot), 0);

  while (simultaneous() > (budget.remaining as number)) {
    const last = findLastIndex(slots, (s) => s.relation !== 'fallback' && s.relation !== 'primary');
    if (last < 0) {
      /*
       * Nothing left to give up but the primary claim, which is never dropped.
       *
       * Unreachable with a real `BidRecommendation` — the pricing pass already
       * caps a bid at what the roster has left — so this fires only when a
       * caller has supplied a price from somewhere else. Said out loud rather
       * than swallowed, because a plan that silently exceeds the wallet is a
       * plan that gets rejected at the Sleeper end with no explanation.
       */
      const primary = slots[0];
      if (primary) {
        reasons.push({
          code: 'budget_caps_simultaneous_claims',
          playerId: primary.pair.addPlayerId,
          value: round2(simultaneous() - (budget.remaining as number)),
        });
      }
      break;
    }
    const removed = slots[last] as T;
    reasons.push({
      code: 'budget_caps_simultaneous_claims',
      playerId: removed.pair.addPlayerId,
      value: spendOf(removed),
    });
    slots.splice(last, 1);
    /* A fallback whose blocking claim is gone is no longer a contingency. */
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i] as T & { blockedBy?: string[] };
      if (slot.relation !== 'fallback') continue;
      const blockedBy = slot.blockedBy ?? [];
      if (blockedBy.length === 0) continue;
      const stillThere = blockedBy.every((id) => slots.some((s) => args.idOf(s.pair) === id));
      if (!stillThere) slots.splice(i, 1);
    }
  }

  return slots;
}

/**
 * Substitutes, complements, and the two cases in between — by simulation.
 *
 * Every relationship below is one division: what the second target is worth
 * once the first has been acquired, over what it was worth on its own. A pair
 * of receivers is a substitute on a roster that starts two and a complement on
 * a roster that starts four, and no static label could ever get both right.
 *
 * `conditional_complement` is the case §11 names and the one a hand-authored
 * label would never produce: the target is still worth having, but only by
 * spending a second, more expensive drop than the one it originally wanted.
 */
function describeRelationships(args: {
  simulation: RosterSimulation;
  considered: readonly string[];
  spine: readonly SpineStep[];
  baselineBest: ReadonlyMap<string, AddDropPair>;
  limits: WaiverPlannerLimits;
}): TargetRelationship[] {
  const { simulation, spine, baselineBest, limits } = args;
  const first = spine[0];
  if (first == null) return [];

  const afterFirst = applyClaims(simulation.baseline.playerIds, [first.pair]);
  const out: TargetRelationship[] = [];

  for (const playerId of args.considered) {
    if (playerId === first.pair.addPlayerId) continue;
    const standalonePair = baselineBest.get(playerId);
    if (standalonePair == null) continue;

    const after = pairsForTarget({ simulation, addPlayerId: playerId, rosterIds: afterFirst, limits });
    const viable = viablePairs(after.pairs, limits);
    const incremental = viable.length > 0 ? (viable[0] as AddDropPair).netGain : 0;
    const standalone = standalonePair.netGain;

    const ratio = standalone > 0 ? incremental / standalone : incremental >= limits.minNetGain ? 1 : 0;
    const dropChanged = viable.length > 0 && (viable[0] as AddDropPair).dropPlayerId !== standalonePair.dropPlayerId;

    let relation: TargetRelation;
    if (ratio <= RELATION_BANDS.redundant) relation = 'redundant';
    else if (ratio <= RELATION_BANDS.substitute || incremental < limits.minNetGain) relation = 'substitute';
    else if (dropChanged) relation = 'conditional_complement';
    else relation = 'complement';

    const reasons: WaiverReason[] = [];
    if (relation === 'redundant') {
      reasons.push({ code: 'redundant_after_earlier_claim', playerId: first.pair.addPlayerId, value: incremental });
    }
    if (relation === 'conditional_complement' && viable.length > 0) {
      reasons.push({
        code: 'requires_second_drop',
        playerId: (viable[0] as AddDropPair).dropPlayerId ?? undefined,
        value: (viable[0] as AddDropPair).dropCost,
      });
    }
    if (relation === 'complement') {
      reasons.push({ code: 'independent_of_earlier_claim', playerId: first.pair.addPlayerId, value: incremental });
    }

    out.push({
      firstPlayerId: first.pair.addPlayerId,
      secondPlayerId: playerId,
      relation,
      incrementalGain: round2(incremental),
      standaloneGain: round2(standalone),
      reasons,
    });
  }

  return out;
}

/** `Array.prototype.findLastIndex` without depending on the lib target. */
function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i] as T)) return i;
  return -1;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
