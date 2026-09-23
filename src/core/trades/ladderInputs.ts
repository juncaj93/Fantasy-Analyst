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
import { isPriced, tradeExcluded } from './rosterUtility.ts';

export function buildLadderFor(opts: {
  targetId: string;
  mineInputs: StartSitInput[];
  theirsInputs: StartSitInput[];
  shape: RosterShape;
  profile: ScoringProfile;
}): {
  inputs: LadderInputs;
  /** `value` is null when the market has not priced him: absent, never zero. */
  target: { playerId: string; name: string; position: string; value: number | null };
  consolidation: ConsolidationAdvice | null;
} | null {
  const target = opts.theirsInputs.find((i) => i.player.id === opts.targetId);
  if (!target) return null;

  const evaluation = evaluatePlayer(target, opts.profile);
  /*
   * No market, no objective value — and no ladder. See `isPriced`.
   *
   * The lineup passes below still run, because the optimiser is the Team
   * screen's and has its own view of who starts; but the number a ladder is
   * anchored on is this one, and it is refused rather than read as a zero.
   */
  const targetPriced = isPriced(evaluation);
  const objective = targetPriced ? Math.max(0, evaluation.score ?? 0) : 0;

  const lineupOf = (inputs: StartSitInput[]) => {
    const lineup = recommendLineup(inputs, opts.shape, opts.profile);
    return {
      points: lineup.recommendedPoints,
      starters: new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null)),
    };
  };
  const points = (inputs: StartSitInput[]) => lineupOf(inputs).points;

  const mineNowLineup = lineupOf(opts.mineInputs);
  const mineWithLineup = lineupOf([...opts.mineInputs, target]);
  const theirsNowLineup = lineupOf(opts.theirsInputs);
  const theirsWithoutLineup = lineupOf(opts.theirsInputs.filter((i) => i.player.id !== opts.targetId));
  const mineNow = mineNowLineup.points;
  const mineWith = mineWithLineup.points;
  const theirsNow = theirsNowLineup.points;
  const theirsWithout = theirsWithoutLineup.points;

  /*
   * The same guard `bilateral.ts` applies to a package, for the same reason.
   *
   * Value to me and cost to his owner are lineup differences, and a lineup
   * that benches or promotes an unpriced player is a difference measured
   * against his news-only score. Anybody whose place in either lineup the
   * move changes must be priced, or the ladder is refused with his name in the
   * sentence. See `RosterDelta.unpricedMoved`.
   */
  const movedUnpriced = (inputs: StartSitInput[], before: Set<string>, after: Set<string>): string[] =>
    inputs
      .filter((i) => i.player.id !== opts.targetId && before.has(i.player.id) !== after.has(i.player.id))
      .map((i) => evaluatePlayer(i, opts.profile))
      .filter((e) => !isPriced(e))
      .map((e) => e.name);
  const unpriced = [
    ...(targetPriced ? [] : [evaluation.name]),
    ...movedUnpriced(opts.mineInputs, mineNowLineup.starters, mineWithLineup.starters),
    ...movedUnpriced(opts.theirsInputs, theirsNowLineup.starters, theirsWithoutLineup.starters),
  ];

  const valueToMe = Math.round(Math.max(0, mineWith - mineNow) * 100) / 100;
  const costToPartner = Math.round(Math.max(0, theirsNow - theirsWithout) * 100) / 100;

  /*
   * What I would send: my least productive startable players, worst first.
   *
   * A placeholder in the honest sense — the user picks the actual package, and
   * this is what the ladder prices against until they do. Bench players who
   * would not start are excluded, because sending a player nobody starts is not
   * an offer.
   *
   * So are players with no market price, whose score is the nudges alone and
   * would price the package on noise, and defences, which are never a trade
   * asset — the same two gates `bilateral.ts` applies to its own packages.
   */
  const offering = opts.mineInputs
    .filter((i) => i.player.id !== opts.targetId)
    .map((i) => evaluatePlayer(i, opts.profile))
    .filter((e) => isPriced(e) && !tradeExcluded(e.position))
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
      ...(unpriced.length > 0 ? { unpriced } : {}),
    },
    target: {
      playerId: evaluation.playerId,
      name: evaluation.name,
      position: evaluation.position,
      value: targetPriced ? objective : null,
    },
    consolidation:
      targetPriced && offering.length >= 2
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
