/**
 * What a player is worth to hold, as opposed to what he is worth on Sunday.
 *
 * ## The bug this exists to end
 *
 * `held.ts` filled both `restOfSeasonValue` and `fourWeekValue` with
 * `evaluation.score` — **this week's projection**, in both fields, under two
 * names that promise a season and a month. Every consumer of a bench slot value
 * was therefore reading one week and believing it had read a horizon.
 *
 * The consequence is a specific and expensive one. A player who cannot play
 * this week projects at or near zero, so his standing worth collapses to zero,
 * so `dropCost.ts` ranks him as the cheapest cut on the roster — and a waiver
 * card offers to drop a second-round pick because he tweaked an ankle. Measured
 * on production on 16 September: a receiver taken at pick 39.8, questionable for
 * week 2, appeared as the drop in three of the four suggested claims.
 *
 * ## What replaces it
 *
 * Two readings of the same player, and a weight that moves between them as the
 * season accumulates evidence:
 *
 *   - **preseason**, the season total this league's own capture projected,
 *     divided by the games a healthy starter actually plays. In September it is
 *     the only durable number that exists, and it is a real one: it is the
 *     market's view of the player over a season, priced in this league's own
 *     scoring.
 *   - **in-season**, fantasy points actually scored per game played, from the
 *     stored weekly lines.
 *
 * In week 1 the first is everything, because the second does not exist. By week
 * six the second is everything, because a sixth of a season of real production
 * says more about a player than an August projection does. In between the
 * weight slides linearly, and {@link DURABLE_FULL_WEIGHT_GAMES} is the only
 * knob.
 *
 * That ordering is the whole design and it is deliberately not symmetric with
 * how the *lineup* is decided. This week's projection stays exactly where it
 * belongs — deciding who starts, and what the lineup loses if somebody is cut.
 * It simply stops being allowed to answer a question about the rest of the
 * season, which it was never able to answer.
 *
 * ## What it refuses to do
 *
 * Nothing here invents a number. A player with no preseason capture and no
 * stored week returns null, and the caller falls back to whatever it had
 * before. Roster percentage is not read, because Sleeper does not publish it.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { UsageWeek } from '../usage/role.ts';
import { EXPECTED_GAMES } from '../nfl/expectedGames.ts';

/**
 * Games of real production before in-season evidence carries the whole reading.
 *
 * Six. Below three, a per-game average is one good afternoon away from being a
 * different number, and an August projection built on a full prior season is
 * the steadier of the two; past six, the season is its own evidence and a
 * preseason ranking is a stale opinion. Linear in between rather than stepped,
 * so nobody's standing worth jumps the week a threshold is crossed.
 */
export const DURABLE_FULL_WEIGHT_GAMES = 6;

/**
 * Games the recent-form reading is measured over.
 *
 * Four, matching the four-week window the rest of this app uses, and weighted
 * by how many of those four actually exist. One game is a quarter of a reading,
 * not a whole one — which is the specific arithmetic that stops a single bad
 * afternoon from emptying a player's standing worth.
 */
export const RECENT_WINDOW_GAMES = 4;

export interface DurableValueInput {
  /**
   * The season total from this league's own preseason capture, or null.
   *
   * Already in this league's scoring — the snapshot is looked up by scoring
   * key, so a capture taken under other rules is absent rather than converted.
   */
  preseasonSeasonPoints: number | null;
  /** Stored weekly lines, in any order. Regular season only is filtered here. */
  weeks: readonly UsageWeek[];
  profile: ScoringProfile;
  /**
   * This week's projection, which is what the old behaviour used for everything.
   *
   * Kept as the last resort so a player with neither a capture nor a stored
   * week is valued exactly as he was before this module existed, rather than
   * dropping to null and becoming unrankable.
   */
  weekProjection: number | null;
}

export interface DurableValue {
  /** What he is worth per week over the rest of the season. */
  restOfSeason: number | null;
  /** The same, weighted towards the last four games. */
  fourWeek: number | null;
  gamesPlayed: number;
  preseasonPerGame: number | null;
  inSeasonPerGame: number | null;
  /** How much of {@link restOfSeason} is in-season evidence, 0–1. */
  inSeasonWeight: number;
  basis: 'preseason' | 'blended' | 'in_season' | 'week_projection' | 'unknown';
}

/**
 * One week's stored line, scored under this league's rules.
 *
 * Null when the row carries no scoreable volume at all, which is a row that
 * exists for some other reason rather than a game in which the player did
 * nothing — the two are different and only the second is a zero.
 *
 * **Interceptions and fumbles are not stored and are therefore not subtracted.**
 * That overstates a turnover-prone quarterback by a point or two a game and
 * every skill player by almost nothing. It is stated here rather than silently
 * absorbed, because the alternative — estimating turnovers from nothing — would
 * put an invented number inside a valuation.
 */
