/**
 * The unit of a waiver decision: one add, one drop, one number.
 *
 * "Who is the best available player" and "who is my worst player" are two
 * rankings, and a plan built by putting the top of one next to the top of the
 * other is wrong often enough to be worth this whole file. The best available
 * receiver may be worth nothing to a roster that already starts three good
 * ones; the cheapest drop may be the only cover at a position; and the second
 * best target paired with a genuinely free drop routinely beats the best target
 * paired with an expensive one.
 *
 * So the ranking is over pairs. `netGain = addValue − dropCost`, both measured
 * in roster utility by the same subtraction, which is the only reason the
 * difference between them means anything.
 *
 * ## Pruning
 *
 * Bounded on purpose and in one place. A pair is discarded before it is
 * measured when the drop is protected, and after it is measured when it would
 * leave a starting slot nothing can fill or when the gain does not clear the
 * bar. Nothing here searches over combinations — that is `claimPlanner.ts`, and
 * it works from the small ranked list this file produces.
 */

import { eligibleDrops, rankDropsFor } from './dropCost.ts';
import type { RosterSimulation } from './rosterState.ts';
import type { AddDropPair, DropCost, WaiverPlannerLimits, WaiverReason } from './types.ts';

export interface PairSearchResult {
  pairs: AddDropPair[];
  /** Every drop weighed for this target, protected ones included. */
  ranking: DropCost[];
  pairsEvaluated: number;
}

/**
 * Every sensible way to fit one target onto one roster, best first.
 *
 * The roster is a parameter rather than the baseline, because the same function
 * has to answer "what would this claim be worth *after* the earlier one landed"
 * — which is a different roster and therefore, frequently, a different drop.
 */
export function pairsForTarget(opts: {
  simulation: RosterSimulation;
  addPlayerId: string;
  rosterIds?: readonly string[];
  limits: WaiverPlannerLimits;
}): PairSearchResult {
  const { simulation, addPlayerId, limits } = opts;
  const rosterIds = opts.rosterIds ?? simulation.baseline.playerIds;

  const before = simulation.stateOf(rosterIds);
  const withAdd = rosterIds.includes(addPlayerId) ? [...rosterIds] : [...rosterIds, addPlayerId];
  const afterAdd = simulation.stateOf(withAdd);

  const addValue = round2(afterAdd.utility - before.utility);
  const addName = simulation.nameOf.get(addPlayerId) ?? addPlayerId;
  const addPosition = simulation.positionOf.get(addPlayerId) ?? '';

  const ranking = rankDropsFor({ simulation, addPlayerId, rosterIds });
  const candidates = eligibleDrops(ranking).slice(0, limits.maxDropsPerTarget);

  const pairs: AddDropPair[] = [];
  let evaluated = 0;

  for (const drop of candidates) {
    evaluated++;
    const after = simulation.stateOf(withAdd.filter((id) => id !== drop.playerId));
    const dropCost = drop.cost ?? 0;
    const netGain = round2(addValue - dropCost);

    const reasons: WaiverReason[] = [...addReasons(simulation, addPlayerId, before, afterAdd), ...drop.reasons];

    /*
     * A move that cannot be made is not a bad move, it is not a move.
     *
     * `opensSlot` is the optimiser's own answer to "is this legal": a slot goes
     * empty only when nothing left on the roster can fill it. Kept in the list
     * and marked rather than silently discarded — a reader who expected to see
     * their spare quarterback offered as the drop is owed the reason he was not
     * — and excluded from anything the plan may use by {@link viablePairs}.
     */
    const opensSlot = after.emptySlots > before.emptySlots;
    if (opensSlot) {
      reasons.push({ code: 'pair_opens_starting_slot', playerId: drop.playerId, position: drop.position });
    }

    if (netGain < limits.minNetGain) {
      /*
       * Kept in the ranking, kept out of the plan.
       *
       * The runner-up drops are shown on the **See Why** sheet, and a reader
       * comparing them deserves to see the one that fell just short along with
       * the reason it did.
       */
      reasons.push({ code: 'net_gain_below_bar', playerId: addPlayerId, value: netGain });
    }

    pairs.push({
      addPlayerId,
      addName,
      addPosition,
      dropPlayerId: drop.playerId,
      dropName: drop.name,
      addValue,
      dropCost: round2(dropCost),
      netGain,
      lineupGain: round2(after.lineupPoints - before.lineupPoints),
      depthChange: startableBench(after) - startableBench(before),
      opensSlot,
      confidence: confidenceOf(simulation, addPlayerId, drop),
      reasons,
    });
  }

  return { pairs: pairs.sort(comparePairs), ranking, pairsEvaluated: evaluated };
}

