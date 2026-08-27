/**
 * Turning a real case into a regression fixture.
 *
 * The last step of the support workflow, and the one that makes the rest of it
 * worth doing. A snapshot diagnoses one report; a fixture stops that report
 * coming back. The conversion has to preserve the case exactly — a fixture that
 * is a *simplified* version of what the user saw would pass while the real
 * thing still failed, which is the failure mode this whole lane exists to end.
 *
 * ## Why the fixture is a snapshot, and not a new format
 *
 * The obvious design is a converter that reads a snapshot and writes a smaller,
 * test-shaped artifact. It is the wrong one. A second format needs a second
 * reader, a second validator and a second set of assumptions about what a board
 * needs, and every one of those is a place where the fixture and the real case
 * can quietly stop being the same thing.
 *
 * So a fixture *is* a snapshot: the same schema, the same reader, the same
 * replay. What conversion does is prove it and canonicalise it —
 *
 *   - **prove**: it is replayed before it is written, and a snapshot that does
 *     not reproduce is not committed as a fixture. A regression fixture whose
 *     expected output was never actually produced by this code is a test that
 *     asserts a guess;
 *   - **canonicalise**: keys are sorted at every depth and the file is written
 *     with a trailing newline, so the same case always produces the same bytes
 *     whatever build emitted it. That is what makes a fixture diffable in
 *     review and stable in git.
 *
 * The distillation the brief allows has already happened, at capture: the
 * player table is reduced to the players who can reach the answer, and the
 * arguments are bounded to the top of the board plus everybody the reader
 * marked. Doing it a second time here would mean a fixture that replays
 * something other than what was captured.
 *
 * ## What is worth committing, and what is not
 *
 * A fixture earns its place in git when **its inputs cannot be regenerated** —
 * a snapshot somebody sent in, of a league and a moment that exist nowhere
 * else. Several hundred kilobytes of JSON is a fair price for data that is
 * otherwise gone.
 *
 * A snapshot captured from a *demo scenario* is the opposite. `buildDraftScenario`
 * is deterministic and its fixtures are already committed under
 * `core/demo/fixtures/`, so such a file is byte-for-byte regenerable from code
 * in this same repository: eleven thousand lines of duplicate, whose only
 * non-duplicated content is an assertion that the engine produced that exact
 * board on the day it was written. That is golden-file testing, which this
 * repository does nowhere else — `audit.draftScore.test.ts` and
 * `tier-ordering.spec.ts` pin the *invariant* rather than the output, on
 * purpose. See the note at the top of `tests/support.fixtures.test.ts`.
 */

import type { SupportSnapshot } from './schema.ts';

/**
 * A snapshot as canonical JSON: keys sorted at every depth, two-space indent,
 * trailing newline.
 *
 * Arrays keep their order, always — an ordered board whose order was sorted
 * away would be a fixture that could not detect a reordering, which is the
 * first term of the reproduction contract.
 */
export function canonicalSnapshotJson(snapshot: SupportSnapshot): string {
  return `${JSON.stringify(sortKeys(snapshot), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value == null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, child]) => [key, sortKeys(child)]));
}

/**
 * Where a committed fixture lives, and what it is called.
 *
 * One directory, one suffix, and a test that reads the whole directory — so
 * adding a case to the regression suite is `--write <name>` and a commit, with
 * no test file to edit and nothing to remember to register. See
 * `tests/support.fixtures.test.ts`.
 */
export const FIXTURE_DIR = 'tests/fixtures/support';
export const FIXTURE_SUFFIX = '.snapshot.json';

/** `my-guy-not-moving` → `tests/fixtures/support/my-guy-not-moving.snapshot.json` */
export function fixturePath(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') throw new Error('a fixture needs a name made of letters or digits');
  return `${FIXTURE_DIR}/${slug}${FIXTURE_SUFFIX}`;
}
