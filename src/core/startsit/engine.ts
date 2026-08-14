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
import {
  assessLateSwap,
  assessRole,
  compareMarkets,
  lockState,
  rolePoints,
  type LateSwapAssessment,
  type LockState,
  type MovementSummary,
  type RoleAssessment,
  type RoleMetric,
} from './decisions.ts';
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
  /** ISO kickoff for this player's game, when the schedule is known. */
  kickoff?: string | null;
  /** The same player's lines at an earlier snapshot, for movement. */
  previousProps?: PlayerProp[];
  /** Per-game opportunity, when a usage source is connected. */
  usage?: RoleMetric[];
  /** Reference time; defaults to now. Injected so tests are deterministic. */
  now?: string | Date;
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
  /** Whether this player's game has already kicked off. */
  lock: LockState;
  /** How the market has moved since the previous snapshot. */
  movement: MovementSummary;
  /** Whether the player's opportunity is actually changing. */
  role: RoleAssessment;
}

export interface StartSitComparison {
  evaluations: StartSitEvaluation[];
  /** Null when no player has enough data to justify a recommendation. */
  recommendedPlayerId: string | null;
  margin: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  warnings: string[];
  /** Whether the preferred player being the later player is a problem. */
  lateSwap: LateSwapAssessment;
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

  // --- role trend ----------------------------------------------------------
  // A modest nudge, and only in a close call: a rising role is a reason to
  // prefer one of two similar players, never a reason to start a worse one.
  // With no usage source connected this is `insufficient_data` and contributes
  // nothing, which is the honest answer rather than a zero dressed as a signal.
  const role = assessRole(input.usage ?? []);
  const roleValue = rolePoints(role.trend);
  components.push({
    key: 'role_trend',
    label: 'Role trend',
    display: role.trend === 'insufficient_data' ? 'insufficient data' : role.label,
    value: roleValue,
    unknown: role.trend === 'insufficient_data',
  });

  const movement = compareMarkets(
    (input.previousProps ?? []).map((p) => ({ market: p.market, line: p.line })),
    input.props.map((p) => ({ market: p.market, line: p.line })),
  );

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
    lock: lockState(input.kickoff, input.now ?? new Date()),
    movement,
    role,
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
      lateSwap: {
        verdict: 'unknown',
        label: 'Late-swap risk unknown',
        detail: 'There is no usable projection for any candidate, so kickoff timing changes nothing.',
        gapHours: null,
        advantage: null,
      },
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

  /*
   * Late-swap safety.
   *
   * The projection compares the week as if it were one moment, and it is not:
   * if the better player kicks off at night and the alternative locks at one,
   * the choice disappears before the news does. Measured against the best
   * candidate that locks earlier, which is the one whose slot would actually be
   * spent by waiting.
   */
  const earlierAlternative =
    sorted
      .slice(1)
      .filter((e) => e.lock.kickoff && best.lock.kickoff && Date.parse(e.lock.kickoff) < Date.parse(best.lock.kickoff))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

  const lateSwap = assessLateSwap(
    {
      preferred: { name: best.name, kickoff: best.lock.kickoff, status: best.statusFlag, score: best.score },
      alternative: earlierAlternative
        ? {
            name: earlierAlternative.name,
            kickoff: earlierAlternative.lock.kickoff,
            status: earlierAlternative.statusFlag,
            score: earlierAlternative.score,
          }
        : null,
    },
    inputs[0]?.now ?? new Date(),
  );

  if (lateSwap.verdict === 'consider_early_option') {
    // Named as a warning rather than silently reordering the board: the
    // projection still prefers the later player, and hiding that would be
    // making the user's risk decision for them.
    warnings.push(lateSwap.detail);
    confidence = confidence === 'high' ? 'medium' : confidence;
  } else if (lateSwap.verdict === 'worth_waiting') {
    reasons.push(lateSwap.detail);
  }

  // A player whose game has started is not a decision any more.
  const locked = evaluations.filter((e) => e.lock.locked);
  if (locked.length > 0) {
    warnings.push(
      `${locked.map((e) => e.name).join(', ')} ${locked.length === 1 ? 'has' : 'have'} already kicked off — that lineup spot is fixed.`,
    );
  }

  const rising = best.role.trend === 'rising_high' || best.role.trend === 'rising_moderate';
  if (rising && margin != null && margin < minMargin) {
    reasons.push(`${best.name}'s role is trending up: ${lowerFirst(best.role.detail)}`);
  }

  const movingUp = best.movement.headline;
  if (movingUp) reasons.push(`${best.name}: ${lowerFirst(movingUp)} (${best.movement.significant.map((m) => m.display).join('; ')})`);

  return {
    evaluations: sorted.concat(evaluations.filter((e) => e.score == null)),
    recommendedPlayerId: best.playerId,
    margin,
    confidence,
    reasons,
    warnings,
    lateSwap,
  };
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
