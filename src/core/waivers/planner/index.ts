/**
 * The waiver claim planner: one call in, one plan out.
 *
 * > Who should I add, what should I bid, who should I drop, and how should I
 * > structure my claims so I end up with the best realistic roster?
 *
 * That is the whole feature, and {@link planWaiverClaims} is the whole surface.
 * Everything else in this folder is private machinery that happens to be
 * exported for its tests.
 *
 * ## What this is not
 *
 * **Not wired.** Nothing in the app calls this yet, deliberately. The Waivers
 * screen, the board, the pricing pass and the DST work are all live lanes, and
 * a planner that reached into any of them would be a merge conflict wearing a
 * feature's clothes. The integration contract is stated at the bottom of this
 * comment so the lane that does the wiring has nothing to work out.
 *
 * **Not a transaction.** No claim is submitted, no player is added or dropped,
 * no budget is spent, and there is no write path in this folder. A plan is a
 * list of claims for a person to type into Sleeper by hand — which is also why
 * the ordering matters so much, since typing them in a different order produces
 * a different result.
 *
 * **Not a second opinion about player value.** The score comes from the
 * start/sit engine, the standing worth of a roster spot from the bench model,
 * and the bid from the FAAB pass. This module decides *structure*: which drop
 * goes with which add, which claims can coexist, and what order they go in.
 *
 * ## What the future Waivers integration has to do
 *
 * ```ts
 * import { planWaiverClaims } from '@core/waivers/planner/index.ts';
 *
 * const plan = planWaiverClaims({
 *   roster,     // StartSitInput[] — the same array the Team screen builds
 *   targets,    // { input, bid, boardRank } per waiver-board row
 *   shape,      // RosterShape, from the league
 *   profile,    // ScoringProfile, from the league
 *   reserveIds, // players on an IR slot
 *   budget: { remaining: myBudget(budgetState)?.remaining ?? null,
 *             usesFaab: budgetState.rule.usesFaab },
 *   now,
 * });
 * ```
 *
 * `targets[].bid` is a structural subset of the `PricedBid` the Waivers screen
 * already computes — pass the existing object through unchanged and the planner
 * will reuse the recommendation and the ceiling rather than pricing anything
 * itself. `boardRank` is the row's position on the existing board; supply it
 * and the planner's target cut respects the league-intelligence ranking instead
 * of falling back to the raw score.
 *
 * What comes back is `plan.claims` — the numbered list, already in the order to
 * enter them — plus `plan.outcomes` for the "best case / fallback / nothing"
 * summary, `plan.relationships` for whether two targets are worth chasing at
 * once, and `plan.dropRanking` for the **See Why** sheet's runner-up drops.
 * `plan.dropAdvice === 'unavailable'` means the roster could not be scored
 * confidently enough to name a cut; show the add and say nothing about the drop.
 *
 * Every string a reader sees is the integration's to write. This module emits
 * {@link WaiverReasonCode} values and the numbers behind them, and no prose.
 */

import type { StartSitInput } from '../../startsit/engine.ts';
import { buildRosterSimulation, plannerExcluded } from './rosterState.ts';
import { planClaims } from './claimPlanner.ts';
import { buildOutcomes } from './outcomes.ts';
import {
  DEFAULT_LIMITS,
  type DropAdviceState,
  type WaiverPlan,
  type WaiverPlannerInput,
  type WaiverPlannerLimits,
  type WaiverReason,
} from './types.ts';

export * from './types.ts';
export {
  buildRosterSimulation,
  applyClaims,
  plannerExcluded,
  BENCH_OPTION_WEIGHT,
  BARE_POSITION_COST,
  PLANNER_EXCLUDED_POSITIONS,
} from './rosterState.ts';
export { rankDropsFor, eligibleDrops, PROTECTED_LINEUP_COST } from './dropCost.ts';
export { pairsForTarget, viablePairs } from './pairs.ts';
export { planClaims, RELATION_BANDS } from './claimPlanner.ts';
export { buildOutcomes } from './outcomes.ts';

/**
 * Plan a waiver run.
 *
 * Deterministic: the same inputs produce the same plan, byte for byte. The only
 * two things that could make it otherwise — the clock and the timestamp — are
 * parameters.
 */
