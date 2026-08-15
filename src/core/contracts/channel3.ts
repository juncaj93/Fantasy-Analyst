/**
 * The stable surface everything in this workstream is consumed through.
 *
 * The modules behind it are free to change: the expected-points rates will be
 * retuned, the fragility weights will move, the schedule outlook will learn to
 * read something better than a residual. What must not change underneath a
 * consumer is the *shape* — which fields exist, what they are called, what an
 * absent answer looks like, and how confident any of it claims to be.
 *
 * So this file is a boundary, not a layer of logic. Every builder here is a
 * projection from an internal assessment onto a named, versioned structure, and
 * the rules are:
 *
 *   - **absence is `null`, never a zero.** A player with no usage source has
 *     `xfp: null`, and any consumer that treats that as `0.0 expected points`
 *     is making its own mistake rather than being handed one.
 *   - **confidence and freshness travel with the payload**, not beside it. A
 *     number whose provenance is one request away is a number somebody will use
 *     without checking.
 *   - **no `NaN`, no `Infinity`, ever.** {@link validateChannel3Payload} says so
 *     out loud, and a test runs it over a fully-populated payload.
 *   - **the version is in the payload.** A consumer can refuse a shape it does
 *     not understand rather than reading fields that have moved.
 *
 * Nothing here computes football. If a value is not already in an assessment,
 * it does not appear in the contract.
 */

import type { BoundaryReport } from '../startsit/boundary.ts';
import { emergencyPivot, type BeneficiaryGraph } from '../injury/beneficiaries.ts';
import type { FragilityAssessment } from '../startsit/fragility.ts';
import type { ModeSuggestion } from '../startsit/modeSuggest.ts';
import type { MultiWeekValue } from '../value/multiWeek.ts';
import type { OptionalityAssessment } from '../startsit/optionality.ts';
import type { ReplacementTree } from '../startsit/contingency.ts';
import type { RoleAssessment } from '../startsit/decisions.ts';
import type { RoleScheduleOutlook } from '../schedule/roleStrength.ts';
import type { SelfGradeReport } from '../grading/report.ts';
import type { StreamingAssessment } from '../startsit/streaming.ts';
import type { XfpAssessment } from '../xfp/model.ts';
import { MODEL_VERSION } from '../grading/model.ts';

/** Bumped when a field is renamed, removed or changes meaning. */
export const CHANNEL3_CONTRACT_VERSION = '1.0.0';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface SourceFreshness {
  source: string;
  state: 'fresh' | 'stale' | 'missing';
  observedAt: string | null;
  ageMinutes: number | null;
}

export interface ConfidenceBlock {
  level: ConfidenceLevel;
  reasons: string[];
}

export interface XfpContract {
  expectedPerGame: number | null;
  actualPerGame: number | null;
  fpoePerGame: number | null;
  touchdownsOverExpectationPerGame: number | null;
  interpretation: XfpAssessment['interpretation'];
  label: string;
  games: number;
  /** True when target depth was measured rather than assumed for the position. */
  depthMeasured: boolean;
  confidence: ConfidenceLevel;
  /** Stated limitations of the opportunity model, for display beside a number. */
  limitations: string[];
}

export interface RoleTrendContract {
  trend: RoleAssessment['trend'];
  label: string;
  games: number;
}

export interface ValueContract {
  thisWeek: number | null;
  nextFourPerWeek: number | null;
  nextFourTotal: number | null;
  weeksAvailable: number;
  horizon: number;
  verdict: MultiWeekValue['verdict'];
  roleStability: MultiWeekValue['roleStability']['state'];
  components: { key: string; label: string; value: number; unknown: boolean }[];
  notes: string[];
}

export interface ScheduleContract {
  verdict: RoleScheduleOutlook['verdict'];
  averagePoints: number | null;
  rated: number;
  byes: number;
  total: number;
  weeks: { week: number; opponent: string | null; bye: boolean; points: number | null; rating: string }[];
  notes: string[];
}

