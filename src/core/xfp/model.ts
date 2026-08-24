/**
 * Expected fantasy points, and the gap between them and what actually happened.
 *
 * Opportunity and efficiency are two different questions wearing one number.
 * A receiver with nine targets and four points had a good week at his job and a
 * bad week at football; a receiver with three targets and eighteen points had
 * the opposite, and only one of those repeats. `xFP` is what the opportunity was
 * worth before anybody caught anything; `FPOE` is actual minus expected, which
 * is the part that did not come from the role.
 *
 * ## What the opportunity model actually knows
 *
 * Everything here is built from the stored weekly rows — targets, air yards,
 * carries, pass attempts — and nothing else. That bounds the claim, and the
 * bound is stated rather than dressed up:
 *
 *   - **target depth is real.** `receiving_air_yards` is in the file, so the
 *     average depth of a player's targets is a measured quantity and the catch
 *     rate, yards and scoring rate attached to a target move with it.
 *   - **red-zone and goal-line opportunity are not.** No free source keyed to
 *     an id space this app already resolves publishes them, so a carry from the
 *     two is worth exactly what a carry from the twenty is worth here. That is
 *     the single largest inaccuracy in this file, it is why a goal-line back's
 *     `FPOE` runs positive all season, and it is reported as
 *     {@link XFP_LIMITATIONS} rather than hidden in a constant.
 *   - **turnovers are not stored**, so neither side of the subtraction contains
 *     them. Wrong in the same direction by the same amount cancels; wrong on one
 *     side only would not.
 *
 * The rates below are league-level averages, openly approximate, stated once so
 * they can be retuned from a season rather than argued about per screen.
 *
 * ## The one rule about scoring
 *
 * `xFP` and actual are both converted with **the league's own scoring profile**,
 * because the brief asks what the opportunity was worth *here*. That makes this
 * module the deliberate opposite of `tdDependency.ts`, which is league-neutral
 * on purpose: a ratio has to mean the same thing in every league, and a
 * difference in points has to be in the points the user plays for.
 *
 * ## Why nothing here scores anything
 *
 * {@link assessXfp} returns no component and the Start/Sit engine never imports
 * it. Opportunity is already in the score once, as `usage_level`; the market's
 * own expectation is in it again as `vegas`; adding expected points off the same
 * carries would be the third count of one afternoon of football. So this is an
 * *interpretation* — a sentence for a card, an input to waiver and trade value,
 * a role-change detector — and the arithmetic that decides a lineup is left
 * exactly where it was. `tests/xfp.test.ts` asserts the engine's score is
 * unchanged by everything in this file.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { UsageWeek } from '../usage/role.ts';

/** What a target is worth before anybody has caught it, by position. */
export const TARGET_MODEL: Record<string, { catchRate: number; yardsPerTarget: number; tdPerTarget: number; adot: number }> = {
  WR: { catchRate: 0.63, yardsPerTarget: 8.1, tdPerTarget: 0.045, adot: 9.5 },
  TE: { catchRate: 0.7, yardsPerTarget: 7.6, tdPerTarget: 0.05, adot: 7.5 },
  RB: { catchRate: 0.76, yardsPerTarget: 6.2, tdPerTarget: 0.028, adot: 0.5 },
  QB: { catchRate: 0.7, yardsPerTarget: 6, tdPerTarget: 0.03, adot: 1 },
};

/**
 * What one yard of target depth does to a target.
 *
 * Deeper targets are caught less often, gain more when they are caught, and
 * score more often. Applied against the position's own typical depth, so a
 * tight end running seven-yard routes is not treated as a shallow receiver —
 * he is treated as an ordinary tight end.
 */
export const DEPTH_SLOPE = {
  catchRatePerYard: -0.022,
  yardsPerTargetPerYard: 0.33,
  tdPerTargetPerYard: 0.0016,
} as const;

/** Bounds on the depth-adjusted rates, so an outlier week cannot leave football. */
export const RATE_BOUNDS = {
  catchRate: { min: 0.3, max: 0.88 },
  yardsPerTarget: { min: 2.5, max: 16 },
  tdPerTarget: { min: 0.012, max: 0.11 },
} as const;

/** What a carry is worth, by who is carrying it. */
export const RUSH_MODEL: Record<string, { yardsPerCarry: number; tdPerCarry: number }> = {
  RB: { yardsPerCarry: 4.3, tdPerCarry: 0.031 },
  QB: { yardsPerCarry: 5, tdPerCarry: 0.033 },
  WR: { yardsPerCarry: 6.4, tdPerCarry: 0.03 },
  TE: { yardsPerCarry: 3.6, tdPerCarry: 0.05 },
};

