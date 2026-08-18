/**
 * What would change my recommendation?
 *
 * A close start/sit call is not really the sentence "start A". It is the
 * sentence "start A, and here is the thing that would make it B" — because the
 * user is going to see Friday's practice report and Sunday's line move whether
 * this app helps them read it or not.
 *
 * ## Computed against the engine, not against a model of the engine
 *
 * Every condition here is found by **re-running the real evaluation** with one
 * input changed and bisecting for the point where the answer flips. That is
 * slower than inverting the arithmetic by hand and it is the only version that
 * cannot drift: the day somebody retunes a mode weight or caps a component
 * pair, these thresholds move with it, because they were never a second copy of
 * the formula. A boundary that disagrees with the recommendation it annotates
 * would be worse than no boundary at all.
 *
 * ## Only material, understandable conditions
 *
 * Three rules keep this from becoming a wall of arithmetic:
 *
 *   - **only close calls.** Above {@link BOUNDARY.closeCall} points the answer
 *     is not on a knife edge and pretending otherwise is theatre.
 *   - **only reachable thresholds.** A line that would have to move forty per
 *     cent, or a wind that would have to reach fifty miles an hour, is not a
 *     condition — it is a way of saying the call is not close after all. Those
 *     are dropped rather than printed.
 *   - **no invented precision.** Thresholds are rounded outward to something a
 *     person could read off a sportsbook or a forecast: half a yard on a line,
 *     a whole mile an hour of wind. The bisection could report four decimals;
 *     four decimals would be a lie about what the inputs know.
 *
 * Nothing here changes a score, a lineup or a recommendation. It annotates one.
 */

import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from './engine.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { StartSitMode } from './mode.ts';
import type { PracticeTrend } from '../injury/model.ts';
import { NO_INJURY_INFORMATION, normalizeDesignation, type InjuryState } from '../injury/model.ts';
import type { MarketKey, PlayerProp } from '../vegas/types.ts';

export const BOUNDARY = {
  /** Margin, in points, above which the call is not close enough to annotate. */
  closeCall: 2.5,
  /** The most a market line may be asked to move, as a share of itself. */
  maxLineMove: 0.3,
  /** The most wind may be asked to rise to, in mph. Beyond this it is fiction. */
  maxWindMph: 32,
  /** Steps of bisection. Ten halvings of a bounded range is far past the
   *  precision the answer is rounded to, and costs ten cheap evaluations. */
  steps: 12,
} as const;

export type BoundaryKind = 'market_line' | 'practice_report' | 'wind';

export interface BoundaryCondition {
  kind: BoundaryKind;
  /** The player whose situation would have to change. */
  playerId: string;
  playerName: string;
  /** Who the recommendation would become. */
  switchToPlayerId: string;
  switchToName: string;
  /** The threshold in its own units, rounded outward. Null for a state change. */
  threshold: number | null;
  unit: string | null;
  /** `Would switch to Higgins if his receiving yards line reaches 64.5` */
  detail: string;
}

export interface BoundaryReport {
  /** Empty when the call is not close, which is itself the answer. */
  conditions: BoundaryCondition[];
  margin: number | null;
  /** Said plainly when there is nothing to report and why. */
  note: string | null;
}

export const NO_BOUNDARIES: BoundaryReport = { conditions: [], margin: null, note: null };

/**
 * The conditions that would flip a two-player call.
 *
 * `inputs` are the same inputs the comparison was built from, in any order; the
 * leader is worked out here rather than passed in so a caller cannot annotate
 * one recommendation with another one's boundaries.
 */
export function findBoundaries(
  inputs: StartSitInput[],
  profile: ScoringProfile,
  opts: { mode?: StartSitMode; now?: string | Date } = {},
): BoundaryReport {
  const mode = opts.mode ?? 'balanced';
  const evaluate = (input: StartSitInput) => evaluatePlayer({ ...input, mode, now: input.now ?? opts.now }, profile);

  const scored = inputs
    .map((input) => ({ input, evaluation: evaluate(input) }))
    .filter((row) => row.evaluation.score != null)
    .sort((a, b) => (b.evaluation.score ?? 0) - (a.evaluation.score ?? 0));

  if (scored.length < 2) return { ...NO_BOUNDARIES, note: 'only one candidate can be scored, so nothing would flip it' };

  const leader = scored[0]!;
  const challenger = scored[1]!;
  const margin = round2((leader.evaluation.score ?? 0) - (challenger.evaluation.score ?? 0));

  if (margin > BOUNDARY.closeCall) {
    return {
      conditions: [],
      margin,
      note: `not a close call — ${leader.evaluation.name} leads by ${margin.toFixed(1)} pts, and no single change reaches that`,
    };
  }

  const conditions: BoundaryCondition[] = [];
  const push = (condition: BoundaryCondition | null) => {
    if (condition) conditions.push(condition);
  };

  push(marketLineBoundary(leader, challenger, evaluate));
  push(practiceBoundary(leader, challenger, evaluate));
  push(practiceBoundary(challenger, leader, evaluate));
  push(windBoundary(leader, challenger, evaluate));

  return {
    conditions,
    margin,
    note: conditions.length === 0 ? 'the call is close, and no single readable change reaches the gap' : null,
  };
}

