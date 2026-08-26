/**
 * A league with a synced manager history, captured and replayed.
 *
 * `managerTendencies` is the one optional member of `DraftBoardSources`, and
 * the demo scenarios do not implement it — so every other test in this suite
 * exercises the shape of board that has *no* history, which is the shape that
 * cannot go wrong in either of the two ways this file exists for.
 *
 * Both were real, both were found by asking what a league that *does* have one
 * would produce, and both would have been invisible until somebody with a
 * synced league sent a snapshot in:
 *
 * **The identities were aliased in the inputs and published in the output.**
 * `nextPickModel.managerHistory` names every manager picking ahead of you and
 * writes them into sentences — `slot 4 (juncaj93): RB demand ×1.2 from 3
 * historical draft(s)`. The inputs section had replaced that user id and that
 * display name with aliases; the output section was copied verbatim. Aliasing
 * one and publishing the other is a redaction that removes nothing.
 *
 * **The profile's content was being deleted on the way out.**
 * `ManagerTendencies.byPosition` is a `Map`, and `JSON.stringify` turns a Map
 * into `{}`. The profile travelled with its identity aliased, its sample counts
 * intact and its actual tendencies gone, so the replayed board had every
 * manager prior silently neutralised — a *different board*, in exactly the
 * leagues that have a history to be wrong about.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { captureDraftSnapshot } from '../src/core/support/draftSnapshot.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';
import type { DraftBoardSources } from '../src/core/draft/boardBuilder.ts';
import type { ManagerTendencies } from '../src/core/managers/managerTendencies.ts';

/** Real-shaped Sleeper identities, so an alias is distinguishable from a leak. */
const PEOPLE = [
  { id: '467803924117221376', name: 'juncaj93' },
  { id: '331590301295116288', name: 'Dave (commish)' },
  { id: '862224113355821056', name: 'TheRealMikeT' },
];

/**
 * A profile with enough of a sample to actually move the board.
 *
 * `usable` and a real `byPosition` are both required: a profile the model
 * declines to use would make this a test of two absent things agreeing.
 */
function tendenciesFor(person: { id: string; name: string }, lift: number): ManagerTendencies {
  return {
    userId: person.id,
    displayName: person.name,
    draftsObserved: 4,
    picksObserved: 60,
    seasons: ['2023', '2024', '2025', '2026'],
    usable: true,
    byPosition: new Map([
      [
        'RB',
        {
          position: 'RB',
          lift,
          medianFirstRound: 2,
          roomMedianFirstRound: 4,
          rateByBucket: { early: 0.4 },
          draftsWithPosition: 4,
          spread: 1,
          confidence: 0.8,
        },
      ],
      [
        'WR',
        {
          position: 'WR',
          lift: -lift,
          medianFirstRound: 6,
          roomMedianFirstRound: 4,
          rateByBucket: { early: 0.1 },
          draftsWithPosition: 3,
          spread: 1.5,
          confidence: 0.6,
        },
      ],
    ]),
    notes: [`${person.name} takes backs early`],
  } as ManagerTendencies;
}

/**
 * The mid-round board, given real managers and a history for three of them.
 *
 * The seats are rewritten as well as the profiles, because the board only
 * trusts a profile whose `userId` still matches the roster's current owner —
 * filed by roster, read by user. A test that supplied profiles without moving
 * the owners would have every one of them discarded and would prove nothing.
 */
async function leagueWithHistory(): Promise<{ sources: DraftBoardSources; draftId: string }> {
  const data = buildDraftScenario(findScenario('draft-mid')!);
  const inner = draftBoardSourcesFrom(data);
  const rosters = await inner.leagues.listRosters(data.league.id);

  const rewritten = rosters.map((roster, i) => {
    const person = PEOPLE[i];
    return person ? { ...roster, ownerId: person.id, ownerName: person.name } : roster;
  });

  const byRoster = new Map<number, ManagerTendencies>();
  PEOPLE.forEach((person, i) => {
    const roster = rewritten[i];
    if (roster) byRoster.set(roster.rosterId, tendenciesFor(person, 0.6 - i * 0.2));
  });

  return {
    draftId: data.draft!.id,
    sources: {
      ...inner,
      leagues: { ...inner.leagues, listRosters: async () => rewritten },
      managerTendencies: async () => byRoster,
    },
  };
}

