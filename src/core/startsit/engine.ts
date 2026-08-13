/**
 * Deterministic start/sit comparison.
 *
 * Components stay separate and inspectable, exactly like the draft engine.
 * Missing Vegas data lowers confidence and is surfaced — it is never imputed,
 * and it never silently becomes a zero that looks like a real projection.
 *
 * Safety: this module recommends. It never edits a lineup.
 */

import type { PlayerSignal } from '../evidence/types.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { PlayerProp } from '../vegas/types.ts';
import { buildExpectation, type VegasExpectation } from './expectation.ts';

export interface StartSitInput {
  player: CanonicalPlayer;
  props: PlayerProp[];
  signal: PlayerSignal | null;
  /** Sleeper injury status ('Questionable', 'Out', 'IR', ...). */
  injuryStatus?: string | null;
  /** How stale the props are, in minutes. Null when there are none. */
  propAgeMinutes?: number | null;
  /** True when the props came from a stale cache. */
  propsStale?: boolean;
}

export interface StartSitComponent {
  key: string;
  label: string;
  display: string;
  /** Points-denominated where possible, so components stay interpretable. */
  value: number;
  unknown: boolean;
}

export interface StartSitEvaluation {
  playerId: string;
  name: string;
  position: string;
  team: string;
  expectation: VegasExpectation;
  components: StartSitComponent[];
  /** Final comparable score, in fantasy points. */
  score: number | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceReasons: string[];
  statusFlag: string | null;
}

export interface StartSitComparison {
  evaluations: StartSitEvaluation[];
  /** Null when no player has enough data to justify a recommendation. */
  recommendedPlayerId: string | null;
  margin: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  warnings: string[];
}

/** Status penalties in fantasy points. Editable policy, not a projection. */
export const STATUS_PENALTY: Record<string, number> = {
  OUT: -99,
  IR: -99,
  SUS: -99,
  PUP: -99,
  DOUBTFUL: -6,
  QUESTIONABLE: -1.5,
};

/** Points added per net unit of recent news signal. Deliberately small. */
export const NEWS_POINTS_PER_UNIT = 0.35;
export const NEWS_RECENT_CAP = 2.1;
export const NEWS_RAW_CAP = 1.2;

