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

export const TRADE_ENGINE_VERSION = composeEngineVersion('trade@1', LINEUP_ENGINE_VERSION);
