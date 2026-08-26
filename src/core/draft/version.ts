/**
 * What version of the Draft reasoning produced a recommendation.
 *
 * One string, bumped by hand, and deliberately not a configuration platform.
 * It exists for exactly one caller: a support snapshot captured on one
 * deployment and replayed against a working copy that has moved on. Without it
 * a replay that disagrees is indistinguishable from a replay that disagrees
 * *because the engine changed*, and the first is a bug while the second is
 * Tuesday.
 *
 * ## When to bump it
 *
 * When a change to this directory could reorder a board or move a component's
 * contribution for unchanged inputs. That is: weights, calibration constants,
 * a new component, a changed formula, a changed tie-break. Not: a comment, a
 * rename, a new diagnostic field, a test.
 *
 * A bump is not a migration. Old snapshots stay replayable — the replay simply
 * reports `engine_version_mismatch` alongside whatever it found, so a reader
 * knows which of the two explanations is on the table before reading the diff.
 *
 * The git SHA does not replace this. A SHA says which commit was deployed and
 * changes on every commit, including the ones that change nothing here; this
 * says whether the *reasoning* moved, which is the question a replay is asking.
 */
export const DRAFT_ENGINE_VERSION = 'draft-engine@1';
