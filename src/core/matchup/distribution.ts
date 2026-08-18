/**
 * What one player's week could still turn into.
 *
 * A win probability computed from two projected totals is not a win
 * probability — it is a comparison of two numbers wearing a percentage sign.
 * The thing that makes a 12-point deficit with a quarterback left recoverable,
 * and the same deficit with a checkdown back left effectively over, is the
 * *shape* of what remains. This module is that shape.
 *
 * ## Three states, three different questions
 *
 *   - **not started** — the full pregame distribution, centred on Fantasy
 *     Analyst's own projection.
 *   - **live** — the distribution of what is *left*, conditioned on what has
 *     already been scored and how much of the game is gone. Points already on
 *     the board are truth and are never re-simulated.
 *   - **final** — no distribution at all. A finished player is an addend, and
 *     continuing to simulate him is the single most common way a live win
 *     probability stays wrong all afternoon.
 *
 * ## Why lognormal
 *
 * Fantasy scoring is non-negative, right-skewed and has no meaningful upper
 * bound: a receiver's median week is well below his mean, and the gap between
 * them is the entire reason anybody starts a boom player. A normal distribution
 * gets both facts wrong — it puts real probability below zero and none in the
 * tail that matters — and truncating it at zero silently inflates the mean,
 * which would make every projected final score too high.
 *
 * The lognormal here is parameterised by mean and coefficient of variation, so
 * the mean is *exactly* the projection the rest of the app already shows. That
 * is not a detail: a distribution whose mean drifted from the projected number
 * would make the projected final score and the win probability two answers to
 * one question.
 *
 * ## No false precision
 *
 * The volatility table is coarse on purpose. It distinguishes the handful of
 * roles whose spread genuinely differs — a rushing quarterback from a pocket
 * one, a deep threat from a possession receiver — and it stops there, because
 * this app does not have the per-player sample that would justify anything
 * finer, and inventing one would put a confident number under the most
 * consequential term in the model.
 */

import type { AvailabilityConfidence } from '../startsit/availabilityConfidence.ts';
import type { GamePhase, MatchupPlayerInput } from './types.ts';

/**
 * How long a distribution treats an NFL game as lasting, in minutes.
 *
 * Wall clock, not game clock: this app has no play-by-play feed, and the only
 * live signal it can honestly read is how long ago a game kicked off. Three
 * hours and five minutes is the ordinary length of a regulation game including
 * its breaks; a game that runs long simply finishes its conditioning a little
 * early, which costs nothing because by then the remaining share is already
 * near zero.
 */
export const GAME_MINUTES = 185;

/**
 * How much the observed pace is believed, at most, at the end of a game.
 *
 * A player with nothing at half-time is having a bad game and his remaining
 * expectation should fall — but not to nothing, because a fantasy week is a
 * handful of discrete events and the largest of them has not necessarily
 * happened yet. This caps how far a quiet first half is allowed to rewrite a
 * pregame projection, and it is the single number to move if live conditioning
 * ever reads as too eager or too stubborn.
 */
export const PACE_TRUST = 0.6;

/**
 * Coefficient of variation by position, before the role adjustment.
 *
 * Read as: a receiver's week has a standard deviation of about half its mean.
 * These are the ordinary spreads of weekly fantasy scoring and they are stated
 * as ratios rather than points so they scale with the projection — a 4-point
 * flex play and a 20-point quarterback do not have the same absolute spread and
 * should not be modelled as if they did.
 */
export const POSITION_VOLATILITY: Record<string, number> = {
  QB: 0.32,
  RB: 0.44,
  WR: 0.52,
  TE: 0.58,
  K: 0.45,
  DEF: 0.65,
};

/** Anything the dictionary does not carry a spread for. Deliberately wide. */
export const DEFAULT_VOLATILITY = 0.55;

