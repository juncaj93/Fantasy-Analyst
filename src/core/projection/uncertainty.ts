/**
 * How wide the week is, where the floor and the ceiling sit, and how much of
 * any of it is worth believing.
 *
 * Three questions that are routinely run together and are not the same question.
 *
 * ## Width is not confidence
 *
 * A quarterback with four priced markets, eight games of steady snaps and a
 * timestamped depth chart from this morning is a **high-confidence** projection.
 * He is also, being a quarterback, one of the **narrowest** weeks on the board.
 * A rookie receiver nobody has priced, with three games of wildly swinging
 * target share, is low-confidence *and* wide. The two move together often enough
 * that collapsing them feels harmless, and then a tight end with one excellent
 * source and a genuinely volatile role gets reported as unreliable data when
 * what he has is reliable data about an unreliable player.
 *
 * So: **width** is what the distribution looks like, and it takes contributions
 * from the player as well as from the data. **Confidence** is about the data
 * only — §17: "Confidence is about data quality/coverage, not player quality" —
 * and it is computed from inputs that mention no player attribute at all.
 * Neither reads the projection's own value, which is the other half of §17's
 * rule and the reason `confidenceFor` is not handed one.
 *
 * ## The shape, and why it is the app's existing one
 *
 * A lognormal parameterised by a coefficient of variation — the same *shape* as
 * `core/matchup/distribution.ts`, and deliberately not the same *numbers*.
 *
 * The shape is shared for a specific reason: §24 anticipates the Matchup
 * simulation eventually consuming Projection v2's distribution, and a v2 that
 * produced a differently-shaped object would make that integration a rewrite
 * instead of a wire-up. So `lognormalParameters` and `probit` are imported from
 * there rather than reimplemented.
 *
 * The widths are **not** shared, and that was a finding rather than a decision:
 * borrowing the simulation's `POSITION_VOLATILITY` produced a nominal 10–90
 * interval that held 43% of the time across a real season. See
 * {@link PROJECTION_VOLATILITY} for the measurement and for why the two
 * questions genuinely have different answers. Nothing here changes that table,
 * because Matchup reads it and phase 1 changes no live behaviour.
 *
 * Fantasy scoring is right-skewed — a receiver's downside is bounded at zero and
 * his upside is a 60-yard catch — so a lognormal's median sits below its mean by
 * construction. That is the correct direction and it is why the median is
 * reported separately from the projection rather than assumed equal to it.
 *
 * ## Floor and ceiling are quantiles, not a bracket
 *
 * §16: "Do not use arbitrary ±X fantasy points." The 10th and 90th percentiles
 * of the fitted lognormal, computed exactly through the existing `probit`
 * rather than sampled, so they are stable between renders and every one of the
 * properties §16 asks for — position-aware, role-aware, coverage-aware — is
 * inherited from the CV rather than bolted on afterwards.
 */

import { POSITION_VOLATILITY, lognormalParameters, probit } from '../matchup/distribution.ts';
import { mayMoveUncertainty } from './classification.ts';
import { THIN_SAMPLE_GAMES, type UsageFeatures } from './features.ts';
import type { AnchorBasis } from './anchor.ts';
import type { RoleChangeEvidence } from './roleEvidence.ts';