export function evaluatePlayer(input: StartSitInput, profile: ScoringProfile): StartSitEvaluation {
  const expectation = buildExpectation(input.player.position, input.props, profile);
  const components: StartSitComponent[] = [];
  const confidenceReasons: string[] = [];

  components.push({
    key: 'vegas',
    label: 'Vegas market expectation',
    display: expectation.points == null ? 'unavailable' : `${expectation.points.toFixed(1)} pts`,
    value: expectation.points ?? 0,
    unknown: expectation.points == null,
  });

  const recentNet = input.signal?.last30.net ?? 0;
  const recentItems = input.signal?.last30.items ?? 0;
  const recentValue = clamp(recentNet * NEWS_POINTS_PER_UNIT, -NEWS_RECENT_CAP, NEWS_RECENT_CAP);
  components.push({
    key: 'news_recent',
    label: 'Recent news (30d)',
    display: recentItems === 0 ? 'no recent evidence' : `${recentNet > 0 ? '+' : ''}${recentNet} net over ${recentItems} item(s)`,
    value: round2(recentValue),
    unknown: recentItems === 0,
  });

  const rawNet = input.signal?.raw.net ?? 0;
  const rawItems = input.signal?.raw.items ?? 0;
  const rawValue = clamp(rawNet * (NEWS_POINTS_PER_UNIT / 2), -NEWS_RAW_CAP, NEWS_RAW_CAP);
  components.push({
    key: 'news_raw',
    label: 'Lifetime news',
    display: rawItems === 0 ? 'no evidence' : `${rawNet > 0 ? '+' : ''}${rawNet} net over ${rawItems} item(s)`,
    value: round2(rawValue),
    unknown: rawItems === 0,
  });

  const statusKey = (input.injuryStatus ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const statusPenalty = STATUS_PENALTY[statusKey] ?? 0;
  components.push({
    key: 'status',
    label: 'Availability',
    display: statusKey ? `${input.injuryStatus}` : 'no status flag',
    value: statusPenalty,
    unknown: false,
  });

  // Uncertainty penalty: thin or stale market data reduces the score slightly,
  // so a well-covered player wins ties against a poorly-covered one.
  let uncertainty = 0;
  if (expectation.points == null) {
    uncertainty -= 0;
    confidenceReasons.push('no Vegas data');
  } else {
    if (expectation.coverage < 1) {
      uncertainty -= (1 - expectation.coverage) * 1.5;
      confidenceReasons.push(`partial market coverage (${Math.round(expectation.coverage * 100)}%)`);
    }
    if ((expectation.minBookCount ?? 0) === 1) {
      uncertainty -= 0.5;
      confidenceReasons.push('single book behind at least one market');
    }
    if (input.propsStale) {
      uncertainty -= 0.75;
      confidenceReasons.push('prop data is stale');
    }
  }
  components.push({
    key: 'uncertainty',
    label: 'Uncertainty penalty',
    display: uncertainty === 0 ? 'none' : `${uncertainty.toFixed(2)} pts`,
    value: round2(uncertainty),
    unknown: false,
  });

  if (input.signal?.pendingCount) {
    confidenceReasons.push(`${input.signal.pendingCount} unreviewed news item(s)`);
  }
  if (input.signal?.mixedCount) {
    confidenceReasons.push(`${input.signal.mixedCount} mixed news item(s)`);
  }

  const known = components.filter((c) => !c.unknown);
  const score = expectation.points == null && recentItems === 0 && rawItems === 0 && statusPenalty === 0
    ? null
    : round2(known.reduce((a, c) => a + c.value, 0));

  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (expectation.points == null) confidence = 'low';
  else if (expectation.coverage < 0.7 || input.propsStale) confidence = 'medium';
  if ((input.signal?.pendingCount ?? 0) > 0 && confidence === 'high') confidence = 'medium';

  return {
    playerId: input.player.id,
    name: input.player.fullName,
    position: input.player.position,
    team: input.player.team,
    expectation,
    components,
    score,
    confidence,
    confidenceReasons,
    statusFlag: statusKey ? input.injuryStatus ?? null : null,
  };
}

/**
 * Compare two or more candidates for the same lineup slot.
 * Returns no recommendation when the data cannot support one.
 */
export function compareStartSit(
  inputs: StartSitInput[],
  profile: ScoringProfile,
  opts: { minMargin?: number } = {},
): StartSitComparison {
  const minMargin = opts.minMargin ?? 0.75;
  const evaluations = inputs.map((i) => evaluatePlayer(i, profile));
  const warnings: string[] = [];
  const reasons: string[] = [];

  const scored = evaluations.filter((e) => e.score != null);
  if (scored.length === 0) {
    return {
      evaluations,
      recommendedPlayerId: null,
      margin: null,
      confidence: 'low',
      reasons: [],
      warnings: ['no usable data for any candidate — recommendation withheld'],
    };
  }

  const sorted = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
  const best = sorted[0]!;
  const runnerUp = sorted[1];
  const margin = runnerUp ? round2((best.score ?? 0) - (runnerUp.score ?? 0)) : null;

  const missingVegas = evaluations.filter((e) => e.expectation.points == null);
  if (missingVegas.length > 0) {
    warnings.push(
      `no Vegas data for ${missingVegas.map((e) => e.name).join(', ')} — compared on news and availability only`,
    );
  }

  let confidence: 'high' | 'medium' | 'low' = best.confidence;
  if (margin != null && margin < minMargin) {
    confidence = confidence === 'high' ? 'medium' : 'low';
    reasons.push(`close call: only ${margin} pts separates the top two`);
  }
  if (missingVegas.length > 0 && confidence === 'high') confidence = 'medium';

  if (best.expectation.points != null) {
    reasons.push(`${best.name} carries the higher market expectation (${best.expectation.points.toFixed(1)} pts)`);
  }
  const newsComp = best.components.find((c) => c.key === 'news_recent');
  if (newsComp && !newsComp.unknown && newsComp.value > 0) {
    reasons.push(`positive recent news: ${newsComp.display}`);
  }
  if (runnerUp) {
    const rivalNews = runnerUp.components.find((c) => c.key === 'news_recent');
    if (rivalNews && !rivalNews.unknown && rivalNews.value < 0) {
      reasons.push(`${runnerUp.name} has a negative recent signal (${rivalNews.display})`);
    }
    if (runnerUp.statusFlag) reasons.push(`${runnerUp.name} is listed ${runnerUp.statusFlag}`);
  }
  if (best.statusFlag) warnings.push(`${best.name} is listed ${best.statusFlag}`);

  return {
    evaluations: sorted.concat(evaluations.filter((e) => e.score == null)),
    recommendedPlayerId: best.playerId,
    margin,
    confidence,
    reasons,
    warnings,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