export interface BeneficiaryContract {
  absentPlayerId: string;
  absentName: string;
  team: string;
  unknown: boolean;
  vacated: { carries: number | null; targets: number | null };
  beneficiaries: {
    playerId: string;
    name: string;
    position: string;
    carriesDelta: number | null;
    targetsDelta: number | null;
    basis: 'prior_absence' | 'depth_inference';
    gamesWithout: number;
    confidence: ConfidenceLevel;
    display: string;
  }[];
  /**
   * The best beneficiary who is actually unrostered, when there is one.
   *
   * Advisory, and the whole of what "automatic emergency pickup" means here: a
   * name, a sentence and a confidence. Nothing in this app adds, drops, claims
   * or queues a player, and a contract field that carried an action would be
   * the first place that changed.
   */
  pivot: { playerId: string; name: string; detail: string; confidence: ConfidenceLevel } | null;
  notes: string[];
}

export interface PlayerIntelligence {
  playerId: string;
  name: string;
  position: string;
  team: string;
  xfp: XfpContract | null;
  roleTrend: RoleTrendContract | null;
  value: ValueContract | null;
  schedule: ScheduleContract | null;
  optionality: { score: number; band: OptionalityAssessment['band']; eligibleSlots: string[]; reasons: string[] } | null;
  confidence: ConfidenceBlock;
  freshness: SourceFreshness[];
}

export interface ReplacementTreeContract {
  playerId: string;
  name: string;
  slot: string | null;
  reason: string;
  plans: { key: string; label: string; replacementName: string | null; points: number | null; loss: number | null; feasible: boolean; detail: string }[];
  waiverPivot: { playerId: string; name: string; gain: number; detail: string } | null;
}

export interface LineupIntelligence {
  fragility: { score: number; band: FragilityAssessment['band']; findings: { kind: string; label: string; detail: string }[] } | null;
  replacementTrees: ReplacementTreeContract[];
  mode: { suggested: ModeSuggestion['mode']; auto: boolean; state: ModeSuggestion['state']; margin: number | null; detail: string } | null;
  /** The conditions that would change a close recommendation. */
  boundaries: { kind: string; playerName: string; switchToName: string; threshold: number | null; unit: string | null; detail: string }[];
  streaming: { position: string; verdict: StreamingAssessment['verdict']; detail: string; replacementLevel: number | null }[];
}

export interface Channel3Payload {
  contractVersion: string;
  /** The decision model that produced any scored field in here. */
  modelVersion: string;
  season: string;
  week: number;
  generatedAt: string;
  players: PlayerIntelligence[];
  lineup: LineupIntelligence | null;
  /**
   * Who gains from an absence, one entry per player who is out.
   *
   * Team-level rather than player-level, because that is the shape of the
   * question: an absence is one fact about one offence, and hanging a copy of
   * it off each beneficiary would let two copies disagree.
   */
  beneficiaries: BeneficiaryContract[];
  /** Present only when a graded week exists. Never partially filled. */
  selfGrade: SelfGradeReport | null;
}

export function xfpContract(assessment: XfpAssessment | null, limitations: readonly string[]): XfpContract | null {
  if (!assessment || assessment.interpretation === 'insufficient_data') return null;
  return {
    expectedPerGame: assessment.xfpPerGame,
    actualPerGame: assessment.actualPerGame,
    fpoePerGame: assessment.fpoePerGame,
    touchdownsOverExpectationPerGame: assessment.tdOverExpectationPerGame,
    interpretation: assessment.interpretation,
    label: assessment.label,
    games: assessment.games,
    depthMeasured: assessment.depthMeasured,
    confidence: assessment.confidence,
    limitations: [...limitations],
  };
}

export function roleTrendContract(role: RoleAssessment | null): RoleTrendContract | null {
  if (!role || role.trend === 'insufficient_data') return null;
  return { trend: role.trend, label: role.label, games: role.games };
}