export function planWaiverClaims(input: WaiverPlannerInput): WaiverPlan {
  const limits: WaiverPlannerLimits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const reasons: WaiverReason[] = [];

  const rosterIds = input.roster.map((player) => player.player.id);
  const rostered = new Set(rosterIds);

  /*
   * A target already on the roster is not a target.
   *
   * Cheap to guard and not hypothetical: the board and the roster are built
   * from two different reads, and a claim recommending a player the reader
   * already owns is the kind of mistake that costs all the trust the rest of
   * the plan earned.
   *
   * A defence is handed straight back for the DST planner to answer — see the
   * note on `PLANNER_EXCLUDED_POSITIONS`. It is excluded here rather than
   * ranked last so that the boundary is visible in one line.
   */
  const targets = input.targets.filter((target) => {
    const id = target.input.player.id;
    if (rostered.has(id)) return false;
    return !plannerExcluded(target.input.player.position);
  });

  const pool: StartSitInput[] = [...input.roster, ...targets.map((t) => t.input)];

  const simulation = buildRosterSimulation({
    pool,
    rosterIds,
    wireIds: targets.map((t) => t.input.player.id),
    shape: input.shape,
    profile: input.profile,
    held: input.held,
    reserveIds: input.reserveIds,
    now: input.now,
  });

  /*
   * Whether a cut can honestly be named at all.
   *
   * The bar is that *something* on this roster is both scorable and not
   * protected. A roster the engine cannot read — a bye-heavy week with no
   * markets, a league synced before the season — must not be handed a confident
   * drop, and §20 of the brief is explicit that the right answer there is to
   * keep the add recommendation and say the drop is unknown.
   */
  const scorableRoster = rosterIds.filter((id) => !simulation.unscored.has(id));
  const dropAdvice: DropAdviceState = scorableRoster.length === 0 ? 'unavailable' : 'available';
  if (dropAdvice === 'unavailable') {
    reasons.push({ code: 'roster_not_scorable', value: rosterIds.length });
  }

  if (dropAdvice === 'unavailable') {
    /*
     * The add half of the advice survives; the drop half does not.
     *
     * §20 of the brief in one branch. A roster nothing can be scored on cannot
     * produce a drop ranking, a net roster gain or a contingency structure —
     * every one of those is a subtraction over a utility that does not exist.
     * What it can still do is say who is worth claiming and what the pricing
     * pass thinks he costs, both of which are facts about the *wire* and are
     * unaffected by the roster being unreadable.
     *
     * So the claims come back with no drop, no gain and no relationships, in
     * the order the board gave them, and `dropAdvice` says why. A reader is
     * told what to add and left to choose the cut themselves, which is exactly
     * the state the product was in before this lane existed.
     */
    return {
      claims: targets.slice(0, limits.maxClaims).map((target, index) => ({
        id: `${target.input.player.id}>none`,
        rank: index + 1,
        addPlayerId: target.input.player.id,
        addName: target.input.player.fullName,
        addPosition: target.input.player.position,
        dropPlayerId: null,
        dropName: null,
        bid: target.bid?.recommended ?? null,
        doNotExceed: target.bid?.doNotExceed ?? null,
        bidHeadline: target.bid?.headline ?? target.bid?.withheld ?? null,
        netGain: null,
        relation: index === 0 ? ('primary' as const) : ('compatible' as const),
        dependsOn: [],
        blockedBy: [],
        mutuallyExclusiveWith: [],
        reasons: [
          { code: 'roster_not_scorable' as const, playerId: target.input.player.id },
          target.bid?.recommended != null
            ? { code: 'bid_reused_from_pricing' as const, playerId: target.input.player.id, value: target.bid.recommended }
            : { code: 'bid_unavailable' as const, playerId: target.input.player.id, value: null },
        ],
        pair: {
          addPlayerId: target.input.player.id,
          addName: target.input.player.fullName,
          addPosition: target.input.player.position,
          dropPlayerId: null,
          dropName: null,
          addValue: 0,
          dropCost: 0,
          netGain: 0,
          lineupGain: 0,
          depthChange: 0,
          opensSlot: false,
          confidence: 'low' as const,
          reasons: [],
        },
      })),
      outcomes: [],
      relationships: [],
      protectedPlayers: [],
      dropRanking: [],
      dropAdvice,
      maxSimultaneousSpend: null,
      reasons,
      limits,
      search: { targetsConsidered: Math.min(targets.length, limits.maxTargets), pairsEvaluated: 0, lineupsEvaluated: simulation.lineupsEvaluated() },
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    };
  }

  const planned = planClaims({
    simulation,
    candidates: targets.map((target) => ({
      playerId: target.input.player.id,
      bid: target.bid ?? null,
      boardRank: target.boardRank ?? null,
    })),
    limits,
    budget: input.budget ?? null,
  });

  const tree = buildOutcomes({
    simulation,
    claims: planned.claims,
    limits,
    budget: input.budget ?? null,
  });

  /*
   * Who the plan refuses to cut, gathered from the rankings that decided it.
   *
   * Taken from the per-target drop rankings rather than recomputed, so the
   * headline list and the **See Why** sheet cannot disagree about who was
   * protected. A player protected against one add and offered against another
   * is listed — protection is add-specific here, and the strongest statement
   * that can honestly be made about him is that at least one claim would not
   * touch him.
   */
  const protectedPlayers = collectProtected(planned.dropRanking);

  /*
   * An empty plan says why it is empty.
   *
   * Two quite different situations produce no claims, and a screen that showed
   * the same blank space for both would be hiding the more interesting one. A
   * roster with nothing spare to cut is a roster that needs a trade or a bye
   * week, not a better waiver target; a roster with plenty to cut and nothing
   * worth adding is a quiet week.
   */
  if (planned.claims.length > 0) {
    // Nothing to explain.
  } else if (planned.dropRanking.every((ranking) => ranking.drops.every((drop) => drop.protection != null))) {
    reasons.push({ code: 'no_eligible_drop', value: rosterIds.length });
  } else if (targets.length > 0) {
    reasons.push({ code: 'net_gain_below_bar', value: limits.minNetGain });
  }

  return {
    claims: planned.claims,
    outcomes: tree.outcomes,
    relationships: planned.relationships,
    protectedPlayers,
    dropRanking: planned.dropRanking,
    dropAdvice,
    maxSimultaneousSpend: tree.maxSimultaneousSpend,
    reasons: [...reasons, ...planned.reasons],
    limits,
    search: {
      targetsConsidered: Math.min(targets.length, limits.maxTargets),
      pairsEvaluated: planned.pairsEvaluated,
      lineupsEvaluated: simulation.lineupsEvaluated(),
    },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

function collectProtected(
  rankings: readonly { addPlayerId: string; drops: readonly { playerId: string; name: string; protection: WaiverPlan['protectedPlayers'][number]['reason'] | null }[] }[],
): WaiverPlan['protectedPlayers'] {
  const out = new Map<string, WaiverPlan['protectedPlayers'][number]>();
  for (const ranking of rankings) {
    for (const drop of ranking.drops) {
      if (drop.protection == null) continue;
      if (out.has(drop.playerId)) continue;
      out.set(drop.playerId, { playerId: drop.playerId, name: drop.name, reason: drop.protection });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
