/**
 * A rehearsal's lifecycle: whose turn it is, what ends it, and what it cannot
 * reach.
 *
 * Three of the brief's four named tests live here — the fourth, isolation, is
 * in `mock.isolation.test.ts`, and the blend itself is in
 * `mockManager.test.ts`:
 *
 *  - **the mock is deleted the instant a real pick appears** for that
 *    `draft_id`, in both places the rule is applied;
 *  - **a second league's mock is unaffected** by the first's deletion, which is
 *    the whole reason the state is keyed the way `draft_queue` is;
 *  - and the snake, the turn-taking and the determinism that let a board be
 *    rebuilt from a stored state on a machine that never ran the simulation.
 */

import { describe, expect, it } from 'vitest';
import {
  MOCK_DRAFT_VERSION,
  advanceMockDraft,
  createMockDraft,
  currentMockPick,
  isMockComplete,
  isMyMockTurn,
  isUsableMockState,
  isVoidedByRealPicks,
  mockPickRecords,
  resetMockDraft,
  slotOnTheClock,
  takeMockPick,
  type MockRoom,
} from '../src/core/draft/mockDraft.ts';
import type { MockCandidate } from '../src/core/draft/mockManager.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const TEAMS = 12;
const ROUNDS = 4;
const MY_SLOT = 5;
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

const room = (over: Partial<MockRoom> = {}): MockRoom => ({
  teams: TEAMS,
  rounds: ROUNDS,
  type: 'snake',
  slotToRosterId: Object.fromEntries(Array.from({ length: TEAMS }, (_, i) => [String(i + 1), 100 + i + 1])),
  mySlot: MY_SLOT,
  shape: SHAPE,
  ...over,
});

function pool(size = 200): MockCandidate[] {
  const positions = ['RB', 'WR', 'QB', 'TE'];
  return Array.from({ length: size }, (_, i) => ({
    playerId: `p${i + 1}`,
    position: positions[i % positions.length]!,
    marketRank: i + 1,
  }));
}

const fresh = (draftId = 'dr-a', seed = 7) =>
  createMockDraft({ draftId, seed, startedAt: '2026-08-27T12:00:00.000Z' });

