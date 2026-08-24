/**
 * Projection v2 — the central estimate, its shape, and everything needed to
 * explain both.
 *
 * > **Vegas remains the anchor. nflverse adds bounded role/usage context and
 * > uncertainty.**
 *
 * That sentence from §3 of the handoff is the whole design, and the arithmetic
 * below is arranged so that it is true by construction rather than by
 * discipline:
 *
 *     points = market components
 *            + estimates for components no market priced        (A, §19)
 *            + a capped adjustment for information newer than
 *              the market snapshot                              (C, §20)
 *
 * There is no fourth term. Nothing about role stability, snap share, opponent
 * quality, pace or recent production appears in that sum, because every one of
 * those is either already inside the market's number or is a fact about width
 * rather than centre. They are all present in the output — in the uncertainty
 * model, in the confidence, in the reasons — and none of them is in the mean.
 *
 * ## Three worlds, one function
 *
 * §14 asks for a deterministic hierarchy and this is it, decided by what the
 * market actually covered rather than by a switch a caller sets:
 *
 *   - **strong coverage** → the market's own components, plus at most a capped
 *     fresh-information adjustment. `basis: 'market'`.
 *   - **partial coverage** → the market's components untouched, and only the
 *     missing ones estimated. `basis: 'market_plus_model'`.
 *   - **no coverage** → a usage model estimate, flagged `modelDerived` so that
 *     no surface can print it as though a book had priced it. `basis: 'model'`.
 *   - **nothing at all** → `points: null`. §26: "never return nonsense zero".
 *
 * ## What happens when nflverse is down
 *
 * §26, and it is the property that makes this safe to build at all: every
 * nflverse input is optional. No roster, no depth chart, no snaps and no stored
 * usage produces a projection that is exactly the market expectation, with the
 * confidence lowered and the reason recorded. **Market-only is a valid answer,
 * not a degraded one**, and `tests/projectionV2.fallback.test.ts` asserts the
 * market-only path is byte-identical to `buildExpectation`'s own total.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { VegasExpectation } from '../startsit/expectation.ts';
import { buildAnchor, type AnchorBasis, type MarketAnchor } from './anchor.ts';
import type { UsageFeatures } from './features.ts';
import { freshInformationAdjustment, type RoleChangeEvidence } from './roleEvidence.ts';
import {
  confidenceFor,
  intervalFor,
  uncertaintyFor,
  type Confidence,
  type ConfidenceModel,
  type ProjectionInterval,
  type UncertaintyModel,
} from './uncertainty.ts';

/**
 * Where every number in a projection came from and how old it is.
 *
 * §11 asks that a projection "carry enough provenance to explain: market
 * timestamp, usage window, depth-chart timestamp, freshness warnings". All four
 * are here, and `warnings` is populated by this module rather than by a caller
 * so that a stale input cannot be silently rendered as a current one.
 */
export interface ProjectionProvenance {
  /** When the market lines under this estimate were captured. */
  marketAsOf: string | null;
  /** Hours between that and `now`, when both are known. */
  marketAgeHours: number | null;
  /** The regular-season weeks the usage window covered, newest first. */
  usageWeeks: number[];
  /** When the usage rows were last ingested. */
  usageAsOf: string | null;
  /** The `dt` of the depth chart read, on the timestamped schema. */
  depthChartAsOf: string | null;
  /** Which nflverse datasets actually contributed. */
  sources: string[];
  /** Inputs the pipeline expected and did not get. */
  missingInputs: string[];
  /** Plain-language freshness problems. Empty is the ordinary case. */
  warnings: string[];
}

export interface ProjectionV2Input {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  /** From `buildExpectation`. Null or empty is a supported, ordinary state. */
  expectation?: VegasExpectation | null;
  features?: UsageFeatures | null;
  profile: ScoringProfile;
  roleChange?: RoleChangeEvidence | null;
  identity?: 'sleeper_direct' | 'roster_bridge' | 'unresolved';
  /** How much of his recent production needed a touchdown, 0–1. */
  tdDependence?: number | null;
  /** From this app's own injury pipeline. Never from nflverse — see §8. */
  availabilityUncertain?: boolean;
  /** True when the depth chart lists him outside the spots his club fields. */
  outsideFieldedSpots?: boolean;
  marketAsOf?: string | null;
  usageAsOf?: string | null;
  depthChartAsOf?: string | null;
  sources?: string[];
  missingInputs?: string[];
  now?: string | Date;
}

export interface ProjectionV2 {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  /** The central estimate, or null when nothing is known. Never a filled-in zero. */
  points: number | null;
  basis: AnchorBasis;
  /**
   * True when no market priced any part of him.
   *
   * §5: a model estimate "must be clearly labeled as model-derived rather than
   * market-derived". This is that label, and it is on the object rather than in
   * a string so a renderer cannot fail to notice it.
   */
  modelDerived: boolean;
  anchor: MarketAnchor;
  /** The capped C-class movement, which is 0 for the overwhelming majority. */
  freshInformation: { points: number; capped: boolean; reason: string | null };
  interval: ProjectionInterval | null;
  uncertainty: UncertaintyModel;
  confidence: ConfidenceModel;
  provenance: ProjectionProvenance;
  /** The handful of sentences that actually explain this number, biggest first. */
  reasons: string[];
}

/** Hours past which a market snapshot is called stale in the provenance. */
export const MARKET_STALE_HOURS = 72;

/**
 * Build one player's Projection v2.
 *
 * Pure, deterministic and total: every branch returns a projection object, and
 * the failure cases are values rather than exceptions. A caller looping a
 * roster cannot have one unresolved player take down the report.
 */
