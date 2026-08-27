/**
 * The writer and the reader are the same gate.
 *
 * There is one failure this feature can produce that costs more than a wrong
 * number: **Copy support snapshot succeeds, the person sends the file in, and
 * `npm run support:fixture` refuses to read it.** By then they have spent their
 * goodwill and the answer they get is about our tooling rather than about their
 * problem — and the shape of the bug is always the same, a check the reader
 * makes and the writer does not.
 *
 * So this file does not test the two refusals anybody happens to remember. It
 * tests the *class*: for every implemented decision, and for every way a
 * snapshot can be broken, if `readSnapshot` refuses the file then `sealSnapshot`
 * must have refused the capture. A gate added to the reader tomorrow is covered
 * by this file the moment it exists, without anybody editing it.
 *
 * The mutations are two kinds on purpose. A short table names the refusals that
 * exist today, so the file reads as a description of them; a mechanical sweep
 * deletes every key of a real snapshot in turn, which is the half that covers
 * the check nobody here has thought of yet.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { captureDraftSnapshot } from '../src/core/support/draftSnapshot.ts';
import { readSnapshot, SnapshotRejected } from '../src/core/support/contract.ts';
import { sealSnapshot, SnapshotUnavailable } from '../src/core/support/emit.ts';
import { IMPLEMENTED_KINDS, type DecisionKind, type SupportSnapshot } from '../src/core/support/schema.ts';

const SHA = '4c1f9a0b2d3e4f5061728394a5b6c7d8e9f00112';
const LEAGUE = 'demo-league';

/** The demo league's own matchup rows, so the Matchup lane has a game to read. */
const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '1007', '1011', '1017', '1019', '1013'];

function sleeperServingMatchups(): SleeperClient {
  const rows = [
    { roster_id: 1, matchup_id: 1, points: 0, starters: MINE, players: [...MINE, '1009'], players_points: {} },
    { roster_id: 2, matchup_id: 1, points: 0, starters: THEIRS, players: [...THEIRS, '1018'], players_points: {} },
  ];
  return new SleeperClient({
    fetch: async (url) =>
      /\/matchups\/\d+$/.test(new URL(url).pathname)
        ? new Response(JSON.stringify(rows), { status: 200 })
        : new Response('null', { status: 200 }),
  });
}

const QUERY: Record<Exclude<DecisionKind, 'draft-board'>, string> = {
  lineup: 'context=lineup&mode=balanced',
  matchup: 'context=matchup',
  'waiver-plan': 'context=waiver-plan',
  'dst-plan': 'context=dst-plan',
  'trade-offer': 'context=trade-offer',
};

/**
 * One real snapshot of every implemented kind, captured once.
 *
 * Real rather than hand-built, because a hand-built snapshot is a guess about
 * the shape and the whole subject here is what the shipped writers actually
 * emit. Captured once and deep-copied per case: six captures is the expensive
 * part of this file and every mutation below wants its own copy anyway.
 */
const originals = new Map<DecisionKind, SupportSnapshot>();

beforeAll(async () => {
  const db = await createTestDb();
  await seedDemoData(db);
  const app = createApp();
  const env: AppEnv = {
    db,
    sleeper: sleeperServingMatchups(),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    releaseSha: SHA,
  };

  for (const [kind, query] of Object.entries(QUERY)) {
    const res = await app(new Request(`https://app.test/api/leagues/${LEAGUE}/support-snapshot?${query}`), env);
    expect(res.status, `${kind}: ${await res.clone().text()}`).toBe(200);
    originals.set(kind as DecisionKind, (await res.json()) as SupportSnapshot);
  }

  const scenario = findScenario('draft-early')!;
  const data = buildDraftScenario(scenario);
  originals.set(
    'draft-board',
    (await captureDraftSnapshot(draftBoardSourcesFrom(data), {
      draftId: data.draft!.id,
      gitSha: SHA,
      position: null,
      queuedOnly: false,
    })) as SupportSnapshot,
  );
}, 120_000);