export function valueContract(value: MultiWeekValue | null): ValueContract | null {
  if (!value || value.verdict === 'unknown') return null;
  return {
    thisWeek: value.thisWeek,
    nextFourPerWeek: value.nextFourPerWeek,
    nextFourTotal: value.nextFourTotal,
    weeksAvailable: value.weeksAvailable,
    horizon: value.horizon,
    verdict: value.verdict,
    roleStability: value.roleStability.state,
    components: value.components.map((c) => ({ key: c.key, label: c.label, value: c.value, unknown: c.unknown })),
    notes: value.notes,
  };
}

export function scheduleContract(outlook: RoleScheduleOutlook | null): ScheduleContract | null {
  if (!outlook || outlook.total === 0) return null;
  return {
    verdict: outlook.verdict,
    averagePoints: outlook.averagePoints,
    rated: outlook.rated,
    byes: outlook.byes,
    total: outlook.total,
    weeks: outlook.weeks.map((w) => ({
      week: w.week,
      opponent: w.opponent,
      bye: w.bye,
      points: w.points,
      rating: w.rating,
    })),
    notes: outlook.notes,
  };
}

export function beneficiaryContract(
  graph: BeneficiaryGraph | null,
  /** Player ids that are unrostered in this league, for the pivot. */
  availablePlayerIds: Iterable<string> = [],
): BeneficiaryContract | null {
  if (!graph) return null;
  return {
    absentPlayerId: graph.absentPlayerId,
    absentName: graph.absentName,
    team: graph.team,
    unknown: graph.unknown,
    vacated: graph.vacated,
    beneficiaries: graph.beneficiaries.map((b) => ({
      playerId: b.playerId,
      name: b.name,
      position: b.position,
      carriesDelta: b.carriesDelta,
      targetsDelta: b.targetsDelta,
      basis: b.basis,
      gamesWithout: b.gamesWithout,
      confidence: b.confidence,
      display: b.display,
    })),
    pivot: emergencyPivot(graph, availablePlayerIds),
    notes: graph.notes,
  };
}

export function replacementTreeContract(tree: ReplacementTree): ReplacementTreeContract {
  return {
    playerId: tree.playerId,
    name: tree.name,
    slot: tree.slot,
    reason: tree.reason,
    plans: tree.plans.map((p) => ({
      key: p.key,
      label: p.label,
      replacementName: p.replacementName,
      points: p.points,
      loss: p.loss,
      feasible: p.feasible,
      detail: p.detail,
    })),
    waiverPivot: tree.waiverPivot
      ? {
          playerId: tree.waiverPivot.playerId,
          name: tree.waiverPivot.name,
          gain: tree.waiverPivot.gain,
          detail: tree.waiverPivot.detail,
        }
      : null,
  };
}

export function lineupIntelligence(opts: {
  fragility?: FragilityAssessment | null;
  trees?: ReplacementTree[];
  mode?: ModeSuggestion | null;
  boundaries?: BoundaryReport | null;
  streaming?: StreamingAssessment[];
}): LineupIntelligence {
  return {
    fragility: opts.fragility
      ? {
          score: opts.fragility.score,
          band: opts.fragility.band,
          findings: opts.fragility.findings.map((f) => ({ kind: f.kind, label: f.label, detail: f.detail })),
        }
      : null,
    replacementTrees: (opts.trees ?? []).map(replacementTreeContract),
    mode: opts.mode
      ? {
          suggested: opts.mode.mode,
          auto: opts.mode.auto,
          state: opts.mode.state,
          margin: opts.mode.margin,
          detail: opts.mode.detail,
        }
      : null,
    boundaries: (opts.boundaries?.conditions ?? []).map((c) => ({
      kind: c.kind,
      playerName: c.playerName,
      switchToName: c.switchToName,
      threshold: c.threshold,
      unit: c.unit,
      detail: c.detail,
    })),
    streaming: (opts.streaming ?? []).map((s) => ({
      position: s.position,
      verdict: s.verdict,
      detail: s.detail,
      replacementLevel: s.replacementLevel,
    })),
  };
}