/**
 * What the role classification does to the spread, as a multiplier.
 *
 * The buckets are the existing ones from `core/startsit/roleProfile.ts` — this
 * module classifies nothing of its own. A rushing quarterback carries two
 * sources of production and a floor a pocket passer does not; a deep threat's
 * week is decided by two or three targets; a possession receiver's is decided
 * by nine. Bounded to ±25% so a role can shade a distribution and never define
 * it.
 */
export const ROLE_VOLATILITY: Record<string, number> = {
  rushing_quarterback: 0.92,
  deep_receiver: 1.2,
  intermediate_receiver: 1,
  underneath_receiver: 0.85,
  receiving_back: 0.9,
  rushing_back: 1.05,
  unclassified: 1,
};

/**
 * The three branches an unresolved availability actually has.
 *
 * Keyed on the existing `AvailabilityConfidence` state rather than on a raw
 * designation, because that state is already the app's answer to "how much do
 * we believe he plays" and a second answer here would be a second opinion the
 * user could catch disagreeing with the Team screen.
 *
 * `limited` is a real branch and not a rounding of the other two: a player who
 * dresses and plays two thirds of the snaps is the most common outcome of a
 * genuine Questionable, and collapsing him into either neighbour is what makes
 * a questionable star look either fine or absent when he is neither.
 */
export interface InjuryMixture {
  /** Probability he plays his ordinary role. */
  normal: number;
  /** Probability he plays a reduced one. */
  limited: number;
  /** Probability he does not play at all. */
  inactive: number;
}

/** What a limited role is worth, as a share of the ordinary projection. */
export const LIMITED_MULTIPLIER = 0.72;

const CERTAIN: InjuryMixture = { normal: 1, limited: 0, inactive: 0 };

export const AVAILABILITY_MIXTURE: Record<AvailabilityConfidence, InjuryMixture> = {
  high_confidence_active: CERTAIN,
  // Listed, but the practice week says he is playing. A small tail, not none.
  moderate_confidence_active: { normal: 0.72, limited: 0.2, inactive: 0.08 },
  // The case the whole mixture exists for: the app genuinely does not know.
  uncertain: { normal: 0.4, limited: 0.3, inactive: 0.3 },
  likely_inactive: { normal: 0.12, limited: 0.2, inactive: 0.68 },
  inactive: { normal: 0, limited: 0, inactive: 1 },
  // Nothing published is not the same as a risk. Treated as playing, and
  // counted in the freshness report so the confidence line can say so.
  unknown: CERTAIN,
};

/** Where a player's game is, and how much of it has gone. */
export interface GameClock {
  phase: GamePhase;
  /** 0 before kickoff, 1 once the game is over. */
  elapsed: number;
  /** True when no kickoff was known and the phase had to be inferred. */
  inferred: boolean;
}

/**
 * Place one player's game on the clock.
 *
 * With a kickoff this is arithmetic. Without one — no Vegas event for his game,
 * which happens for a team nobody in the matchup has a prop on — the only
 * honest signals left are whether he has scored anything and whether anybody
 * else has finished, so the caller passes what it knows and the result is
 * marked `inferred`. An inferred clock is used, and it degrades the forecast's
 * confidence rather than being silently trusted.
 */
export function resolveGameClock(
  kickoff: string | null,
  now: Date | string,
  opts: { hasPoints?: boolean; weekSettled?: boolean } = {},
): GameClock {
  const at = typeof now === 'string' ? Date.parse(now) : now.getTime();
  const start = kickoff ? Date.parse(kickoff) : Number.NaN;

  if (!Number.isFinite(start)) {
    // The week is over: everything in it is settled, whatever the schedule
    // said. This is the branch that stops a finished week from being simulated
    // forever on a deployment with no odds coverage.
    if (opts.weekSettled) return { phase: 'final', elapsed: 1, inferred: true };
    /*
     * Points on the board with no clock behind them.
     *
     * Treated as a game in progress rather than as one that has finished,
     * because calling it final would lock in a partial score as if it were a
     * result. Half elapsed is the least committal reading of "it has started
     * and we cannot see how far in it is".
     */
    if (opts.hasPoints) return { phase: 'live', elapsed: 0.5, inferred: true };
    return { phase: 'not_started', elapsed: 0, inferred: true };
  }

  if (at < start) return { phase: 'not_started', elapsed: 0, inferred: false };
  const minutes = (at - start) / 60_000;
  if (minutes >= GAME_MINUTES) return { phase: 'final', elapsed: 1, inferred: false };
  return { phase: 'live', elapsed: clamp(minutes / GAME_MINUTES, 0, 1), inferred: false };
}