const copyOf = (kind: DecisionKind): SupportSnapshot =>
  JSON.parse(JSON.stringify(originals.get(kind))) as SupportSnapshot;

/** Whether a function refused, and with what. */
function refusal(run: () => unknown): Error | null {
  try {
    run();
    return null;
  } catch (err) {
    return err as Error;
  }
}

// --------------------------------------------------- the property, stated once

/**
 * The one claim, checked against a snapshot however it was broken.
 *
 * The implication runs in one direction only, and deliberately: `sealSnapshot`
 * is allowed to refuse *more* than `readSnapshot` does — it also rejects values
 * `JSON` would silently change, which a file that has already been through JSON
 * cannot contain — and that asymmetry is the writer being stricter than the
 * reader, which is the safe side. What must never happen is the other one.
 */
function assertSymmetric(
  kind: DecisionKind,
  snapshot: SupportSnapshot,
  how: string,
  opts: { mustRefuse?: boolean } = {},
): void {
  const wire = JSON.parse(JSON.stringify(snapshot)) as unknown;
  const readerSaid = refusal(() => readSnapshot(wire));
  const writerSaid = refusal(() => sealSnapshot(snapshot));

  /*
   * The named table asserts the reader *does* refuse, and the sweep does not.
   *
   * Without this the table would rot into six passing tests about nothing the
   * moment a mutation stopped breaking anything — an implication with a false
   * antecedent is true and silent. The sweep is exempt because deleting an
   * optional key is legitimately allowed to be fine, and that is the answer it
   * is looking for.
   */
  if (opts.mustRefuse === true) {
    expect(readerSaid, `${kind}: a snapshot ${how} was read without complaint, so this case tests nothing`).not.toBeNull();
  }

  if (readerSaid == null) return;
  expect(
    writerSaid,
    `${kind}: readSnapshot refuses a snapshot ${how} (${readerSaid.message}), but sealSnapshot would have emitted it`,
  ).not.toBeNull();
}

describe('a capture that succeeds is a file the reader accepts', () => {
  it.each(IMPLEMENTED_KINDS)('%s, exactly as it was captured', (kind) => {
    const snapshot = copyOf(kind);
    expect(() => sealSnapshot(snapshot)).not.toThrow();
    expect(readSnapshot(JSON.parse(JSON.stringify(snapshot))).decision.kind).toBe(kind);
  });
});

// ------------------------------------------------------------- the named ways

/**
 * Every refusal `readSnapshot` makes today, named.
 *
 * Each entry breaks a real snapshot one way. The sweep below covers the ways
 * nobody has named; this table is here so a reader can see what the gate is
 * for without reading `contract.ts` first.
 */
const BREAKAGES: { how: string; break: (snapshot: Record<string, never>) => void }[] = [
  { how: 'from a schema this build has never heard of', break: (s) => void ((s as never as { schema: string }).schema = 'junculator/support-snapshot@99') },
  { how: 'naming a decision this build does not replay', break: (s) => void ((s as never as { decision: { kind: string } }).decision.kind = 'roster-move') },
  { how: 'with no capture instant at all', break: (s) => void delete (s as never as { capturedAt?: string }).capturedAt },
  { how: 'whose capture instant is not a date', break: (s) => void ((s as never as { capturedAt: string }).capturedAt = 'the Tuesday after') },
  {
    how: 'carrying a credential it acquired after capture',
    break: (s) => void ((s as never as { decision: { context: Record<string, string> } }).decision.context['apiKey'] = 'live-abc123'),
  },
  {
    how: 'carrying an address it acquired after capture',
    break: (s) => void ((s as never as { decision: { context: Record<string, string> } }).decision.context['note'] = 'ask gary@example.com'),
  },
  {
    how: 'with nothing left in it to rebuild from',
    /*
     * Emptied by walking rather than by naming a field per kind.
     *
     * Every lane keeps what it read under `decision.inputs` in an array
     * somewhere, and which array is the adapter's business. Emptying all of
     * them is the one mutation that means "this file has nothing in it" for all
     * six without this test having to know the shape of any of them.
     */
    break: (s) => emptyEveryArray((s as never as { decision: { inputs: unknown } }).decision.inputs),
  },
];

