/**
 * Two clocks that are set in a time zone rather than in UTC.
 *
 *   - manager tendencies: Wednesday midday, Detroit time, after waivers run;
 *   - the schedule's post-flex checks: Tuesday evening and Wednesday, Eastern.
 *
 * Both are asked of the zone database, never answered with a fixed UTC hour,
 * because the season crosses the end of daylight saving time. In 2026 that is
 * Sunday 1 November: Detroit noon is 16:00 UTC the Wednesday before it and 17:00
 * UTC the Wednesday after, and an hour's difference is the difference between
 * running after waivers and running before them.
 */

import { describe, expect, it } from 'vitest';
import { managerIntelWindow } from '../src/core/league/managerIntelCadence.ts';
import { FLEX_CHECK_WINDOWS, scheduleFlexCheckDue } from '../src/core/nfl/flexCheck.ts';
import { zonedDate, zonedParts } from '../src/core/time/zoned.ts';
import { waiverReadDue } from '../src/core/league/waiverReadCadence.ts';
import { nflverseFeedDue } from '../src/core/nflverse/cadence.ts';

const at = (iso: string) => Date.parse(iso);

/** Every five-minute tick in a UTC day, as scheduled times. */
function ticksOf(day: string): number[] {
  const start = at(`${day}T00:00:00Z`);
  return Array.from({ length: 288 }, (_, i) => start + i * 5 * 60_000);
}

describe('wall-clock parts', () => {
  it('reads Detroit as four hours behind UTC in October and five in November', () => {
    expect(zonedParts(at('2026-10-28T16:00:00Z'), 'America/Detroit')).toMatchObject({ weekday: 3, hour: 12, minute: 0 });
    expect(zonedParts(at('2026-11-04T17:00:00Z'), 'America/Detroit')).toMatchObject({ weekday: 3, hour: 12, minute: 0 });
  });

  it('puts the changeover on the first Sunday of November, to the hour', () => {
    // 06:00 UTC on Sunday 1 November is 02:00 EDT, the instant the clocks go
    // back to 01:00 EST.
    expect(zonedParts(at('2026-11-01T05:59:00Z'), 'America/Detroit')).toMatchObject({ day: 1, hour: 1, minute: 59 });
    expect(zonedParts(at('2026-11-01T06:00:00Z'), 'America/Detroit')).toMatchObject({ day: 1, hour: 1, minute: 0 });
  });

  it('gives the local calendar date, which is not always the UTC one', () => {
    // Midnight UTC is still the evening before in Detroit.
    expect(zonedDate(at('2026-10-29T00:00:00Z'), 'America/Detroit')).toBe('2026-10-28');
  });
});

