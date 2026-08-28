/**
 * The roster you hold mid-draft.
 *
 * Sleeper's roster endpoint stays empty until a draft finishes, so if the Team
 * page waits for it, it is blank for the entire draft — the one time it matters
 * most. These tests pin the reconstruction and, more importantly, the handover
 * to Sleeper's canonical roster afterwards.
 */

import { describe, expect, it } from 'vitest';
import {
  buildLiveRoster,
  fillSlotRows,
  openStarters,
  rosterProgress,
  type LiveRosterInput,
} from '../src/core/draft/liveRoster.ts';
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
  /**
   * The order the strip reads in, which is the chip row's order.
   *
   * Sleeper lists a defence among the positions — `QB, RB, RB, WR, WR, TE,
   * FLEX, K, DEF, BN…` is an ordinary `roster_positions` — so the rows arrived
   * as `QB · RB · WR · TE · DEF · FLX · BN`, with the defence interrupting the
   * four positions a drafter is choosing between and the flex that spans three
   * of them landing after it.
   */
  it('puts the flex after its positions, the defence after the flex, and the bench last', () => {
    const shape = buildRosterShape([
      'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ]);
    expect(rosterProgress(shape, {}).map((s) => s.slot)).toEqual([
      'QB',
      'RB',
      'WR',
      'TE',
      'FLEX',
      'DEF',
      'BN',
    ]);
  });

  /**
   * Ordering only: the same rows, the same counts, the same requirements.
   *
   * A sort that quietly dropped or merged a row would satisfy the test above
   * and be a far worse bug than the order it fixed.
   */
  it('reorders the rows and changes not one of them', () => {
    const shape = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN']);
    const rows = rosterProgress(shape, { QB: 1, RB: 3, WR: 1, DEF: 1 });
    const byName = new Map(rows.map((r) => [r.slot, r]));

    expect(rows.map((r) => r.slot)).toEqual(['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN']);
    expect(byName.get('QB')).toMatchObject({ filled: 1, required: 1 });
    expect(byName.get('RB')).toMatchObject({ filled: 2, required: 2 });
    expect(byName.get('WR')).toMatchObject({ filled: 1, required: 1 });
    expect(byName.get('TE')).toMatchObject({ filled: 0, required: 1 });
    expect(byName.get('FLEX')).toMatchObject({ filled: 1, required: 1 });
    expect(byName.get('DEF')).toMatchObject({ filled: 1, required: 1 });
    // Every player is in exactly one count, which the sort must not disturb.
    const held = rows.reduce((total, row) => total + row.filled, 0);
    expect(held).toBe(6);
  });

  /** A slot nobody has heard of keeps its place rather than being sorted away. */
  it('keeps an unknown starting slot among the starters', () => {
    const shape = buildRosterShape(['QB', 'LB', 'DEF', 'BN']);
    expect(rosterProgress(shape, {}).map((s) => s.slot)).toEqual(['QB', 'LB', 'DEF', 'BN']);
  });

  it('reports every starting slot the league has, filled out of required', () => {
    expect(rosterProgress(SHAPE, { QB: 0, RB: 1, WR: 3, TE: 0 })).toEqual([
      { slot: 'QB', filled: 0, required: 1, accepts: ['QB'] },
      { slot: 'RB', filled: 1, required: 2, accepts: ['RB'] },
      { slot: 'WR', filled: 2, required: 2, accepts: ['WR'] },
      { slot: 'TE', filled: 0, required: 1, accepts: ['TE'] },
      // The third receiver is the one covering FLEX.
      { slot: 'FLEX', filled: 1, required: 1, accepts: ['RB', 'WR', 'TE'] },
      // …so nobody is left over, and the bench is untouched.
      { slot: 'BN', filled: 0, required: SHAPE.benchSlots, accepts: [], bench: true },
    ]);
  });

  it('never shows a starting slot the league does not have', () => {
    const noKicker = rosterProgress(buildRosterShape(['QB', 'RB', 'WR', 'BN']), { QB: 1 });
    expect(noKicker.map((s) => s.slot)).toEqual(['QB', 'RB', 'WR', 'BN']);
  });

  it('has no bench row in a league configured without a bench', () => {
    const noBench = rosterProgress(buildRosterShape(['QB', 'RB', 'WR', 'FLEX']), { QB: 1 });
    expect(noBench.map((s) => s.slot)).toEqual(['QB', 'RB', 'WR', 'FLEX']);
  });

  it('has no FLEX row in a league that does not use one', () => {
    const noFlex = rosterProgress(buildRosterShape(['QB', 'RB', 'RB', 'WR', 'BN', 'BN']), { RB: 2 });
    expect(noFlex.map((s) => s.slot)).toEqual(['QB', 'RB', 'WR', 'BN']);
  });

  /**
   * The half of the line that was missing.
   *
   * Bench is depth held beyond the lineup, so the same player may never be
   * counted in both halves — which is the only way `1/2 RB … 0/5 BN` can be
   * read as a statement about one roster.
   */
  describe('bench', () => {
    it('counts only players the starting slots did not take', () => {
      // Three receivers: two start, one covers FLEX, none reach the bench.
      const lean = rosterProgress(SHAPE, { WR: 3 });
      expect(lean.find((s) => s.slot === 'BN')).toMatchObject({ filled: 0, required: SHAPE.benchSlots });

      // A fourth has nowhere else to go.
      const deep = rosterProgress(SHAPE, { WR: 4 });
      expect(deep.find((s) => s.slot === 'BN')).toMatchObject({ filled: 1 });
    });

    it('counts a player at a position the league does not start as bench depth', () => {
      const withKicker = rosterProgress(buildRosterShape(['QB', 'RB', 'WR', 'BN', 'BN']), { QB: 1, K: 2 });
      expect(withKicker.find((s) => s.slot === 'BN')).toMatchObject({ filled: 2, required: 2 });
    });

    it('reports the league’s configured bench capacity, not a guess', () => {
      const shape = buildRosterShape(['QB', 'RB', 'WR', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
      expect(rosterProgress(shape, {}).find((s) => s.slot === 'BN')).toMatchObject({ filled: 0, required: 6 });
    });

    /**
     * A roster holding more players than it has room for is a fact about
     * Sleeper, not about this arithmetic. `9/6 BN` would say the app had
     * miscounted.
     */
    it('never reports more bench used than the league has', () => {
      const over = rosterProgress(buildRosterShape(['QB', 'BN', 'BN']), { RB: 9 });
      expect(over.find((s) => s.slot === 'BN')).toMatchObject({ filled: 2, required: 2 });
    });

    it('moves as picks are made', () => {
      // SHAPE starts QB/RB/RB/WR/WR/TE/FLEX, so the fourth receiver is the
      // first player with nowhere to start.
      expect(rosterProgress(SHAPE, { WR: 3 }).find((s) => s.slot === 'BN')!.filled).toBe(0);
      expect(rosterProgress(SHAPE, { WR: 4 }).find((s) => s.slot === 'BN')!.filled).toBe(1);
      expect(rosterProgress(SHAPE, { WR: 5 }).find((s) => s.slot === 'BN')!.filled).toBe(2);
    });
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

/**
 * The same allocation, reported by name instead of by count.
 *
 * `rosterProgress` says *how many* of each slot are covered; `fillSlotRows`
 * says *who* is in them, and it must never be able to disagree — a team sheet
 * showing three receivers beside a header strip saying `2/3 WR` would be two
 * answers to one question. The invariant is asserted directly below, because it
 * is the whole reason the function walks the rows rather than the shape.
 */
describe('putting players into the slots the league has', () => {
  const shape = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

  const held = (positions: string[]) => positions.map((position, i) => ({ playerId: `h${i}`, position }));

  const counts = (positions: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of positions) out[p] = (out[p] ?? 0) + 1;
    return out;
  };

  it('fills fixed slots first, then the flex, then the bench', () => {
    const positions = ['RB', 'WR', 'WR', 'RB', 'QB', 'WR'];
    const rows = fillSlotRows(rosterProgress(shape, counts(positions)), held(positions));
    expect(rows.map((r) => [r.slot, r.players.map((p) => p.position)])).toEqual([
      ['QB', ['QB']],
      ['RB', ['RB', 'RB']],
      ['WR', ['WR', 'WR']],
      ['TE', []],
      ['FLEX', ['WR']],
      ['BN', []],
    ]);
  });

  it('cannot disagree with the count the header strip already shows', () => {
    for (const positions of [
      [],
      ['QB'],
      ['WR', 'WR', 'WR', 'WR'],
      ['RB', 'RB', 'RB', 'TE', 'TE', 'QB', 'QB', 'WR'],
      ['TE', 'TE', 'TE', 'TE', 'TE'],
    ]) {
      const progress = rosterProgress(shape, counts(positions));
      const filled = fillSlotRows(progress, held(positions));
      for (const row of progress) {
        const found = filled.find((f) => f.slot === row.slot);
        const got = found?.players.length ?? 0;
        /*
         * Starting slots match exactly. The bench is the one row where the two
         * are allowed to differ, and only upwards: `rosterProgress` caps its
         * count at the configured bench so the strip never reads `9/6 BN`,
         * while the team sheet has to draw every player the reader actually
         * holds — a pick vanishing off your own roster is worse than a row that
         * shows more names than spaces. See `fillSlotRows`.
         */
        if (row.bench) expect(got, `BN with ${positions.join('/')}`).toBeGreaterThanOrEqual(row.filled);
        else expect(got, `${row.slot} with ${positions.join('/')}`).toBe(row.filled);
      }
    }
  });

  it('draws every player on an over-full bench, though the strip caps its count', () => {
    const positions = ['TE', 'TE', 'TE', 'TE', 'TE'];
    const progress = rosterProgress(shape, counts(positions));
    const bench = fillSlotRows(progress, held(positions)).find((r) => r.bench);
    expect(progress.find((r) => r.bench)?.filled, 'the strip says 2/2, not 3/2').toBe(2);
    expect(bench?.players).toHaveLength(3);
  });

  it('keeps pick order inside a slot, so the earlier pick is listed first', () => {
    const players = [
      { playerId: 'early', position: 'WR' },
      { playerId: 'late', position: 'WR' },
    ];
    const rows = fillSlotRows(rosterProgress(shape, { WR: 2 }), players);
    expect(rows.find((r) => r.slot === 'WR')?.players.map((p) => p.playerId)).toEqual(['early', 'late']);
  });

  it('drops nobody, even in a league with no bench at all', () => {
    const benchless = buildRosterShape(['QB', 'RB']);
    const positions = ['QB', 'RB', 'WR', 'WR'];
    const rows = fillSlotRows(rosterProgress(benchless, counts(positions)), held(positions));
    const placed = rows.flatMap((r) => r.players.map((p) => p.playerId));
    expect(new Set(placed).size, 'every player is somewhere, exactly once').toBe(positions.length);
    expect(rows.find((r) => r.bench)?.players.map((p) => p.position)).toEqual(['WR', 'WR']);
  });
});