/**
 * How wide a week is **in which he was involved at all**, by position.
 *
 * The conditioning in that sentence is the whole design, and it is there because
 * the first two attempts at this were wrong in a way only a backtest could show.
 *
 * **Attempt one** borrowed `POSITION_VOLATILITY` from
 * `core/matchup/distribution.ts`. A nominal 10–90 interval built from it
 * contained the outcome **43%** of the time across 3,938 player-weeks of 2025.
 * That table is not wrong; it answers a different question. It describes what is
 * *left* of a game already under way — truth banked, minutes elapsed,
 * correlations applied — and this describes a whole week from Tuesday, which is
 * a strictly larger unknown.
 *
 * **Attempt two** widened it to the empirical spread of `actual / projected`
 * (QB 0.43, RB 0.78, WR 0.85, TE 0.83). Coverage rose to 69% and stopped, and
 * the residual was not noise: outcomes fell *below* the floor twice as often as
 * above the ceiling — 23.8% under for receivers against 12.7% over. Widening
 * further did not fix it, which is the signature of a wrong shape rather than a
 * wrong parameter.
 *
 * **What was actually wrong.** A lognormal cannot reach zero and a fantasy week
 * can. Measured on 2025, among players projected three points or more, the share
 * of weeks scoring under 15% of the projection was:
 *
 *     QB 0.9%    RB 7.8%    WR 10.5%    TE 7.8%
 *
 * He was inactive by kickoff, or left in the first quarter, or was simply never
 * thrown to. No continuous unimodal shape puts a tenth of its mass on top of
 * zero, so the distribution is a **mixture**: a bust branch at approximately
 * zero with probability {@link BUST_RATE}, and a lognormal for the rest. Once
 * they are separated, the lognormal has a job it can do, and the conditional
 * spread it needs is much closer to the original guess:
 *
 *     QB 0.42    RB 0.70    WR 0.75    TE 0.74
 *
 * The table below is those figures divided by the mean widening factor the
 * B-class modifiers actually apply — measured at 0.87 to 0.90 across the same
 * population — so that a *typical* player comes out at the measured dispersion
 * rather than 13% below it. Calibrating the base and then letting a skewed set
 * of multipliers pull every projection under it is how an uncertainty model ends
 * up narrower than the thing it was fitted to.
 *
 * ## What is still wrong, said rather than tuned away
 *
 * These values are **not** the ones that produce a perfect 10/80/10. A grid
 * search over the same season wanted a base coefficient of variation of about
 * **1.55** for backs, receivers and tight ends — roughly twice the measured
 * dispersion, and pressed against the top of the search range, which is the
 * signature of a fit absorbing something that is not width.
 *
 * Two things it would have been absorbing. A lognormal has thinner tails than
 * real fantasy scoring even after the bust branch is removed: the 40-yard
 * touchdown is more common than the shape allows. And the anchor itself is
 * biased for some positions — conditional on not busting, tight ends outscored
 * their projection by 13% on average — and widening a distribution to cover
 * somebody else's bias is not calibration, it is hiding a bias inside a spread.
 *
 * So the measured numbers are what is here, and the residual is reported instead
 * of fitted: the interval runs a little tight in the upper tail, most visibly at
 * tight end. That is a real limitation, it is in `docs/PROJECTION_V2.md`, and it
 * is one of the reasons the recommendation at the end of phase 1 is to keep
 * this side-by-side rather than to ship it.
 *
 * **The consequence, stated rather than tuned away: a receiver's honest tenth
 * percentile is zero.** More than one receiver week in ten is a bust, so the
 * bottom decile of his distribution *is* the bust branch. A floor that looked
 * more comfortable would be a floor that was wrong one week in nine.
 *
 * Fitted on 2025 alone, which is the season nflverse has published in full. §22
 * says not to overfit to one and the risk is named in `docs/PROJECTION_V2.md`;
 * `scripts/projection-v2-backtest.mjs` is the harness that produced every
 * number above and re-runs against any season.
 */
export const PROJECTION_VOLATILITY: Record<string, number> = {
  QB: 0.48,
  RB: 0.77,
  WR: 0.85,
  TE: 0.85,
};

/**
 * Anything the table does not carry. At the wide end of what is in it, because a
 * position this app has never modelled is not a narrow one.
 */
export const DEFAULT_PROJECTION_VOLATILITY = 0.8;

/**
 * How often a week is a bust — under 15% of what he was projected for.
 *
 * Measured on 2025 over players projected three points or more. A quarterback
 * who starts almost always throws; a receiver can be shut out by one cornerback
 * and a game script, and one in ten is.
 *
 * This is a fact about the position, not about the player, and the player-level
 * adjustments to it are in {@link uncertaintyFor} — availability that is not
 * settled, a role that has not settled, a sample too thin to have shown a bust
 * yet.
 */
export const BUST_RATE: Record<string, number> = {
  QB: 0.02,
  RB: 0.08,
  WR: 0.11,
  TE: 0.08,
};

export const DEFAULT_BUST_RATE = 0.1;

/**
 * The most of a distribution that may sit on the bust branch.
 *
 * A third. Past that the mixture stops describing a footballer and starts
 * describing a coin, and the honest output for a player that uncertain is a
 * lower confidence rather than a more elaborate distribution.
 */