describe('the weekly manager-tendencies window', () => {
  it('opens at Wednesday noon Detroit time before the clocks change', () => {
    expect(managerIntelWindow(at('2026-10-28T16:00:00Z'))).toBe('2026-10-28');
    expect(managerIntelWindow(at('2026-10-28T15:55:00Z'))).toBeNull();
  });

  it('opens at Wednesday noon Detroit time after the clocks change, an hour later in UTC', () => {
    expect(managerIntelWindow(at('2026-11-04T17:00:00Z'))).toBe('2026-11-04');
    // 16:00 UTC is 11:00 in Detroit that week: a fixed UTC hour would fire here.
    expect(managerIntelWindow(at('2026-11-04T16:00:00Z'))).toBeNull();
    expect(managerIntelWindow(at('2026-11-04T16:55:00Z'))).toBeNull();
  });

  it('is two hours wide, 24 ticks, and closes at 14:00 local', () => {
    const edt = ticksOf('2026-10-28').filter((t) => managerIntelWindow(t) != null);
    expect(edt).toHaveLength(24);
    expect(new Date(edt[0]!).toISOString()).toBe('2026-10-28T16:00:00.000Z');
    expect(new Date(edt.at(-1)!).toISOString()).toBe('2026-10-28T17:55:00.000Z');

    const est = ticksOf('2026-11-04').filter((t) => managerIntelWindow(t) != null);
    expect(est).toHaveLength(24);
    expect(new Date(est[0]!).toISOString()).toBe('2026-11-04T17:00:00.000Z');
  });

  it('fires on no other weekday, across a whole fortnight either side of the change', () => {
    let hits = 0;
    for (let d = 0; d < 14; d++) {
      const day = new Date(at('2026-10-26T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
      for (const t of ticksOf(day)) if (managerIntelWindow(t) != null) hits++;
    }
    // Two Wednesdays, 24 ticks each.
    expect(hits).toBe(48);
  });

  it('is keyed by the Detroit date, so the late evening of Tuesday UTC is not a Wednesday', () => {
    expect(managerIntelWindow(at('2026-10-28T03:00:00Z'))).toBeNull(); // Tuesday 11pm in Detroit
  });

  it('ignores a missing or unusable time', () => {
    expect(managerIntelWindow(undefined)).toBeNull();
    expect(managerIntelWindow(Number.NaN)).toBeNull();
  });

  it('also arrives in the spring, when the clocks go forward', () => {
    // 2027: daylight time returns Sunday 14 March, so noon on Wednesday 17 March
    // is back to 16:00 UTC. Nothing is played then and the arithmetic still holds.
    expect(managerIntelWindow(at('2027-03-17T16:00:00Z'))).toBe('2027-03-17');
    expect(managerIntelWindow(at('2027-03-10T17:00:00Z'))).toBe('2027-03-10');
    expect(managerIntelWindow(at('2027-03-10T16:00:00Z'))).toBeNull();
  });
});

describe('the post-flex schedule checks', () => {
  it('has three windows, all Tuesday evening or Wednesday', () => {
    expect(FLEX_CHECK_WINDOWS).toHaveLength(3);
    for (const w of FLEX_CHECK_WINDOWS) expect([2, 3]).toContain(w.weekday);
  });

  it('fires at 21:00 Eastern on Tuesday, which is 01:00 UTC before the change and 02:00 after', () => {
    expect(scheduleFlexCheckDue(at('2026-10-28T01:00:00Z'))).toBe(true); // Tue 27 Oct, 9pm EDT
    expect(scheduleFlexCheckDue(at('2026-11-04T02:00:00Z'))).toBe(true); // Tue 3 Nov, 9pm EST
    expect(scheduleFlexCheckDue(at('2026-11-04T01:00:00Z'))).toBe(false); // 8pm EST
  });

  it('fires at 09:00 and 15:00 Eastern on Wednesday', () => {
    expect(scheduleFlexCheckDue(at('2026-10-28T13:00:00Z'))).toBe(true);
    expect(scheduleFlexCheckDue(at('2026-10-28T19:00:00Z'))).toBe(true);
    expect(scheduleFlexCheckDue(at('2026-11-04T14:00:00Z'))).toBe(true);
    expect(scheduleFlexCheckDue(at('2026-11-04T20:00:00Z'))).toBe(true);
    expect(scheduleFlexCheckDue(at('2026-11-04T13:00:00Z'))).toBe(false);
  });

  it('is exactly three ticks a week', () => {
    let hits = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(at('2026-10-26T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
      for (const t of ticksOf(day)) if (scheduleFlexCheckDue(t)) hits++;
    }
    expect(hits).toBe(3);
    hits = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(at('2026-11-02T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
      for (const t of ticksOf(day)) if (scheduleFlexCheckDue(t)) hits++;
    }
    expect(hits).toBe(3);
  });

  it('ignores a missing time', () => {
    expect(scheduleFlexCheckDue(undefined)).toBe(false);
  });
});

describe('neither clock lands on a tick that is already heavy', () => {
  it('never shares a tick with an nflverse file, whichever side of the change', () => {
    for (const day of ['2026-10-27', '2026-10-28', '2026-11-03', '2026-11-04']) {
      for (const t of ticksOf(day)) {
        if (scheduleFlexCheckDue(t)) expect(nflverseFeedDue(t), new Date(t).toISOString()).toBeNull();
        if (managerIntelWindow(t) != null && nflverseFeedDue(t)) throw new Error(`overlap at ${new Date(t).toISOString()}`);
      }
    }
  });

  it('can share a tick with the league read in winter, which is why the worker skips that tick', () => {
    // 18:15 UTC on 4 November is 13:15 in Detroit: in the window, and a
    // league-read tick. Documented here so the skip in the worker is not
    // mistaken for a leftover.
    const t = at('2026-11-04T18:15:00Z');
    expect(managerIntelWindow(t)).not.toBeNull();
    expect(waiverReadDue(t)).toBe(true);
  });
});
