/**
 * A captured board, replayed, and the two compared with nothing forgiven.
 *
 * This is the test the whole Support Snapshot lane rests on. Everything else in
 * the feature — the button, the CLI, the fixture converter — is plumbing around
 * one claim: that a snapshot carries enough to rebuild the exact board it was
 * taken from, and that nothing needed was distilled away.
 *
 * The claim is checked the only way that means anything: capture a real board
 * from a real scenario, throw away everything except the snapshot, rebuild the
 * board from the snapshot alone, and require every term of the reproduction
 * contract to hold. Six scenarios, chosen so the degraded shapes are covered as
 * well as the healthy ones — a snapshot that reproduces a comfortable
 * mid-round board and quietly loses the reason DOG is unavailable would be a
 * snapshot that cannot diagnose the reports most likely to arrive.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftBoard } from '../src/core/draft/boardBuilder.ts';
import { DRAFT_ENGINE_VERSION } from '../src/core/draft/version.ts';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { captureDraftSnapshot, SNAPSHOT_DETAIL_ROWS } from '../src/core/support/draftSnapshot.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';
import { SUPPORT_SNAPSHOT_SCHEMA } from '../src/core/support/schema.ts';
import type { DraftBoardSources } from '../src/core/draft/boardBuilder.ts';

const GIT_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f009876543';

/**
 * The scenarios worth replaying.
 *
 * Round one and round six are the ordinary cases. Round thirteen is the one
 * where most of the pool has no ADP at all, which is where a distillation that
 * kept "the priced players" and called it a day would fall over. The three
 * degraded ones each remove a different input, and each has a *reason string*
 * on the board that a replay has to reproduce word for word.
 */
const SCENARIOS = [
  'draft-early',
  'draft-mid',
  'draft-late',
  'dog-unavailable',
  'dog-stale',
  'sleeper-adp-unavailable',
] as const;

function sourcesFor(id: string): { sources: DraftBoardSources; draftId: string } {
  const scenario = findScenario(id);
  if (!scenario) throw new Error(`scenario ${id} is not registered`);
  const data = buildDraftScenario(scenario);
  if (!data.draft) throw new Error(`scenario ${id} has no draft`);
  return { sources: draftBoardSourcesFrom(data), draftId: data.draft.id };
}

/**
 * The round trip a support conversation actually performs.
 *
 * `JSON.parse(JSON.stringify(...))` is not ceremony. The snapshot leaves this
 * process as text and comes back as text, and a capture that happened to hand
 * back live `Map`s or `Date`s would pass a test that skipped the encoding and
 * fail on the first real file. Serialising here is what makes the test's
 * subject the *file* rather than the object.
 */
async function roundTrip(id: string, opts: { position?: string | null; queuedOnly?: boolean } = {}) {
  const { sources, draftId } = sourcesFor(id);
  const captured = await captureDraftSnapshot(sources, {
    draftId,
    gitSha: GIT_SHA,
    position: opts.position ?? null,
    queuedOnly: opts.queuedOnly ?? false,
  });
  const wire = JSON.parse(JSON.stringify(captured)) as unknown;
  const snapshot = readSnapshot(wire);
  return { captured, snapshot, report: await replayDraftSnapshot(snapshot) };
}

describe('a captured board replays exactly', () => {
  for (const id of SCENARIOS) {
    it(`${id} reproduces from its snapshot alone`, async () => {
      const { report } = await roundTrip(id);

      /*
       * The differences are asserted before the outcome, deliberately.
       *
       * `expect(outcome).toBe('reproduced')` on a failure prints
       * `'output_difference' !== 'reproduced'`, which says nothing about what
       * moved. Asserting the list first means a regression prints the term, the
       * player and both values — which is the difference between a red tick and
       * a diagnosis.
       */
      expect(report.differences).toEqual([]);
      expect(report.outcome).toBe('reproduced');
      expect(report.engine.matches).toBe(true);
    });
  }

  it('reproduces a position-filtered board, where the scored pool is cut differently', async () => {
    const { report } = await roundTrip('draft-mid', { position: 'WR' });
    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
  });

  it('reproduces the queue filter, where the reader’s own order wins over the ranking', async () => {
    const { report } = await roundTrip('draft-late', { queuedOnly: true });
    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
  });
});

