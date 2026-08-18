/**
 * What each side actually needs, and which remaining event decides the most.
 *
 * ## Leverage is not projection
 *
 * The player who matters most in a matchup is frequently not the one projected
 * highest. A quarterback with eighteen points still to come and a wide
 * distribution can swing a close matchup either way; a back projected two
 * points more, with a settled role and a narrow one, cannot swing anything. And
 * a modest player becomes the whole afternoon when the margin is four points
 * and he is the only man left playing.
 *
 * So leverage here is measured in **win probability**, not points: how far the
 * matchup moves between a bad game from him and a good one. That is the number
 * §15 asks for, and it is computed against the same simulated afternoons
 * everything else on the screen came from, so it cannot disagree with the win
 * probability beside it.
 *
 * ## Thresholds, and the honesty they require
 *
 * "You need Hurts ≥ 24.5" is only true in the sense that it is the point at
 * which *his* contribution reaches a target, holding the rest of the afternoon
 * at whatever the simulation says it will be. When two or three players are
 * still live, no single number is a condition for winning, and saying one is
 * would be false certainty. Two things stop that here: a threshold is only
 * offered when the player actually has the leverage to reach the target, and
 * the phrasing this feeds carries `roughly` / `about` wherever more than one
 * outcome is still open — see `insights.ts`, which owns the words.
 */

import { playerQuantile, winProbabilityGiven, type SimulationResult } from './simulate.ts';
import type { PlayerDistribution } from './distribution.ts';
import type { MatchupPlayerInput, MatchupSide } from './types.ts';

/** How much win probability a swing has to be worth before it is worth saying. */
export const MATERIAL_SWING = 0.04;

/** One player's grip on the outcome, in win probability. */
export interface PlayerLeverage {
  playerId: string;
  name: string;
  side: MatchupSide;
  /** Win probability if he has a bad game (10th percentile of his own total). */
  winAtFloor: number;
  /** Win probability if he has a good one (90th percentile). */
  winAtCeiling: number;
  /** The gap between them: how much of the outcome he is holding. */
  swing: number;
  /** His simulated final at those two percentiles, for the sentence. */
  floor: number;
  ceiling: number;
  /** His expected final total. */
  projected: number;
  /** Points already banked. */
  actual: number;
  /** Share of the remaining outcome variance he accounts for, 0..1. */
  varianceShare: number;
}

/**
 * Rank every still-uncertain player by how much of the outcome he holds.
 *
 * Locked players are absent rather than ranked at zero: a player whose game is
 * over holds none of the outcome, and listing him with a swing of zero would
 * invite a card to say "the biggest remaining swing is somebody who has
 * finished".
 */
export function rankLeverage(
  result: SimulationResult,
  players: MatchupPlayerInput[],
  distributions: PlayerDistribution[],
): PlayerLeverage[] {
  const byId = new Map(players.map((p) => [p.playerId, p]));
  const starting = distributions.filter((d) => d.starting && !d.locked && result.samples.has(d.playerId));

  /*
   * How much of what is left each player is responsible for.
   *
   * Variance rather than spread, because variances of roughly independent
   * contributions add — so a share of the total is a meaningful sentence
   * ("one remaining player decides 41% of the outcome"), and a share of the
   * standard deviations would not be.
   */
  const variances = new Map<string, number>();
  let totalVariance = 0;
  for (const distribution of starting) {
    const column = result.samples.get(distribution.playerId)!;
    const variance = varianceOf(column);
    variances.set(distribution.playerId, variance);
    totalVariance += variance;
  }

  const out: PlayerLeverage[] = [];
  for (const distribution of starting) {
    const player = byId.get(distribution.playerId);
    if (!player) continue;
    const floor = playerQuantile(result, distribution.playerId, 0.1);
    const ceiling = playerQuantile(result, distribution.playerId, 0.9);
    const winAtFloor = winProbabilityGiven(result, distribution.playerId, floor, distribution.side);
    const winAtCeiling = winProbabilityGiven(result, distribution.playerId, ceiling, distribution.side);
    out.push({
      playerId: distribution.playerId,
      name: player.name,
      side: distribution.side,
      winAtFloor: round4(winAtFloor),
      winAtCeiling: round4(winAtCeiling),
      swing: round4(Math.abs(winAtCeiling - winAtFloor)),
      floor,
      ceiling,
      projected: round2(mean(result.samples.get(distribution.playerId)!)),
      actual: distribution.settled,
      varianceShare: totalVariance > 0 ? round4((variances.get(distribution.playerId) ?? 0) / totalVariance) : 0,
    });
  }

  return out.sort((a, b) => b.swing - a.swing || a.name.localeCompare(b.name));
}

/** A points threshold on one player, and what reaching it is worth. */
export interface NeedThreshold {
  playerId: string;
  name: string;
  side: MatchupSide;
  /** The total he has to reach. */
  target: number;
  /** How many more points that is than he has now. */
  moreNeeded: number;
  /** The win probability at that total, from the user's point of view. */
  winAtTarget: number;
  /** The win probability as things stand. */
  winNow: number;
  /**
   * True when this is the only outcome still open, so the threshold is a
   * condition rather than a most-likely path. Decides whether the sentence says
   * "you need" or "roughly".
   */
  soleVariable: boolean;
  /** True when he cannot reach the target even at his ceiling. */
  outOfReach: boolean;
}

/**
 * The total one player has to reach for the user's win probability to hit
 * `target`.
 *
 * A bisection over his own simulated range, which is exact to within the
 * tolerance and needs no assumption about the shape of anything: the function
 * "win probability given he scores exactly x" is monotone in x for a player on
 * the user's side and monotone the other way for one on the opponent's, and
 * that is the only property it relies on.
 *
 * Null when the target is already met, or when it cannot be reached at all —
 * both of which are more useful facts than a number nobody can act on.
 */
