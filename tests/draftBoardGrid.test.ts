/**
 * The draft board as a board.
 *
 * Everything here is about arrangement rather than judgement — no score, no
 * ADP, no availability. The four things that can be got quietly wrong are the
 * snake direction, whose column a traded pick lands in, how a name is shortened
 * when two players share a surname, and whether a finished draft still claims
 * to have somebody on the clock. Each has its own group below.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDraftBoardGrid,
  compositionLine,
  pickLabel,
  shortPlayerName,
  shortPlayerNames,
  type BoardManager,
  type BoardPick,
} from '../src/core/draft/boardGrid.ts';

const TEAMS = 12;
const ROUNDS = 12;

function managers(count = TEAMS, mine = 1): BoardManager[] {
  return Array.from({ length: count }, (_, i) => ({
    slot: i + 1,
    name: i + 1 === mine ? 'You' : `Manager ${i + 1}`,
    isMine: i + 1 === mine,
  }));
}

function pick(pickNo: number, ownerSlot: number, over: Partial<BoardPick> = {}): BoardPick {
  return {
    pickNo,
    playerId: `p${pickNo}`,
    name: `Player ${pickNo}`,
    position: 'WR',
    team: 'CHI',
    ownerSlot,
    ...over,
  };
}

/** The cell at a round and column, from a built grid. */
function cellAt(grid: ReturnType<typeof buildDraftBoardGrid>, round: number, slot: number) {
  return grid.rows[round - 1]!.cells.find((c) => c.slot === slot)!;
}

describe('snake layout', () => {
  const grid = buildDraftBoardGrid({
    teams: TEAMS,
    rounds: ROUNDS,
    type: 'snake',
    managers: managers(),
    picks: [],
    currentPick: 1,
  });

  it('runs round one left to right', () => {
    expect(grid.rows[0]!.cells.map((c) => c.entries[0]!.pickNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('turns round two round without moving anybody’s column', () => {
    expect(grid.rows[1]!.cells.map((c) => c.entries[0]!.pickNo)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13]);
    // The columns themselves are unchanged — that is the whole point of a board.
    expect(grid.rows[1]!.cells.map((c) => c.slot)).toEqual(grid.rows[0]!.cells.map((c) => c.slot));
  });

  it('turns back again in round three', () => {
    expect(grid.rows[2]!.cells.map((c) => c.entries[0]!.pickNo)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
  });

  it('gives every pick in the draft exactly one cell', () => {
    const seen = grid.rows.flatMap((row) => row.cells.flatMap((cell) => cell.entries.map((e) => e.pickNo)));
    expect(seen).toHaveLength(TEAMS * ROUNDS);
    expect(new Set(seen).size).toBe(TEAMS * ROUNDS);
  });

  it('keeps a manager’s picks in one column, all the way down', () => {
    const column = grid.rows.map((row) => cellAt(grid, row.round, 4).entries[0]!.pickNo);
    expect(column).toEqual([4, 21, 28, 45, 52, 69, 76, 93, 100, 117, 124, 141]);
  });

  it('does not reverse a linear draft', () => {
    const linear = buildDraftBoardGrid({
      teams: 4,
      rounds: 2,
      type: 'linear',
      managers: managers(4),
      picks: [],
      currentPick: 1,
    });
    expect(linear.rows[1]!.cells.map((c) => c.entries[0]!.pickNo)).toEqual([5, 6, 7, 8]);
  });

  it('labels picks in the round.pick convention', () => {
    expect(pickLabel(1, 12)).toBe('1.01');
    expect(pickLabel(13, 12)).toBe('2.01');
    expect(pickLabel(64, 12)).toBe('6.04');
    expect(pickLabel(144, 12)).toBe('12.12');
  });
});

describe('traded pick ownership', () => {
  it('draws a completed pick in the column of the manager who made it', () => {
    // Pick 3 sits in seat 3 but roster 7's manager made it.
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [pick(1, 1), pick(2, 2), pick(3, 7)],
      currentPick: 4,
    });
    expect(cellAt(grid, 1, 7).entries.map((e) => e.pickNo)).toEqual([3, 7]);
    expect(cellAt(grid, 1, 3).entries).toHaveLength(0);
    const traded = cellAt(grid, 1, 7).entries.find((e) => e.pickNo === 3)!;
    expect(traded.traded).toBe(true);
    expect(traded.seatSlot).toBe(3);
    expect(traded.player?.playerId).toBe('p3');
  });

  it('follows a published ownership map for picks nobody has made yet', () => {
    // Sleeper says slot 5 owns pick 9, which the snake would give to slot 9.
    const pickOwners = Array.from({ length: TEAMS * ROUNDS }, () => null as number | null);
    pickOwners[8] = 5;
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [],
      currentPick: 1,
      pickOwners,
    });
    expect(cellAt(grid, 1, 5).entries.map((e) => e.pickNo)).toEqual([5, 9]);
    expect(cellAt(grid, 1, 9).entries).toHaveLength(0);
    expect(cellAt(grid, 1, 5).entries.find((e) => e.pickNo === 9)!.traded).toBe(true);
  });

  it('lets what actually happened overrule what the map predicted', () => {
    const pickOwners = Array.from({ length: TEAMS * ROUNDS }, () => null as number | null);
    pickOwners[2] = 5;
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      // Sleeper reports roster 8's manager actually made pick 3.
      picks: [pick(3, 8)],
      currentPick: 4,
      pickOwners,
    });
    expect(cellAt(grid, 1, 8).entries.map((e) => e.pickNo)).toContain(3);
    expect(cellAt(grid, 1, 5).entries.map((e) => e.pickNo)).not.toContain(3);
  });

  it('ignores an owner the draft does not have a seat for', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [pick(3, 99)],
      currentPick: 4,
    });
    expect(cellAt(grid, 1, 3).entries.map((e) => e.pickNo)).toEqual([3]);
    expect(cellAt(grid, 1, 3).entries[0]!.traded).toBe(false);
  });
});

