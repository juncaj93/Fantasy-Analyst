/**
 * Opportunity, weighted for recency, and deliberately blind to fantasy points.
 *
 * ## The rule this file exists to enforce
 *
 * A player's recent fantasy total is the *output* of a week: it contains the
 * touchdown he happened to score, the 60-yard catch-and-run, the defensive
 * return that was credited to nobody's role. Opportunity is the *input*: the
 * carries, the targets, the share of the team's throws. Inputs repeat and
 * outputs do not, so a lineup decision that reads the output is reading the
 * noisiest available version of the question.
 *
 * So this module never sees a fantasy point. It reads volume, converts it into
 * a bounded number of points, and that number is the only way usage enters the
 * Start/Sit score. A player with four targets a game and three touchdowns in
 * the last month scores *below* a player with ten targets and none, which is
 * the whole intent — and `tests/startsit.usage.test.ts` asserts exactly that,
 * so the property cannot quietly regress.
 *
 * ## Recency, without letting one week rewrite a player
 *
 * The last two games carry the most weight, the two before them a middling
 * amount, and everything earlier in the window is the baseline that stops one
 * afternoon redefining somebody. Written as weights rather than as a cutoff so
 * there is no cliff between "recent" and "not recent": a five-game sample and
 * an eight-game sample answer the same way about the same player.
 *
 * ## What it is measured against
 *
 * A number of targets means nothing on its own — ten is enormous for a tight
 * end and ordinary for a number-one receiver. Every value is scored against a
 * per-position **startable baseline**: roughly what a starting fantasy player
 * at that position sees in a week. Those are stated constants, tunable, and
 * openly approximate; what they buy is that positions are comparable, which is
 * what a lineup decision needs.
 */

import type { UsageWeek } from '../usage/role.ts';

/**
 * Recency weights, newest game first.
 *
 * Anything older than the fifth game back keeps the tail weight. Not
 * normalised here: `weightedMean` divides by the weights it actually used, so a
 * three-game series and an eight-game series are both averages rather than one
 * being a smaller number for having less history.
 */
export const RECENCY_WEIGHTS = [4, 4, 2, 2, 1] as const;
const TAIL_WEIGHT = 1;

/**
 * What a startable week of opportunity looks like, by position.
 *
 * `full` is the volume at which the component saturates — a genuine
 * every-down, first-read role. `replacement` is roughly the volume of the
 * player you would stream instead. Between them the score runs -1 to +1.
 *
 * Openly approximate, and stated in one place so they can be tuned from a
 * season's data rather than argued about per screen.
 */
export const OPPORTUNITY_BASELINE: Record<string, { replacement: number; full: number }> = {
  QB: { replacement: 26, full: 40 },
  RB: { replacement: 9, full: 20 },
  WR: { replacement: 4, full: 9 },
  TE: { replacement: 3, full: 7 },
};

/** How many points a saturated opportunity signal is worth. Bounded, and small. */
export const USAGE_POINTS = 2;

export interface UsageAssessment {
  /** Recency-weighted opportunity per game, in the position's own units. */
  perGame: number | null;
  /** What the units are: `targets + carries`, `pass attempts`, and so on. */
  unit: string;
  /** -1..1 against the position's replacement and full baselines. */
  score: number;
  /** Points added to the Start/Sit score. Bounded by {@link USAGE_POINTS}. */
  points: number;
  /** Games the number rests on. */
  games: number;
  /** True when no usage source has anything for this player. */
  unknown: boolean;
  /** The component line. Never a bare number. */
  display: string;
  /** A clause for the drivers list, or null. */
  driver: string | null;
}

export const NO_USAGE: UsageAssessment = {
  perGame: null,
  unit: 'opportunity',
  score: 0,
  points: 0,
  games: 0,
  unknown: true,
  display: 'no usage data',
  driver: null,
};

/**
 * The opportunity a position is judged on.
 *
 * A back's carries and targets are both touches and are added; a receiver's
 * carries are a gadget play and are not. A quarterback is judged on pass
 * attempts, with designed runs added at their fantasy weight rather than
 * one-for-one — a rushing attempt is worth several times a pass attempt to a
 * fantasy score, and counting them equally would rank a game manager over a
 * quarterback who runs.
 */
function opportunityOf(position: string, week: UsageWeek): number | null {
  const pos = position.toUpperCase();
  if (pos === 'QB') {
    const attempts = week.passAttempts;
    const carries = week.carries;
    if (attempts == null && carries == null) return null;
    return (attempts ?? 0) + (carries ?? 0) * 2.5;
  }
  if (pos === 'RB') {
    if (week.carries == null && week.targets == null) return null;
    return (week.carries ?? 0) + (week.targets ?? 0);
  }
  if (pos === 'WR' || pos === 'TE') return week.targets;
  return null;
}

const UNIT: Record<string, string> = {
  QB: 'dropbacks and designed runs',
  RB: 'touches',
  WR: 'targets',
  TE: 'targets',
};

/**
 * Score a player's opportunity. Regular season only; a blank is not a zero.
 */
export function assessUsage(position: string, weeks: UsageWeek[], window = 8): UsageAssessment {
  const pos = position.toUpperCase();
  const baseline = OPPORTUNITY_BASELINE[pos];
  if (!baseline) return NO_USAGE;

  const games = weeks
    .filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG')
    .sort((a, b) => a.week - b.week)
    .slice(-window);

  // Newest first, which is the order the weights are written in.
  const values = games
    .map((g) => opportunityOf(pos, g))
    .filter((v): v is number => v != null && Number.isFinite(v))
    .reverse();
  if (values.length === 0) return { ...NO_USAGE, unit: UNIT[pos] ?? 'opportunity' };

  const perGame = round1(weightedMean(values));
  const score = round3(scoreAgainst(perGame, baseline));
  const points = round2(score * USAGE_POINTS);
  const unit = UNIT[pos] ?? 'opportunity';

  return {
    perGame,
    unit,
    score,
    points,
    games: values.length,
    unknown: false,
    display: `${perGame} ${unit} per game (recency-weighted over ${values.length})`,
    driver:
      score >= 0.5
        ? `${perGame} ${unit} per game`
        : score <= -0.5
          ? `only ${perGame} ${unit} per game`
          : null,
  };
}

/**
 * Where a volume sits between the streaming alternative and a full role.
 *
 * Linear between the two anchors and clamped outside them: a player at twice a
 * full workload is not twice as certain, he is the same certain.
 */
function scoreAgainst(value: number, baseline: { replacement: number; full: number }): number {
  const span = baseline.full - baseline.replacement;
  if (span <= 0) return 0;
  return clamp((value - baseline.replacement) / span, -1, 1);
}

/** Weighted by recency, divided by the weight actually used. */
function weightedMean(newestFirst: number[]): number {
  let total = 0;
  let weight = 0;
  for (let i = 0; i < newestFirst.length; i++) {
    const w = RECENCY_WEIGHTS[i] ?? TAIL_WEIGHT;
    total += newestFirst[i]! * w;
    weight += w;
  }
  return weight === 0 ? 0 : total / weight;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