export function projectV2(input: ProjectionV2Input): ProjectionV2 {
  const now = input.now ? new Date(input.now) : new Date();
  const position = input.position.toUpperCase();
  const features = input.features ?? null;

  const anchor = buildAnchor(position, input.expectation ?? null, features, input.profile);

  /*
   * The one place usage is allowed near the mean, and it is gated three ways
   * inside `freshInformationAdjustment`: the role change must be corroborated
   * beyond the depth chart, it must carry a capture time, and that time must be
   * after the market snapshot. Everything that fails any of those returns 0.
   */
  const fresh = freshInformationAdjustment(
    input.roleChange ?? { ...NO_CHANGE },
    anchor.points,
  );

  const points =
    anchor.points == null ? null : round2(Math.max(0, anchor.points + fresh.points));

  const marketAgeHours =
    input.marketAsOf != null ? hoursBetween(input.marketAsOf, now) : null;

  const warnings: string[] = [];
  if (marketAgeHours != null && marketAgeHours > MARKET_STALE_HOURS) {
    warnings.push(`the market lines are ${Math.round(marketAgeHours / 24)} days old`);
  }
  if (input.expectation && (input.expectation.minBookCount ?? 0) === 1) {
    warnings.push('the thinnest market used came from a single book');
  }
  if (features && features.thinSample && features.games > 0) {
    warnings.push(`the usage window covers only ${features.games} games`);
  }
  if (anchor.unfilledMarkets.length > 0) {
    warnings.push(
      `no market and no usable usage for ${anchor.unfilledMarkets.join(', ')}, which are absent from the estimate rather than zero`,
    );
  }
  const stale = warnings.length > 0;

  const uncertainty = uncertaintyFor({
    position,
    features,
    basis: anchor.basis,
    marketCoverage: anchor.marketCoverage,
    roleChange: input.roleChange ?? null,
    tdDependence: input.tdDependence ?? null,
    stale,
    identity: input.identity,
    availabilityUncertain: input.availabilityUncertain,
    outsideFieldedSpots: input.outsideFieldedSpots,
  });

  const confidence = confidenceFor({
    basis: anchor.basis,
    marketCoverage: anchor.marketCoverage,
    features,
    identity: input.identity,
    stale,
    marketAgeHours,
    availabilityUncertain: input.availabilityUncertain,
    roleChange: input.roleChange ?? null,
    missingInputs: input.missingInputs,
  });

  const provenance: ProjectionProvenance = {
    marketAsOf: input.marketAsOf ?? null,
    marketAgeHours: marketAgeHours == null ? null : Math.round(marketAgeHours * 10) / 10,
    usageWeeks: features?.weeks ?? [],
    usageAsOf: input.usageAsOf ?? null,
    depthChartAsOf: input.depthChartAsOf ?? null,
    sources: input.sources ?? [],
    missingInputs: input.missingInputs ?? [],
    warnings,
  };

  return {
    playerId: input.playerId,
    name: input.name,
    position,
    team: input.team,
    points,
    basis: anchor.basis,
    modelDerived: anchor.basis === 'model',
    anchor,
    freshInformation: fresh,
    interval: intervalFor(points, uncertainty.cv),
    uncertainty,
    confidence,
    provenance,
    reasons: explain(anchor, fresh, uncertainty, confidence, provenance),
  };
}

const NO_CHANGE: RoleChangeEvidence = {
  state: 'none',
  direction: 'none',
  observedAt: null,
  newerThanMarket: false,
  qualifiesForMeanAdjustment: false,
  strength: 0,
  previousRank: null,
  currentRank: null,
  reasons: [],
};

/**
 * The sentences that explain the number, in the order they matter.
 *
 * Derived from what the estimate actually did rather than written beside it, so
 * a reason can never describe a mechanism the arithmetic did not use — the same
 * rule `core/startsit/engine.ts` applies to its drivers, and for the same
 * reason: a breakdown that can disagree with its own total is worse than none.
 */
function explain(
  anchor: MarketAnchor,
  fresh: { points: number; reason: string | null },
  uncertainty: UncertaintyModel,
  confidence: ConfidenceModel,
  provenance: ProjectionProvenance,
): string[] {
  const out: string[] = [];

  if (anchor.basis === 'none') {
    out.push('No market priced him and no usage is stored, so this app has no projection for him.');
    return out;
  }

  if (anchor.marketPoints != null) {
    const priced = anchor.components.filter((c) => c.source === 'market');
    out.push(
      `${anchor.marketPoints} pts from ${priced.length} priced market${priced.length === 1 ? '' : 's'} ` +
        `(${priced.map((c) => c.market).join(', ')}).`,
    );
  }
  if (anchor.filledMarkets.length > 0) {
    out.push(
      `${anchor.modelPoints} pts estimated from usage for ${anchor.filledMarkets.join(', ')}, ` +
        'which no market priced. Every component the market did price is unchanged.',
    );
  }
  if (anchor.basis === 'model') {
    out.push('This is a model estimate, not a market one: no book priced any part of his week.');
  }
  if (fresh.points !== 0 && fresh.reason) out.push(`${fresh.reason}.`);

  const widest = [...uncertainty.factors].sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1))[0];
  if (widest) {
    out.push(
      `${widest.multiplier > 1 ? 'Widened' : 'Narrowed'} because ${widest.reason} ` +
        `(spread ${uncertainty.cv} against ${uncertainty.baseCv} for the position).`,
    );
  }
  out.push(`Confidence ${confidence.level}: ${confidence.reasons[0] ?? 'no coverage detail recorded'}.`);
  for (const warning of provenance.warnings) out.push(`Note: ${warning}.`);
  return out;
}

function hoursBetween(iso: string, now: Date): number | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return (now.getTime() - at) / 3_600_000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export type { Confidence, ConfidenceModel, ProjectionInterval, UncertaintyModel };
