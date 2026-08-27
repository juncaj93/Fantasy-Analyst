/**
 * The matchup, played out a few thousand times.
 *
 * ## What is simulated, and what is not
 *
 * ```text
 * actual locked points          ← Sleeper's, never touched
 * + simulated remaining outcomes ← this module
 * = final team total
 * ```
 *
 * A player whose game is over contributes his real points and is never drawn
 * for. That is not an optimisation, it is the difference between a live win
 * probability and a pregame one that keeps being recomputed: a matchup where
 * both benches are empty and every game is final has exactly one outcome, and
 * the model has to say 100% rather than 94%.
 *
 * ## Deterministic, and why that is not a nicety
 *
 * The generator is seeded from a fingerprint of the matchup state. The same
 * state gives the same numbers, forever, on any machine. A screen that polls
 * every thirty seconds and shows 61%, 62%, 60%, 61% has taught its reader to
 * ignore it — and the movement that matters, the two points a touchdown
 * actually moved, is invisible inside the noise. `Math.random` is not called
 * anywhere in this feature.
 *
 * ## Common random numbers
 *
 * Every player who could matter is drawn — starters and bench alike — and every
 * draw is kept. That is what makes §23 and §25 answerable *exactly* rather than
 * approximately: the win probability of the lineup with a bench receiver
 * swapped in is computed from the same simulated afternoons as the current
 * lineup's, so the difference between the two contains no sampling noise of its
 * own. Two independent runs of four thousand draws could not tell a two-point
 * lineup edge from their own error; the same four thousand draws can.
 */

import { hashString, mulberry32 } from '../draft/nextpick/rng.ts';
import { buildFactorStructure, type FactorStructure } from './correlation.ts';
import { LIMITED_MULTIPLIER, lognormalParameters, type PlayerDistribution } from './distribution.ts';
import type { MatchupPlayerInput } from './types.ts';

/**
 * How many afternoons are played out.
 *
 * Four thousand puts the standard error of a win probability at 0.79 points at
 * its worst (p = 0.5) and less at both ends, which is inside the whole number
 * the score card shows. `tests/matchup.simulate.test.ts` measures that rather
 * than assuming it, by re-running the same state under different seeds and
 * asserting the spread.
 *
 * It costs a few tens of milliseconds for two full rosters, and it costs that
 * once per *matchup state* rather than once per render — the forecast is cached
 * on the same fingerprint that seeds it, so a poll that finds nothing changed
 * pays nothing at all.
 */
export const DEFAULT_DRAWS = 4000;

export interface SimulationInput {
  players: MatchupPlayerInput[];
  distributions: PlayerDistribution[];
  /**
   * The matchup-state fingerprint, or the 32-bit hash of one.
   *
   * A string is hashed here; a number is used as the hash directly. The second
   * form exists for one caller and is worth the branch: a support snapshot
   * aliases the league id, the league id is hashed into the fingerprint, and a
   * replay seeded from the aliased fingerprint draws a *different afternoon* —
   * disagreeing with its own capture by a point of win probability, which is
   * indistinguishable from the outside from a regression. Carrying the hash
   * reproduces the draws without carrying the identity that produced them. The
   * Draft board solved the same problem the same way; see
   * `core/draft/nextpick/index.ts`.
   */
  seed: string | number;
  draws?: number;
}

export interface SimulationResult {
  draws: number;
  /** Simulated final totals for the user's starting lineup. */
  mine: Float64Array;
  /** Simulated final totals for the opponent's starting lineup. */
  theirs: Float64Array;
  /**
   * Each uncertain player's simulated *final* total, draw by draw.
   *
   * Absent for a locked player, whose final total is a constant and is in
   * `settledById` instead. Kept so counterfactuals — a lineup swap, a "what if
   * he scores 18" threshold — can be answered against the same afternoons
   * rather than against a second, noisier run.
   */
  samples: Map<string, Float64Array>;
  /** The constant final total of every player who can no longer change. */
  settledById: Map<string, number>;
  /** Share of draws the user's side won. A tie counts as half.  */
  winProbability: number;
  /** Exact ties, which a league may or may not have a rule for. */
  tieProbability: number;
  /** Mean simulated final for each side — the projected final score. */
  projectedMine: number;
  projectedTheirs: number;
  /** How much of each side's total is already banked truth. */
  settledMine: number;
  settledTheirs: number;
  /** True when neither side has any uncertainty left. */
  settled: boolean;
  factors: FactorStructure;
}