export const MAX_BUST_RATE = 0.35;

/**
 * Bounds on the fitted coefficient of variation.
 *
 * The ceiling sits well above the widest base times its widening factors, so the
 * clamp cannot quietly cancel every B-class signal for receivers — an
 * uncertainty model that cannot express uncertainty is the failure worth
 * guarding against here.
 */
export const CV_BOUNDS = { min: 0.25, max: 1.8 } as const;

/**
 * The simulation's table, imported only so a test can compare against it.
 *
 * Exported so `tests/projectionV2.model.test.ts` can assert these two are
 * different values — which is what stops a later tidy-up "deduplicating" them
 * and silently rewriting the Matchup screen's win probabilities.
 */
export const SIMULATION_VOLATILITY = POSITION_VOLATILITY;

/** Where the floor and the ceiling are taken. */
export const QUANTILES = { floor: 0.1, median: 0.5, ceiling: 0.9 } as const;

/**
 * Snap-share and target-share standard deviations that count as steady or wild.
 *
 * Measured in share, so 0.06 is six points of snap share game to game — the
 * spread of a player whose job is settled. 0.18 is a player whose club has not
 * decided. Between them nothing is claimed in either direction.
 */
export const STABILITY_BANDS = { steady: 0.06, volatile: 0.18 } as const;

/** One thing that changed the width, and by how much. */
export interface WidthFactor {
  /** The registry key from `core/projection/classification.ts`. */
  key: string;
  /** Multiplier applied to the coefficient of variation. */
  multiplier: number;
  reason: string;
}

export interface UncertaintyModel {
  /**
   * The fitted coefficient of variation of the **live branch** — the week in
   * which he was involved. Not the spread of the whole distribution, which also
   * contains the bust branch.
   */
  cv: number;
  /** The position's base, before anything data-dependent. */
  baseCv: number;
  /**
   * Probability the week is a bust: approximately zero points.
   *
   * A separate branch rather than a thin left tail, because a lognormal cannot
   * reach zero and a tenth of receiver weeks are zero. See {@link BUST_RATE}.
   */
  bustRate: number;
  factors: WidthFactor[];
  /** Reasons the bust branch is heavier than the position's own base rate. */
  bustReasons: string[];
  /** True when the clamp bound the result rather than the factors. */
  clamped: boolean;
}

/** What a caller passes in about the data behind a projection. */
export interface UncertaintyInput {
  position: string;
  features: UsageFeatures | null | undefined;
  basis: AnchorBasis;
  /** 0–1, share of the position's expected markets that were priced. */
  marketCoverage: number;
  roleChange?: RoleChangeEvidence | null;
  /**
   * How much of his recent production needed a touchdown, 0–1, from the
   * existing `core/startsit/tdDependency.ts`. Null when unknown.
   */
  tdDependence?: number | null;
  /** True when any input the estimate rests on is older than it should be. */
  stale?: boolean;
  /** How the player's `gsis_id` was arrived at. */
  identity?: 'sleeper_direct' | 'roster_bridge' | 'unresolved';
  /**
   * The existing availability read, from this app's own injury pipeline.
   * Never from nflverse — §8 forbids that and this consumes rather than
   * duplicates the signal that already exists.
   */
  availabilityUncertain?: boolean;
  /** True when the depth chart lists him outside the spots his club fields. */
  outsideFieldedSpots?: boolean;
}

/**
 * Fit the width.
 *
 * Every factor is looked up in the classification registry before it is applied,
 * so a width contribution from a feature not classified B or C is refused the
 * same way a mean contribution from a feature not classified A or C is.
 */
