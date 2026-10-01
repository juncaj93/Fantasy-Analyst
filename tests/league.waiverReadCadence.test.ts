/** The league re-read: every three hours at a quarter past, on one tick each time. */

import { describe, expect, it } from 'vitest';
import { waiverReadDue } from '../src/core/league/waiverReadCadence.ts';
import { nflverseFeedDue } from '../src/core/nflverse/cadence.ts';

const at = (iso: string) => Date.parse(iso);

describe('the league read clock', () => {
  it('fires on the 15-minute tick of every third hour', () => {
    expect(waiverReadDue(at('2026-10-01T00:15:00Z'))).toBe(true);
    expect(waiverReadDue(at('2026-10-01T09:15:00Z'))).toBe(true);
    expect(waiverReadDue(at('2026-10-01T21:15:00Z'))).toBe(true);
  });

  it('fires once a window, eight times a day', () => {
    let hits = 0;
    for (let m = 0; m < 24 * 60; m += 5) {
      if (waiverReadDue(at('2026-10-01T00:00:00Z') + m * 60_000)) hits++;
    }
    expect(hits).toBe(8);
  });

  it('stays off the other hours and the other ticks', () => {
    expect(waiverReadDue(at('2026-10-01T10:15:00Z'))).toBe(false);
    expect(waiverReadDue(at('2026-10-01T09:10:00Z'))).toBe(false);
    expect(waiverReadDue(at('2026-10-01T09:20:00Z'))).toBe(false);
    expect(waiverReadDue(undefined)).toBe(false);
  });

  it('never shares a tick with an nflverse feed', () => {
    for (let m = 0; m < 24 * 60; m += 5) {
      const t = at('2026-10-01T00:00:00Z') + m * 60_000;
      if (waiverReadDue(t)) expect(nflverseFeedDue(t)).toBeNull();
    }
  });
});