/**
 * One player's remaining uncertainty, ready to be sampled.
 *
 * `locked` players carry no distribution at all — that is the type saying what
 * §6 says in words. Everything below the simulator reads `remainingMean` and
 * `remainingCv`, and adds `settled` back afterwards, so points already scored
 * can never be resampled by any code path.
 */
export interface PlayerDistribution {
  playerId: string;
  side: MatchupPlayerInput['side'];
  starting: boolean;
  phase: GamePhase;
  /** True when nothing about this player can still change. */
  locked: boolean;
  /** Points already banked. Sleeper's, and never modelled. */
  settled: number;
  /**
   * The share of his game still to be played, 0..1.
   *
   * Carried rather than recomputed downstream, because it is the denominator of
   * "how much was he expected to have by now" — the only honest way to say a
   * player is running below projection at half-time without claiming he has
   * missed a whole game's worth of points.
   */
  remainingShare: number;
  /**
   * Expected points still to come **if he plays his ordinary role**.
   *
   * The mixture below is what turns this into an unconditional expectation —
   * see {@link effectiveRemaining}. Kept separate so the two statements stay
   * distinguishable: "what he would score" and "what he is expected to score
   * given he might not play" are different sentences, and a card that needs the
   * first must not be handed the second.
   */
  remainingMean: number;
  /** Relative spread of what is left. Zero when nothing is left. */
  remainingCv: number;
  /** The unresolved-availability branches, when there are any. */
  mixture: InjuryMixture;
  /** True when the projection was unknown and the player contributes only truth. */
  projectionUnknown: boolean;
  /** True when the clock had to be inferred rather than read. */
  clockInferred: boolean;
  /** Floor / median / ceiling of his *final* total, for display and leverage. */
  floor: number;
  median: number;
  ceiling: number;
}

/** How wide a relative spread may get, either way. Guards against divide-by-nothing. */
const MIN_CV = 0.05;
const MAX_CV = 2.5;