function emptyEveryArray(node: unknown): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.length = 0;
    return;
  }
  for (const value of Object.values(node as Record<string, unknown>)) emptyEveryArray(value);
}

describe('nothing the reader refuses can be emitted', () => {
  for (const kind of IMPLEMENTED_KINDS) {
    describe(kind, () => {
      it.each(BREAKAGES)('$how', ({ how, break: breakIt }) => {
        const snapshot = copyOf(kind);
        breakIt(snapshot as never as Record<string, never>);
        assertSymmetric(kind, snapshot, how, { mustRefuse: true });
      });
    });
  }
});

// ------------------------------------------------------------- the unnamed ways

/**
 * The half that covers the check nobody has written yet.
 *
 * Deleting a key at a time is a crude fuzz and it is the right crudeness here:
 * the property under test is not "these particular refusals agree" but "the two
 * gates are one gate", and a sweep derived from the snapshot's own shape keeps
 * holding as the shape changes. Two levels, because `decision` is where every
 * kind-specific gate lives and a missing top-level key is the other half.
 */
describe('nothing the reader refuses can be emitted, for keys nobody named', () => {
  it.each(IMPLEMENTED_KINDS)('%s survives having each of its keys removed, or refuses on both sides', (kind) => {
    const shape = copyOf(kind);
    const paths: string[][] = [
      ...Object.keys(shape).map((key) => [key]),
      ...Object.keys(shape.decision).map((key) => ['decision', key]),
    ];
    expect(paths.length, 'the sweep has to sweep something').toBeGreaterThan(6);

    for (const path of paths) {
      const snapshot = copyOf(kind);
      let node = snapshot as unknown as Record<string, unknown>;
      for (const step of path.slice(0, -1)) node = node[step] as Record<string, unknown>;
      delete node[path[path.length - 1]!];
      assertSymmetric(kind, snapshot, `with ${path.join('.')} removed`);
    }
  });
});

// -------------------------------------------------------------- the empty case

/**
 * The one refusal that is not a bug, and is therefore phrased for a person.
 *
 * A league with nothing to decide about produces an honestly empty capture, and
 * the person who tapped the button is owed the screen's own sentence. Every
 * other refusal above is a snapshot this build wrote and cannot read, which is a
 * programming error and is allowed to surface as one — a distinction the route
 * depends on, because `SnapshotUnavailable` is the 409 and a `SnapshotRejected`
 * escaping a capture would be a 500.
 */
describe('an empty capture is refused in the app’s own words', () => {
  it.each(IMPLEMENTED_KINDS)('%s says what happened rather than naming a field', (kind) => {
    const snapshot = copyOf(kind);
    emptyEveryArray((snapshot.decision as unknown as { inputs: unknown }).inputs);

    const thrown = refusal(() => sealSnapshot(snapshot));
    expect(thrown, 'an empty capture must not be emitted').toBeInstanceOf(SnapshotUnavailable);
    expect((thrown as SnapshotUnavailable).status).toBe(409);
    expect(thrown!.message, 'the sentence is for a reader, not for a debugger').not.toContain('decision.inputs');
    expect(thrown!.message).toMatch(/^No .* yet\.$/);
  });

  it('names the field instead when the same file is read back', () => {
    const snapshot = copyOf('lineup');
    emptyEveryArray((snapshot.decision as unknown as { inputs: unknown }).inputs);

    const thrown = refusal(() => readSnapshot(JSON.parse(JSON.stringify(snapshot))));
    expect(thrown).toBeInstanceOf(SnapshotRejected);
    expect((thrown as SnapshotRejected).outcome).toBe('data_mismatch');
    expect(thrown!.message).toContain('decision.inputs.startSit');
  });
});
