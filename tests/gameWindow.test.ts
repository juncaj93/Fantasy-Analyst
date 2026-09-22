/**
 * The one definition of "football is on right now".
 *
 * Read by the schedule ingest, which uses it to decide how often to re-check
 * the fixture list, and by the three screens with a pull-to-refresh, which use
 * it to say whether pulling is likely to change anything. The cases below are
 * the ones a wall-clock table gets wrong — which is why this reads kickoffs.
 */

import { describe, expect, it } from 'vitest';
import { GAME_LENGTH_HOURS, gameWindowFrom } from '../src/core/nfl/gameWindow.ts';

const at = (iso: string) => new Date(iso);

describe('a kickoff opens a window and closes it again', () => {
  /** A 1pm Eastern Sunday in September, which is 17:00 UTC. */
  const SUNDAY_EARLY = '2026-09-20T17:00:00.000Z';

  it('is not live before the whistle', () => {
    const w = gameWindowFrom([SUNDAY_EARLY], at('2026-09-20T16:59:00.000Z'));
    expect(w.live).toBe(false);
    // And it says what is coming, so a screen can be specific rather than coy.
    expect(w.next).toBe(SUNDAY_EARLY);
  });

  it('is live at the whistle', () => {
    expect(gameWindowFrom([SUNDAY_EARLY], at(SUNDAY_EARLY)).live).toBe(true);
  });

  it('is still live three hours in, which is where most games are', () => {
    expect(gameWindowFrom([SUNDAY_EARLY], at('2026-09-20T20:00:00.000Z')).live).toBe(true);
  });

  it('closes after the game length, and not before', () => {
    const justInside = at('2026-09-20T20:29:00.000Z');
    const justOutside = at('2026-09-20T20:31:00.000Z');
    expect(gameWindowFrom([SUNDAY_EARLY], justInside).live).toBe(true);
    expect(gameWindowFrom([SUNDAY_EARLY], justOutside).live).toBe(false);
    expect(GAME_LENGTH_HOURS).toBe(3.5);
  });

  it('reports the later finish when two slates overlap', () => {
    /*
     * The one-o'clock games are still running when the four-o'clock ones
     * start, and the window has to be the union rather than the first one it
     * found — otherwise the refresh hint goes quiet at 4:30 on a Sunday, which
     * is the single worst moment for it to.
     */
    const w = gameWindowFrom([SUNDAY_EARLY, '2026-09-20T20:25:00.000Z'], at('2026-09-20T20:26:00.000Z'));
    expect(w.live).toBe(true);
    expect(w.until).toBe('2026-09-20T23:55:00.000Z');
  });
});

describe('the cases a wall-clock table gets wrong', () => {
  /*
   * Each of these is a real fixture slot that a table of Eastern ranges either
   * misses entirely or places an hour out. They pass here for free, because
   * nothing in this module knows what day of the week it is.
   */

  it('counts a London game at 09:30 Eastern', () => {
    const london = '2026-10-11T13:30:00.000Z';
    expect(gameWindowFrom([london], at('2026-10-11T14:00:00.000Z')).live).toBe(true);
  });

  it('counts a Thanksgiving afternoon game', () => {
    const thanksgiving = '2026-11-26T17:30:00.000Z';
    expect(gameWindowFrom([thanksgiving], at('2026-11-26T18:00:00.000Z')).live).toBe(true);
  });

  it('counts a December Saturday', () => {
    const saturday = '2026-12-19T21:00:00.000Z';
    expect(gameWindowFrom([saturday], at('2026-12-19T22:00:00.000Z')).live).toBe(true);
  });

  it('follows the clocks going back rather than being an hour out', () => {
    /*
     * The same 1pm Eastern Sunday fixture, in November, is 18:00 UTC and not
     * 17:00. A fixed UTC table would have called this live an hour early and
     * dead an hour early; the stored kickoff simply is what it is.
     */
    const november = '2026-11-15T18:00:00.000Z';
    expect(gameWindowFrom([november], at('2026-11-15T17:30:00.000Z')).live).toBe(false);
    expect(gameWindowFrom([november], at('2026-11-15T18:30:00.000Z')).live).toBe(true);
  });
});

describe('what it does with nothing usable', () => {
  it('is quiet on an empty fixture list', () => {
    expect(gameWindowFrom([], at('2026-09-20T17:00:00.000Z'))).toEqual({ live: false, until: null, next: null });
  });

  it('skips a fixture nobody has timed rather than placing it at the epoch', () => {
    /*
     * The failure this guards: `Date.parse(null)` is NaN and a naive
     * comparison would treat an untimed fixture as long finished, which is
     * harmless — but coercing it to 0 would put it in 1970 and report a bye
     * week as a slate that ended decades ago. Skipping says the true thing.
     */
    const w = gameWindowFrom([null, undefined, '', 'not a date'], at('2026-09-20T17:00:00.000Z'));
    expect(w).toEqual({ live: false, until: null, next: null });
  });

  it('still finds the good kickoff among bad ones', () => {
    const w = gameWindowFrom([null, 'nonsense', '2026-09-20T17:00:00.000Z'], at('2026-09-20T18:00:00.000Z'));
    expect(w.live).toBe(true);
  });

  it('gives no next kickoff once the season is behind it', () => {
    const w = gameWindowFrom(['2026-09-20T17:00:00.000Z'], at('2027-02-01T00:00:00.000Z'));
    expect(w).toEqual({ live: false, until: null, next: null });
  });
});