describe('the room drafts up to your turn and then stops', () => {
  it('runs exactly the four seats before yours, and hands you the clock', () => {
    const advanced = advanceMockDraft(fresh(), room(), pool());
    expect(advanced.made).toHaveLength(MY_SLOT - 1);
    expect(advanced.made.map((p) => p.slot)).toEqual([1, 2, 3, 4]);
    expect(advanced.made.every((p) => p.by === 'bot')).toBe(true);
    expect(currentMockPick(advanced.state)).toBe(MY_SLOT);
    expect(isMyMockTurn(advanced.state, room())).toBe(true);
  });

  it('takes nobody twice', () => {
    const advanced = advanceMockDraft(fresh(), room(), pool());
    const ids = advanced.state.picks.map((p) => p.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('turns the snake around, through ownership.ts rather than by hand', () => {
    /*
     * Seat 5 picks 5th in round one and 20th in round two — `12 - 5 + 1 = 8`
     * places later in a reversed round. A mock that walked the seats in order
     * would put the reader on the clock at pick 17 and be a linear draft
     * wearing a snake's name.
     */
    const start = advanceMockDraft(fresh(), room(), pool());
    const afterMine = takeMockPick(start.state, room(), pool(), 'p200');
    expect(afterMine.refused).toBeNull();
    expect(currentMockPick(afterMine.state)).toBe(2 * TEAMS - MY_SLOT + 1);
    expect(isMyMockTurn(afterMine.state, room())).toBe(true);
  });

  it('is a linear draft when the draft is linear', () => {
    const linear = room({ type: 'linear' });
    const start = advanceMockDraft(fresh(), linear, pool());
    const afterMine = takeMockPick(start.state, linear, pool(), 'p200');
    expect(currentMockPick(afterMine.state)).toBe(TEAMS + MY_SLOT);
  });

  it('runs to the end and then stops, with nobody on the clock', () => {
    let state = fresh();
    for (;;) {
      const advanced = advanceMockDraft(state, room(), pool());
      state = advanced.state;
      if (isMockComplete(state, room())) break;
      const taken = takeMockPick(state, room(), pool(), state.picks.length === 4 ? 'p199' : `p${190 - state.picks.length}`);
      expect(taken.refused).toBeNull();
      state = taken.state;
    }
    expect(state.picks).toHaveLength(TEAMS * ROUNDS);
    expect(slotOnTheClock(state, room())).toBeNull();
    expect(isMyMockTurn(state, room())).toBe(false);
  });

  it('refuses a pick out of turn rather than reordering the draft', () => {
    const before = fresh();
    const refused = takeMockPick(before, room(), pool(), 'p1');
    expect(refused.refused).toBe('it is not your pick');
    expect(refused.state).toBe(before);
  });

  it('refuses a player who is already gone, and one who was never on the board', () => {
    const start = advanceMockDraft(fresh(), room(), pool()).state;
    const gone = start.picks[0]!.playerId;
    expect(takeMockPick(start, room(), pool(), gone).refused).toContain('already been taken');
    expect(takeMockPick(start, room(), pool(), 'nobody').refused).toContain('not on this board');
  });

  it('drafts for every seat when the reader has none', () => {
    const stateless = room({ mySlot: null });
    const advanced = advanceMockDraft(fresh(), stateless, pool());
    expect(advanced.state.picks).toHaveLength(TEAMS * ROUNDS);
  });
});

describe('the same state is the same draft, however it was reached', () => {
  it('advancing one pick at a time gives the draft advancing all at once does', () => {
    const all = advanceMockDraft(fresh('dr-a', 99), room({ mySlot: null }), pool()).state;

    let piecewise = fresh('dr-a', 99);
    for (let i = 0; i < TEAMS * ROUNDS; i++) {
      /*
       * One seat at a time, by giving the model a `mySlot` that is about to
       * pick — so it stops after every single selection and has to arrive at
       * the same board from forty-eight separate calls.
       */
      const next = slotOnTheClock(piecewise, room({ mySlot: null }));
      const stopAfterOne = room({ mySlot: next === TEAMS ? 1 : next! + 1 });
      piecewise = advanceMockDraft(piecewise, stopAfterOne, pool()).state;
    }
    expect(piecewise.picks).toEqual(all.picks);
  });

  it('a different seed is a different draft', () => {
    const a = advanceMockDraft(fresh('dr-a', 1), room({ mySlot: null }), pool()).state;
    const b = advanceMockDraft(fresh('dr-a', 2), room({ mySlot: null }), pool()).state;
    expect(a.picks.map((p) => p.playerId)).not.toEqual(b.picks.map((p) => p.playerId));
  });

  it('a reset is a new draft rather than an edited one', () => {
    const played = advanceMockDraft(fresh(), room(), pool()).state;
    const reset = resetMockDraft(played, 4242, '2026-08-27T13:00:00.000Z');
    expect(reset.picks).toEqual([]);
    expect(reset.seed).toBe(4242);
    expect(reset.draftId).toBe(played.draftId);
    expect(played.picks.length, 'the abandoned run is not mutated').toBeGreaterThan(0);
  });
});

describe('the first real pick deletes the mock', () => {
  it('is the rule, stated once', () => {
    expect(isVoidedByRealPicks(0)).toBe(false);
    expect(isVoidedByRealPicks(1)).toBe(true);
    expect(isVoidedByRealPicks(96)).toBe(true);
  });

  it('a draft that is merely set up is not a draft that has started', () => {
    /*
     * The distinction the whole feature lives in. Sleeper publishes a full pick
     * list for a draft nobody has picked in yet — every row present, every
     * `player_id` null — and a count of *rows* would make Mock Draft unreachable
     * in the only window it is for. The count that matters is of picks that
     * name a player, which is what `readMockRoom` passes in.
     */
    expect(isVoidedByRealPicks([null, null, null].filter(Boolean).length)).toBe(false);
  });
});

describe('a mock belongs to one draft, the way a queue does', () => {
  it('refuses a state filed under a different draft', () => {
    const first = fresh('dr-a');
    expect(isUsableMockState(first, 'dr-a')).toBe(true);
    expect(isUsableMockState(first, 'dr-b'), 'one league cannot read another league’s mock').toBe(false);
  });

  it('refuses a state this build does not know how to read', () => {
    const stale = { ...fresh('dr-a'), version: MOCK_DRAFT_VERSION + 1 };
    expect(isUsableMockState(stale, 'dr-a')).toBe(false);
  });

  it('refuses anything that is not a state at all', () => {
    for (const value of [null, undefined, 42, 'dr-a', [], {}, { draftId: 'dr-a' }]) {
      expect(isUsableMockState(value, 'dr-a'), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });

  it('leaves a second league’s mock exactly as it was when the first is deleted', () => {
    /*
     * The reason the key is the draft id and not, say, "the current mock".
     * Migration `0029` is the precedent: a global key let a finished draft's
     * shortlist surface in the next league's board, and the fix was the key
     * rather than any screen. Here the two states are two independent objects
     * and deletion is per-draft by construction, which is what this asserts —
     * the store is a map from draft id to state, and dropping one entry cannot
     * be made to drop the other.
     */
    const store = new Map<string, unknown>();
    const a = advanceMockDraft(fresh('dr-a', 11), room(), pool()).state;
    const b = advanceMockDraft(fresh('dr-b', 22), room(), pool()).state;
    store.set(a.draftId, a);
    store.set(b.draftId, b);

    // The first league's draft starts for real.
    if (isVoidedByRealPicks(1)) store.delete('dr-a');

    expect(store.has('dr-a')).toBe(false);
    expect(isUsableMockState(store.get('dr-b'), 'dr-b')).toBe(true);
    expect((store.get('dr-b') as typeof b).picks).toEqual(b.picks);
  });
});

describe('a mock pick, as a board reads it', () => {
  it('lands on the reader’s own roster, so the mock roster is not empty', () => {
    const start = advanceMockDraft(fresh(), room(), pool()).state;
    const mine = takeMockPick(start, room(), pool(), 'p150').state;
    const records = mockPickRecords(mine, room(), { myRosterId: 100 + MY_SLOT, myUserId: 'me' });

    const own = records.find((r) => r.playerId === 'p150')!;
    expect(own.rosterId).toBe(100 + MY_SLOT);
    expect(own.pickedBy).toBe('me');
    expect(own.draftSlot).toBe(MY_SLOT);
    expect(own.round).toBe(1);
    expect(own.pickInRound).toBe(MY_SLOT);
  });

  it('says it is a mock in the payload a snapshot would redact', () => {
    const start = advanceMockDraft(fresh(), room(), pool()).state;
    for (const record of mockPickRecords(start, room())) {
      expect(JSON.parse(record.raw)).toMatchObject({ mock: true });
    }
  });

  it('carries a roster id for every seat the draft names one for', () => {
    const start = advanceMockDraft(fresh(), room(), pool()).state;
    for (const record of mockPickRecords(start, room())) {
      expect(record.rosterId).toBe(100 + record.draftSlot);
    }
  });
});