type Row = { input: StartSitInput; evaluation: StartSitEvaluation };
type Evaluate = (input: StartSitInput) => StartSitEvaluation;

/**
 * The line the challenger's market would have to reach.
 *
 * Only his **largest priced market** is moved, because that is the number a
 * person can actually look up on Sunday morning; moving three lines at once
 * produces a condition nobody can check. Receptions and yards are both
 * eligible — whichever is carrying more of his expectation.
 */
function marketLineBoundary(leader: Row, challenger: Row, evaluate: Evaluate): BoundaryCondition | null {
  const contribution = [...challenger.evaluation.expectation.contributions]
    .filter((c) => c.line != null && c.line > 0 && c.points > 0)
    .sort((a, b) => b.points - a.points)[0];
  if (!contribution || contribution.line == null) return null;

  const current = contribution.line;
  const ceiling = current * (1 + BOUNDARY.maxLineMove);
  const beats = (line: number) => {
    const moved = withLine(challenger.input, contribution.market, line);
    return (evaluate(moved).score ?? 0) >= (leader.evaluation.score ?? 0);
  };
  if (!beats(ceiling)) return null;
  if (beats(current)) return null;

  const threshold = roundUpTo(bisect(current, ceiling, beats), 0.5);
  return {
    kind: 'market_line',
    playerId: challenger.evaluation.playerId,
    playerName: challenger.evaluation.name,
    switchToPlayerId: challenger.evaluation.playerId,
    switchToName: challenger.evaluation.name,
    threshold,
    unit: MARKET_UNIT[contribution.market] ?? contribution.market,
    detail: `Would switch to ${challenger.evaluation.name} if his ${MARKET_LABEL[contribution.market] ?? contribution.market} line reaches ${threshold} (it is ${round1(current)})`,
  };
}

/**
 * Friday's practice report, as a condition rather than as a number.
 *
 * Availability is not continuous and must not be bisected: there is no such
 * thing as 63% of a limited practice. The states the week can actually end in
 * are tried in order of how bad they are, and the first one that flips the call
 * is the condition — which is exactly how somebody reads the report anyway.
 */
function practiceBoundary(subject: Row, rival: Row, evaluate: Evaluate): BoundaryCondition | null {
  const injury = injuryOf(subject.input);
  if (injury.designation !== 'questionable') return null;

  const worseningSubjectIsLeader = (subject.evaluation.score ?? 0) >= (rival.evaluation.score ?? 0);
  /*
   * The leader's week can only get worse and the challenger's can only get
   * better. Trying both directions on both players would produce conditions
   * that are already true — "would switch if the man you are not starting
   * practises worse" is not information.
   */
  const trends: PracticeTrend[] = worseningSubjectIsLeader
    ? ['stable_limited', 'not_practising']
    : ['improving', 'full_participant'];

  for (const trend of trends) {
    if (trend === injury.practice.trend) continue;
    const moved = withPractice(subject.input, injury, trend);
    const movedScore = evaluate(moved).score ?? 0;
    const rivalScore = rival.evaluation.score ?? 0;
    const flipped = worseningSubjectIsLeader ? movedScore < rivalScore : movedScore >= rivalScore;
    if (!flipped) continue;
    const switchTo = worseningSubjectIsLeader ? rival : subject;
    return {
      kind: 'practice_report',
      playerId: subject.evaluation.playerId,
      playerName: subject.evaluation.name,
      switchToPlayerId: switchTo.evaluation.playerId,
      switchToName: switchTo.evaluation.name,
      threshold: null,
      unit: null,
      detail: `Would switch to ${switchTo.evaluation.name} if ${subject.evaluation.name} is ${PRACTICE_PHRASE[trend]} on Friday`,
    };
  }
  return null;
}