export function scoreUsageWeek(week: UsageWeek, profile: ScoringProfile): number | null {
  const fields = [week.passYards, week.passTds, week.rushYards, week.rushTds, week.recYards, week.recTds, week.receptions];
  if (fields.every((v) => v == null)) return null;

  const receptions = week.receptions ?? 0;
  const points =
    (week.passYards ?? 0) * profile.pointsPerPassYard +
    (week.passTds ?? 0) * profile.passTd +
    (week.rushYards ?? 0) * profile.pointsPerRushYard +
    (week.rushTds ?? 0) * profile.rushTd +
    (week.recYards ?? 0) * profile.pointsPerRecYard +
    (week.recTds ?? 0) * profile.recTd +
    receptions * profile.ppr;

  return round2(points);
}

/** The regular-season weeks that carry a scoreable line, oldest first. */
function scoredWeeks(weeks: readonly UsageWeek[], profile: ScoringProfile): { week: number; points: number }[] {
  return weeks
    .filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG')
    .map((w) => ({ week: w.week, points: scoreUsageWeek(w, profile) }))
    .filter((w): w is { week: number; points: number } => w.points != null)
    .sort((a, b) => a.week - b.week);
}

export function durableValue(input: DurableValueInput): DurableValue {
  const { profile, preseasonSeasonPoints, weekProjection } = input;

  /*
   * A season total over the games a healthy starter plays, not over the games
   * this one has played. Dividing 288 points by one September appearance is a
   * week-one projection of 288 points, and `EXPECTED_GAMES` is the constant
   * that already exists for exactly this division — see `core/nfl/expectedGames.ts`.
   */
  const preseasonPerGame =
    preseasonSeasonPoints != null && Number.isFinite(preseasonSeasonPoints)
      ? round2(preseasonSeasonPoints / EXPECTED_GAMES)
      : null;

  const played = scoredWeeks(input.weeks, profile);
  const gamesPlayed = played.length;
  const inSeasonPerGame =
    gamesPlayed > 0 ? round2(played.reduce((sum, w) => sum + w.points, 0) / gamesPlayed) : null;

  const recent = played.slice(-RECENT_WINDOW_GAMES);
  const recentPerGame =
    recent.length > 0 ? round2(recent.reduce((sum, w) => sum + w.points, 0) / recent.length) : null;

  /*
   * The slide. Nought at kickoff of week one, one from the sixth game on.
   *
   * Capped at the count of games that exist, so a player who has missed four
   * weeks is not credited with four weeks of evidence he did not produce.
   */
  const inSeasonWeight = Math.min(gamesPlayed, DURABLE_FULL_WEIGHT_GAMES) / DURABLE_FULL_WEIGHT_GAMES;

  /*
   * The recent window is weighted by how much of it exists as well as by the
   * slide, because one game is a quarter of a four-game reading. This is the
   * arithmetic that stops a single bad afternoon carrying a player's whole
   * standing worth: at week two it is worth a quarter of the faster half of a
   * blend that is itself still mostly August.
   */
  const recentWeight = inSeasonWeight * Math.min(recent.length, RECENT_WINDOW_GAMES) / RECENT_WINDOW_GAMES;

  const blend = (value: number | null, weight: number): number | null => {
    if (value == null) return preseasonPerGame;
    if (preseasonPerGame == null) return value;
    return round2(weight * value + (1 - weight) * preseasonPerGame);
  };

  const restOfSeason = blend(inSeasonPerGame, inSeasonWeight);
  const fourWeek = blend(recentPerGame, recentWeight);

  const basis: DurableValue['basis'] =
    preseasonPerGame != null && inSeasonPerGame != null
      ? 'blended'
      : preseasonPerGame != null
        ? 'preseason'
        : inSeasonPerGame != null
          ? 'in_season'
          : weekProjection != null
            ? 'week_projection'
            : 'unknown';

  /*
   * Neither source exists, so the old behaviour stands: this week's projection,
   * under both names. A rookie nobody captured and nobody has seen play is
   * exactly the player this app understands least, and inventing a durable
   * number for him would be worse than the week number it replaces.
   */
  if (restOfSeason == null) {
    return {
      restOfSeason: weekProjection,
      fourWeek: weekProjection,
      gamesPlayed,
      preseasonPerGame,
      inSeasonPerGame,
      inSeasonWeight,
      basis,
    };
  }

  return {
    restOfSeason,
    fourWeek: fourWeek ?? restOfSeason,
    gamesPlayed,
    preseasonPerGame,
    inSeasonPerGame,
    inSeasonWeight,
    basis,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
