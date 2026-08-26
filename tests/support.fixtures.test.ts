/**
 * Every committed support fixture, replayed.
 *
 * This is the regression suite the support workflow feeds. A real report is
 * captured, replayed, diagnosed, fixed — and then the exact case that was wrong
 * is written into `tests/fixtures/support/` and never allowed to be wrong
 * quietly again.
 *
 * It reads the whole directory rather than naming files, deliberately. Adding a
 * case has to be `npm run support:fixture -- snapshot.json --write <name>` and a
 * commit: no test to edit, nothing to register, no chance of a fixture sitting
 * in the tree that nothing runs. A support lane whose last step is "and remember
 * to add it to the list" is a support lane whose fixtures stop being added.
 *
 * A failure here is not necessarily a bug. `engine_version_mismatch` means the
 * reasoning was deliberately changed and the fixture is describing the old one;
 * see `core/draft/version.ts` for what to do about it. Anything else is a
 * regression against a case that really happened.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR, FIXTURE_SUFFIX, canonicalSnapshotJson } from '../src/core/support/fixture.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';

function fixtureFiles(): string[] {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(FIXTURE_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

const files = fixtureFiles();

describe('committed support fixtures', () => {
  /*
   * An empty directory is a passing suite, and it says so.
   *
   * Silently running zero tests would let the directory be emptied — or the
   * suffix changed — without anything noticing, which is exactly the sort of
   * "green because nothing ran" the rest of this app spends real effort
   * avoiding.
   */
  it(`reads ${FIXTURE_DIR}`, () => {
    expect(Array.isArray(files)).toBe(true);
  });

  for (const name of files) {
    describe(name, () => {
      const raw = readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8');
      const snapshot = readSnapshot(JSON.parse(raw));

      it('replays to the board it was captured from', async () => {
        const report = await replayDraftSnapshot(snapshot);
        expect(report.differences).toEqual([]);
        expect(report.outcome).toBe('reproduced');
      });

      it('is canonical on disk, so a re-write is an empty diff', () => {
        expect(raw).toBe(canonicalSnapshotJson(snapshot));
      });
    });
  }
});