export function channel3Payload(opts: {
  season: string;
  week: number;
  generatedAt: string;
  players: PlayerIntelligence[];
  lineup?: LineupIntelligence | null;
  beneficiaries?: BeneficiaryContract[];
  selfGrade?: SelfGradeReport | null;
}): Channel3Payload {
  return {
    contractVersion: CHANNEL3_CONTRACT_VERSION,
    modelVersion: MODEL_VERSION,
    season: opts.season,
    week: opts.week,
    generatedAt: opts.generatedAt,
    players: opts.players,
    lineup: opts.lineup ?? null,
    beneficiaries: opts.beneficiaries ?? [],
    selfGrade: opts.selfGrade ?? null,
  };
}

/**
 * Everything wrong with a payload, in plain language.
 *
 * A validator rather than a type guard, because the failures worth catching are
 * not type errors: a `NaN` that made it through arithmetic, a confidence level
 * nobody recognises, a version from the future. Returns an empty array for a
 * good payload and is run over a fully-populated one in the tests, which is
 * what makes this contract *testable* rather than merely declared.
 */
export function validateChannel3Payload(payload: Channel3Payload): string[] {
  const problems: string[] = [];
  const levels = new Set(['high', 'medium', 'low']);

  if (payload.contractVersion !== CHANNEL3_CONTRACT_VERSION) {
    problems.push(`contract version ${payload.contractVersion} is not ${CHANNEL3_CONTRACT_VERSION}`);
  }
  if (!payload.modelVersion) problems.push('model version is missing');
  if (!Number.isInteger(payload.week) || payload.week < 0) problems.push(`week ${payload.week} is not a week number`);
  if (Number.isNaN(Date.parse(payload.generatedAt))) problems.push('generatedAt is not a usable timestamp');

  for (const player of payload.players) {
    const where = `${player.name || player.playerId}`;
    if (!player.playerId) problems.push('a player has no id');
    if (!levels.has(player.confidence.level)) problems.push(`${where}: unknown confidence level`);
    for (const source of player.freshness) {
      if (!['fresh', 'stale', 'missing'].includes(source.state)) {
        problems.push(`${where}: source ${source.source} has an unknown state`);
      }
      if (source.state === 'missing' && source.observedAt != null) {
        problems.push(`${where}: source ${source.source} is missing but carries an observation time`);
      }
    }
    if (player.xfp && !levels.has(player.xfp.confidence)) problems.push(`${where}: unknown xFP confidence`);
    problems.push(...finiteProblems(player, where));
  }

  if (payload.lineup) problems.push(...finiteProblems(payload.lineup, 'lineup'));
  for (const graph of payload.beneficiaries) {
    if (graph.unknown && graph.beneficiaries.length > 0) {
      problems.push(`${graph.absentName}: the graph says unknown and still names beneficiaries`);
    }
    if (graph.pivot && !graph.beneficiaries.some((b) => b.playerId === graph.pivot!.playerId)) {
      problems.push(`${graph.absentName}: the emergency pivot is not one of the beneficiaries`);
    }
    problems.push(...finiteProblems(graph, `beneficiaries.${graph.absentPlayerId}`));
  }
  if (payload.selfGrade) {
    if (payload.selfGrade.appliedChanges.length > 0) {
      problems.push('the self-grade reports applied changes, which it must never do');
    }
    if (payload.selfGrade.suggestions.some((s) => s.applied)) {
      problems.push('a self-grade suggestion is marked applied');
    }
  }

  return problems;
}

/** Every non-finite number anywhere in a value, by path. */
function finiteProblems(value: unknown, path: string): string[] {
  const problems: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) problems.push(`${at} is ${String(node)}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return problems;
}
