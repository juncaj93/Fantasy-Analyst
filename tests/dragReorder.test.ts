/**
 * The three decisions inside a long-press drag.
 *
 * Separated from the DOM so they can be checked without a browser, and worth
 * checking because each one has a failure that is invisible in a screenshot:
 * a hold threshold that steals scrolls, an index that lands half a row late,
 * and offsets that open two gaps instead of one.
 */

import { describe, expect, it } from 'vitest';
import {
  LONG_PRESS_MS,
  PRESS_SLOP,
  moveItem,
  pressVerdict,
  rowOffset,
  targetIndex,
} from '../src/core/draft/dragReorder.ts';

describe('scrolling wins until the press has been held', () => {
  it('is still deciding before the hold has elapsed', () => {
    expect(pressVerdict({ heldMs: 100, movedPx: 2 })).toBe('holding');
  });

  it('becomes a drag once held long enough without moving', () => {
    expect(pressVerdict({ heldMs: LONG_PRESS_MS, movedPx: 0 })).toBe('drag');
    expect(pressVerdict({ heldMs: LONG_PRESS_MS + 200, movedPx: PRESS_SLOP })).toBe('drag');
  });

  it('gives up the moment the finger moves more than the tremor tolerance', () => {
    expect(pressVerdict({ heldMs: 100, movedPx: PRESS_SLOP + 1 })).toBe('scroll');
  });

  /**
   * The failure this guards: a slow scroll that pauses is not a drag. Movement
   * past the slop is decisive whatever the elapsed time, so a gesture cannot be
   * reclaimed after it has been judged a scroll.
   */
  it('treats movement as decisive even after a long hold', () => {
    expect(pressVerdict({ heldMs: 5000, movedPx: PRESS_SLOP + 1 })).toBe('scroll');
  });

  it('tolerates a resting thumb', () => {
    expect(pressVerdict({ heldMs: LONG_PRESS_MS, movedPx: PRESS_SLOP - 1 })).toBe('drag');
  });
});

describe('the target index follows the finger', () => {
  const base = { fromIndex: 3, rowHeight: 60, count: 10 };

  it('stays put for movement inside half a row', () => {
    expect(targetIndex({ ...base, deltaY: 20 })).toBe(3);
    expect(targetIndex({ ...base, deltaY: -20 })).toBe(3);
  });

  it('swaps once the finger passes a row’s midpoint, not its edge', () => {
    expect(targetIndex({ ...base, deltaY: 31 })).toBe(4);
    expect(targetIndex({ ...base, deltaY: -31 })).toBe(2);
  });

  it('moves several rows at once', () => {
    expect(targetIndex({ ...base, deltaY: 180 })).toBe(6);
  });

  it('clamps at both ends of the list', () => {
    expect(targetIndex({ ...base, deltaY: 10_000 })).toBe(9);
    expect(targetIndex({ ...base, deltaY: -10_000 })).toBe(0);
  });

  it('refuses to guess when the row height is unknown', () => {
    expect(targetIndex({ ...base, rowHeight: 0, deltaY: 200 })).toBe(3);
  });
});

describe('the rows in between open exactly one gap', () => {
  const rowHeight = 60;

  it('moves the passed rows up when dragging down', () => {
    const at = (index: number) => rowOffset({ index, fromIndex: 1, toIndex: 4, rowHeight });
    expect(at(0)).toBe(0); // above the drag: untouched
    expect(at(1)).toBe(0); // the dragged row itself follows the finger
    expect([at(2), at(3), at(4)]).toEqual([-rowHeight, -rowHeight, -rowHeight]);
    expect(at(5)).toBe(0); // below the target: untouched
  });

  it('moves the passed rows down when dragging up', () => {
    const at = (index: number) => rowOffset({ index, fromIndex: 4, toIndex: 1, rowHeight });
    expect(at(0)).toBe(0);
    expect([at(1), at(2), at(3)]).toEqual([rowHeight, rowHeight, rowHeight]);
    expect(at(4)).toBe(0);
    expect(at(5)).toBe(0);
  });

  it('moves nothing when the target is where it started', () => {
    for (let i = 0; i < 6; i++) {
      expect(rowOffset({ index: i, fromIndex: 2, toIndex: 2, rowHeight })).toBe(0);
    }
  });

  /**
   * One gap opens and one closes — never two of either. Summed over the list,
   * the shifted rows have to account for exactly one row height of travel per
   * position moved.
   */
  it('shifts exactly as many rows as the drag travelled', () => {
    const shifted = Array.from({ length: 10 }, (_, i) =>
      rowOffset({ index: i, fromIndex: 2, toIndex: 7, rowHeight }),
    ).filter((offset) => offset !== 0);
    expect(shifted).toHaveLength(5);
    expect(new Set(shifted)).toEqual(new Set([-rowHeight]));
  });
});

describe('the optimistic list matches where the row was dropped', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('moves a row down', () => {
    expect(moveItem(ids, 0, 3)).toEqual(['b', 'c', 'd', 'a', 'e']);
  });

  it('moves a row up', () => {
    expect(moveItem(ids, 4, 1)).toEqual(['a', 'e', 'b', 'c', 'd']);
  });

  it('is a no-op for a row dropped where it started', () => {
    expect(moveItem(ids, 2, 2)).toEqual(ids);
  });

  it('clamps rather than losing a row off either end', () => {
    expect(moveItem(ids, 0, 99)).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(moveItem(ids, 4, -99)).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('never drops or duplicates a row', () => {
    for (let from = 0; from < ids.length; from++) {
      for (let to = 0; to < ids.length; to++) {
        expect(moveItem(ids, from, to).slice().sort()).toEqual([...ids].sort());
      }
    }
  });

  it('leaves the caller’s array alone', () => {
    const original = [...ids];
    moveItem(ids, 0, 4);
    expect(ids).toEqual(original);
  });
});
