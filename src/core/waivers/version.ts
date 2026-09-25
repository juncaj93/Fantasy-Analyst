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

/*
 * `waiver@2`: the board answers three questions rather than one.
 *
 * A bench-value tier and an unscorable tier both reach the claim planner, and
 * the planner's own `minNetGain` is now actually reachable — so a league whose
 * inputs have not changed at all can get different claims, in a different
 * order, at different prices. That is exactly what the head of this string is
 * for.
 */
/*
 * `waiver@3`: positions have a depth policy, and attention is a tie-break.
 *
 * A slot position already at its cap (QB, TE, K, DEF) is measured against its
 * own weakest player at the upgrade bar, with one such add per position; a
 * running back leans ahead of a close receiver; Sleeper's trending adds lift a
 * borderline call and break a near-tie; and a player at the top of the adds
 * list is not offered as a cut. See `core/waivers/depthPolicy.ts`.
 */
/*
 * `waiver@4`: the two cut protections are one market hold, and its draft
 * condition is the league's starter pool rather than a fixed pick 80.
 */
export const WAIVER_ENGINE_VERSION = composeEngineVersion('waiver@4', LINEUP_ENGINE_VERSION, DST_ENGINE_VERSION);
