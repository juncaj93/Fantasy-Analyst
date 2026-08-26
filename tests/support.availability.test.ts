/**
 * The lines on a card that no component score stands behind.
 *
 * Most of what a snapshot reproduces is the ranking, and the ranking is
 * self-checking: if every component, weight and contribution matches, the
 * numbers derived from them matched too. A handful of things on a draft card
 * are not like that, because they are the *only* output of a source —
 *
 *   - `injuryStates` reaches the board through `injuryLine` and nothing else.
 *     No score reads it. Lose the round trip and every number on the board
 *     still matches while the availability line under a player's name quietly
 *     disappears;
 *   - `preseasonPoints` is read by a component *and* printed on its own;
 *   - `tierContext` comes from the demand model, which walks the pick stream
 *     through a path no score touches;
 *   - `nextPick` carries the model behind `Next%`, including the only
 *     per-player evidence that a manager prior applied.
 *
 * The demo's draft scenarios carry no injuries at all, so the round-trip tests
 * were exercising an empty map and proving nothing about any of it. This
 * supplies the states the fixtures do not — the same technique
 * `support.managerHistory.test.ts` uses, and for the same reason: a blind spot
 * in a fixture becomes a blind spot in the feature.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { captureDraftSnapshot } from '../src/core/support/draftSnapshot.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';
import { buildDraftBoard, type DraftBoardSources } from '../src/core/draft/boardBuilder.ts';
import type { InjuryState } from '../src/core/injury/model.ts';

/**
 * A designation with enough behind it that the board prints a line.
 *
 * `injuryLineFor` draws on the designation, the body part and the practice
 * reading, so a bare `questionable` would produce a shorter sentence and a
 * weaker test — the point is to move every field that can travel.
 */
function questionable(bodyPart: string, observedAt: string): InjuryState {
  return {
    designation: 'questionable',
    designationSource: 'nflverse',
    bodyPart,
    bodyPartSource: 'nflverse',
    practice: { status: 'full', source: 'nflverse', observedAt },
    practiceSource: 'nflverse',
    freshness: 'fresh',
    observedAt,
    confidence: 'high',
    conflict: false,
    conflictNote: null,
    observations: [
      { source: 'nflverse', designation: 'questionable', raw: 'Q', observedAt, bodyPart },
      { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt, bodyPart },
    ],
  } as InjuryState;
}

/**
 * The mid-round board, with three of the top players carrying a designation.
 *
 * Applied to whoever the board actually ranks first rather than to named
 * players, so a fixture edit that reorders the world cannot turn this into a
 * test about three rows nobody looks at.
 */
async function boardWithInjuries(): Promise<{ sources: DraftBoardSources; draftId: string; injured: string[] }> {
  const data = buildDraftScenario(findScenario('draft-mid')!);
  const inner = draftBoardSourcesFrom(data);
  const board = await buildDraftBoard(inner, data.draft!.id, { limit: 10 });
  const injured = board.recommendations.slice(0, 3).map((rec) => rec.playerId);

  const states = new Map<string, InjuryState>([
    [injured[0]!, questionable('hamstring', '2026-08-30T18:00:00.000Z')],
    [injured[1]!, questionable('ankle', '2026-08-30T20:00:00.000Z')],
    [injured[2]!, questionable('knee', '2026-08-29T15:00:00.000Z')],
  ]);

  return {
    draftId: data.draft!.id,
    injured,
    sources: {
      ...inner,
      injuryStates: async (players) => {
        const out = new Map<string, InjuryState>();
        for (const { playerId } of players) {
          const state = states.get(playerId);
          if (state) out.set(playerId, state);
        }
        return out;
      },
    },
  };
}