/**
 * Startable players who are not starting — the bench that would cover an
 * absence, rather than every name below the lineup.
 *
 * An unscorable rookie and a man on injured reserve both occupy a bench spot
 * and neither is depth, so counting spots would report a roster as deepened by
 * a move that changed nothing about who could play.
 */
function startableBench(state: { starterIds: ReadonlySet<string>; startableIds: readonly string[] }): number {
  return state.startableIds.filter((id) => !state.starterIds.has(id)).length;
}

/**
 * The pairs a plan may actually use.
 *
 * The bar is applied here rather than inside the generator so that the sheet
 * and the plan read the same list and disagree only about which part of it is
 * an instruction.
 */
export function viablePairs(pairs: readonly AddDropPair[], limits: WaiverPlannerLimits): AddDropPair[] {
  return pairs.filter((p) => !p.opensSlot && p.netGain >= limits.minNetGain);
}

/** Why the add is worth having, said in terms of what the lineup did with him. */
function addReasons(
  simulation: RosterSimulation,
  addPlayerId: string,
  before: { starterIds: ReadonlySet<string>; emptySlots: number },
  afterAdd: { starterIds: ReadonlySet<string>; emptySlots: number },
): WaiverReason[] {
  const reasons: WaiverReason[] = [];
  const position = simulation.positionOf.get(addPlayerId) ?? undefined;
  if (afterAdd.starterIds.has(addPlayerId)) {
    reasons.push(
      afterAdd.emptySlots < before.emptySlots
        ? { code: 'add_fills_empty_slot', playerId: addPlayerId, position }
        : { code: 'add_enters_lineup', playerId: addPlayerId, position },
    );
  } else {
    const value = simulation.valueOf.get(addPlayerId) ?? null;
    reasons.push(
      value != null && value > 0
        ? { code: 'add_bench_depth', playerId: addPlayerId, position, value }
        : { code: 'add_no_lineup_effect', playerId: addPlayerId, position, value },
    );
  }
  return reasons;
}

/**
 * How much to trust the number.
 *
 * Three things can undermine a pair and they are all about the inputs rather
 * than the arithmetic: the incoming player may be barely scorable, the drop's
 * standing worth may rest on a role nobody has seen enough of, and the pair may
 * be a bench-for-bench move where the whole gain sits in the option term. The
 * grade is deliberately coarse — it exists so the UI can hedge a sentence, not
 * so a reader can compare two mediums.
 */
function confidenceOf(simulation: RosterSimulation, addPlayerId: string, drop: DropCost): 'high' | 'medium' | 'low' {
  const addEvaluation = simulation.evaluationOf.get(addPlayerId);
  if (addEvaluation == null || addEvaluation.score == null) return 'low';
  if (addEvaluation.confidence === 'low') return 'low';
  if (drop.lineupCost > 0) return addEvaluation.confidence === 'high' ? 'high' : 'medium';
  /* A bench-for-bench move rests entirely on the discounted option term. */
  return addEvaluation.confidence === 'high' ? 'medium' : 'low';
}

/** Biggest net gain first, then the cheaper drop, then stable on the name. */
function comparePairs(a: AddDropPair, b: AddDropPair): number {
  if (b.netGain !== a.netGain) return b.netGain - a.netGain;
  if (a.dropCost !== b.dropCost) return a.dropCost - b.dropCost;
  return (a.dropName ?? '').localeCompare(b.dropName ?? '');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