describe('name abbreviation', () => {
  it('uses first initial and last name', () => {
    expect(shortPlayerName('Jalen Hurts')).toBe('J. Hurts');
    expect(shortPlayerName('Jayden Daniels')).toBe('J. Daniels');
    expect(shortPlayerName('Christian McCaffrey')).toBe('C. McCaffrey');
  });

  it('keeps a multi-word surname whole', () => {
    expect(shortPlayerName('Amon-Ra St. Brown')).toBe('A. St. Brown');
    expect(shortPlayerName('Puka Nacua')).toBe('P. Nacua');
  });

  it('keeps a hyphenated surname whole', () => {
    expect(shortPlayerName('Jaylen Waddle-Jones')).toBe('J. Waddle-Jones');
  });

  it('keeps a suffix with the surname', () => {
    expect(shortPlayerName('Marvin Harrison Jr.')).toBe('M. Harrison Jr.');
    expect(shortPlayerName('Michael Pittman Jr')).toBe('M. Pittman Jr');
    expect(shortPlayerName('Odell Beckham III')).toBe('O. Beckham III');
  });

  it('names a defence for its club rather than initialling it', () => {
    expect(shortPlayerName('Chicago Bears', 'DEF')).toBe('Bears');
  });

  it('leaves a one-word name alone', () => {
    expect(shortPlayerName('Ochocinco')).toBe('Ochocinco');
  });

  it('lengthens the initial only for the players who actually collide', () => {
    const short = shortPlayerNames([
      { playerId: 'a', name: 'Marquise Brown', position: 'WR' },
      { playerId: 'b', name: 'Malik Brown', position: 'WR' },
      { playerId: 'c', name: 'Jalen Hurts', position: 'QB' },
    ]);
    expect(short.get('a')).toBe('Mar. Brown');
    expect(short.get('b')).toBe('Mal. Brown');
    // Everybody else keeps the short form. A collision is not contagious.
    expect(short.get('c')).toBe('J. Hurts');
  });

  it('stops at the shortest prefix that separates them', () => {
    const short = shortPlayerNames([
      { playerId: 'a', name: 'Amari Cooper', position: 'WR' },
      { playerId: 'b', name: 'Bryan Cooper', position: 'WR' },
    ]);
    expect(short.get('a')).toBe('A. Cooper');
    expect(short.get('b')).toBe('B. Cooper');
  });

  it('falls back to the whole name when nothing shorter separates two players', () => {
    const short = shortPlayerNames([
      { playerId: 'a', name: 'John Smith', position: 'WR' },
      { playerId: 'b', name: 'Jordan Smith', position: 'WR' },
    ]);
    expect(short.get('a')).toBe('Joh. Smith');
    expect(short.get('b')).toBe('Jor. Smith');
  });

  it('prints two genuinely identical names identically rather than inventing a difference', () => {
    const short = shortPlayerNames([
      { playerId: 'a', name: 'Mike Williams', position: 'WR' },
      { playerId: 'b', name: 'Mike Williams', position: 'TE' },
    ]);
    expect(short.get('a')).toBe('M. Williams');
    expect(short.get('b')).toBe('M. Williams');
  });

  it('is the same answer whichever order the picks arrive in', () => {
    const roster = [
      { playerId: 'a', name: 'Marquise Brown', position: 'WR' },
      { playerId: 'b', name: 'Malik Brown', position: 'WR' },
      { playerId: 'c', name: 'Jalen Hurts', position: 'QB' },
    ];
    const forwards = shortPlayerNames(roster);
    const backwards = shortPlayerNames([...roster].reverse());
    expect([...forwards.entries()].sort()).toEqual([...backwards.entries()].sort());
  });

  it('short-names the players on the board itself', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [pick(1, 1, { name: 'Jalen Hurts', position: 'QB' })],
      currentPick: 2,
    });
    const entry = cellAt(grid, 1, 1).entries[0]!;
    expect(entry.player?.shortName).toBe('J. Hurts');
    // The full name survives for the screen reader.
    expect(entry.player?.name).toBe('Jalen Hurts');
  });
});