/** What a drop-back is worth. Quarterbacks only. */
export const PASS_MODEL = { yardsPerAttempt: 7.1, tdPerAttempt: 0.046 } as const;

export const XFP = {
  /** Games below which nothing is claimed at all. */
  minGames: 4,
  /** Games at or above which the read is high confidence. */
  strongGames: 6,
  /**
   * Points per game of `FPOE` at which the gap is worth a sentence.
   *
   * Below this the difference is a rounding error in a model built from league
   * averages, and calling it a finding would be inventing precision the inputs
   * do not carry.
   */
  material: 1.5,
  /** Touchdowns above expectation per game at which regression is the story. */
  materialTdOverExpectation: 0.35,
} as const;

/** Said on the card, in the app's own voice, wherever an xFP number appears. */
export const XFP_LIMITATIONS = [
  'no red-zone or goal-line data is published free on this id space, so a carry from the two counts as a carry',
  'turnovers are not stored, so neither expected nor actual contains them',
] as const;

export type XfpInterpretation =
  | 'usage_stronger_than_results'
  | 'production_outrunning_opportunity'
  | 'td_regression_risk'
  | 'role_healthy_despite_box_score'
  | 'matched'
  | 'insufficient_data';

export const XFP_LABEL: Record<XfpInterpretation, string> = {
  usage_stronger_than_results: 'Usage stronger than results',
  production_outrunning_opportunity: 'Production outrunning opportunity',
  td_regression_risk: 'TD regression risk',
  role_healthy_despite_box_score: 'Role healthy despite low box score',
  matched: 'Production matches opportunity',
  insufficient_data: 'Not enough games',
};

export interface XfpGame {
  week: number;
  /** Expected points from the opportunity, under league scoring. */
  xfp: number;
  /** Reconstructed actual points, under the same scoring. Null when unstored. */
  actual: number | null;
  /** actual − xFP. Null when either side is missing. */
  fpoe: number | null;
  /** Touchdowns above what the volume expected. Null when unstored. */
  tdOverExpectation: number | null;
}

export interface XfpAssessment {
  games: number;
  xfpPerGame: number | null;
  actualPerGame: number | null;
  fpoePerGame: number | null;
  /** Touchdowns above expectation per game, the driver behind most big gaps. */
  tdOverExpectationPerGame: number | null;
  interpretation: XfpInterpretation;
  label: string;
  display: string;
  /** A sentence for a card, or null when there is nothing worth saying. */
  driver: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** True when target depth was measured rather than assumed for the position. */
  depthMeasured: boolean;
  perGame: XfpGame[];
  /** Always zero. See the header: this signal never enters a lineup score. */
  points: 0;
}

export const NO_XFP: XfpAssessment = {
  games: 0,
  xfpPerGame: null,
  actualPerGame: null,
  fpoePerGame: null,
  tdOverExpectationPerGame: null,
  interpretation: 'insufficient_data',
  label: XFP_LABEL.insufficient_data,
  display: 'no opportunity data',
  driver: null,
  confidence: 'low',
  depthMeasured: false,
  perGame: [],
  points: 0,
};

/**
 * One week's expected points from what he was given.
 *
 * Exported because the weekly figure is useful on its own — a single game's
 * `xFP` against its box score is how a fluky afternoon is recognised as one —
 * and because a per-game function is the honest unit to test.
 */
export function expectedPoints(position: string, week: UsageWeek, profile: ScoringProfile): { points: number; touchdowns: number } | null {
  const pos = position.toUpperCase();
  const targets = week.targets;
  const carries = week.carries;
  const attempts = pos === 'QB' ? week.passAttempts : null;
  if (targets == null && carries == null && attempts == null) return null;

  let points = 0;
  let touchdowns = 0;

  if (targets != null && targets > 0) {
    const rates = depthAdjustedRates(pos, targets, week.receivingAirYards ?? null);
    const receptions = targets * rates.catchRate;
    const yards = targets * rates.yardsPerTarget;
    const tds = targets * rates.tdPerTarget;
    points += receptions * (profile.ppr + (pos === 'TE' ? profile.teBonus : 0));
    points += yards * profile.pointsPerRecYard;
    points += tds * profile.recTd;
    touchdowns += tds;
  }

  if (carries != null && carries > 0) {
    const rush = RUSH_MODEL[pos] ?? RUSH_MODEL.RB!;
    points += carries * rush.yardsPerCarry * profile.pointsPerRushYard;
    points += carries * rush.tdPerCarry * profile.rushTd;
    touchdowns += carries * rush.tdPerCarry;
  }

  if (attempts != null && attempts > 0) {
    points += attempts * PASS_MODEL.yardsPerAttempt * profile.pointsPerPassYard;
    points += attempts * PASS_MODEL.tdPerAttempt * profile.passTd;
    touchdowns += attempts * PASS_MODEL.tdPerAttempt;
  }

  return { points: round2(points), touchdowns: round3(touchdowns) };
}

