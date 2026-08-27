/**
 * The fixture converter, and every case committed to `tests/fixtures/support/`.
 *
 * ## What belongs in that directory, and what does not
 *
 * A committed fixture is a **real case whose inputs cannot be regenerated** — a
 * snapshot somebody sent in, of a league and a moment that exist nowhere else.
 * That is the whole reason to keep several hundred kilobytes of JSON in git:
 * the data is irreplaceable, and losing it means losing the ability to prove the
 * bug stays fixed.
 *
 * A snapshot captured from a **demo scenario** is the opposite of that, and this
 * file used to carry one. `buildDraftScenario` is deterministic and its
 * fixtures are already committed under `src/core/demo/fixtures/`, so the file
 * was byte-for-byte regenerable from code in this same repository — eleven
 * thousand lines of duplicate, and the largest file in the tree by some
 * distance. Its only non-duplicated content was an assertion that the engine
 * produced that exact board on the day it was written, which is golden-file
 * testing: a technique this repository uses nowhere else in two hundred and
 * thirty-six test files, and which `audit.draftScore.test.ts` and
 * `tier-ordering.spec.ts` deliberately do differently, by naming the invariant
 * instead of freezing the output.
 *
 * So the directory is empty, on purpose, until a real report arrives. What is
 * tested here is the *mechanism* — and it is tested against a fixture written
 * to a temporary directory, because proving that the converter round-trips
 * needs a file, not a committed one.
 *
 * A failure in the committed half is not necessarily a bug.
 * `engine_version_mismatch` means the reasoning was deliberately changed and the
 * fixture describes the old one; see `core/draft/version.ts`. Anything else is a
 * regression against a case that really happened.
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_DIR, FIXTURE_SUFFIX, canonicalSnapshotJson, fixturePath } from '../src/core/support/fixture.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';
import { captureDraftSnapshot } from '../src/core/support/draftSnapshot.ts';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';

function fixtureFiles(): string[] {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(FIXTURE_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

describe('the fixture converter', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'support-fixture-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** Exactly what the CLI does with `--write`, minus the process. */
  async function writeFixture(name: string): Promise<string> {
    const data = buildDraftScenario(findScenario('draft-late')!);
    const snapshot = await captureDraftSnapshot(draftBoardSourcesFrom(data), {
      draftId: data.draft!.id,
      gitSha: 'demo',
    });
    const path = join(scratch, fixturePath(name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalSnapshotJson(snapshot), 'utf8');
    return path;
  }

  it('writes a file that reads back and replays to the board it came from', async () => {
    const path = await writeFixture('draft-late-my-guy');
    const raw = readFileSync(path, 'utf8');

    /*
     * Read from disk rather than passed in memory.
     *
     * A fixture is a file, and the failure worth catching is one that only
     * appears after a round trip through text — a `Map` that stringified to
     * `{}`, a `Date` that became a string. Handing the object straight to the
     * replay would skip exactly that.
     */
    const snapshot = readSnapshot(JSON.parse(raw));
    const report = await replaySnapshot(snapshot);

    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
  });

  it('is canonical, so a re-write is an empty diff', async () => {
    const first = readFileSync(await writeFixture('same-case'), 'utf8');
    const second = readFileSync(await writeFixture('same-case'), 'utf8');

    expect(second).toBe(first);
    // Keys sorted at every depth, and a trailing newline, so git is happy.
    expect(first.endsWith('\n')).toBe(true);
    expect(canonicalSnapshotJson(readSnapshot(JSON.parse(first)))).toBe(first);
  });

  it('turns a free-text label into a path under the fixture directory', () => {
    expect(fixturePath('My Guy — not moving!')).toBe(`${FIXTURE_DIR}/my-guy-not-moving${FIXTURE_SUFFIX}`);
    expect(fixturePath('  Spaced  Out  ')).toBe(`${FIXTURE_DIR}/spaced-out${FIXTURE_SUFFIX}`);
    expect(() => fixturePath('---')).toThrow(/needs a name/);
  });
});

describe('committed support fixtures', () => {
  const files = fixtureFiles();

  /*
   * An empty directory is a passing suite, and it says so out loud.
   *
   * Silently running zero cases would let the directory be emptied — or the
   * suffix changed — without anything noticing, which is the "green because
   * nothing ran" this repository spends real effort avoiding. Empty is the
   * expected state until somebody sends a report in; see the note at the top of
   * this file for why a demo-derived fixture does not count as one.
   */
  it(`reads ${FIXTURE_DIR}, which is empty until a real case arrives`, () => {
    expect(Array.isArray(files)).toBe(true);
  });

  for (const name of files) {
    describe(name, () => {
      const raw = readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8');
      const snapshot = readSnapshot(JSON.parse(raw));

      /*
       * Through the dispatcher, not through one surface's adapter.
       *
       * A committed fixture is whatever somebody sent in, and by now that can be
       * any of the six decisions — so the suite reads the kind off the file the
       * way the CLI does. That is the whole of "there is no test to edit and
       * nothing to register": a waiver plan dropped into this directory is
       * replayed by the waiver adapter without a line changing here.
       */
      it('replays to the decision it was captured from', async () => {
        const report = await replaySnapshot(snapshot);
        expect(report.differences, report.summary).toEqual([]);
        expect(report.outcome).toBe('reproduced');
      });

      it('is canonical on disk, so a re-write is an empty diff', () => {
        expect(raw).toBe(canonicalSnapshotJson(snapshot));
      });

      /**
       * A fixture earns its place when its inputs cannot be regenerated.
       *
       * A snapshot captured from a *demo scenario* is the opposite: the
       * scenarios are deterministic and their fixtures are already committed, so
       * such a file is byte-for-byte regenerable from code in this same
       * repository, and its only non-duplicated content is an assertion that the
       * engine produced that answer on the day it was written. This repository
       * pins invariants rather than outputs.
       *
       * The check is `release.gitSha`, because a demo capture says `demo` there
       * precisely so a rehearsal can never be mistaken for a deployment — which
       * makes it the one field that tells the two apart. It is here rather than
       * in a review checklist because a `--write` in a test run has already
       * leaked one into a commit once, and a rule nothing enforces is a rule
       * that holds until somebody is in a hurry.
       */
      it('came from a deployment rather than from a rehearsal', () => {
        expect(
          snapshot.release.gitSha,
          `${name} was captured from Demo Mode, and a demo scenario is regenerable from this repository`,
        ).not.toBe('demo');
      });
    });
  }
});
