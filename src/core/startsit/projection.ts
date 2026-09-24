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
 *  3. otherwise this league's own imported preseason season total over
 *     {@link EXPECTED_GAMES};
 *  4. otherwise null, rendered as `—`.
 *
 * **The fallback is display-only.** It does not enter the start/sit ranking, the
 * matchup simulation, the draft score, the trade engine or any other
 * recommendation this app makes. Those all read {@link marketProjection}, which
 * knows nothing about tiers 2 and 3 and cannot be made to — neither is an
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
 * this design exists to prevent, and an August season total shown as a forecast
 * of Sunday is the second.
 *
 * ## Why the third tier is here and not in one screen
 *
 * It was written in `core/matchup/build.ts` on 15 September 2026, as a private
 * `projectionFor`, and for a week the Matchup screen was the only place that
 * could reach it. What that produced is the bug this file was moved here to
 * prevent, in a new place: on 22 September 2026 a Compare sheet showed Trey
 * McBride as `unknown` Vegas, 0% coverage and a paragraph of grey caveat, while
 * this league's own snapshot held 183.7 preseason points for him under exactly
 * its own scoring key — 11.5 a week. Matchup had three tiers, Team had two, and
 * Compare had one, for the same player in the same session.
 *
 * So the ladder is one function again, and `projectionFor` delegates to it. A
 * screen may decline to show a tier; it may not have a different ladder.
 *
 * Still not to be confused with the **whole** of StartWho's Preseason PTS as the
 * draft board reads it — that is a season-long ranking input answering a
 * different question. What crosses into this file is one number per player,
 * passed in by a caller, divided once. Nothing here imports the snapshot, the
 * repository or the import parser, and nothing in it may.
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

/*
 * One constant, and the reason it is an import rather than a `16` typed here:
 * `core/trades/arbitrage.ts` divides the same total for the same reason, and a
 * second copy would drift the moment either was tuned. `core/nfl/` holds facts
 * about the National Football League and imports nothing itself, so this costs
 * the leaf nothing — see its own header.
 */
import { EXPECTED_GAMES } from '../nfl/expectedGames.ts';

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
  expectation?: { points: number | null; missingMarkets?: readonly string[] } | null;
  /** The scored components. Absent means the availability charge cannot be found. */
  components?: { key: string; value: number; unknown: boolean }[];
}

/**
 * Where a displayed projection came from.
 *
 * `market` is this app's own, derived from betting lines under the league's
 * scoring. `sleeper` is Rotowire's published weekly number, distributed by
 * Sleeper, shown only where this app has nothing. `preseason` is this league's
 * own imported season total over {@link EXPECTED_GAMES} — not a weekly forecast
 * at all, and the weakest of the three. Every one of them must be named wherever
 * it is drawn.
 */
export type ProjectionSource = 'market' | 'sleeper' | 'preseason';

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
 * **This answers "is there a market", not "is it the whole week".** A player
 * with one of his position's four markets gets a number here — `evaluatePlayer`
 * sums whatever was posted — and that is deliberate: it is the definition the
 * trade engine's "priced" gate is built on, and it must not move. Whether the
 * number is complete is {@link marketIsComplete}'s question, and the display
 * ladder and the lineup ranking ask it; see {@link completeMarketProjection}.
 *
 * ## It is the market expectation, and nothing added to it
 *
 * This used to return `score` with the availability penalty taken back out,
 * which is a different number: `score` is the market expectation **plus every
 * bounded nudge the engine applies** — news, usage, role, game script, weather,
 * the matchup, uncertainty. Measured on production on 16 September 2026:
 *
 *     Mark Andrews   market 5.40  ->  printed 6.77   (+25%)
 *     Jayden Reed    market 4.81  ->  printed 5.79   (+20%)
 *     Bijan Robinson market 15.9  ->  printed 19.0   (+19%)
 *
 * The owner reported it from the other end: the Team row said 19.0 and the
 * player's own card said 15.9, and the gap looked enough like an average of
 * this app's number and Rotowire's to be worth asking about. It was not an
 * average — nothing here has ever read Rotowire — it was this app quietly
 * adding a fifth to a betting line and printing the result as a forecast.
 *
 * The nudges are a *ranking* device. They are bounded, they are measured in
 * ones and twos, and they exist so two players a market prices alike can still
 * be told apart. None of them was fitted to predict points. Adding them to a
 * market line and printing the total is precisely the unvalidated arithmetic
 * this same file refuses to perform on Rotowire's number, done to our own.
 *
 * So the projection is the expectation. `score` keeps the nudges and keeps
 * doing the ranking, which is what it was built for; the two numbers now answer
 * the two different questions they were always meant to.
 *
 * The availability penalty needs no unwinding any more — it was never in the
 * expectation — and the reasoning behind removing it still holds: a
 * Questionable player's designation is on his own row, so charging him for it
 * inside the projection too would say it twice.
 */
