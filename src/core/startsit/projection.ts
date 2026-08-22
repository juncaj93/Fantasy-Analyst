/**
 * The one number this app is allowed to print under the word "projected".
 *
 * ## Why this is not the start/sit score
 *
 * `evaluatePlayer` returns a `score`, and a score is not a projection. It is a
 * *comparable* number built to answer "start him or bench him", and it is the
 * sum of whichever components happened to be known — the Vegas market
 * expectation, plus a handful of bounded adjustments for news, usage, role,
 * game script, weather, the matchup and availability.
 *
 * The market expectation is the only one of those that is a forecast of a week
 * of football. Everything else is a nudge measured in ones and twos. So when
 * the market is missing, the engine still hands back a perfectly good *ranking*
 * score — and it is a ranking score made entirely of nudges, with no base
 * underneath it.
 *
 * Printed beside a player's name under the heading "Projected points", that
 * number is a lie of the most damaging kind: it is not obviously broken. On 22
 * August 2026 production showed `Jalen Hurts 3.15`, `Christian McCaffrey 1.35`
 * and `Malik Nabers -0.9`, against published week-one projections of 20.98,
 * 17.17 and 10.4. Every one of those was the sum of the news and availability
 * adjustments with the entire market base dropped as unknown, and every one of
 * them read as a considered forecast.
 *
 * **A projection therefore requires a market.** No market expectation, no
 * projection — the answer is null, and null is rendered as "unknown" rather
 * than as a number. That is the whole rule, and it is the difference between a
 * screen that says "we do not know" and a screen that says "he will score one
 * and a half".
 *
 * ## Why the availability penalty comes back out
 *
 * The engine charges a Questionable player points for being questionable. The
 * matchup model carries the same fact as a mixture over playing / playing
 * limited / not playing, and the Team screen prints his designation on his own
 * row. In every case availability is already expressed somewhere else, so
 * leaving it inside the projection too would charge him twice.
 *
 * ## Why it lives here rather than beside either screen
 *
 * It used to live in `core/matchup/build.ts`, which meant the Matchup screen
 * refused to show a projection it could not stand behind while the Team screen —
 * reading the raw score through a different path — showed one anyway, for the
 * same player, in the same session. One definition, in the layer that owns the
 * evaluation, is what stops two screens disagreeing about what a projection is.
 */

/**
 * The parts of an evaluation a projection is derived from.
 *
 * Structural rather than the full `StartSitEvaluation`, so the weekly card —
 * which carries a deliberately reduced view of an evaluation — can be projected
 * without being widened into the whole thing.
 */
export interface ProjectableEvaluation {
  score: number | null;
  /**
   * The market expectation. Optional because a caller may not carry it, and
   * **absent is treated exactly like null**: a projection this module cannot
   * confirm has a market underneath it is not a projection.
   */
  expectation?: { points: number | null } | null;
  /** The scored components. Absent means the availability charge cannot be found. */
  components?: { key: string; value: number; unknown: boolean }[];
}

/**
 * The weekly fantasy projection for one player, or null when there is not one.
 *
 * Null is a real answer and the caller must render it as one. Zero is not a
 * substitute: a player projected zero is a prediction, and a player nobody has
 * priced is a gap in coverage, and the two must never look the same.
 */
export function weeklyProjection(evaluation: ProjectableEvaluation | null | undefined): number | null {
  if (!evaluation || evaluation.score == null) return null;
  if (evaluation.expectation?.points == null) return null;

  const availability = (evaluation.components ?? []).find((c) => c.key === 'status');
  const penalty = availability && !availability.unknown ? availability.value : 0;
  return Math.max(0, Math.round((evaluation.score - penalty) * 100) / 100);
}
