/**
 * What version of the weekly reasoning produced an answer.
 *
 * Two strings, and the split matters. `STARTSIT_ENGINE_VERSION` is the player
 * evaluator — the components, their weights, the expectation model, the
 * availability read, the mode multipliers — and it is the foundation four
 * in-season surfaces stand on. `LINEUP_ENGINE_VERSION` is the optimiser above
 * it: the slot assignment, the swap threshold, the confidence and the late-swap
 * pass.
 *
 * They are separate because they move for different reasons and because a
 * snapshot should say which one moved. A change to how a Questionable player is
 * charged reorders every screen in the app; a change to the minimum swap gain
 * reorders the Team screen and nothing else.
 *
 * ## When to bump `STARTSIT_ENGINE_VERSION`
 *
 * When a change under `core/startsit/` could move a player's score or a
 * component's contribution for unchanged inputs: weights, calibration
 * constants, a new component, a changed formula, a changed tie-break. Not: a
 * comment, a rename, a new diagnostic field, a test.
 *
 * Bumping it moves the lineup, matchup, waiver, DST and trade versions with it,
 * because every one of them composes this string — see `core/engineVersion.ts`.
 * That is the whole reason it is composed rather than copied.
 *
 * ## When to bump `LINEUP_ENGINE_VERSION`'s own head
 *
 * When `lineup.ts` or `contracts/integration.ts`'s weekly pass could produce a
 * different lineup, a different swap list or a different confidence for
 * unchanged evaluations.
 *
 * See `core/draft/version.ts` for the argument that a git SHA does not replace
 * either of these.
 */

import { composeEngineVersion } from '../engineVersion.ts';

/** The player evaluator. Four surfaces read it; see the note above. */
export const STARTSIT_ENGINE_VERSION = 'startsit@1';

/** The optimiser, and the weekly intelligence pass layered onto it. */
export const LINEUP_ENGINE_VERSION = composeEngineVersion('lineup@1', STARTSIT_ENGINE_VERSION);
