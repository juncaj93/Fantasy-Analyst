/**
 * Which rows the board calls level.
 *
 * The rule is narrow on purpose — a row is level when the row directly above or
 * below shows the same whole-number Score — and the edges are where a narrow
 * rule goes wrong: the ends of the list, a run of more than two, players no
 * market has priced, and two players with the same Score who are not next to
 * each other.
 */

import { describe, expect, it } from 'vitest';
import { levelRunSize, levelWithNeighbour } from '../src/core/draft/levelScores.ts';

describe('level with a neighbour', () => {
  it('marks a pair and leaves the rows either side alone', () => {
    expect(levelWithNeighbour([87, 85, 85, 82])).toEqual([false, true, true, false]);
  });

  it('marks every row of a longer run', () => {
    expect(levelWithNeighbour([76, 75, 74, 74, 74, 74, 71])).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  /** The first and last rows have only one neighbour, and it still counts. */
  it('handles both ends of the board', () => {
    expect(levelWithNeighbour([90, 90, 80])).toEqual([true, true, false]);
    expect(levelWithNeighbour([90, 80, 80])).toEqual([false, true, true]);
    expect(levelWithNeighbour([90])).toEqual([false]);
    expect(levelWithNeighbour([])).toEqual([]);
  });

  /**
   * Two rows apart is not the confusion this exists for.
   *
   * Marking every repeat of a value would put the mark on most of the board and
   * say nothing about why a player moved: what makes a slide look arbitrary is
   * the players immediately around him being on his number.
   */
  it('does not mark equal scores that are not adjacent', () => {
    expect(levelWithNeighbour([85, 80, 85])).toEqual([false, false, false]);
  });

  /**
   * A player no market has priced prints a dash, not a number.
   *
   * Two dashes in a row are not two players who are level; they are two players
   * whose composites are not on the priced scale at all. Marking them would
   * claim a comparison that the board is explicit about refusing to make.
   */
  it('never calls unpriced players level', () => {
    expect(levelWithNeighbour([74, null, null, 60])).toEqual([false, false, false, false]);
    expect(levelWithNeighbour([null, 74, 74])).toEqual([false, true, true]);
  });
});

describe('how big the run is', () => {
  it('counts the whole run from anywhere inside it', () => {
    const scores = [76, 74, 74, 74, 74, 71];
    expect(levelRunSize(scores, 1)).toBe(4);
    expect(levelRunSize(scores, 2)).toBe(4);
    expect(levelRunSize(scores, 4)).toBe(4);
  });

  it('counts a row with nobody beside it as one', () => {
    expect(levelRunSize([87, 85, 82], 0)).toBe(1);
    expect(levelRunSize([87, 85, 82], 1)).toBe(1);
  });

  it('counts an unpriced row as one', () => {
    expect(levelRunSize([null, null], 0)).toBe(1);
  });
});