describe('live draft state', () => {
  const picks = [pick(1, 1), pick(2, 2), pick(3, 3)];

  it('fills the cell the pick actually belongs to', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks,
      currentPick: 4,
    });
    expect(cellAt(grid, 1, 2).entries[0]!.player?.playerId).toBe('p2');
    expect(cellAt(grid, 1, 2).entries[0]!.state).toBe('done');
    expect(cellAt(grid, 1, 5).entries[0]!.player).toBeNull();
  });

  it('marks the pick on the clock, and only that one', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks,
      currentPick: 4,
    });
    expect(grid.current).toEqual({ round: 1, slot: 4, pickNo: 4 });
    expect(cellAt(grid, 1, 4).entries[0]!.state).toBe('current');
    const currents = grid.rows.flatMap((r) => r.cells.flatMap((c) => c.entries)).filter((e) => e.state === 'current');
    expect(currents).toHaveLength(1);
  });

  it('advances the current pick when a new one lands', () => {
    const before = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks,
      currentPick: 4,
    });
    const after = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [...picks, pick(4, 4)],
      currentPick: 5,
    });
    expect(before.current?.pickNo).toBe(4);
    expect(after.current?.pickNo).toBe(5);
    expect(cellAt(after, 1, 4).entries[0]!.state).toBe('done');
    expect(cellAt(after, 1, 5).entries[0]!.state).toBe('current');
  });

  it('finds the current pick on the right side of an even round', () => {
    // Pick 13 opens round two, and in a snake that is the last seat, not the first.
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: Array.from({ length: 12 }, (_, i) => pick(i + 1, i + 1)),
      currentPick: 13,
    });
    expect(grid.current).toEqual({ round: 2, slot: 12, pickNo: 13 });
  });

  it('marks the most recent completed pick, and only the most recent', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks,
      currentPick: 4,
    });
    expect(grid.latest).toEqual({ round: 1, slot: 3, pickNo: 3 });
    const latest = grid.rows.flatMap((r) => r.cells.flatMap((c) => c.entries)).filter((e) => e.latest);
    expect(latest.map((e) => e.pickNo)).toEqual([3]);
  });

  it('has nothing on the clock, and nothing latest, before a draft starts', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [],
      currentPick: 1,
    });
    expect(grid.current).toEqual({ round: 1, slot: 1, pickNo: 1 });
    expect(grid.latest).toBeNull();
  });

  it('has no current cell once the draft is complete', () => {
    const all = Array.from({ length: TEAMS * ROUNDS }, (_, i) => pick(i + 1, ((i % TEAMS) + 1)));
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: all,
      currentPick: TEAMS * ROUNDS + 1,
      complete: true,
    });
    expect(grid.current).toBeNull();
    expect(grid.rows.flatMap((r) => r.cells.flatMap((c) => c.entries)).some((e) => e.state === 'current')).toBe(false);
    // And the board is still entirely readable as history.
    expect(grid.rows.flatMap((r) => r.cells.flatMap((c) => c.entries)).every((e) => e.state === 'done')).toBe(true);
  });

  /**
   * A draft closed early is still closed.
   *
   * Sleeper can mark a draft complete with picks left unmade — a league that
   * abandoned the last two rounds, or a commissioner who ended it. The counter
   * still points at a pick inside the board, so only the status can say that
   * nobody is on the clock, and a board that outlined that cell would be
   * promising a turn that is never coming.
   */
  it('has no current cell in a draft closed before its last pick', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [pick(1, 1), pick(2, 2)],
      currentPick: 3,
      complete: true,
    });
    expect(grid.current).toBeNull();
    expect(cellAt(grid, 1, 3).entries[0]!.state).toBe('future');
    expect(grid.rows.flatMap((r) => r.cells.flatMap((c) => c.entries)).some((e) => e.state === 'current')).toBe(false);
    // The picks that were made are still there to read.
    expect(grid.latest).toEqual({ round: 1, slot: 2, pickNo: 2 });
  });

  it('has no current cell when the counter has run off the end, status or not', () => {
    const grid = buildDraftBoardGrid({
      teams: 2,
      rounds: 2,
      type: 'snake',
      managers: managers(2),
      picks: [],
      currentPick: 99,
    });
    expect(grid.current).toBeNull();
  });

  it('shows a drafted player as done even if the counter disagrees', () => {
    const grid = buildDraftBoardGrid({
      teams: TEAMS,
      rounds: ROUNDS,
      type: 'snake',
      managers: managers(),
      picks: [pick(1, 1), pick(2, 2)],
      currentPick: 2,
    });
    expect(cellAt(grid, 1, 2).entries[0]!.state).toBe('done');
  });
});