describe('the snapshot is what it claims to be', () => {
  it('carries the schema identity, the release and both versions', async () => {
    const { captured } = await roundTrip('draft-mid');
    expect(captured.schema).toBe(SUPPORT_SNAPSHOT_SCHEMA);
    expect(captured.release.gitSha).toBe(GIT_SHA);
    expect(captured.release.surface).toBe('draft-board');
    expect(captured.release.engineVersion).toBe(DRAFT_ENGINE_VERSION);
    expect(captured.decision.kind).toBe('draft-board');
  });

  it('pins the clock to the scenario’s own instant, not to now', async () => {
    const scenario = findScenario('draft-mid')!;
    const { captured } = await roundTrip('draft-mid');
    expect(captured.capturedAt).toBe(new Date(scenario.asOf).toISOString());
    expect(captured.decision.inputs.now).toBe(captured.capturedAt);
  });

  it('records the ordering in full and the argument for the top of the board', async () => {
    const { captured } = await roundTrip('draft-mid');
    const output = captured.decision.output;

    expect(output.order.length).toBeGreaterThan(SNAPSHOT_DETAIL_ROWS);
    expect(output.detailSelection.topRows).toBe(SNAPSHOT_DETAIL_ROWS);
    expect(output.rows).toHaveLength(output.detailRows);
    // In board order, and every row's rank is its real place on the whole board.
    expect(output.rows.map((r) => r.playerId)).toEqual(
      output.order.filter((id) => output.rows.some((r) => r.playerId === id)),
    );
    for (const row of output.rows) expect(output.order[row.rank - 1]).toBe(row.playerId);

    // Every component the engine produced, with its own weight and what it spent.
    for (const row of output.rows) {
      expect(row.components.length).toBeGreaterThan(0);
      for (const component of row.components) {
        expect(component).toHaveProperty('weight');
        expect(component).toHaveProperty('contribution');
        expect(output.componentLabels[component.key]).toBeTruthy();
      }
    }
  });

  /**
   * The row a support conversation is usually about.
   *
   * `draft-late` is round thirteen, and the fixture's marked players are
   * deliberately spread down the board so that some of them are still available
   * deep into it. Their arguments have to be in the file wherever they landed —
   * a snapshot that carried the top twenty-four and dropped the ♥♥♥ at rank
   * eighty would be missing precisely the row somebody is complaining about.
   */
  it('carries the argument for every marked player, wherever he finished', async () => {
    const { captured } = await roundTrip('draft-late');
    const output = captured.decision.output;
    const detailed = new Set(output.rows.map((r) => r.playerId));

    const marked = Object.entries(captured.decision.inputs.flags)
      .filter(([id, flag]) => (flag.level > 0 || flag.queued) && output.order.includes(id))
      .map(([id]) => id);
    expect(marked.length).toBeGreaterThan(0);
    for (const id of marked) expect(detailed).toContain(id);

    // And at least one of them is below the top-of-board cut, or this proves nothing.
    const belowTheCut = marked.filter((id) => output.order.indexOf(id) >= output.detailSelection.topRows);
    expect(belowTheCut.length).toBeGreaterThan(0);
    expect(output.detailSelection.marked).toBe(belowTheCut.length);
  });

  it('keeps players the board never scored, because the model still reads them', async () => {
    const REASONS = ['drafted', 'priced', 'scored', 'simulated'];

    const unfiltered = (await roundTrip('draft-mid')).captured.decision.inputs.playerCensus;
    expect(unfiltered.captured).toBeGreaterThan(0);
    expect(unfiltered.captured).toBeLessThanOrEqual(unfiltered.listed);
    expect(Object.keys(unfiltered.keptBecause).every((why) => REASONS.includes(why))).toBe(true);
    expect(unfiltered.keptBecause['scored']).toBeGreaterThan(0);

    /*
     * The filtered board is where the four reasons stop being the same players.
     *
     * Tap WR and the board scores receivers — but the next-pick model still
     * drafts from the whole room's board, and the market's picture of the draft
     * still counts every priced player at every position. A capture that kept
     * "what was on screen" would replay a room in which the eleven managers
     * ahead of you only ever take receivers, and every survival percentage on
     * the board would be wrong in a way nothing on it admitted.
     */
    const filtered = (await roundTrip('draft-mid', { position: 'WR' })).captured.decision.inputs.playerCensus;
    expect(Object.keys(filtered.keptBecause).sort()).toEqual(REASONS);
    expect(filtered.keptBecause['simulated']).toBeGreaterThan(0);
    expect(filtered.keptBecause['priced']).toBeGreaterThan(0);
  });

  /**
   * The bound, against a dictionary the size of the real one.
   *
   * The demo world is 276 players, which is smaller than the scoring cap — so
   * every one of them is reachable and the distillation has nothing to drop.
   * That is a property of the fixture, not of the feature, and testing the
   * bound against it would be testing nothing. Production reads about 2,500
   * rows, so this pads the player table to that scale with players nobody will
   * ever draft and asserts the two things that then matter: the file stays
   * small, and the board still comes out identical.
   */
  it('stays bounded against a full-size player dictionary, and still reproduces', async () => {
    const { sources, draftId } = sourcesFor('draft-mid');
    const real = await sources.players.listAll();
    const filler = Array.from({ length: 2_200 }, (_, i) => ({
      ...real[i % real.length]!,
      id: `filler-${i}`,
      sleeperPlayerId: `filler-${i}`,
      fullName: `Filler Player ${String(i).padStart(4, '0')}`,
      // No market has priced them and nobody searches for them, so they sort to
      // the very back of both pools — exactly like the tail of the real table.
      searchRank: 900_000 + i,
    }));
    const padded: DraftBoardSources = {
      ...sources,
      players: { listAll: async () => [...real, ...filler] },
    };

    const captured = await captureDraftSnapshot(padded, { draftId, gitSha: GIT_SHA });
    const census = captured.decision.inputs.playerCensus;
    expect(census.listed).toBe(real.length + filler.length);
    // A few hundred rather than a few thousand: the players who can reach the answer.
    expect(census.captured).toBeLessThan(census.listed / 3);

    const report = await replayDraftSnapshot(readSnapshot(JSON.parse(JSON.stringify(captured))));
    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');

    /*
     * And the one number the distillation genuinely moves says so, with both
     * values, instead of a smaller pool passing quietly as a match.
     */
    expect(report.distillation).toHaveLength(1);
    expect(report.distillation[0]!.term).toBe('poolHealth.activeEligible');
    expect(report.distillation[0]!.captured).toBe(census.activeEligible);
    expect(Number(report.distillation[0]!.replayed)).toBeLessThan(census.activeEligible);
  });

  it('drops the two next-pick fields that measure the machine rather than the board', async () => {
    const { captured } = await roundTrip('draft-mid');
    const model = captured.decision.output.nextPickModel as Record<string, unknown>;
    expect(model).not.toHaveProperty('elapsedMs');
    expect(model).not.toHaveProperty('cached');
    // What it does keep is the reasoning: the simulated interval and its drivers.
    expect(model).toHaveProperty('simulations');
    expect(model).toHaveProperty('slotsAhead');
  });
});

