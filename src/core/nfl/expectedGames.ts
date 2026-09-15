/**
 * How many games a season-long projection is spread over.
 *
 * A leaf with one number in it, and it is a leaf because two modules now need
 * the same division for the same reason and a second copy of `16` would drift
 * the moment one of them was tuned. `core/trades/arbitrage.ts` divides a
 * preseason total to get the week a player was expected to have; `core/matchup
 * /build.ts` divides the same total to get a projection for a starter nobody
 * else has priced. Same number, same justification, one definition.
 *
 * ## Why it lives here
 *
 * It was written into `core/season/` first, and `infrastructureIsolation.test
 * .ts` rejected it in the same minute — correctly. That directory is season
 * resolution, rollover policy and cache keys, and the rule it enforces is that
 * nothing which decides anything about football may import the plumbing, so
 * that a Draft Score cannot start changing in March for reasons that have
 * nothing to do with the player.
 *
 * This is not plumbing. "A healthy starter plays sixteen of the seventeen" is
 * a fact about the National Football League, which is what `core/nfl/` holds,
 * beside the fixture list and the thirty-two clubs. The test caught a
 * misfiling rather than a design error, which is the whole reason it reads the
 * import graph instead of the behaviour.
 *
 * Nothing may be added here that imports anything — the matchup assembly must
 * not reach the trade engine to read a constant, which is the point of
 * splitting it out at all. See `core/trades/category.ts` for the perf-budget
 * failure that made this the house rule.
 */

/**
 * Sixteen, not seventeen.
 *
 * Seventeen is the schedule and is the wrong number: it charges every player
 * for a bye he has not reached and for the weeks he was hurt, both of which
 * make September look like underperformance. Sixteen is the ordinary count of
 * games a healthy starter actually plays, so the quotient is the week he was
 * expected to have rather than a share of a season he has not finished.
 */
export const EXPECTED_GAMES = 16;