export function thresholdFor(
  result: SimulationResult,
  leverage: PlayerLeverage,
  target: number,
  opts: { liveVariables?: number } = {},
): NeedThreshold | null {
  const column = result.samples.get(leverage.playerId);
  if (!column) return null;

  const winNow = result.winProbability;
  // The direction the user's win probability moves as this player scores more.
  const helping = leverage.winAtCeiling >= leverage.winAtFloor;

  // For a player who helps, a higher score is better; the search runs from his
  // floor upward. For one who hurts — an opponent — it runs the other way, and
  // the question becomes the total he has to stay *under*.
  /*
   * The range searched is his own simulated one, with a little headroom.
   *
   * Deliberately not widened to whatever score would reach an arbitrary target.
   * "You need forty-one from your tight end" is arithmetically true and is not
   * a most-likely path; a threshold outside a player's own distribution is a
   * sentence about a miracle, and §14 asks for the path rather than the
   * miracle. Callers pick a target he can actually reach — see `insights.ts`.
   */
  let low = Math.min(leverage.floor, leverage.actual);
  let high = Math.max(leverage.ceiling * 1.15, leverage.actual + 0.1);
  if (!helping) low = Math.min(low, 0);

  const at = (value: number) => winProbabilityGiven(result, leverage.playerId, value, leverage.side);

  const winAtHigh = at(high);
  const winAtLow = at(low);
  const best = helping ? winAtHigh : winAtLow;
  const worst = helping ? winAtLow : winAtHigh;
  if (best < target && worst < target) {
    return {
      playerId: leverage.playerId,
      name: leverage.name,
      side: leverage.side,
      target: round1(helping ? high : low),
      moreNeeded: round1(Math.max(0, (helping ? high : low) - leverage.actual)),
      winAtTarget: round4(best),
      winNow: round4(winNow),
      soleVariable: (opts.liveVariables ?? 2) <= 1,
      outOfReach: true,
    };
  }
  if (worst >= target) return null;

  let lo = helping ? low : high;
  let hi = helping ? high : low;
  // Twenty-two halvings of a range of at most a few hundred points lands well
  // inside the tenth of a point the sentence prints.
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid;
    else lo = mid;
  }
  const solution = hi;

  return {
    playerId: leverage.playerId,
    name: leverage.name,
    side: leverage.side,
    target: round1(solution),
    moreNeeded: round1(Math.max(0, solution - leverage.actual)),
    winAtTarget: round4(at(solution)),
    winNow: round4(winNow),
    soleVariable: (opts.liveVariables ?? 2) <= 1,
    outOfReach: false,
  };
}

/**
 * Whether the matchup is mathematically decided, as opposed to merely settled
 * in simulation.
 *
 * §29 insists these are two different sentences and they are: a side that
 * cannot be caught because nobody is left to score is finished, and a side the
 * model gives 97% is not. The first is arithmetic over the remaining ceilings;
 * the second is a probability, and calling it a clinch would be the one claim
 * in this feature nobody could defend when it went the other way.
 */
export interface ClinchState {
  /** True when the trailing side has no arithmetic route left. */
  mathematical: boolean;
  /** True when the simulation puts it beyond reasonable doubt but not beyond arithmetic. */
  nearClinch: boolean;
  /** Who is safe, when either is true. */
  leader: MatchupSide | null;
  /** The most the trailing side could still score. */
  maxRemainingForTrailer: number;
}

export function assessClinch(
  result: SimulationResult,
  distributions: PlayerDistribution[],
  opts: { nearClinchAt?: number } = {},
): ClinchState {
  const nearAt = opts.nearClinchAt ?? 0.97;
  const leadingIsMine = result.projectedMine >= result.projectedTheirs;

  /*
   * The trailing side's arithmetic ceiling, from the simulated maxima rather
   * than from a projection: the largest total any of the four thousand
   * afternoons produced for them. A side that never once caught up across the
   * whole simulation is not mathematically eliminated — a lognormal has no
   * upper bound — so this is only allowed to declare a clinch when the trailing
   * side has *nothing left to draw for at all*.
   */
  const trailingSide: MatchupSide = leadingIsMine ? 'theirs' : 'mine';
  const trailingUncertain = distributions.filter((d) => d.starting && d.side === trailingSide && !d.locked && d.remainingMean > 0);
  const leadingSettled = leadingIsMine ? result.settledMine : result.settledTheirs;
  const trailingSettled = leadingIsMine ? result.settledTheirs : result.settledMine;
  const leadingUncertain = distributions.filter((d) => d.starting && d.side !== trailingSide && !d.locked && d.remainingMean > 0);

  const mathematical =
    trailingUncertain.length === 0 && leadingUncertain.length === 0 && leadingSettled > trailingSettled;

  const winner = result.winProbability >= 0.5 ? 'mine' : 'theirs';
  const confidence = winner === 'mine' ? result.winProbability : 1 - result.winProbability;

  return {
    mathematical,
    nearClinch: !mathematical && confidence >= nearAt,
    leader: mathematical || confidence >= nearAt ? (winner as MatchupSide) : null,
    maxRemainingForTrailer: round2(trailingUncertain.reduce((sum, d) => sum + d.ceiling - d.settled, 0)),
  };
}

function varianceOf(values: Float64Array): number {
  const m = mean(values);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i]! - m;
    total += d * d;
  }
  return total / values.length;
}

function mean(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  return total / values.length;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
