/**
 * Every way the week can actually go, and not one of them a percentage.
 *
 * A plan of three claims has eight branches on paper and rather fewer in life,
 * because the claims interfere: a drop spent by one claim is unavailable to the
 * next, and a target landed by one claim cannot be landed again. Enumerating
 * the branches on paper and then simulating each one against the real
 * sequential mechanics is what turns a list of claims into the sentence the
 * reader wants — *best case you land both and drop two; more likely you land
 * one; if the room outbids you, nothing changes*.
 *
 * ## Reachable, not likely
 *
 * There is no probability anywhere in this file. The app does not have a
 * defensible model of whether a bid wins — it has an observed distribution of
 * what past bids cost, which is a fact about prices and not about outcomes —
 * and an "expected value" built by multiplying these branches by invented odds
 * would be a confident number resting on nothing. So each outcome is labelled
 * by what it *is* (the best available, a partial landing, nothing) and ordered
 * by what it is worth, and the reader supplies their own sense of the odds.
 *
 * ## Bounded by construction
 *
 * At most `2^maxClaims` walks, each one a handful of set operations over a
 * memoised utility function, then deduplicated by the claims that actually
 * executed — which collapses most of them, because the branches where a claim
 * could not execute are the same branch. Sixteen walks at the default limits.
 */

import { applyClaims, type RosterSimulation } from './rosterState.ts';
import type { WaiverClaimRecommendation, WaiverOutcome, WaiverPlannerLimits } from './types.ts';

export interface OutcomeTree {
  outcomes: WaiverOutcome[];
  /** The most any single reachable outcome would cost. Null with no bids. */
  maxSimultaneousSpend: number | null;
}

/**
 * Walk the claim list the way Sleeper does, once per branch.
 *
 * `won` is the set of claims the room did not outbid. A claim in that set still
 * only *executes* if, by the time the run reaches it, its target is not already
 * rostered and its drop still is — which is the entire mechanism the plan was
 * built to exploit, applied here in reverse to find out what it produces.
 */
export function buildOutcomes(opts: {
  simulation: RosterSimulation;
  claims: readonly WaiverClaimRecommendation[];
  limits: WaiverPlannerLimits;
  budget?: { remaining: number | null; usesFaab: boolean } | null;
}): OutcomeTree {
  const { simulation, claims, limits } = opts;
  const remaining = opts.budget?.usesFaab === true ? opts.budget.remaining : null;

  if (claims.length === 0) {
    return {
      outcomes: [
        {
          id: 'none',
          claimIds: [],
          addedPlayerIds: [],
          droppedPlayerIds: [],
          netGain: 0,
          spend: null,
          kind: 'none',
        },
      ],
      maxSimultaneousSpend: null,
    };
  }

  const baselineUtility = simulation.baseline.utility;
  const seen = new Map<string, WaiverOutcome>();
  let anyBid = false;

  const branches = 1 << claims.length;
  for (let mask = 0; mask < branches; mask++) {
    let roster: readonly string[] = simulation.baseline.playerIds;
    const executed: WaiverClaimRecommendation[] = [];

    for (const [index, claim] of claims.entries()) {
      if ((mask & (1 << index)) === 0) continue;
      if (roster.includes(claim.addPlayerId)) continue;
      if (claim.dropPlayerId != null && !roster.includes(claim.dropPlayerId)) continue;
      roster = applyClaims(roster, [claim]);
      executed.push(claim);
    }

    const key = executed.map((c) => c.id).join('|') || 'none';
    if (seen.has(key)) continue;

    const bids = executed.map((c) => c.bid);
    const priced = bids.filter((b): b is number => b != null);
    if (priced.length > 0) anyBid = true;
    const spend = priced.length === executed.length && executed.length > 0 ? sum(priced) : executed.length === 0 ? 0 : null;

    /*
     * A branch the wallet cannot pay for is not a branch.
     *
     * The planner has already trimmed the claim list so this should not fire,
     * and it is asserted rather than assumed because the trimming and the
     * enumeration are two different pieces of arithmetic and the day they
     * disagree is the day a reader is shown an outcome they cannot have.
     */
    if (remaining != null && spend != null && spend > remaining) continue;

    seen.set(key, {
      id: key,
      claimIds: executed.map((c) => c.id),
      addedPlayerIds: executed.map((c) => c.addPlayerId),
      droppedPlayerIds: executed.map((c) => c.dropPlayerId).filter((id): id is string => id != null),
      netGain: round2(simulation.utility(roster) - baselineUtility),
      spend,
      kind: executed.length === 0 ? 'none' : 'partial',
    });
  }

  const all = [...seen.values()].sort(compareOutcomes);
  const best = all.find((o) => o.kind !== 'none');
  if (best) best.kind = 'best';

  /*
   * The no-action branch is always reported, and is never trimmed.
   *
   * It is the one outcome the reader is guaranteed to be able to have, and a
   * plan that only listed the ways things could go well would be a plan that
   * quietly implied they will.
   */
  const none = all.find((o) => o.kind === 'none');
  const trimmed = all.filter((o) => o.kind !== 'none').slice(0, Math.max(0, limits.maxOutcomes - 1));
  const outcomes = none ? [...trimmed, none] : trimmed;

  /*
   * The do-nothing branch is excluded rather than counted as zero.
   *
   * "The most this plan could cost you" is a statement about the plan, and a
   * plan whose every priced branch is unknown should say so rather than report
   * the cost of not acting on it.
   */
  const spends = all
    .filter((o) => o.claimIds.length > 0)
    .map((o) => o.spend)
    .filter((s): s is number => s != null);

  return {
    outcomes,
    maxSimultaneousSpend: anyBid && spends.length > 0 ? Math.max(...spends) : null,
  };
}

/** Best first, then the one that spends least, then stable on the id. */
function compareOutcomes(a: WaiverOutcome, b: WaiverOutcome): number {
  if (b.netGain !== a.netGain) return b.netGain - a.netGain;
  const aSpend = a.spend ?? Number.POSITIVE_INFINITY;
  const bSpend = b.spend ?? Number.POSITIVE_INFINITY;
  if (aSpend !== bSpend) return aSpend - bSpend;
  return a.id.localeCompare(b.id);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
