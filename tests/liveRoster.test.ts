/**
 * The roster you hold mid-draft.
 *
 * Sleeper's roster endpoint stays empty until a draft finishes, so if the Team
 * page waits for it, it is blank for the entire draft — the one time it matters
 * most. These tests pin the reconstruction and, more importantly, the handover
 * to Sleeper's canonical roster afterwards.
 */

import { describe, expect, it } from 'vitest';
import { buildLiveRoster, openStarters, rosterProgress, type LiveRosterInput } from '../src/core/draft/liveRoster.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

const PLAYERS = new Map([
  ['p1', { fullName: 'Bijan Robinson', position: 'RB', team: 'ATL' }],
  ['p2', { fullName: 'Puka Nacua', position: 'WR', team: 'LAR' }],
  ['p3', { fullName: 'Trey McBride', position: 'TE', team: 'ARI' }],
  ['p4', { fullName: 'Rival Player', position: 'WR', team: 'NYJ' }],
]);

function input(over: Partial<LiveRosterInput> = {}): LiveRosterInput {
  return {
    picks: [
      { playerId: 'p1', pickNo: 8, rosterId: 3, pickedBy: 'me' },
      { playerId: 'p4', pickNo: 9, rosterId: 5, pickedBy: 'them' },
      { playerId: 'p2', pickNo: 17, rosterId: 3, pickedBy: 'me' },
    ],
    rosterId: 3,
    ownerId: 'me',
    sleeperPlayerIds: [],
    byId: PLAYERS,
    shape: SHAPE,
    draftStatus: 'drafting',
    ...over,
  };
}

describe('reconstructing a roster from the pick stream', () => {
  it('collects the picks you made, in order, with their pick numbers', () => {
    const roster = buildLiveRoster(input());
    expect(roster.players.map((p) => p.name)).toEqual(['Bijan Robinson', 'Puka Nacua']);
    expect(roster.players[0]!.pickNo).toBe(8);
    expect(roster.live).toBe(true);
    expect(roster.picksMade).toBe(2);
  });

  it('leaves other teams’ picks alone', () => {
    expect(buildLiveRoster(input()).players.some((p) => p.name === 'Rival Player')).toBe(false);
  });

  /** Best-ball and mock drafts often record only who picked. */
  it('recognises your picks by Sleeper user when no roster id is recorded', () => {
    const roster = buildLiveRoster(
      input({
        rosterId: null,
        picks: [{ playerId: 'p1', pickNo: 8, rosterId: null, pickedBy: 'me' }],
      }),
    );
    expect(roster.players).toHaveLength(1);
  });

  it('counts positions and roster spots left', () => {
    const roster = buildLiveRoster(input());
    expect(roster.counts).toEqual({ RB: 1, WR: 1 });
    expect(roster.filled).toBe(2);
    // 7 starting slots + 2 bench = 9 capacity.
    expect(roster.remaining).toBe(7);
  });

  it('is not live once the draft is done', () => {
    expect(buildLiveRoster(input({ draftStatus: 'complete' })).live).toBe(false);
  });
});

describe('handing over to Sleeper’s roster', () => {
  /** The transition is where duplicates would come from. */
  it('does not list a player twice when Sleeper starts reporting them', () => {
    const roster = buildLiveRoster(input({ sleeperPlayerIds: ['p1', 'p2'], draftStatus: 'complete' }));
    expect(roster.players.map((p) => p.playerId)).toEqual(['p1', 'p2']);
  });

  it('picks up players Sleeper knows about that the picks did not cover', () => {
    const roster = buildLiveRoster(input({ sleeperPlayerIds: ['p3'], draftStatus: 'complete' }));
    expect(roster.players.map((p) => p.playerId)).toEqual(['p1', 'p2', 'p3']);
    // A player who arrived from the roster rather than a pick has no pick number.
    expect(roster.players[2]!.pickNo).toBeNull();
  });
});

