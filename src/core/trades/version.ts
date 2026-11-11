/**
 * What version of the trade reasoning produced an offer.
 *
 * Composed on the lineup optimiser rather than on the evaluator alone, because
 * objective trade value in this app *is* a lineup difference: `rosterUtility.ts`
 * runs the optimiser over a roster with and without a player, and the gap is
 * what the player is worth to that team. A change to the assignment or to the
 * evaluator moves every value on both sides of every offer.
 *
 * Bump the head — `trade@N` — when a change to `core/trades/` could move a
 * surfaced offer, its ranking, its verdict or its value components for
 * unchanged evaluations: the search bounds, the viability rules, the manager-fit
 * model, the consolidation rules, the value split.
 *
 * Not for a comment, a rename or a new diagnostic field. See
 * `core/draft/version.ts` for the full argument.
 */

import { composeEngineVersion } from '../engineVersion.ts';
import { LINEUP_ENGINE_VERSION } from '../startsit/version.ts';

/**
 * `trade@4`, 23 October 2026: this week's availability is Team's rule
 * (`core/injury/weekAvailability.ts`): a Questionable player is a whole game,
 * a Doubtful one his rate less six points. Later weeks keep their assumption.
 */
/**
 * `trade@5`, 4 November 2026 (review T1, T9): a player's trade rate is his
 * rest-of-season rate, half his projections (this week and the next three)
 * and half his season average, and a playoff week counts 1.5 times. The trade
 * ideas find, gate and rank on it, not on this week's lineup.
 */
/**
 * `trade@6`, 8 November 2026 (round 13): a Doubtful free agent is not part
 * of the replacement level (Doubtful is Out this week).
 */
/**
 * `trade@7`, 11 November 2026 (round 17): the rest-of-season rate is 75
 * percent projection and 25 percent season average (was 50/50). Trades has no
 * Sleeper-only discount of its own.
 */
/**
 * `trade@8`, 11 November 2026 (round 19): the trade ideas come from the trade
 * finder (`finder.ts`): every small deal screened, the best put through Check
 * a trade, at most three shown, fair to both sides or the closest labelled.
 */
export const TRADE_ENGINE_VERSION = composeEngineVersion('trade@8',LINEUP_ENGINE_VERSION);
