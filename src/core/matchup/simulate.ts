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
 * How wrong a side's projected total is, as a fraction of itself.
 *
 * Eight per cent, which on a 130-point lineup is about ten points. This is a
 * calibration choice rather than a measured constant and is stated as one: the
 * app has not yet scored enough of its own weeks to fit it, and the honest
 * default is the one that stops the model claiming more certainty than a
 * weekly projection can carry.
 *
 * What it is worth, on the lineup that prompted it (134.6 against 117.2):
 *
 *     none  -> 74.0%      the old behaviour, and the reported one
 *     0.08  -> 71.6%
 *
 * The direction generalises: every probability moves toward 50%, and the
 * further out it was the more it moves. A 95% reads nearer 88%. That is the
 * point — the extremes were where the missing term cost the most.
 *
 * Raising it makes the app more cautious and lowering it more confident; nought
 * restores exactly what this replaced.
 */
export const PROJECTION_ERROR_CV = 0.08;

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
  /**
   * Banked points Sleeper counts for a side that this app's starter list does
   * not account for.
   *
   * Zero on a healthy matchup and the whole reason this field exists on an
   * unhealthy one. `actual` is Sleeper's own team total and is authoritative;
   * the totals below are summed from the starters this app could resolve, and
   * the two are only equal while every starter mapped. A roster spot the player
   * table could not resolve — the case the Team screen already counts as
   * `unknownPlayers` — leaves points inside Sleeper's number and outside this
   * one.
   *
   * Left out, the consequence is visible rather than subtle: with every game
   * final the screen showed **92 points scored and a projected final of 78**, a
   * team forecast to finish below what it had already banked. And the win
   * probability was computed from the smaller number, so the manager with the
   * unattributed points was quietly under-credited all afternoon.
   *
   * Added as a constant rather than modelled, because that is exactly what it
   * is: Sleeper computed those points under the league's own scoring and they
   * cannot change. Never negative — see `buildForecast`, which clamps at zero
   * rather than subtracting modelled points on the strength of a disagreement
   * it cannot explain.
   */
  unattributed?: { mine: number; theirs: number };
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
  let settledMine = input.unattributed?.mine ?? 0;
  let settledTheirs = input.unattributed?.theirs ?? 0;
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

  /*
   * The error in the projections themselves, which until now was nought.
   *
   * Every draw above answers "how much does this player's week vary around what
   * we expect of him". None of it answers "and how wrong is what we expect".
   * The model treated each projection as a known mean, so the only uncertainty
   * it carried was the one it could see — and a model that is certain about its
   * own centre is overconfident at exactly the moment a reader most wants to
   * trust it.
   *
   * Reported on 16 September 2026 as a 17.4-point favourite reading 75%.
   * Measured on that lineup, the simulation's spread on the difference was 27.3
   * points and the arithmetic was internally consistent; what was missing is
   * this. With it, the same matchup reads about 72%.
   *
   * ## Why it is one shock per side and not per player
   *
   * Projection error is mostly *common*. A week where the app's numbers run
   * high runs high across the slate — a scoring environment, a set of game
   * scripts, a model fitted to the wrong month — and independent per-player
   * error would average away to almost nothing across ten starters, which is
   * the same as not modelling it. One draw per side, applied to every player on
   * that side, is the shape of the thing being modelled.
   *
   * Drawn separately for the two sides rather than shared, because a shared
   * shock would cancel in the difference and change no win probability at all.
   *
   * ## Why it is multiplicative, and mean-preserving
   *
   * Multiplicative so it scales with how much football is left: a side with
   * four players still to play carries less of it than one with ten, and a
   * settled side carries none, which falls out of applying it to `remaining`
   * and never to `settled`. Points already scored are truth and no forecast
   * error applies to them.
   *
   * Mean-preserving (the `- sigma^2 / 2`) so the *projected final* on the card
   * does not move. This widens the distribution; it does not re-forecast
   * anybody, and a reader who compares the two totals sees the same two numbers
   * they saw before.
   */
  const errorSigma = Math.sqrt(Math.log(1 + PROJECTION_ERROR_CV * PROJECTION_ERROR_CV));
  const errorShift = (errorSigma * errorSigma) / 2;

  const teamDraws = new Float64Array(Math.max(factors.teamFactors, 1));
  const gameDraws = new Float64Array(Math.max(factors.gameFactors, 1));
  const rivalDraws = new Float64Array(Math.max(factors.rivalFactors, 1));

  let ties = 0;
  let wins = 0;

  for (let draw = 0; draw < draws; draw++) {
    for (let i = 0; i < factors.teamFactors; i++) teamDraws[i] = normal();
    for (let i = 0; i < factors.gameFactors; i++) gameDraws[i] = normal();
    for (let i = 0; i < factors.rivalFactors; i++) rivalDraws[i] = normal();

    /* How wrong this afternoon's projections turn out to be, per side. */
    const mineError = Math.exp(errorSigma * normal() - errorShift);
    const theirsError = Math.exp(errorSigma * normal() - errorShift);

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

      /*
       * Applied per player rather than to the finished side total, so a
       * player's own `samples` row carries the same afternoon his side's total
       * does. `winProbabilityWithSwap` recombines those rows draw by draw, and
       * a sample that had not seen the shock would answer a counterfactual
       * about a different week from the one it is being compared against.
       */
      const error = entry.distribution.side === 'mine' ? mineError : theirsError;
      const remaining = scale === 0 ? 0 : Math.exp(entry.mu + entry.sigma * z) * scale * error;
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
