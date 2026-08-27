/**
 * What version of the waiver reasoning produced a claim plan.
 *
 * The most composed of the six, and honestly so: a claim plan is the lineup
 * optimiser (what the roster is worth now), the wire scan on top of it (what
 * each add would be worth), the defence planner beside it (which owns the DEF
 * row outright), and the pricing and ordering passes over the result. A
 * calibration change in any of them moves a bid, a drop or the order the claims
 * are entered in.
 *
 * `composeEngineVersion` de-duplicates, so the two paths this reaches
 * `startsit@1` by — through the lineup and through the defence planner — say it
 * once.
 *
 * Bump the head — `waiver@N` — when a change to `core/waivers/`,
 * `core/startsit/waivers.ts` or `core/faab/` could move a claim, a bid, a drop
 * or the claim order for unchanged inputs: the gain threshold, the pricing
 * model, the competition read, the contingency rules, the protection rules.
 *
 * Not for a comment, a rename or a new diagnostic field. See
 * `core/draft/version.ts` for the full argument.
 */

import { composeEngineVersion } from '../engineVersion.ts';
import { LINEUP_ENGINE_VERSION } from '../startsit/version.ts';
import { DST_ENGINE_VERSION } from '../dst/version.ts';

export const WAIVER_ENGINE_VERSION = composeEngineVersion('waiver@1', LINEUP_ENGINE_VERSION, DST_ENGINE_VERSION);