export function uncertaintyFor(input: UncertaintyInput): UncertaintyModel {
  const baseCv = PROJECTION_VOLATILITY[input.position.toUpperCase()] ?? DEFAULT_PROJECTION_VOLATILITY;
  const factors: WidthFactor[] = [];

  const add = (key: string, multiplier: number, reason: string): void => {
    if (multiplier === 1) return;
    // The gate, on the path. An unregistered or A/D-class key contributes
    // nothing to the width, however it was wired in.
    if (!mayMoveUncertainty(key)) return;
    factors.push({ key, multiplier, reason });
  };

  // ---- market coverage ----------------------------------------------------
  if (input.basis === 'model') {
    add(
      'uncertainty.market_coverage',
      1.3,
      'no market priced any part of this player, so the estimate is the usage model alone',
    );
  } else if (input.marketCoverage >= 0.999) {
    add('uncertainty.market_coverage', 0.92, 'every market this position expects was priced');
  } else if (input.marketCoverage >= 0.5) {
    add(
      'uncertainty.market_coverage',
      1.08,
      `${Math.round(input.marketCoverage * 100)}% of the expected markets were priced; the rest was estimated`,
    );
  } else {
    add(
      'uncertainty.market_coverage',
      1.18,
      `only ${Math.round(input.marketCoverage * 100)}% of the expected markets were priced`,
    );
  }

  // ---- usage sample -------------------------------------------------------
  const games = input.features?.games ?? 0;
  if (games === 0) {
    add('uncertainty.sample_size', 1.2, 'no stored usage for this player at all');
  } else if (games < THIN_SAMPLE_GAMES) {
    add('uncertainty.sample_size', 1.12, `only ${games} game${games === 1 ? '' : 's'} of usage`);
  } else if (games < 6) {
    add('uncertainty.sample_size', 1.05, `${games} games of usage, which is short of a settled read`);
  }

  // ---- role stability -----------------------------------------------------
  addStability(add, 'uncertainty.snap_share_stability', 'snap share', input.features?.snapShareStability ?? null, games);
  addStability(
    add,
    'uncertainty.target_share_stability',
    'target share',
    input.features?.targetShareStability ?? null,
    games,
  );
  addStability(
    add,
    'uncertainty.carry_share_stability',
    'carry share',
    input.features?.carryShareStability ?? null,
    games,
  );

  // ---- touchdown dependence ----------------------------------------------
  if (input.tdDependence != null) {
    if (input.tdDependence >= 0.5) {
      add(
        'uncertainty.td_dependence',
        1.14,
        `${Math.round(input.tdDependence * 100)}% of his recent points needed a touchdown`,
      );
    } else if (input.tdDependence <= 0.2) {
      add(
        'uncertainty.td_dependence',
        0.95,
        `only ${Math.round(input.tdDependence * 100)}% of his recent points needed a touchdown`,
      );
    }
  }

  // ---- freshness, identity, availability, depth ---------------------------
  if (input.stale) {
    add('uncertainty.freshness', 1.1, 'at least one input is older than its refresh window');
  }
  if (input.identity === 'roster_bridge') {
    add('uncertainty.identity', 1.02, 'identified through the roster crosswalk rather than directly');
  }
  if (input.availabilityUncertain) {
    add('uncertainty.injury', 1.15, 'his availability for this week is not settled');
  }
  /*
   * Asymmetric, and §15 is the reason: "Never narrow uncertainty just because a
   * player is listed first on a depth chart." Being listed outside the spots his
   * club fields is a question worth widening for; being listed inside them is
   * a form somebody filled in.
   */
  if (input.outsideFieldedSpots) {
    add('uncertainty.depth_role', 1.08, 'the depth chart lists him outside the spots his club fields');
  }
  if (input.roleChange && input.roleChange.state !== 'none') {
    add(
      'fresh.role_change',
      1.1,
      `his role is in motion (${input.roleChange.state}), which widens the week whichever way it moved`,
    );
  }

  const raw = factors.reduce((cv, f) => cv * f.multiplier, baseCv);
  const cv = Math.min(CV_BOUNDS.max, Math.max(CV_BOUNDS.min, raw));

  /*
   * The bust branch, adjusted for the player rather than only the position.
   *
   * Additive rather than multiplicative, and deliberately: these are answers to
   * "how much more often than a typical player at his position does this one
   * disappear", and a multiplier on a 2% quarterback base would say almost
   * nothing while the same multiplier on an 11% receiver said a great deal.
   */
  const baseBust = BUST_RATE[input.position.toUpperCase()] ?? DEFAULT_BUST_RATE;
  const bustReasons: string[] = [];
  let bust = baseBust;
  if (input.availabilityUncertain) {
    bust += 0.08;
    bustReasons.push('his availability for this week is not settled');
  }
  if (games === 0) {
    bust += 0.06;
    bustReasons.push('no stored usage, so nothing has shown whether he disappears');
  } else if (games < THIN_SAMPLE_GAMES) {
    bust += 0.03;
    bustReasons.push(`only ${games} game${games === 1 ? '' : 's'} of usage`);
  }
  const shares = [input.features?.snapShareStability, input.features?.targetShareStability];
  if (shares.some((sd) => sd != null && sd >= STABILITY_BANDS.volatile)) {
    bust += 0.04;
    bustReasons.push('his share of the work has swung game to game');
  }
  if (input.basis === 'model') {
    bust += 0.03;
    bustReasons.push('no market priced him, so nothing outside his own history says he plays');
  }
  if (input.outsideFieldedSpots) {
    bust += 0.03;
    bustReasons.push('the depth chart lists him outside the spots his club fields');
  }

  return {
    cv: round3(cv),
    baseCv,
    bustRate: round3(Math.min(MAX_BUST_RATE, bust)),
    factors,
    bustReasons,
    clamped: Math.abs(cv - raw) > 1e-9,
  };
}