describe('availability travels with the snapshot', () => {
  it('records the line the board drew, for every player carrying one', async () => {
    const { sources, draftId, injured } = await boardWithInjuries();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });

    const lines = snapshot.decision.output.rows.filter((row) => row.injuryLine != null);
    /*
     * The guard on the guard: without this the four assertions below would pass
     * on a board where nothing was injured, by comparing two empty sets.
     */
    expect(lines.length, 'no availability line was drawn, so nothing below is being tested').toBe(injured.length);
    for (const row of lines) {
      expect(injured).toContain(row.playerId);
      expect(row.injuryLine).toMatch(/hamstring|ankle|knee/);
    }
  });

  it('replays to the same lines, not merely to the same scores', async () => {
    const { sources, draftId } = await boardWithInjuries();
    const snapshot = readSnapshot(
      JSON.parse(JSON.stringify(await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' }))),
    );
    const report = await replayDraftSnapshot(snapshot);

    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
    expect(report.board!.recommendations.filter((rec) => rec.injuryLine != null).length).toBeGreaterThan(0);
  });

  it('notices an availability line that changed, even when every score matches', async () => {
    const { sources, draftId } = await boardWithInjuries();
    const snapshot = JSON.parse(
      JSON.stringify(await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' })),
    ) as Awaited<ReturnType<typeof captureDraftSnapshot>>;

    /*
     * The whole reason these fields are captured.
     *
     * Nothing about the ranking is touched here — the components, the total and
     * the order are all left exactly as they were. If `injuryLine` were not
     * part of the contract this snapshot would reproduce perfectly while
     * describing a board that said something different under a player's name.
     */
    const row = snapshot.decision.output.rows.find((r) => r.injuryLine != null)!;
    row.injuryLine = 'Q · shoulder · did not practise';

    const report = await replayDraftSnapshot(readSnapshot(snapshot));
    expect(report.outcome).toBe('output_difference');
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]!.term).toBe('injuryLine');
  });
});

describe('the rest of what no component stands behind', () => {
  /**
   * Round one, because that is where a tier line exists.
   *
   * `tierContextLine` says something only when a cliff is close enough to act
   * on and the managers ahead of you actually need the position; by round six
   * the fixture's tiers have been eaten and every row is legitimately silent.
   * A field that is null everywhere it is checked is a field being captured and
   * compared without ever having a value to be wrong about — so the scenario is
   * chosen to make it non-null rather than the assertion softened to accept
   * nothing.
   */
  it('carries the tier line, the market headline and the imported projection', async () => {
    const data = buildDraftScenario(findScenario('draft-early')!);
    const snapshot = await captureDraftSnapshot(draftBoardSourcesFrom(data), {
      draftId: data.draft!.id,
      gitSha: 'deadbeef',
    });
    const rows = snapshot.decision.output.rows;

    expect(rows.some((row) => row.tierContext != null), 'no tier line on any row').toBe(true);
    expect(rows.some((row) => row.marketHeadline != null), 'no market headline on any row').toBe(true);
    expect(rows.some((row) => row.preseasonPoints != null), 'no imported projection on any row').toBe(true);
  });

  it('notices a tier line that changed, when nothing else did', async () => {
    const data = buildDraftScenario(findScenario('draft-early')!);
    const snapshot = JSON.parse(
      JSON.stringify(
        await captureDraftSnapshot(draftBoardSourcesFrom(data), { draftId: data.draft!.id, gitSha: 'deadbeef' }),
      ),
    ) as Awaited<ReturnType<typeof captureDraftSnapshot>>;

    const row = snapshot.decision.output.rows.find((r) => r.tierContext != null)!;
    row.tierContext = 'QB tier cliff · 1 left in this tier';

    const report = await replayDraftSnapshot(readSnapshot(snapshot));
    expect(report.outcome).toBe('output_difference');
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]!.term).toBe('tierContext');
  });

  it('carries the model behind Next%, with its drivers', async () => {
    const data = buildDraftScenario(findScenario('draft-mid')!);
    const snapshot = await captureDraftSnapshot(draftBoardSourcesFrom(data), {
      draftId: data.draft!.id,
      gitSha: 'deadbeef',
    });

    const withModel = snapshot.decision.output.rows.filter((row) => row.nextPick != null);
    expect(withModel.length).toBeGreaterThan(0);
    expect(withModel.some((row) => row.nextPick!.drivers.length > 0)).toBe(true);
    expect(withModel.every((row) => typeof row.nextPick!.confidence === 'string')).toBe(true);
  });
});