const capture = async () => {
  const { sources, draftId } = await leagueWithHistory();
  return captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });
};

describe('a league with a manager history', () => {
  it('actually applies one, or this file is testing nothing', async () => {
    const snapshot = await capture();
    /*
     * The guard on the guard.
     *
     * Every assertion below is about what happens when a manager prior is in
     * force. If the fixture stopped producing one — a changed threshold, a
     * changed sample requirement — the rest of this file would pass by
     * describing an absence, so the presence is asserted first and loudly.
     */
    const history = snapshot.decision.output.nextPickModel.managerHistory;
    expect(history, 'no manager prior was applied, so nothing below is being tested').not.toBeNull();
    expect(history!.managersWithHistory).toBeGreaterThan(0);
    expect(history!.entries.length).toBeGreaterThan(0);
    expect(snapshot.decision.inputs.managerTendencies).not.toBeNull();
    expect(snapshot.decision.inputs.managerTendencies!.length).toBe(PEOPLE.length);
  });

  it('names nobody, in the inputs or in the diagnostics', async () => {
    const snapshot = await capture();
    const text = JSON.stringify(snapshot);

    for (const person of PEOPLE) {
      expect(text, `${person.id} survived capture`).not.toContain(person.id);
      expect(text, `${person.name} survived capture`).not.toContain(person.name);
    }

    // And the diagnostics carry aliases rather than blanks: a redaction that
    // deleted the name would lose the ability to say which seat is which.
    for (const entry of snapshot.decision.output.nextPickModel.managerHistory!.entries) {
      if (entry.displayName != null) expect(entry.displayName).toMatch(/^Manager \d+$/);
    }
  });

  it('gives a manager the same alias in the diagnostics as on his roster', async () => {
    const snapshot = await capture();
    const inputs = snapshot.decision.inputs;
    const bySlot = new Map(
      Object.entries(inputs.draft.slotToRosterId).map(([slot, rosterId]) => [
        Number(slot),
        inputs.rosters.find((r) => r.rosterId === rosterId)?.ownerName ?? null,
      ]),
    );

    /*
     * `Manager 3` on a card and `Manager 3` in a note have to be one person, or
     * the aliasing has made the file harder to read than the real names were.
     */
    for (const entry of snapshot.decision.output.nextPickModel.managerHistory!.entries) {
      if (entry.displayName == null) continue;
      expect(entry.displayName, `slot ${entry.slot} is a different manager in the diagnostics`).toBe(
        bySlot.get(entry.slot),
      );
    }
  });

  it('carries the profile’s actual tendencies, not an empty Map', async () => {
    const snapshot = JSON.parse(JSON.stringify(await capture())) as Awaited<ReturnType<typeof capture>>;

    for (const entry of snapshot.decision.inputs.managerTendencies!) {
      const byPosition = entry.tendencies['byPosition'] as Record<string, unknown>;
      expect(Object.keys(byPosition).sort(), 'byPosition was stringified to nothing').toEqual(['RB', 'WR']);
      expect((byPosition['RB'] as { lift: number }).lift).not.toBe(0);
    }
  });

  it('replays to the same board, priors and all', async () => {
    const snapshot = readSnapshot(JSON.parse(JSON.stringify(await capture())));
    const report = await replayDraftSnapshot(snapshot);

    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
    // The prior survived the round trip rather than being neutralised into
    // agreement: a board with no history would also have matched a board with
    // no history, which is why the first test in this file exists.
    expect(report.board!.nextPickModel.managerHistory).not.toBeNull();
  });
});
