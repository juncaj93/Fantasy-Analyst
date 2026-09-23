import { describe, expect, it } from 'vitest';
import { nflverseFeedDue } from '../src/core/nflverse/cadence.ts';

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 23, h, m, s);

describe('which nflverse feed a five-minute tick owns', () => {
  it('hands the three feeds to three consecutive ticks, roster first', () => {
    expect(nflverseFeedDue(at(9, 30))).toBe('roster');
    expect(nflverseFeedDue(at(9, 35))).toBe('depth');
    expect(nflverseFeedDue(at(9, 40))).toBe('snaps');
  });

  it('repeats in the evening as a floor under a morning tick that did not fire', () => {
    expect(nflverseFeedDue(at(21, 30))).toBe('roster');
    expect(nflverseFeedDue(at(21, 35))).toBe('depth');
    expect(nflverseFeedDue(at(21, 40))).toBe('snaps');
  });

  it('owns exactly one five-minute tick per feed per pass', () => {
    let owned = 0;
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      if (nflverseFeedDue(at(Math.floor(minute / 60), minute % 60))) owned++;
    }
    expect(owned).toBe(6);
  });

  it('reads the scheduled minute, so a late delivery stays in its window', () => {
    expect(nflverseFeedDue(at(9, 34, 59))).toBe('roster');
    expect(nflverseFeedDue(at(9, 45))).toBeNull();
    expect(nflverseFeedDue(at(9, 29, 59))).toBeNull();
  });

  it('declines without a scheduled time rather than guessing one', () => {
    expect(nflverseFeedDue(undefined)).toBeNull();
    expect(nflverseFeedDue(Number.NaN)).toBeNull();
  });
});