export function marketProjection(evaluation: ProjectableEvaluation | null | undefined): number | null {
  const points = evaluation?.expectation?.points;
  if (points == null || !Number.isFinite(points)) return null;
  return Math.max(0, Math.round(points * 100) / 100);
}

/**
 * Whether every market this player's position is priced on is in the number.
 *
 * ## Why a market number can be real and still not be a forecast
 *
 * `buildExpectation` sums whichever markets a book has posted, so a player with
 * one of four is still handed a total — and until 24 September 2026 that total
 * was printed as though it were the whole week. Measured on production that
 * morning, from a Patriots snapshot bought on the Tuesday before most of the
 * board was up:
 *
 *     Rhamondre Stevenson   0.75   anytime TD only      the full board: 8.79
 *     TreVeyon Henderson    0.69   anytime TD only      the full board: 7.76
 *     Drake Maye           11.19   no passing-TD line   the full board: 20.21
 *
 * Every one of those is a real betting line, correctly converted, and every one
 * of them is a fraction of the player's week. A partial sum is not a
 * conservative estimate, it is a different quantity — and nothing on the screen
 * could tell it apart from a complete one.
 *
 * Absent `missingMarkets` counts as complete, so a caller carrying a reduced
 * view of an evaluation is not quietly demoted. A defence's expectation always
 * carries an empty list: its one number is its game line, which is either there
 * or not.
 */
export function marketIsComplete(evaluation: ProjectableEvaluation | null | undefined): boolean {
  return (evaluation?.expectation?.missingMarkets?.length ?? 0) === 0;
}

/**
 * {@link marketProjection}, but only when the market is the whole of the week.
 *
 * The number the *display* ladder and the lineup's ranking read. It is not
 * what the trade engine reads: `core/trades` asks {@link marketProjection}
 * whether a player is priced at all, and a partial market is still a market
 * there. See `tests/tradeIsolation.partialMarket.test.ts`.
 */
export function completeMarketProjection(evaluation: ProjectableEvaluation | null | undefined): number | null {
  return marketIsComplete(evaluation) ? marketProjection(evaluation) : null;
}

/**
 * The number a screen may print under the word "projected", and its source.
 *
 * The whole hierarchy, in one place: this app's market-derived projection first,
 * the published fallback second, this league's preseason season total over a
 * season of games third, unknown fourth. Callers pass whichever of the two
 * borrowed figures they hold and `null` for the rest; passing either can never
 * displace a market projection, and omitting both reduces this to {@link
 * marketProjection} with provenance attached.
 *
 * Both fallbacks are quoted **exactly as stored**. No availability penalty is
 * taken off either and no adjustment is added to them — this app's bounded
 * nudges were fitted to this app's own base, and applying them to somebody
 * else's model would be arithmetic nobody has validated on a number nobody here
 * computed. It is also why there is nothing here that could double-count: a
 * lower tier is not combined with a higher one, it replaces it.
 *
 * The third tier is the weakest claim in the app and the caller has to be able
 * to say so on screen, which is what `source: 'preseason'` is for: it is an
 * August opinion of a whole season, flattened, with no account of who the
 * player faces on Sunday or whether he is still the starter. It beats a dash
 * for the same reason tier 2 does — a reader with no number cannot weigh
 * anything — and it must never be drawn as though it were a forecast of this
 * week. See `.matchup-player-proj-estimated` and `.compare-cell-preseason`.
 */
export function weeklyProjection(
  evaluation: ProjectableEvaluation | null | undefined,
  published?: number | null,
  preseasonSeasonTotal?: number | null,
): WeeklyProjection {
  /*
   * A partial market does not hold the first rung.
   *
   * It drops to the tiers below it, exactly as no market would, and when they
   * are empty too the answer is unknown rather than the partial sum. The
   * alternative was to keep the real lines and fill the missing ones from
   * Rotowire, and it is not available: the feed this app stores is a single
   * total per player, so there is no Rotowire touchdown figure to borrow
   * without inventing one — and adding two models' components together is the
   * unvalidated arithmetic this file already refuses. See `marketIsComplete`.
   */
  const market = completeMarketProjection(evaluation);
  if (market != null) return { points: market, source: 'market' };
  if (published != null && Number.isFinite(published)) {
    return { points: Math.max(0, Math.round(published * 100) / 100), source: 'sleeper' };
  }
  /*
   * A season total over the games a healthy starter plays, and never over the
   * games *this* one has played: the second reading of "average over games"
   * makes a week-one projection three hundred points and would have looked
   * like a feature right up until somebody read the screen.
   *
   * Zero and negative totals are refused rather than clamped. A stored zero is
   * a player the import could not price, not a player projected for nothing,
   * and passing it on as 0.0 would relabel a gap as a forecast.
   */
  if (
    preseasonSeasonTotal != null &&
    Number.isFinite(preseasonSeasonTotal) &&
    preseasonSeasonTotal > 0
  ) {
    return {
      points: Math.round((preseasonSeasonTotal / EXPECTED_GAMES) * 100) / 100,
      source: 'preseason',
    };
  }
  return UNKNOWN;
}
