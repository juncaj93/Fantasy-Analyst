/**
 * Value one player against two rosters, and assemble the ladder's inputs.
 *
 * Three numbers have to come out of this, and they are genuinely different:
 *
 *   - **objective value** — what he scores, full stop;
 *   - **value to me** — what my starting lineup gains by adding him, which is
 *     zero for a fifth receiver however good he is, and large for the one
 *     player who fills an empty slot;
 *   - **cost to his owner** — what *his* lineup loses by giving him up, which
 *     is what makes a deal possible: a player surplus to their needs costs them
 *     less than he is worth.
 *
 * All three are weekly starting-lineup points from the same optimiser the Team
 * screen draws, run twice per roster — with and without him. That is four
 * optimiser passes for one ladder, which is why the endpoint that needs it is
 * its own request rather than a field on the trade board.
 *
 * Shared rather than private to that handler so Demo Mode prices a trade
 * through the same four passes.
 */

import { evaluatePlayer, type StartSitInput } from '../startsit/engine.ts';
import { recommendLineup } from '../startsit/lineup.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import { assessConsolidation, type ConsolidationAdvice } from './consolidation.ts';
import type { LadderInputs } from './ladder.ts';

export function buildLadderFor(opts: {
  targetId: string;
  mineInputs: StartSitInput[];
  theirsInputs: StartSitInput[];
  shape: RosterShape;
  profile: ScoringProfile;
}): {
  inputs: LadderInputs;
  target: { playerId: string; name: string; position: string; value: number };
  consolidation: ConsolidationAdvice | null;
} | null {
  const target = opts.theirsInputs.find((i) => i.player.id === opts.targetId);
  if (!target) return null;

  const evaluation = evaluatePlayer(target, opts.profile);
  const objective = Math.max(0, evaluation.score ?? 0);

  const points = (inputs: StartSitInput[]) => recommendLineup(inputs, opts.shape, opts.profile).recommendedPoints;

  const mineNow = points(opts.mineInputs);
  const mineWith = points([...opts.mineInputs, target]);
  const theirsNow = points(opts.theirsInputs);
  const theirsWithout = points(opts.theirsInputs.filter((i) => i.player.id !== opts.targetId));

  const valueToMe = Math.round(Math.max(0, mineWith - mineNow) * 100) / 100;
  const costToPartner = Math.round(Math.max(0, theirsNow - theirsWithout) * 100) / 100;

  /*
   * What I would send: my least productive startable players, worst first.
   *
   * A placeholder in the honest sense — the user picks the actual package, and
   * this is what the ladder prices against until they do. Bench players who
   * would not start are excluded, because sending a player nobody starts is not
   * an offer.
   */
  const offering = opts.mineInputs
    .filter((i) => i.player.id !== opts.targetId)
    .map((i) => evaluatePlayer(i, opts.profile))
    .filter((e) => (e.score ?? 0) > 0)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 2);

  return {
    inputs: {
      targetPlayerId: evaluation.playerId,
      targetName: evaluation.name,
      targetValue: objective,
      targetValueToMe: valueToMe,
      targetCostToPartner: costToPartner,
      offering: {
        value: round2(offering.reduce((sum, e) => sum + (e.score ?? 0), 0)),
        valueToReceiver: round2(offering.reduce((sum, e) => sum + (e.score ?? 0), 0)),
        playerIds: offering.map((e) => e.playerId),
        names: offering.map((e) => e.name),
      },
      partner: null,
    },
    target: {
      playerId: evaluation.playerId,
      name: evaluation.name,
      position: evaluation.position,
      value: objective,
    },
    consolidation:
      offering.length >= 2
        ? assessConsolidation({
            sending: offering.map((e) => ({
              playerId: e.playerId,
              name: e.name,
              position: e.position,
              weeklyValue: e.score ?? 0,
            })),
            receiving: {
              playerId: evaluation.playerId,
              name: evaluation.name,
              position: evaluation.position,
              weeklyValue: objective,
            },
            startingPointsNow: mineNow,
            startingPointsAfter: points([
              ...opts.mineInputs.filter((i) => !offering.some((e) => e.playerId === i.player.id)),
              target,
            ]),
            usableDepth: startableDepth(opts.mineInputs, opts.shape, opts.profile),
            fragileStarters: opts.mineInputs
              .map((i) => evaluatePlayer(i, opts.profile))
              .filter((e) => e.statusFlag != null).length,
            startingSlots: opts.shape.totalStarters,
            rosterSize: opts.mineInputs.length,
            week: 1,
            finalWeek: 14,
            uncoveredByes: 0,
          })
        : null,
  };
}

/**
 * Bench players who could legally start, by position.
 *
 * The "depth" half of the consolidation question. Counted as *startable* rather
 * than as bodies: two players nobody would ever start are not depth, and
 * trading them away costs no fragility whatever the roster size says.
 */
export function startableDepth(
  inputs: StartSitInput[],
  shape: RosterShape,
  profile: ScoringProfile,
): Record<string, number> {
  const lineup = recommendLineup(inputs, shape, profile);
  const starters = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
  const out: Record<string, number> = {};
  for (const input of inputs) {
    if (starters.has(input.player.id)) continue;
    const evaluation = evaluatePlayer(input, profile);
    if ((evaluation.score ?? 0) <= 0 || evaluation.ruledOut) continue;
    out[evaluation.position] = (out[evaluation.position] ?? 0) + 1;
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