function addStability(
  add: (key: string, multiplier: number, reason: string) => void,
  key: string,
  label: string,
  stdev: number | null,
  games: number,
): void {
  /*
   * Unknown is not steady.
   *
   * A player with no snap file has an unknown snap share, and treating that as
   * stability would narrow the very projections that deserve the most room.
   * It widens slightly instead — but only once there is enough usage for the
   * absence to be conspicuous, so a September player is not charged twice for
   * a short season that `uncertainty.sample_size` has already accounted for.
   */
  if (stdev == null) {
    if (games >= THIN_SAMPLE_GAMES) add(key, 1.04, `${label} is not known for him`);
    return;
  }
  if (stdev <= STABILITY_BANDS.steady) {
    add(key, 0.94, `${label} has been steady (sd ${stdev})`);
  } else if (stdev >= STABILITY_BANDS.volatile) {
    add(key, 1.12, `${label} has swung game to game (sd ${stdev})`);
  }
}

/** A projection's shape, in points. */
export interface ProjectionInterval {
  floor: number;
  median: number;
  ceiling: number;
}

/**
 * Floor, median and ceiling as exact quantiles of the fitted mixture.
 *
 * The distribution is `bustRate` of mass at approximately zero and the rest a
 * lognormal, and the two are combined so that **the mixture's mean is exactly
 * the projection it was built from**. That identity is why the live branch is
 * fitted to `mean / (1 - bustRate)` rather than to `mean`: a bust branch that
 * contributed nothing to the mean while taking a tenth of the probability would
 * quietly make every distribution's expectation lower than the number printed
 * beside it, and §24 anticipates a simulation eventually summing these.
 *
 * Treating the bust branch as exactly zero is not an approximation for
 * convenience — it was checked. On 2025 the mean of `actual / projected` among
 * bust weeks was **0.02**.
 *
 * A quantile that falls inside the bust branch is zero, and that is the whole
 * point of the mixture: with an 11% bust rate, a receiver's tenth percentile
 * *is* zero, and reporting anything else would be reporting a floor he falls
 * below one week in nine.
 *
 * §16: quantiles, not an arbitrary ±X. Computed exactly through the existing
 * `probit` rather than sampled, so they are stable between renders.
 */
export function intervalFor(
  mean: number | null,
  cv: number,
  bustRate = 0,
): ProjectionInterval | null {
  if (mean == null || !Number.isFinite(mean) || mean <= 0) return null;
  const q = Math.min(MAX_BUST_RATE, Math.max(0, bustRate));
  const live = mean / (1 - q);
  const { mu, sigma } = lognormalParameters(live, cv);

  /*
   * Rescale each quantile out of the mixture and into the live branch. `p <= q`
   * means the quantile sits in the bust branch, which is zero.
   */
  const at = (p: number): number => {
    if (p <= q) return 0;
    const conditional = (p - q) / (1 - q);
    return round2(Math.exp(mu + sigma * probit(conditional)));
  };
  return { floor: at(QUANTILES.floor), median: at(QUANTILES.median), ceiling: at(QUANTILES.ceiling) };
}

// ------------------------------------------------------------- confidence ---

export type Confidence = 'high' | 'medium' | 'low';

