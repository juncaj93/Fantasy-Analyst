/**
 * Projection v2 beside what the app actually shows today — the gate, not a
 * feature.
 *
 * §13 and §21 are the reason this module exists and the reason nothing consumes
 * its output: Phase 1 computes v2 "offline / side-by-side", compares it against
 * the current market projection and the Rotowire fallback, produces explainable
 * diagnostics, and proves no decision engine changed. This is that comparison,
 * and its most important property is that it is **read-only in both directions**
 * — it reads what the live engines produce and returns a report; nothing here
 * writes a projection anywhere a recommendation could find it.
 *
 * ## What it compares against, and why both
 *
 * `core/startsit/projection.ts` defines a strict two-tier hierarchy: this app's
 * market-derived projection where a market exists, and Rotowire's published
 * weekly number — display-only — where one does not. Those two are different
 * kinds of object and a report that averaged them would be comparing v2 against
 * a mixture nobody sees. So both are carried, and `differenceAgainst` says which
 * one the difference was taken against: the market where there is one, because
 * that is what the simulation reads, and the fallback where there is not,
 * because that is what the screen shows.
 *
 * ## Not tuned to look different
 *
 * §21 closes with "Do not tune merely to make Projection v2 look different", and
 * the honest form of that instruction is a report whose headline number is
 * expected to be near zero for well-covered players. A v2 that moves every
 * strong-market projection has failed §23's first gate — "strong-market players
 * are not materially degraded" — however impressive the movement looks.
 */

import type { ProjectionV2 } from './v2.ts';
import type { Confidence } from './uncertainty.ts';

/** Why a row is worth a human's attention. §21's four highlight categories. */
export type SideBySideFlag = 'largest_change' | 'no_market' | 'low_confidence' | 'role_change';

export interface SideBySideRow {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  /** What the live engine projects today. Null when it declines to. */
  marketProjection: number | null;
  /** Rotowire-via-Sleeper's published weekly number. Display-only, today and here. */
  rotowireProjection: number | null;
  /** Projection v2. */
  v2Projection: number | null;
  /** `v2 - baseline`, where the baseline is named by `differenceAgainst`. */
  difference: number | null;
  differenceAgainst: 'market' | 'rotowire' | null;
  floor: number | null;
  ceiling: number | null;
  confidence: Confidence;
  confidenceScore: number;
  /** 0–1, share of the position's expected markets that were priced. */
  marketCoverage: number;
  /** Regular-season games of stored usage behind the estimate. */
  usageGames: number;
  roleChangeState: string;
  basis: ProjectionV2['basis'];
  filledMarkets: string[];
  reasons: string[];
  flags: SideBySideFlag[];
}

export interface SideBySideSummary {
  players: number;
  /** How many landed in each of §14's three worlds. */
  byBasis: Record<ProjectionV2['basis'], number>;
  byConfidence: Record<Confidence, number>;
  /**
   * Mean absolute difference against the live market projection, over players
   * the market actually covered.
   *
   * **The single number this whole phase turns on.** §23's first rollout gate is
   * that strong-market players are not materially degraded, and a large value
   * here is that gate failing regardless of how good the reasoning looks.
   */
  meanAbsoluteDifferenceStrongMarket: number | null;
  /** The same over players with partial coverage, where a fill was applied. */
  meanAbsoluteDifferencePartialMarket: number | null;
  /** How many players v2 could project that the live market projection could not. */
  newlyProjectable: number;
  /** How many the live engine projects and v2 does not. Should be zero. */
  lostProjections: number;
  /** How many had any fresh-information adjustment at all. */
  withFreshInformation: number;
  /** The largest single absolute difference seen. */
  largestDifference: number | null;
}

export interface SideBySideReport {
  generatedAt: string;
  season: string;
  week: number | null;
  rows: SideBySideRow[];
  summary: SideBySideSummary;
}

/** Points of difference at or above which a row is highlighted. */
export const LARGEST_CHANGE_POINTS = 2;

