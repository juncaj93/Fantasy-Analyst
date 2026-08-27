/**
 * What version of the defence reasoning produced a plan.
 *
 * Composed on the start/sit engine, because a defence is projected by it like
 * any other player — `assemble.ts` runs `evaluatePlayer` over the rostered and
 * available defences before the planner ever sees them.
 *
 * Bump the head — `dst@N` — when a change to `core/dst/` could move a
 * Stream / Hold / Stash decision, a projected gain or the bar it has to clear
 * for unchanged evaluations: the hold horizon, the streaming threshold, the
 * outlook's anchor rules, the bench-cost model, the playoff emphasis.
 *
 * Not for a comment, a rename or a new diagnostic field. See
 * `core/draft/version.ts` for the full argument.
 */

import { composeEngineVersion } from '../engineVersion.ts';
import { STARTSIT_ENGINE_VERSION } from '../startsit/version.ts';

export const DST_ENGINE_VERSION = composeEngineVersion('dst@1', STARTSIT_ENGINE_VERSION);