describe('which starting slots are still open', () => {
  it('reports every requirement as open on an empty roster', () => {
    const open = openStarters(SHAPE, {});
    expect(open).toEqual([
      { slot: 'QB', count: 1, accepts: ['QB'] },
      { slot: 'RB', count: 2, accepts: ['RB'] },
      { slot: 'WR', count: 2, accepts: ['WR'] },
      { slot: 'TE', count: 1, accepts: ['TE'] },
      { slot: 'FLEX', count: 1, accepts: ['RB', 'WR', 'TE'] },
    ]);
  });

  it('fills fixed slots before offering the leftovers to flex', () => {
    // Three RBs: two fill the RB slots, the third covers FLEX.
    const open = openStarters(SHAPE, { RB: 3, WR: 2, TE: 1, QB: 1 });
    expect(open).toEqual([]);
  });

  it('still wants a flex when every fixed slot is exactly covered', () => {
    const open = openStarters(SHAPE, { RB: 2, WR: 2, TE: 1, QB: 1 });
    expect(open).toEqual([{ slot: 'FLEX', count: 1, accepts: ['RB', 'WR', 'TE'] }]);
  });

  it('names the position you are missing', () => {
    const open = openStarters(SHAPE, { RB: 2, WR: 2, QB: 1 });
    expect(open.map((o) => o.slot)).toContain('TE');
  });

  /** A surplus at one position does not excuse a gap at another. */
  it('does not let extra running backs cover a missing quarterback', () => {
    const open = openStarters(SHAPE, { RB: 6 });
    expect(open.find((o) => o.slot === 'QB')?.count).toBe(1);
  });
});

/**
 * The one line the draft header shows instead of a roster card.
 *
 * It is status, not advice: how much of a starting lineup exists, in the
 * league's own slots. What to do about it is the ranked list's job.
 */
describe('roster progress line', () => {
  it('reports every starting slot the league has, filled out of required', () => {
    expect(rosterProgress(SHAPE, { QB: 0, RB: 1, WR: 3, TE: 0 })).toEqual([
      { slot: 'QB', filled: 0, required: 1, accepts: ['QB'] },
      { slot: 'RB', filled: 1, required: 2, accepts: ['RB'] },
      { slot: 'WR', filled: 2, required: 2, accepts: ['WR'] },
      { slot: 'TE', filled: 0, required: 1, accepts: ['TE'] },
      // The third receiver is the one covering FLEX.
      { slot: 'FLEX', filled: 1, required: 1, accepts: ['RB', 'WR', 'TE'] },
    ]);
  });

  it('never shows a slot the league does not have', () => {
    const noKicker = rosterProgress(buildRosterShape(['QB', 'RB', 'WR', 'BN']), { QB: 1, K: 2 });
    expect(noKicker.map((s) => s.slot)).toEqual(['QB', 'RB', 'WR']);
  });

  it('collapses repeated flex slots into one row', () => {
    const shape = buildRosterShape(['QB', 'RB', 'WR', 'FLEX', 'FLEX', 'BN']);
    const progress = rosterProgress(shape, { QB: 1, RB: 2, WR: 2 });
    expect(progress.find((s) => s.slot === 'FLEX')).toEqual({
      slot: 'FLEX',
      filled: 2,
      required: 2,
      accepts: ['RB', 'WR', 'TE'],
    });
  });

  it('fills fixed slots before flex, so a surplus never hides a gap', () => {
    const progress = rosterProgress(SHAPE, { RB: 6 });
    expect(progress.find((s) => s.slot === 'QB')).toMatchObject({ filled: 0, required: 1 });
    expect(progress.find((s) => s.slot === 'RB')).toMatchObject({ filled: 2, required: 2 });
    expect(progress.find((s) => s.slot === 'FLEX')).toMatchObject({ filled: 1, required: 1 });
  });

  it('moves as picks are made', () => {
    const before = buildLiveRoster(input({ picks: [] })).progress;
    const after = buildLiveRoster(input()).progress;
    expect(before.find((s) => s.slot === 'RB')!.filled).toBe(0);
    expect(after.find((s) => s.slot === 'RB')!.filled).toBe(1);
    expect(after.find((s) => s.slot === 'WR')!.filled).toBe(1);
  });
});