export function buildDistribution(
  player: MatchupPlayerInput,
  clock: GameClock,
): PlayerDistribution {
  const settled = Number.isFinite(player.actual) ? player.actual : 0;

  /*
   * A finished player, and a player nobody can score.
   *
   * Both contribute their actual points and nothing else, and both are marked
   * locked so the simulator never draws for them. They are different states —
   * one is truth, the other is a gap — and they are told apart by
   * `projectionUnknown` so the freshness report can count the second without
   * pretending the first is a problem.
   */
  if (clock.phase === 'final') {
    return settledDistribution(player, clock, settled, false);
  }
  if (player.projection == null) {
    return settledDistribution(player, clock, settled, true);
  }
  /*
   * Ruled out before kickoff is a fact, not a branch.
   *
   * A player who is Out scores nothing, and modelling a tail in which he plays
   * would be the app arguing with a published inactive list.
   */
  if (player.ruledOut) {
    return settledDistribution(player, clock, settled, false);
  }

  const cv = volatilityFor(player.position, player.roleBucket);
  const remainingShare = clamp(1 - clock.elapsed, 0, 1);

  /*
   * The mean of what is left.
   *
   * Before kickoff it is simply the projection. Once a game is running it is a
   * blend of two readings of the same player: what he was projected to do with
   * the time remaining, and what the pace he has actually set implies about it.
   * The blend leans further toward the observed pace the further into the game
   * it is — early, a quiet quarter says almost nothing; late, it is most of
   * what is known — and {@link PACE_TRUST} caps how far that can go.
   */
  const paceWeight = clock.phase === 'live' ? clamp(clock.elapsed * PACE_TRUST, 0, PACE_TRUST) : 0;
  const impliedFromPace = clock.elapsed > 0.02 ? settled / clock.elapsed : player.projection;
  const fullExpectation = paceWeight * impliedFromPace + (1 - paceWeight) * player.projection;
  const remainingMean = Math.max(0, round2(fullExpectation * remainingShare));

  /*
   * The spread of what is left.
   *
   * A week's scoring is a sum of roughly independent events, so its variance
   * scales with the share of the game still to be played and its standard
   * deviation with the square root of that share. The consequence is the one
   * that matters on a Sunday afternoon: relative uncertainty *rises* as a game
   * runs down, because the same handful of possible touchdowns is being priced
   * against a smaller and smaller expected total.
   */
  const fullSd = Math.max(player.projection, 0) * cv;
  const remainingSd = fullSd * Math.sqrt(remainingShare);
  const remainingCv = remainingMean <= 0 ? 0 : clamp(remainingSd / remainingMean, MIN_CV, MAX_CV);

  const mixture = mixtureFor(player, clock);
  const quantiles = finalQuantiles(settled, remainingMean, remainingCv, mixture);

  return {
    playerId: player.playerId,
    side: player.side,
    starting: player.starting,
    phase: clock.phase,
    locked: false,
    settled,
    remainingShare: round2(remainingShare),
    remainingMean,
    remainingCv,
    mixture,
    projectionUnknown: false,
    clockInferred: clock.inferred,
    ...quantiles,
  };
}

/**
 * The mixture that applies right now.
 *
 * Only before kickoff. Once a game is running, whether he is playing is no
 * longer a question — the scoreboard is answering it — so §8's branch is
 * collapsed rather than carried, which is also what stops an inactive tail from
 * suppressing the projection of somebody who is visibly on the field.
 */
function mixtureFor(player: MatchupPlayerInput, clock: GameClock): InjuryMixture {
  if (clock.phase !== 'not_started') return CERTAIN;
  return AVAILABILITY_MIXTURE[player.availability] ?? CERTAIN;
}

function settledDistribution(
  player: MatchupPlayerInput,
  clock: GameClock,
  settled: number,
  projectionUnknown: boolean,
): PlayerDistribution {
  return {
    playerId: player.playerId,
    side: player.side,
    starting: player.starting,
    phase: clock.phase,
    locked: true,
    settled,
    remainingShare: round2(clamp(1 - clock.elapsed, 0, 1)),
    remainingMean: 0,
    remainingCv: 0,
    mixture: CERTAIN,
    projectionUnknown,
    clockInferred: clock.inferred,
    floor: settled,
    median: settled,
    ceiling: settled,
  };
}

/** The blended spread for one player, bounded so a role can never define it. */
export function volatilityFor(position: string, roleBucket: string): number {
  const base = POSITION_VOLATILITY[(position ?? '').toUpperCase()] ?? DEFAULT_VOLATILITY;
  const role = ROLE_VOLATILITY[roleBucket] ?? 1;
  return clamp(base * role, 0.15, 1.2);
}

/**
 * Lognormal parameters for a given mean and coefficient of variation.
 *
 * Solved rather than approximated, so the distribution's mean is exactly the
 * projection it was built from — see the header for why that identity has to
 * hold.
 */
export function lognormalParameters(mean: number, cv: number): { mu: number; sigma: number } {
  const safeCv = clamp(cv, MIN_CV, MAX_CV);
  const sigma = Math.sqrt(Math.log(1 + safeCv * safeCv));
  return { mu: Math.log(Math.max(mean, 1e-6)) - (sigma * sigma) / 2, sigma };
}

/** Draw from that lognormal given a standard-normal deviate. */
export function lognormalDraw(mean: number, cv: number, z: number): number {
  if (mean <= 0) return 0;
  const { mu, sigma } = lognormalParameters(mean, cv);
  return Math.exp(mu + sigma * z);
}

