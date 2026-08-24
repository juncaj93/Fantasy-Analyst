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
 * A lognormal parameterised by a coefficient of variation, from
 * `core/matchup/distribution.ts`. Reused rather than re-chosen for a specific
 * reason: §24 anticipates the Matchup simulation eventually consuming Projection
 * v2's distribution, and a v2 that produced a differently-shaped object would
 * make that integration a rewrite instead of a wire-up. `POSITION_VOLATILITY`
 * is already this app's tested view of how wide a position's week is; what this
 * module adds is the *data-dependent* part the simulation has never had.
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

import { POSITION_VOLATILITY, DEFAULT_VOLATILITY, lognormalParameters, probit } from '../matchup/distribution.ts';
import { mayMoveUncertainty } from './classification.ts';
import { THIN_SAMPLE_GAMES, type UsageFeatures } from './features.ts';
import type { AnchorBasis } from './anchor.ts';
import type { RoleChangeEvidence } from './roleEvidence.ts';

/** Bounds on the fitted coefficient of variation. */
export const CV_BOUNDS = { min: 0.18, max: 1.25 } as const;

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
  /** The fitted coefficient of variation, after every factor and the clamp. */
  cv: number;
  /** The position's base, before anything data-dependent. */
  baseCv: number;
  factors: WidthFactor[];
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
  const baseCv = POSITION_VOLATILITY[input.position.toUpperCase()] ?? DEFAULT_VOLATILITY;
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
  return { cv: round3(cv), baseCv, factors, clamped: Math.abs(cv - raw) > 1e-9 };
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
 * Floor, median and ceiling as exact lognormal quantiles of the fitted
 * distribution.
 *
 * The mean is the projection and the distribution is fitted to it, so the
 * median comes out below it — which is correct for a right-skewed week and is
 * the reason both are reported. A caller printing the median under the word
 * "projected" would be printing a different number from the one every other
 * surface uses, so the projection travels beside these rather than being
 * replaced by them.
 */
export function intervalFor(mean: number | null, cv: number): ProjectionInterval | null {
  if (mean == null || !Number.isFinite(mean) || mean <= 0) return null;
  const { mu, sigma } = lognormalParameters(mean, cv);
  const at = (p: number): number => round2(Math.exp(mu + sigma * probit(p)));
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