export interface SideBySideInput {
  projection: ProjectionV2;
  /** What `marketProjection()` returns for him today. */
  marketProjection: number | null;
  /** The published fallback, when the app has one for him. */
  rotowireProjection: number | null;
}

export function buildSideBySide(
  inputs: SideBySideInput[],
  meta: { season: string; week: number | null; generatedAt: string },
): SideBySideReport {
  const rows: SideBySideRow[] = inputs.map(({ projection, marketProjection, rotowireProjection }) => {
    /*
     * The baseline is the market where one exists, because that is the number
     * every recommendation in this app is built on. Falling back to Rotowire
     * only where the app itself falls back keeps the comparison against what a
     * user would actually be looking at.
     */
    const baseline = marketProjection ?? rotowireProjection ?? null;
    const against: SideBySideRow['differenceAgainst'] =
      marketProjection != null ? 'market' : rotowireProjection != null ? 'rotowire' : null;
    const difference =
      projection.points != null && baseline != null ? round2(projection.points - baseline) : null;

    const flags: SideBySideFlag[] = [];
    if (difference != null && Math.abs(difference) >= LARGEST_CHANGE_POINTS) flags.push('largest_change');
    if (projection.modelDerived) flags.push('no_market');
    if (projection.confidence.level === 'low') flags.push('low_confidence');
    if ((projection.provenance.depthChartAsOf != null || projection.freshInformation.points !== 0) &&
        projection.anchor.basis !== 'none') {
      // Only when there is a role change to speak of; the timestamp alone is not one.
      if (projection.freshInformation.points !== 0) flags.push('role_change');
    }

    return {
      playerId: projection.playerId,
      name: projection.name,
      position: projection.position,
      team: projection.team,
      marketProjection,
      rotowireProjection,
      v2Projection: projection.points,
      difference,
      differenceAgainst: against,
      floor: projection.interval?.floor ?? null,
      ceiling: projection.interval?.ceiling ?? null,
      confidence: projection.confidence.level,
      confidenceScore: projection.confidence.score,
      marketCoverage: projection.anchor.marketCoverage,
      usageGames: projection.provenance.usageWeeks.length,
      roleChangeState: projection.freshInformation.points !== 0 ? 'adjusted' : 'none',
      basis: projection.basis,
      filledMarkets: projection.anchor.filledMarkets,
      reasons: projection.reasons,
      flags,
    };
  });

  return { generatedAt: meta.generatedAt, season: meta.season, week: meta.week, rows, summary: summarise(rows, inputs) };
}

function summarise(rows: SideBySideRow[], inputs: SideBySideInput[]): SideBySideSummary {
  const byBasis: Record<ProjectionV2['basis'], number> = {
    market: 0,
    market_plus_model: 0,
    model: 0,
    none: 0,
  };
  const byConfidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  for (const row of rows) {
    byBasis[row.basis]++;
    byConfidence[row.confidence]++;
  }

  const strong = rows.filter((r) => r.basis === 'market' && r.differenceAgainst === 'market' && r.difference != null);
  const partial = rows.filter(
    (r) => r.basis === 'market_plus_model' && r.differenceAgainst === 'market' && r.difference != null,
  );

  const differences = rows.map((r) => r.difference).filter((d): d is number => d != null).map(Math.abs);

  return {
    players: rows.length,
    byBasis,
    byConfidence,
    meanAbsoluteDifferenceStrongMarket: meanAbs(strong.map((r) => r.difference!)),
    meanAbsoluteDifferencePartialMarket: meanAbs(partial.map((r) => r.difference!)),
    newlyProjectable: rows.filter((r) => r.v2Projection != null && r.marketProjection == null).length,
    lostProjections: rows.filter((r) => r.v2Projection == null && r.marketProjection != null).length,
    withFreshInformation: inputs.filter((i) => i.projection.freshInformation.points !== 0).length,
    largestDifference: differences.length === 0 ? null : round2(Math.max(...differences)),
  };
}

function meanAbs(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((a, b) => a + Math.abs(b), 0) / values.length);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