/**
 * What actually happened, in the same units.
 *
 * Reconstructed from stored volume rather than read from anybody's fantasy
 * total, for the same reason the rest of this app reconstructs it: the league's
 * scoring is known here and a third party's idea of a point is not. Null when
 * the week carries no production fields at all, which is not the same as a zero.
 */
export function actualPoints(position: string, week: UsageWeek, profile: ScoringProfile): { points: number; touchdowns: number } | null {
  const pos = position.toUpperCase();
  const fields = [week.receptions, week.recYards, week.recTds, week.rushYards, week.rushTds, week.passYards, week.passTds];
  if (fields.every((f) => f == null)) return null;

  const points =
    (week.receptions ?? 0) * (profile.ppr + (pos === 'TE' ? profile.teBonus : 0)) +
    (week.recYards ?? 0) * profile.pointsPerRecYard +
    (week.recTds ?? 0) * profile.recTd +
    (week.rushYards ?? 0) * profile.pointsPerRushYard +
    (week.rushTds ?? 0) * profile.rushTd +
    (week.passYards ?? 0) * profile.pointsPerPassYard +
    (week.passTds ?? 0) * profile.passTd;

  return {
    points: round2(points),
    touchdowns: round3((week.recTds ?? 0) + (week.rushTds ?? 0) + (week.passTds ?? 0)),
  };
}

/**
 * The season read: how much opportunity, how much production, and the gap.
 *
 * Regular season only and most-recent-window only, the same population the rest
 * of the usage layer works over, so two cards about the same player cannot be
 * describing two different sets of games.
 */
export function assessXfp(position: string, weeks: UsageWeek[], profile: ScoringProfile, window = 8): XfpAssessment {
  const pos = position.toUpperCase();
  const games = weeks
    .filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG')
    .sort((a, b) => a.week - b.week)
    .slice(-window);

  const perGame: XfpGame[] = [];
  let depthMeasured = false;
  for (const week of games) {
    const expected = expectedPoints(pos, week, profile);
    if (expected == null) continue;
    if (week.receivingAirYards != null && (week.targets ?? 0) > 0) depthMeasured = true;
    const actual = actualPoints(pos, week, profile);
    perGame.push({
      week: week.week,
      xfp: expected.points,
      actual: actual?.points ?? null,
      fpoe: actual == null ? null : round2(actual.points - expected.points),
      tdOverExpectation: actual == null ? null : round2(actual.touchdowns - expected.touchdowns),
    });
  }

  if (perGame.length < XFP.minGames) {
    return { ...NO_XFP, games: perGame.length, perGame, depthMeasured };
  }

  const xfpPerGame = round2(mean(perGame.map((g) => g.xfp)));
  const withActual = perGame.filter((g) => g.actual != null);
  const actualPerGame = withActual.length === 0 ? null : round2(mean(withActual.map((g) => g.actual!)));
  const fpoePerGame = actualPerGame == null ? null : round2(actualPerGame - xfpPerGame);
  const tdOverPerGame =
    withActual.length === 0 ? null : round2(mean(withActual.map((g) => g.tdOverExpectation ?? 0)));

  const confidence: 'high' | 'medium' | 'low' =
    perGame.length >= XFP.strongGames && depthMeasured ? 'high' : perGame.length >= XFP.strongGames ? 'medium' : 'medium';

  const interpretation = interpret(pos, xfpPerGame, fpoePerGame, tdOverPerGame);
  const gap = fpoePerGame == null ? '' : `${fpoePerGame > 0 ? '+' : ''}${fpoePerGame.toFixed(1)} vs expected`;

  return {
    games: perGame.length,
    xfpPerGame,
    actualPerGame,
    fpoePerGame,
    tdOverExpectationPerGame: tdOverPerGame,
    interpretation,
    label: XFP_LABEL[interpretation],
    display:
      actualPerGame == null
        ? `${xfpPerGame.toFixed(1)} expected pts/game from opportunity`
        : `${actualPerGame.toFixed(1)} actual vs ${xfpPerGame.toFixed(1)} expected · ${gap}`,
    driver: driverFor(interpretation, xfpPerGame, fpoePerGame, tdOverPerGame),
    confidence,
    depthMeasured,
    perGame,
    points: 0,
  };
}