export function simulateMatchup(input: SimulationInput): SimulationResult {
  const draws = Math.max(1, Math.floor(input.draws ?? DEFAULT_DRAWS));
  const byId = new Map(input.players.map((p) => [p.playerId, p]));

  /*
   * Ordered by projection inside each club and position, so the primary back
   * takes the `+` side of the usage-competition factor. Sorted here rather than
   * relied upon from the caller, because the ordering is part of the model and
   * a caller that happened to pass the roster in Sleeper's order would silently
   * change which of two teammates is the committee's lead.
   */
  const ordered = [...input.distributions].sort((a, b) => {
    const pa = byId.get(a.playerId);
    const pb = byId.get(b.playerId);
    return (pb?.projection ?? 0) - (pa?.projection ?? 0) || a.playerId.localeCompare(b.playerId);
  });

  const factors = buildFactorStructure(
    ordered.map((d) => {
      const player = byId.get(d.playerId);
      return {
        playerId: d.playerId,
        position: player?.position ?? '',
        team: player?.team ?? '',
        opponent: player?.opponent ?? null,
      };
    }),
  );

  const uncertain = ordered.filter((d) => !d.locked && d.remainingMean > 0);
  const assignmentById = new Map(factors.assignments.map((a) => [a.playerId, a]));

  /*
   * The constant part of each side's total, added once rather than four
   * thousand times: every locked player, plus the banked points of everybody
   * still playing. Nothing here is drawn for, which is §6's "actual points are
   * locked truth" expressed as arithmetic that cannot be got wrong.
   */
  let settledMine = 0;
  let settledTheirs = 0;
  const settledById = new Map<string, number>();
  for (const distribution of ordered) {
    if (distribution.locked) settledById.set(distribution.playerId, distribution.settled);
    if (!distribution.starting) continue;
    if (distribution.side === 'mine') settledMine += distribution.settled;
    else settledTheirs += distribution.settled;
  }

  const mine = new Float64Array(draws);
  const theirs = new Float64Array(draws);
  const samples = new Map<string, Float64Array>();
  for (const distribution of uncertain) samples.set(distribution.playerId, new Float64Array(draws));

  // Precomputed per player: the lognormal parameters and the mixture cut points.
  const plan = uncertain.map((distribution) => {
    const { mu, sigma } = lognormalParameters(distribution.remainingMean, distribution.remainingCv);
    const assignment = assignmentById.get(distribution.playerId)!;
    return {
      distribution,
      mu,
      sigma,
      inactiveCut: distribution.mixture.inactive,
      limitedCut: distribution.mixture.inactive + distribution.mixture.limited,
      assignment,
      samples: samples.get(distribution.playerId)!,
      counts: distribution.starting,
    };
  });

  const random = mulberry32(typeof input.seed === 'number' ? input.seed : hashString(input.seed));
  const normal = normalStream(random);

  const teamDraws = new Float64Array(Math.max(factors.teamFactors, 1));
  const gameDraws = new Float64Array(Math.max(factors.gameFactors, 1));
  const rivalDraws = new Float64Array(Math.max(factors.rivalFactors, 1));

  let ties = 0;
  let wins = 0;

  for (let draw = 0; draw < draws; draw++) {
    for (let i = 0; i < factors.teamFactors; i++) teamDraws[i] = normal();
    for (let i = 0; i < factors.gameFactors; i++) gameDraws[i] = normal();
    for (let i = 0; i < factors.rivalFactors; i++) rivalDraws[i] = normal();

    let mineTotal = settledMine;
    let theirsTotal = settledTheirs;

    for (const entry of plan) {
      const a = entry.assignment;
      let z = a.residual * normal();
      if (a.teamFactor >= 0) z += a.team * teamDraws[a.teamFactor]!;
      if (a.gameFactor >= 0) z += a.game * gameDraws[a.gameFactor]!;
      if (a.rivalFactor >= 0) z += a.rival * a.rivalSign * rivalDraws[a.rivalFactor]!;

      /*
       * Which branch of an unresolved availability this afternoon is in.
       *
       * Drawn independently of the outcome itself: whether a questionable
       * receiver is active is not correlated with how well his quarterback
       * throws, and pretending it is would be inventing a mechanism.
       */
      const branch = random();
      let scale = 1;
      if (branch < entry.inactiveCut) scale = 0;
      else if (branch < entry.limitedCut) scale = LIMITED_MULTIPLIER;

      const remaining = scale === 0 ? 0 : Math.exp(entry.mu + entry.sigma * z) * scale;
      const final = entry.distribution.settled + remaining;
      entry.samples[draw] = final;

      if (!entry.counts) continue;
      if (entry.distribution.side === 'mine') mineTotal += remaining;
      else theirsTotal += remaining;
    }

    mine[draw] = mineTotal;
    theirs[draw] = theirsTotal;
    if (mineTotal > theirsTotal) wins++;
    else if (mineTotal === theirsTotal) ties++;
  }

  return {
    draws,
    mine,
    theirs,
    samples,
    settledById,
    winProbability: (wins + ties / 2) / draws,
    tieProbability: ties / draws,
    projectedMine: round2(mean(mine)),
    projectedTheirs: round2(mean(theirs)),
    settledMine: round2(settledMine),
    settledTheirs: round2(settledTheirs),
    settled: plan.length === 0,
    factors,
  };
}

