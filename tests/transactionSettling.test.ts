/**
 * When a week of transactions may be locked.
 *
 * The dates are this league's own 2026 calendar: Sleeper moved to week 4 on
 * Tuesday 29 September, and week 3's waiver claims posted at 07:10 UTC on
 * Wednesday 30 September, filed under week 3.
 */

import { describe, expect, it } from 'vitest';
import { isTransactionWeekSettled } from '../src/core/league/transactionSettling.ts';

const at = (iso: string) => new Date(iso);
const settled = (week: number, now: string, finishedSeason = false) =>
  isTransactionWeekSettled({ week, currentWeek: 4, finishedSeason, now: at(now) });

describe('the transaction settle rule', () => {
  it('never locks the week being played', () => {
    for (const day of ['2026-09-29', '2026-10-01', '2026-10-04']) expect(settled(4, `${day}T12:00:00Z`)).toBe(false);
  });

  it('keeps last week open on Tuesday and Wednesday, when its waiver run posts', () => {
    expect(settled(3, '2026-09-29T09:00:00Z')).toBe(false);
    // The run itself, and the daily read two hours after it.
    expect(settled(3, '2026-09-30T07:10:00Z')).toBe(false);
    expect(settled(3, '2026-09-30T09:00:00Z')).toBe(false);
  });

  it('locks last week from Thursday, after the run has posted', () => {
    expect(settled(3, '2026-10-01T09:00:00Z')).toBe(true);
    expect(settled(3, '2026-10-05T09:00:00Z')).toBe(true);
  });

  it('locks every older week whatever the day', () => {
    expect(settled(2, '2026-09-29T09:00:00Z')).toBe(true);
    expect(settled(1, '2026-09-30T09:00:00Z')).toBe(true);
  });

  it('locks everything in a finished season', () => {
    expect(settled(4, '2026-09-30T09:00:00Z', true)).toBe(true);
    expect(settled(3, '2026-09-29T09:00:00Z', true)).toBe(true);
  });
});
