/**
 * Sorting reorders and does nothing else.
 *
 * The property worth a permanent test is not which order comes out — that is
 * one comparison function and it is obvious. It is that switching the control
 * cannot change a single number on a single card. A sort that quietly
 * renormalised a Score, or recomputed a tier from the new neighbours, would
 * look completely correct: the rows would be in the right order and the numbers
 * on them would be wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT_MODE,
  SORT_MODES,
  hasDogCoverage,
  isSortMode,
  sortBoard,
} from '../src/core/draft/boardSort.ts';

interface Row {
  playerId: string;
  name: string;
  score: number;
  total: number;
  adp: number | null;
  dogAdp: number | null;
  survivalProbability: number | null;
  tierIndex: number | null;
  queued: boolean;
  myGuyLevel: number;
  newsLifetimeNet: number;
  adpValue: number | null;
}

const BOARD: Row[] = [
  row('a', 'Alpha', 91, 0.5, 54.5, 48.2),
  row('b', 'Bravo', 88, 0.2, 12.1, 61.7),
  row('c', 'Charlie', 84, -0.1, 70.0, 52.0),
  row('d', 'Delta', 80, -0.4, 33.3, null),
  row('e', 'Echo', 77, -0.9, null, 22.5),
  row('f', 'Foxtrot', 70, -1.4, null, null),
];

function row(
  playerId: string,
  name: string,
  score: number,
  total: number,
  adp: number | null,
  dogAdp: number | null,
): Row {
  return {
    playerId,
    name,
    score,
    total,
    adp,
    dogAdp,
    survivalProbability: 0.4,
    tierIndex: 1,
    queued: false,
    myGuyLevel: 0,
    newsLifetimeNet: 3,
    adpValue: adp == null ? null : 60 - adp,
  };
}

describe('the three modes order by what they name', () => {
  it('defaults to Score', () => {
    expect(DEFAULT_SORT_MODE).toBe('score');
    expect(SORT_MODES).toEqual(['score', 'adp', 'dog', 'pts']);
  });

  it('Score uses the full composite, in the engine’s own order', () => {
    expect(sortBoard(BOARD, 'score').map((r) => r.playerId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  /**
   * Score sorts on `total`, not on the rounded 0-100 `score`. Two players whose
   * composites round to the same whole number are genuinely different and the
   * board separated them; sorting on the rounded value would collapse them into
   * a tie and then re-break it alphabetically.
   */
  it('Score separates players whose rounded scores tie', () => {
    const tied = [row('x', 'Xray', 85, -0.2, 20, 20), row('y', 'Yankee', 85, 0.3, 30, 30)];
    expect(sortBoard(tied, 'score').map((r) => r.playerId)).toEqual(['y', 'x']);
  });

  it('ADP uses Sleeper ADP ascending, and only Sleeper ADP', () => {
    const sorted = sortBoard(BOARD, 'adp');
    expect(sorted.slice(0, 4).map((r) => r.adp)).toEqual([12.1, 33.3, 54.5, 70.0]);
  });

  it('DOG uses raw Underdog ADP ascending, and only Underdog ADP', () => {
    const sorted = sortBoard(BOARD, 'dog');
    expect(sorted.slice(0, 4).map((r) => r.dogAdp)).toEqual([22.5, 48.2, 52.0, 61.7]);
  });

  /**
   * The two market sorts must genuinely disagree — if a DOG sort happened to be
   * the ADP sort, a bug substituting one column for the other would pass every
   * other test in this file.
   */
  it('produces a different order for ADP than for DOG', () => {
    expect(sortBoard(BOARD, 'adp').map((r) => r.playerId)).not.toEqual(
      sortBoard(BOARD, 'dog').map((r) => r.playerId),
    );
  });
});

describe('missing values go to the bottom, never to the top', () => {
  it('puts players with no Sleeper ADP last under ADP', () => {
    const sorted = sortBoard(BOARD, 'adp');
    expect(sorted.slice(-2).map((r) => r.adp)).toEqual([null, null]);
  });

  it('puts players with no DOG last under DOG', () => {
    const sorted = sortBoard(BOARD, 'dog');
    expect(sorted.slice(-2).map((r) => r.dogAdp)).toEqual([null, null]);
  });

  it('orders the unpriced tail by the composite rather than by accident', () => {
    // Delta (total -0.4) ahead of Foxtrot (-1.4) among the DOG-less.
    const tail = sortBoard(BOARD, 'dog').slice(-2);
    expect(tail.map((r) => r.playerId)).toEqual(['d', 'f']);
  });

  it('never substitutes the other market for a missing one', () => {
    // Echo has no Sleeper ADP but does have DOG. Under ADP he is in the tail;
    // under DOG he is first. A column filled from the other would put him in a
    // plausible middle position under both.
    expect(sortBoard(BOARD, 'adp').at(-1)!.playerId === 'e' || sortBoard(BOARD, 'adp').at(-2)!.playerId === 'e').toBe(
      true,
    );
    expect(sortBoard(BOARD, 'dog')[0]!.playerId).toBe('e');
  });
});

describe('switching the sort mutates nothing', () => {
  it('returns the same objects, not copies', () => {
    for (const mode of SORT_MODES) {
      for (const sorted of sortBoard(BOARD, mode)) {
        expect(BOARD.some((original) => original === sorted)).toBe(true);
      }
    }
  });

  it('leaves Score, Val, Next, tier, tally, queue and My Guy untouched', () => {
    const before = JSON.stringify(BOARD);
    for (const mode of SORT_MODES) sortBoard(BOARD, mode);
    expect(JSON.stringify(BOARD)).toBe(before);
  });

  it('returns every player in every mode, losing none', () => {
    for (const mode of SORT_MODES) {
      const ids = sortBoard(BOARD, mode).map((r) => r.playerId).sort();
      expect(ids).toEqual(BOARD.map((r) => r.playerId).sort());
    }
  });

  it('is stable across repeated switching', () => {
    const first = sortBoard(BOARD, 'dog').map((r) => r.playerId);
    sortBoard(BOARD, 'adp');
    sortBoard(BOARD, 'score');
    expect(sortBoard(BOARD, 'dog').map((r) => r.playerId)).toEqual(first);
  });

  it('round-trips back to the board the server sent', () => {
    const original = sortBoard(BOARD, 'score').map((r) => r.playerId);
    const viaDog = sortBoard(sortBoard(BOARD, 'dog'), 'score').map((r) => r.playerId);
    expect(viaDog).toEqual(original);
  });
});

describe('the control knows when DOG has nothing to order by', () => {
  it('reports coverage when at least one player is priced', () => {
    expect(hasDogCoverage(BOARD)).toBe(true);
  });

  it('reports none when no player is', () => {
    expect(hasDogCoverage(BOARD.map((r) => ({ ...r, dogAdp: null })))).toBe(false);
  });

  it('recognises only the three real modes', () => {
    expect(isSortMode('dog')).toBe(true);
    expect(isSortMode('projection')).toBe(false);
    expect(isSortMode(null)).toBe(false);
  });
});