/**
 * The unconditional expectation of what is still to come.
 *
 * `remainingMean` assumes he plays; this folds the mixture back in, and it is
 * the number that adds up to the team's projected final score. One function so
 * the display total and the simulation's own mean cannot drift apart.
 */
export function effectiveRemaining(distribution: PlayerDistribution): number {
  const { mixture, remainingMean } = distribution;
  return round2(remainingMean * (mixture.normal + mixture.limited * LIMITED_MULTIPLIER));
}

/** What a player's final total is projected to be: truth plus expectation. */
export function projectedFinal(distribution: PlayerDistribution): number {
  return round2(distribution.settled + effectiveRemaining(distribution));
}

/**
 * The scale of the active branch, as one multiplier.
 *
 * The mixture has two playing branches, and treating them as one lognormal
 * whose mean is their weighted average is an approximation — a deliberate one.
 * Modelling them as two separate lognormals would move a tenth of a point on a
 * quantile and would cost a second parameterisation to keep in step with the
 * sampler; §4's instruction not to create false precision where the data is
 * weak applies to the shape of a Questionable tight end as much as to anything.
 */
function activeScale(mixture: InjuryMixture): number {
  const playing = mixture.normal + mixture.limited;
  if (playing <= 0) return 0;
  return (mixture.normal + mixture.limited * LIMITED_MULTIPLIER) / playing;
}

/**
 * Floor, median and ceiling of a player's *final* total.
 *
 * The tenth, fiftieth and ninetieth percentiles: the honest reading of "the bad
 * case", "the ordinary case" and "the good case" for a distribution with no
 * upper bound. The inactive branch is folded in by shifting the quantile, which
 * is what makes a genuinely questionable player's floor collapse to his banked
 * points rather than sitting at a number that assumes he plays.
 */
function finalQuantiles(
  settled: number,
  mean: number,
  cv: number,
  mixture: InjuryMixture,
): { floor: number; median: number; ceiling: number } {
  if (mean <= 0) return { floor: settled, median: settled, ceiling: settled };
  const { mu, sigma } = lognormalParameters(mean, cv);
  const scale = activeScale(mixture);
  const playing = Math.max(1 - mixture.inactive, 1e-6);
  const at = (p: number) => {
    // Probability mass sitting exactly on the banked total, from the inactive
    // branch. Below it, the quantile *is* the banked total.
    const conditional = (p - mixture.inactive) / playing;
    if (conditional <= 0) return round2(settled);
    return round2(settled + Math.exp(mu + sigma * probit(conditional)) * scale);
  };
  return { floor: at(0.1), median: at(0.5), ceiling: at(0.9) };
}

/**
 * The inverse standard normal CDF, to about seven decimal places.
 *
 * Acklam's rational approximation with one Halley refinement step. Present
 * because the quantiles above are display numbers computed once per player and
 * a sampling estimate of them would jitter between renders for no reason —
 * which is exactly the failure §5 forbids for the win probability, and there is
 * no reason to accept it here either.
 */
export function probit(p: number): number {
  const q = clamp(p, 1e-9, 1 - 1e-9);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;

  let x: number;
  if (q < low) {
    const s = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0]! * s + c[1]!) * s + c[2]!) * s + c[3]!) * s + c[4]!) * s + c[5]!) /
      ((((d[0]! * s + d[1]!) * s + d[2]!) * s + d[3]!) * s + 1);
  } else if (q > 1 - low) {
    const s = Math.sqrt(-2 * Math.log(1 - q));
    x = -(((((c[0]! * s + c[1]!) * s + c[2]!) * s + c[3]!) * s + c[4]!) * s + c[5]!) /
      ((((d[0]! * s + d[1]!) * s + d[2]!) * s + d[3]!) * s + 1);
  } else {
    const s = q - 0.5;
    const r = s * s;
    x = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * s /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  return x;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