/**
 * Standard normal deviates, two at a time.
 *
 * Box–Muller produces a pair from a pair of uniforms, so the spare is kept
 * rather than thrown away — which halves the number of generator calls in the
 * hottest loop in this feature for no change at all in what comes out.
 */
export function normalStream(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare != null) {
      const value = spare;
      spare = null;
      return value;
    }
    // Guarded away from zero: `Math.log(0)` is `-Infinity`, and one infinity in
    // four thousand draws is a `NaN` win probability.
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/**
 * The probability the user's side wins, given one player's final total is `value`.
 *
 * Answered by replacing that player's column with a constant across the same
 * simulated afternoons, which is what makes "you need Hurts ≥ 24.5" a statement
 * about this matchup rather than about a second Monte Carlo run. A locked
 * player has no column, so the answer is simply the current win probability —
 * his total is not a variable any more.
 */
export function winProbabilityGiven(
  result: SimulationResult,
  playerId: string,
  value: number,
  side: 'mine' | 'theirs',
): number {
  const column = result.samples.get(playerId);
  if (!column) return result.winProbability;
  let wins = 0;
  let ties = 0;
  for (let i = 0; i < result.draws; i++) {
    const delta = value - column[i]!;
    const mine = side === 'mine' ? result.mine[i]! + delta : result.mine[i]!;
    const theirs = side === 'theirs' ? result.theirs[i]! + delta : result.theirs[i]!;
    if (mine > theirs) wins++;
    else if (mine === theirs) ties++;
  }
  return (wins + ties / 2) / result.draws;
}

/**
 * The win probability if one starter were replaced by one bench player.
 *
 * Both columns already exist, so this is a subtraction over the stored draws
 * and nothing is resimulated. Advisory only: it reports what a legal lineup
 * would have been worth, and there is no code path in this app that sets one.
 */
export function winProbabilityWithSwap(
  result: SimulationResult,
  outPlayerId: string,
  inPlayerId: string,
): number {
  const outColumn = result.samples.get(outPlayerId);
  const inColumn = result.samples.get(inPlayerId);
  const outSettled = result.settledById.get(outPlayerId) ?? 0;
  const inSettled = result.settledById.get(inPlayerId) ?? 0;

  let wins = 0;
  let ties = 0;
  for (let i = 0; i < result.draws; i++) {
    const removed = outColumn ? outColumn[i]! : outSettled;
    const added = inColumn ? inColumn[i]! : inSettled;
    const mine = result.mine[i]! - removed + added;
    const theirs = result.theirs[i]!;
    if (mine > theirs) wins++;
    else if (mine === theirs) ties++;
  }
  return (wins + ties / 2) / result.draws;
}

/** A player's simulated final total at a percentile, from the stored draws. */
export function playerQuantile(result: SimulationResult, playerId: string, p: number): number {
  const column = result.samples.get(playerId);
  if (!column) return result.settledById.get(playerId) ?? 0;
  const sorted = Float64Array.from(column).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return round2(sorted[index]!);
}

function mean(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  return total / values.length;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