describe('manager columns', () => {
  it('fills in a plain name for a seat Sleeper has not named', () => {
    const grid = buildDraftBoardGrid({
      teams: 4,
      rounds: 2,
      type: 'snake',
      managers: [{ slot: 1, name: 'You', isMine: true }],
      picks: [],
      currentPick: 1,
    });
    expect(grid.managers.map((m) => m.name)).toEqual(['You', 'Team 2', 'Team 3', 'Team 4']);
    expect(grid.managers.filter((m) => m.isMine).map((m) => m.slot)).toEqual([1]);
  });

  it('keeps one column per seat even when handed rubbish', () => {
    const grid = buildDraftBoardGrid({
      teams: 3,
      rounds: 1,
      type: 'snake',
      managers: [
        { slot: 0, name: 'Nobody', isMine: false },
        { slot: 9, name: 'Nobody either', isMine: false },
        { slot: 2, name: '   ', isMine: false },
      ],
      picks: [],
      currentPick: 1,
    });
    expect(grid.managers.map((m) => m.slot)).toEqual([1, 2, 3]);
    expect(grid.managers[1]!.name).toBe('Team 2');
  });
});

describe('roster composition', () => {
  it('counts what each manager has taken, in the order they took it', () => {
    const grid = buildDraftBoardGrid({
      teams: 2,
      rounds: 3,
      type: 'snake',
      managers: managers(2),
      picks: [
        pick(1, 1, { position: 'RB' }),
        pick(2, 2, { position: 'WR' }),
        pick(3, 2, { position: 'WR' }),
        pick(4, 1, { position: 'RB' }),
        pick(5, 1, { position: 'TE' }),
      ],
      currentPick: 6,
    });
    expect(compositionLine(grid.composition.find((c) => c.slot === 1))).toBe('2 RB · 1 TE');
    expect(compositionLine(grid.composition.find((c) => c.slot === 2))).toBe('2 WR');
  });

  it('says nothing for a manager who has not picked', () => {
    const grid = buildDraftBoardGrid({
      teams: 2,
      rounds: 2,
      type: 'snake',
      managers: managers(2),
      picks: [],
      currentPick: 1,
    });
    expect(compositionLine(grid.composition.find((c) => c.slot === 1))).toBe('');
  });
});