/**
 * Which of the four readings this is.
 *
 * Order matters, and it is the order of what a person would say first. A player
 * beating his opportunity on touchdowns is a regression story before he is an
 * efficiency story, because the touchdowns are the part that will stop. A player
 * whose opportunity is genuinely startable and whose box score is not is a
 * *buy* rather than a *bust*, and that distinction is the whole reason the two
 * negative readings are separate.
 */
function interpret(
  position: string,
  xfpPerGame: number,
  fpoePerGame: number | null,
  tdOverPerGame: number | null,
): XfpInterpretation {
  if (fpoePerGame == null) return 'insufficient_data';

  if (fpoePerGame >= XFP.material) {
    if ((tdOverPerGame ?? 0) >= XFP.materialTdOverExpectation) return 'td_regression_risk';
    return 'production_outrunning_opportunity';
  }

  if (fpoePerGame <= -XFP.material) {
    // Startable opportunity with a bad box score is the reading that changes a
    // waiver claim; the same gap on a bench-level role is just a bad player.
    const startable = STARTABLE_XFP[position] ?? STARTABLE_XFP.WR!;
    return xfpPerGame >= startable ? 'role_healthy_despite_box_score' : 'usage_stronger_than_results';
  }

  return 'matched';
}

/**
 * Expected points at which a role is a startable one, by position.
 *
 * The same idea as `OPPORTUNITY_BASELINE` in `usageTrend.ts` and deliberately
 * not the same numbers: that table is in targets and carries, this one is in
 * points, and converting between them would tie two approximations together so
 * that retuning either quietly moves the other.
 */
export const STARTABLE_XFP: Record<string, number> = { QB: 16, RB: 10, WR: 9, TE: 7 };

function driverFor(
  interpretation: XfpInterpretation,
  xfpPerGame: number,
  fpoePerGame: number | null,
  tdOverPerGame: number | null,
): string | null {
  const gap = fpoePerGame == null ? '0.0' : Math.abs(fpoePerGame).toFixed(1);
  switch (interpretation) {
    case 'td_regression_risk':
      return `Scoring above what the volume expects · ${(tdOverPerGame ?? 0).toFixed(2)} touchdowns per game over expectation`;
    case 'production_outrunning_opportunity':
      return `Beating his opportunity by ${gap} pts a game · efficiency, not role`;
    case 'role_healthy_despite_box_score':
      return `The role is worth ${xfpPerGame.toFixed(1)} pts a game · the box score is ${gap} behind it`;
    case 'usage_stronger_than_results':
      return `Producing ${gap} pts a game below his opportunity, and the opportunity is thin`;
    default:
      return null;
  }
}

/**
 * Catch rate, yards and scoring per target at this player's own target depth.
 *
 * Falls back to the position's average depth when air yards are missing, which
 * the assessment records as `depthMeasured: false` rather than passing off an
 * assumption as a measurement.
 */
export function depthAdjustedRates(
  position: string,
  targets: number,
  airYards: number | null,
): { catchRate: number; yardsPerTarget: number; tdPerTarget: number } {
  const base = TARGET_MODEL[position] ?? TARGET_MODEL.WR!;
  const adot = airYards == null || targets <= 0 ? base.adot : airYards / targets;
  const delta = adot - base.adot;
  return {
    catchRate: bound(base.catchRate + delta * DEPTH_SLOPE.catchRatePerYard, RATE_BOUNDS.catchRate),
    yardsPerTarget: bound(base.yardsPerTarget + delta * DEPTH_SLOPE.yardsPerTargetPerYard, RATE_BOUNDS.yardsPerTarget),
    tdPerTarget: bound(base.tdPerTarget + delta * DEPTH_SLOPE.tdPerTargetPerYard, RATE_BOUNDS.tdPerTarget),
  };
}

function bound(value: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, value));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
