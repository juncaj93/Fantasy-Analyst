/**
 * How much of what he has produced needed a touchdown to happen.
 *
 * Two players average fourteen points. One does it on ten targets and ninety
 * yards a game with no scores; the other on four targets, forty yards, and four
 * touchdowns in four weeks. They are not the same start, and the average that
 * makes them look identical is precisely the number a lineup screen should not
 * be reading.
 *
 * ## What is measured
 *
 * Yardage points against total points, both reconstructed from stored volume
 * rather than taken from anybody's fantasy total. A share of production that
 * came from the end zone is the dependency; the rest is the part that repeats.
 *
 * ## The mistake this must not make
 *
 * A goal-line back is *supposed* to score. Punishing him for touchdown
 * dependency would be punishing him for having the most valuable role on the
 * field. So dependency alone is never the verdict — it is read together with
 * whether the touchdowns look like a **role** or like **luck**:
 *
 *   - scoring in most weeks, on real volume, is a role. The dependency is
 *     reported and costs him nothing.
 *   - scoring in one or two weeks out of six, on thin volume, is luck. That is
 *     what the penalty is for.
 *
 * The app has no red-zone or goal-line touch data — no free source keyed to an
 * id space this project already resolves publishes it — so "role" is inferred
 * from **consistency of scoring plus volume** rather than asserted from
 * red-zone share. That is a weaker instrument than red-zone touches and it is
 * the honest one available; the limitation is stated on the card rather than
 * hidden in a threshold.
 */

import type { UsageWeek } from '../usage/role.ts';

export const TD_DEPENDENCY = {
  /** Games below which nothing is claimed. */
  minGames: 4,
  /** Share of production from touchdowns above which the profile is fragile. */
  dependent: 0.45,
  /** ...and below which it is emphatically not. */
  independent: 0.25,
  /** Share of games with a touchdown at or above which scoring looks like a role. */
  roleGameShare: 0.5,
  /** Points a fully touchdown-dependent, low-volume profile is docked. */
  penalty: -1.2,
  /** Points a strong, repeatable yardage profile is credited. */
  credit: 0.4,
  /** Touchdown value in fantasy points. Six for all skill scoring. */
  touchdownPoints: 6,
} as const;

export type TdProfile =
  | 'td_dependent_weak_opportunity'
  | 'td_driven_with_role'
  | 'balanced'
  | 'volume_driven'
  | 'insufficient_data';

export interface TdDependencyAssessment {
  profile: TdProfile;
  /** Share of reconstructed production that came from touchdowns, 0..1. */
  share: number | null;
  touchdowns: number;
  /** Games in which he scored at least one. */
  scoringGames: number;
  games: number;
  /** Points added to the Start/Sit score. Negative only for the fragile case. */
  points: number;
  display: string;
  driver: string | null;
}

export const NO_TD_DATA: TdDependencyAssessment = {
  profile: 'insufficient_data',
  share: null,
  touchdowns: 0,
  scoringGames: 0,
  games: 0,
  points: 0,
  display: 'no scoring data',
  driver: null,
};

/**
 * Reconstruct a week's fantasy points from stored volume.
 *
 * Yardage at the conventional rates, receptions ignored on purpose: PPR is a
 * league setting and this ratio must mean the same thing in every league, or a
 * full-PPR receiver would look less touchdown-dependent than the identical
 * player in a standard league. The question being asked — how much of this came
 * from the end zone — is about the player, not the scoring rules.
 */
function yardagePoints(week: UsageWeek): number | null {
  const pass = week.passYards;
  const rush = week.rushYards;
  const rec = week.recYards;
  if (pass == null && rush == null && rec == null) return null;
  return (pass ?? 0) / 25 + (rush ?? 0) / 10 + (rec ?? 0) / 10;
}

function touchdownsOf(week: UsageWeek): number | null {
  const values = [week.passTds, week.rushTds, week.recTds].filter((v): v is number => v != null);
  if (values.length === 0) return null;
  // A passing touchdown is worth two thirds of a rushing or receiving one in
  // ordinary scoring, and counting them the same would make every quarterback
  // look touchdown-dependent.
  return (week.rushTds ?? 0) + (week.recTds ?? 0) + (week.passTds ?? 0) * (4 / 6);
}

export function assessTdDependency(weeks: UsageWeek[], window = 8): TdDependencyAssessment {
  const games = weeks
    .filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG')
    .sort((a, b) => a.week - b.week)
    .slice(-window)
    .map((w) => ({ yards: yardagePoints(w), tds: touchdownsOf(w) }))
    .filter((g) => g.yards != null || g.tds != null);

  if (games.length < TD_DEPENDENCY.minGames) return { ...NO_TD_DATA, games: games.length };

  const yardage = games.reduce((total, g) => total + (g.yards ?? 0), 0);
  const touchdowns = games.reduce((total, g) => total + (g.tds ?? 0), 0);
  const scoringGames = games.filter((g) => (g.tds ?? 0) >= 1).length;
  const fromTds = touchdowns * TD_DEPENDENCY.touchdownPoints;
  const total = yardage + fromTds;

  if (total <= 0) {
    return {
      ...NO_TD_DATA,
      games: games.length,
      display: 'no production to attribute',
    };
  }

  const share = round3(fromTds / total);
  const yardsPerGame = round1(yardage / games.length);
  const scoresLikeARole = scoringGames / games.length >= TD_DEPENDENCY.roleGameShare;

  /*
   * The four outcomes, and which of them costs anything.
   *
   * Only the first does. A player who scores in most weeks is described, not
   * punished: the dependency is real and so is the role that produces it, and a
   * lineup screen that benched every goal-line back would be worse than one
   * with no touchdown model at all.
   */
  if (share >= TD_DEPENDENCY.dependent && !scoresLikeARole) {
    // Scaled by how far past the line he is, so the cliff is not a cliff.
    const severity = clamp01((share - TD_DEPENDENCY.dependent) / (1 - TD_DEPENDENCY.dependent));
    return {
      profile: 'td_dependent_weak_opportunity',
      share,
      touchdowns: round1(touchdowns),
      scoringGames,
      games: games.length,
      points: round2(TD_DEPENDENCY.penalty * (0.5 + 0.5 * severity)),
      display: `${Math.round(share * 100)}% of production from ${round1(touchdowns)} scores in ${scoringGames} of ${games.length} games`,
      driver: `TD-dependent · ${yardsPerGame} yardage points per game outside the scores`,
    };
  }

  if (share >= TD_DEPENDENCY.dependent) {
    return {
      profile: 'td_driven_with_role',
      share,
      touchdowns: round1(touchdowns),
      scoringGames,
      games: games.length,
      points: 0,
      display: `${Math.round(share * 100)}% of production from scores, in ${scoringGames} of ${games.length} games`,
      driver: `TD-driven with a scoring role · found the end zone in ${scoringGames} of ${games.length}`,
    };
  }

  if (share <= TD_DEPENDENCY.independent) {
    return {
      profile: 'volume_driven',
      share,
      touchdowns: round1(touchdowns),
      scoringGames,
      games: games.length,
      points: TD_DEPENDENCY.credit,
      display: `${Math.round(share * 100)}% of production from scores · ${yardsPerGame} yardage points per game`,
      driver: `Production does not need a touchdown · ${yardsPerGame} yardage points per game`,
    };
  }

  return {
    profile: 'balanced',
    share,
    touchdowns: round1(touchdowns),
    scoringGames,
    games: games.length,
    points: 0,
    display: `${Math.round(share * 100)}% of production from scores`,
    driver: null,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
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