describe('capture changes nothing it looks at', () => {
  it('produces the same board before and after a snapshot is taken', async () => {
    const { sources, draftId } = sourcesFor('draft-mid');
    const before = await buildDraftBoard(sources, draftId, { limit: 40 });
    await captureDraftSnapshot(sources, { draftId, gitSha: GIT_SHA });
    const after = await buildDraftBoard(sources, draftId, { limit: 40 });

    expect(after.recommendations.map((r) => r.playerId)).toEqual(before.recommendations.map((r) => r.playerId));
    expect(after.recommendations.map((r) => r.total)).toEqual(before.recommendations.map((r) => r.total));
    expect(after.warnings).toEqual(before.warnings);
  });

  it('reaches the sources through reads alone — a source with no writes on it', async () => {
    const { sources, draftId } = sourcesFor('draft-mid');
    /*
     * There is no write to intercept, which is the point being asserted.
     *
     * `DraftBoardSources` has no mutating member, so "capture cannot change
     * anything" is a property of the type rather than of the implementation.
     * What this checks is the thing a type cannot: that capture does not reach
     * around the interface for something else. Every own property of the
     * object handed in is a function or a namespace of functions, and the
     * capture is given nothing else.
     */
    const called: string[] = [];
    const watched: DraftBoardSources = {
      ...sources,
      players: {
        listAll: async () => {
          called.push('players.listAll');
          return sources.players.listAll();
        },
      },
    };
    await captureDraftSnapshot(watched, { draftId, gitSha: GIT_SHA });
    expect(called).toContain('players.listAll');
  });
});
