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
 * projection *from this app* — see {@link marketProjection}, which is the number
 * every engine in the codebase reads and the only one any of them may read.
 *
 * ## The published fallback, and the line it must not cross
 *
 * The rule above left Team drawing a column of dashes for as long as no betting
 * market has priced the week, which through August 2026 was every player on
 * every roster. Sleeper publishes a weekly projection feed — Rotowire's model,
 * distributed by Sleeper — and the product decision is to show it when this app
 * has nothing of its own, under a strict order:
 *
 *  1. this app's market-derived projection, whenever a market exists;
 *  2. otherwise Rotowire-via-Sleeper's published weekly projection;
 *  3. otherwise null, rendered as `—`.
 *
 * **The fallback is display-only.** It does not enter the start/sit ranking, the
 * matchup simulation, the draft score, the trade engine or any other
 * recommendation this app makes. Those all read {@link marketProjection}, which
 * knows nothing about tier 2 and cannot be made to — the fallback is not an
 * argument it takes. That separation is enforced by the shape of these two
 * functions rather than by a comment, because a comment is not a compiler.
 *
 * The reason is not squeamishness. A recommendation built on somebody else's
 * model is a recommendation this app cannot explain, defend or calibrate, and
 * every engine here is built to show its working. Quoting a number and standing
 * behind a number are different acts, and only the first one is on offer.
 *
 * **Provenance travels with the number.** {@link weeklyProjection} never returns
 * a bare figure: it returns the figure and where it came from, so a caller
 * physically cannot render one without having been told the other. A Rotowire
 * number displayed as though it came from betting markets is the single failure
 * this design exists to prevent.
 *
 * Not to be confused with StartWho's **Preseason PTS**, which is a season-long
 * baseline from a different feed answering a different question. Nothing in this
 * file reads it and nothing in it may.
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
 * Where a displayed projection came from.
 *
 * `market` is this app's own, derived from betting lines under the league's
 * scoring. `sleeper` is Rotowire's published weekly number, distributed by
 * Sleeper, shown only where this app has nothing — and it must be named wherever
 * it is drawn.
 */
export type ProjectionSource = 'market' | 'sleeper';

/** A projection and its provenance, which are never separated. */
export interface WeeklyProjection {
  points: number | null;
  /** Null exactly when `points` is null. */
  source: ProjectionSource | null;
}

/** The answer when nobody has priced him and nobody has published him. */
const UNKNOWN: WeeklyProjection = { points: null, source: null };

/**
 * **This app's own** weekly fantasy projection, or null when there is not one.
 *
 * The engine-facing number, and the only projection any recommendation is
 * allowed to be built on. Null is a real answer and the caller must treat it as
 * one. Zero is not a substitute: a player projected zero is a prediction, and a
 * player nobody has priced is a gap in coverage, and the two must never look the
 * same.
 *
 * "Sufficient market coverage" is not re-decided here. `evaluatePlayer` already
 * refuses to publish an expectation it cannot stand behind — it returns
 * `points: null` when the markets it needs are missing — so this reads that
 * decision rather than inventing a second threshold that could disagree with it.
 */
export function marketProjection(evaluation: ProjectableEvaluation | null | undefined): number | null {
  if (!evaluation || evaluation.score == null) return null;
  if (evaluation.expectation?.points == null) return null;

  const availability = (evaluation.components ?? []).find((c) => c.key === 'status');
  const penalty = availability && !availability.unknown ? availability.value : 0;
  return Math.max(0, Math.round((evaluation.score - penalty) * 100) / 100);
}

/**
 * The number a screen may print under the word "projected", and its source.
 *
 * The whole hierarchy, in one place: this app's market-derived projection first,
 * the published fallback second, unknown third. Callers pass the published
 * figure for this player if they have one and `null` if they do not; passing one
 * can never displace a market projection, and omitting the argument entirely
 * reduces this to {@link marketProjection} with provenance attached.
 *
 * The fallback is quoted **exactly as published**. No availability penalty is
 * taken off it and no adjustment is added to it — this app's bounded nudges were
 * fitted to this app's own base, and applying them to somebody else's model
 * would be arithmetic nobody has validated on a number nobody here computed. It
 * is also why there is nothing here that could double-count: tier 2 is not
 * combined with tier 1, it replaces it.
 */
export function weeklyProjection(
  evaluation: ProjectableEvaluation | null | undefined,
  published?: number | null,
): WeeklyProjection {
  const market = marketProjection(evaluation);
  if (market != null) return { points: market, source: 'market' };
  if (published != null && Number.isFinite(published)) {
    return { points: Math.max(0, Math.round(published * 100) / 100), source: 'sleeper' };
  }
  return UNKNOWN;
}
