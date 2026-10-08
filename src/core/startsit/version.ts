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

/**
 * The player evaluator. Four surfaces read it; see the note above.
 *
 * `startsit@2`, 6 October 2026: everything except the market and availability
 * is held to a tenth of the market number, with smaller caps on news; see
 * `adjustmentBudget.ts`. Scores move for unchanged inputs, hence the bump. *
 * `startsit@3`, 8 October 2026: a touchdown over/under above 0.5 is converted
 * to the any-touchdown chance it implies (`touchdownLine.ts`) instead of being
 * read as one. Market numbers rise for unchanged inputs, hence the bump.
 */
export const STARTSIT_ENGINE_VERSION = 'startsit@3';

/**
 * The optimiser, and the weekly intelligence pass layered onto it.
 *
 * `lineup@2`, 24 September 2026: an empty slot is a fill rather than a swap,
 * a swap names only a starter the incoming player can legally replace, and a
 * player whose market is missing lines ranks on his published figure where
 * one exists. Scores are unchanged, which is why `startsit@1` is.
 *
 * `lineup@3`, 30 September 2026: a published figure ranks with the same
 * status, news, usage and matchup reads `score` carries, not bare, through
 * `decisionPoints`, which the Compare sheet now ranks on too. `score` itself
 * is unchanged, so `startsit@1` still is.
 */
export const LINEUP_ENGINE_VERSION = composeEngineVersion('lineup@3', STARTSIT_ENGINE_VERSION);