/**
 * The wind that would take the leader below the challenger.
 *
 * Only offered when the leader is actually outdoors with a forecast, and only
 * up to a speed a forecast might genuinely reach. A condition about a fifty
 * mile an hour wind is not a lineup decision, it is a weather emergency.
 */
function windBoundary(leader: Row, challenger: Row, evaluate: Evaluate): BoundaryCondition | null {
  const forecast = leader.input.weather;
  if (!forecast || forecast.indoor) return null;
  const current = forecast.windMph ?? 0;
  if (current >= BOUNDARY.maxWindMph) return null;

  const falls = (mph: number) => {
    const moved = { ...leader.input, weather: { ...forecast, windMph: mph, gustMph: null } };
    return (evaluate(moved).score ?? 0) < (challenger.evaluation.score ?? 0);
  };
  if (!falls(BOUNDARY.maxWindMph)) return null;
  if (falls(current)) return null;

  const threshold = Math.ceil(bisect(current, BOUNDARY.maxWindMph, falls));
  return {
    kind: 'wind',
    playerId: leader.evaluation.playerId,
    playerName: leader.evaluation.name,
    switchToPlayerId: challenger.evaluation.playerId,
    switchToName: challenger.evaluation.name,
    threshold,
    unit: 'mph',
    detail: `Would switch to ${challenger.evaluation.name} if the wind in ${leader.evaluation.name}'s game exceeds ${threshold} mph`,
  };
}

const MARKET_LABEL: Partial<Record<MarketKey, string>> = {
  receiving_yards: 'receiving yards',
  receptions: 'receptions',
  rush_yards: 'rushing yards',
  pass_yards: 'passing yards',
  pass_tds: 'passing touchdowns',
};

const MARKET_UNIT: Partial<Record<MarketKey, string>> = {
  receiving_yards: 'yards',
  receptions: 'receptions',
  rush_yards: 'yards',
  pass_yards: 'yards',
  pass_tds: 'touchdowns',
};

const PRACTICE_PHRASE: Record<PracticeTrend, string> = {
  full_participant: 'a full participant',
  improving: 'upgraded in practice',
  stable_limited: 'limited again',
  not_practising: 'held out of practice',
  worsening: 'downgraded in practice',
  unknown: 'unreported',
};

/** The same player with one market line moved. Everything else is untouched. */
function withLine(input: StartSitInput, market: MarketKey, line: number): StartSitInput {
  const props: PlayerProp[] = input.props.map((p) => (p.market === market ? { ...p, line } : p));
  return { ...input, props };
}

/** The same player with a different Friday. */
function withPractice(input: StartSitInput, injury: InjuryState, trend: PracticeTrend): StartSitInput {
  return {
    ...input,
    injury: {
      ...injury,
      practice: { ...injury.practice, trend, label: PRACTICE_PHRASE[trend] },
      // A hypothetical report is a fresh one, or the freshness discount would
      // quietly damp the very change being tested.
      freshness: 'fresh',
      confidence: injury.confidence === 'unknown' ? 'moderate' : injury.confidence,
    },
  };
}

/**
 * The state the engine would score, whichever door the caller came in.
 *
 * Mirrors `resolveInjuryState` in the engine deliberately rather than importing
 * it — that one is private, and the alternative is exporting an internal so a
 * boundary can reach it.
 */
function injuryOf(input: StartSitInput): InjuryState {
  if (input.injury) return input.injury;
  const reading = normalizeDesignation(input.injuryStatus);
  if (reading.designation === 'unknown') return NO_INJURY_INFORMATION;
  return {
    ...NO_INJURY_INFORMATION,
    designation: reading.designation,
    designationSource: 'sleeper',
    confidence: 'moderate',
    freshness: 'fresh',
  };
}

/**
 * The smallest value in `[lo, hi]` at which `predicate` becomes true.
 *
 * The caller has already established that it is false at `lo` and true at `hi`,
 * so this is a plain bisection on a monotone predicate — which every input this
 * module moves is, because each one enters the score through a single
 * monotonic component.
 */
function bisect(lo: number, hi: number, predicate: (value: number) => boolean): number {
  let low = lo;
  let high = hi;
  for (let i = 0; i < BOUNDARY.steps; i += 1) {
    const mid = (low + high) / 2;
    if (predicate(mid)) high = mid;
    else low = mid;
  }
  return high;
}

function roundUpTo(value: number, step: number): number {
  return Math.round(Math.ceil(value / step) * step * 100) / 100;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