export interface ConfidenceModel {
  level: Confidence;
  /** 0–100. Exposed so a tier boundary is inspectable rather than magic. */
  score: number;
  reasons: string[];
}

/**
 * How much the *data* behind a projection is worth believing.
 *
 * Deliberately not handed the projection. §17: "Do not conflate confidence with
 * projection score." Every contributor below is a fact about coverage,
 * freshness, sample size, identity or role settledness, and none of them is a
 * fact about how good the player is or how many points he is going to score.
 *
 * Scored out of 100 from a written-down table rather than tiered by judgement,
 * so a projection that drops from High to Medium can always be asked why.
 */
export function confidenceFor(input: {
  basis: AnchorBasis;
  marketCoverage: number;
  features: UsageFeatures | null | undefined;
  identity?: 'sleeper_direct' | 'roster_bridge' | 'unresolved';
  stale?: boolean;
  /** Hours since the market snapshot, when it is known. */
  marketAgeHours?: number | null;
  availabilityUncertain?: boolean;
  roleChange?: RoleChangeEvidence | null;
  /** Inputs the pipeline expected and did not get, by name. */
  missingInputs?: string[];
}): ConfidenceModel {
  let score = 0;
  const reasons: string[] = [];

  // --- market coverage: the largest single contributor, 0–40 ---------------
  if (input.basis === 'model') {
    reasons.push('no market priced this player, so the estimate is model-derived');
  } else if (input.marketCoverage >= 0.999) {
    score += 40;
    reasons.push('every market this position expects was priced');
  } else if (input.marketCoverage >= 0.66) {
    score += 30;
    reasons.push(`${Math.round(input.marketCoverage * 100)}% of the expected markets were priced`);
  } else if (input.marketCoverage > 0) {
    score += 18;
    reasons.push(`only ${Math.round(input.marketCoverage * 100)}% of the expected markets were priced`);
  }

  // --- usage sample: 0–25 --------------------------------------------------
  const games = input.features?.games ?? 0;
  if (games >= 6) {
    score += 25;
    reasons.push(`${games} games of stored usage`);
  } else if (games >= THIN_SAMPLE_GAMES) {
    score += 16;
    reasons.push(`${games} games of stored usage, which is a short read`);
  } else if (games > 0) {
    score += 8;
    reasons.push(`only ${games} game${games === 1 ? '' : 's'} of stored usage`);
  } else {
    reasons.push('no stored usage for this player');
  }

  // --- freshness: 0–15 -----------------------------------------------------
  const age = input.marketAgeHours;
  if (input.stale) {
    reasons.push('at least one input is older than its refresh window');
  } else if (age == null) {
    score += 6;
    reasons.push('the market snapshot carries no timestamp');
  } else if (age <= 24) {
    score += 15;
    reasons.push(`the market was priced ${Math.round(age)}h ago`);
  } else if (age <= 72) {
    score += 9;
    reasons.push(`the market was priced ${Math.round(age)}h ago`);
  } else {
    score += 2;
    reasons.push(`the market was priced ${Math.round(age / 24)} days ago`);
  }

  // --- identity: 0–10 ------------------------------------------------------
  if (input.identity === 'sleeper_direct') {
    score += 10;
  } else if (input.identity === 'roster_bridge') {
    score += 7;
    reasons.push('identified through the roster crosswalk rather than directly');
  } else if (input.identity === 'unresolved') {
    reasons.push('this player could not be resolved onto an nflverse identifier');
  }

  // --- role settledness: 0–10 ---------------------------------------------
  const change = input.roleChange;
  if (!change || change.state === 'none') {
    score += 10;
  } else if (change.state === 'depth_only') {
    score += 6;
    reasons.push('his depth-chart position moved and nothing corroborates it');
  } else {
    score += 4;
    reasons.push(`his role is changing (${change.state})`);
  }

  // --- deductions ----------------------------------------------------------
  if (input.availabilityUncertain) {
    score -= 10;
    reasons.push('his availability for this week is not settled');
  }
  for (const missing of input.missingInputs ?? []) {
    score -= 5;
    reasons.push(`expected input missing: ${missing}`);
  }

  const bounded = Math.max(0, Math.min(100, score));
  const level: Confidence = bounded >= 70 ? 'high' : bounded >= 45 ? 'medium' : 'low';
  return { level, score: bounded, reasons };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
