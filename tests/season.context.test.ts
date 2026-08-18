/**
 * Which season it is.
 *
 * Every test here is a date on which the old arithmetic gave a different answer
 * from Sleeper, or on which two of the six copies of that arithmetic gave
 * different answers from each other. The February and January cases are the
 * ones that used to bite: a calendar guess and a live provider disagree for
 * about six weeks a year, and those six weeks are exactly when a rollover is
 * happening.
 */

import { describe, expect, it } from 'vitest';
import {
  STATE_STALE_AFTER_DAYS,
  calendarSeason,
  isCurrentSeason,
  priorSeason,
  resolveSeasonContext,
} from '../src/core/season/context.ts';

const at = (iso: string) => new Date(iso);

describe('Sleeper is the authority', () => {
  it('takes the season from /state/nfl whatever the calendar says', () => {
    /*
     * The case the calendar gets wrong, and the reason this module exists.
     *
     * On 5 January 2027 the calendar guess says "2026" — correct, as it
     * happens. But if Sleeper had already rolled to 2027 (dynasty leagues roll
     * early, and Sleeper's state is what the rest of the app's data is stamped
     * with), the guess would be a year behind the data. Sleeper wins.
     */
    const ctx = resolveSeasonContext({
      state: { season: '2027', seasonType: 'off', week: 0, fetchedAt: '2027-01-05T00:00:00Z' },
      now: at('2027-01-05T12:00:00Z'),
    });
    expect(ctx.season).toBe('2027');
    expect(ctx.source).toBe('sleeper_state');
    expect(ctx.assumed).toBe(false);
  });

  it('carries the week and season type through', () => {
    const ctx = resolveSeasonContext({
      state: { season: '2026', seasonType: 'regular', week: 3, fetchedAt: '2026-09-24T00:00:00Z' },
      now: at('2026-09-24T12:00:00Z'),
    });
    expect(ctx.seasonType).toBe('regular');
    expect(ctx.week).toBe(3);
    expect(ctx.previousSeason).toBe('2025');
  });

  it('ignores a state with no usable season', () => {
    const ctx = resolveSeasonContext({
      state: { season: null, seasonType: 'regular', week: 3, fetchedAt: '2026-09-24T00:00:00Z' },
      league: { season: '2026' },
      now: at('2026-09-24T12:00:00Z'),
    });
    expect(ctx.source).toBe('league');
    expect(ctx.season).toBe('2026');
  });
});

describe('falling back, and saying so', () => {
  it('uses the selected league when Sleeper has never been read', () => {
    const ctx = resolveSeasonContext({ state: null, league: { season: '2026' }, now: at('2027-02-01T00:00:00Z') });
    expect(ctx.season).toBe('2026');
    expect(ctx.source).toBe('league');
    expect(ctx.assumed).toBe(false);
  });

  it('falls back to the calendar and marks the answer as a guess', () => {
    const ctx = resolveSeasonContext({ now: at('2027-09-01T00:00:00Z') });
    expect(ctx.season).toBe('2027');
    expect(ctx.source).toBe('calendar');
    expect(ctx.assumed).toBe(true);
    // The distinction the readiness check keys on: a guess is never "ready".
    expect(ctx.reason).toContain('assuming');
  });

  it('knows the league year rolls over in March, not January', () => {
    // A January date belongs to the season that started the previous autumn.
    expect(calendarSeason(at('2027-01-15T00:00:00Z'))).toBe('2026');
    expect(calendarSeason(at('2027-02-28T00:00:00Z'))).toBe('2026');
    expect(calendarSeason(at('2027-03-01T00:00:00Z'))).toBe('2027');
    expect(calendarSeason(at('2027-12-31T00:00:00Z'))).toBe('2027');
  });
});

describe('a state that has not been refreshed is still used, but flagged', () => {
  it('marks state older than the threshold as stale', () => {
    const fetched = '2027-01-01T00:00:00Z';
    const later = new Date(Date.parse(fetched) + (STATE_STALE_AFTER_DAYS + 1) * 86_400_000);
    const ctx = resolveSeasonContext({
      state: { season: '2026', seasonType: 'post', week: 1, fetchedAt: fetched },
      now: later,
    });
    // Still used — it is the best thing available — but the report says so, and
    // the readiness check refuses to call the app ready on it.
    expect(ctx.season).toBe('2026');
    expect(ctx.stateStale).toBe(true);
    expect(ctx.reason).toContain('not recently');
  });

  it('does not flag state read this morning', () => {
    const ctx = resolveSeasonContext({
      state: { season: '2026', seasonType: 'regular', week: 4, fetchedAt: '2026-10-01T06:00:00Z' },
      now: at('2026-10-01T12:00:00Z'),
    });
    expect(ctx.stateStale).toBe(false);
  });

  it('treats a state with no timestamp as stale', () => {
    const ctx = resolveSeasonContext({
      state: { season: '2026', seasonType: 'regular', week: 4, fetchedAt: null },
      now: at('2026-10-01T12:00:00Z'),
    });
    expect(ctx.stateStale).toBe(true);
  });
});

describe('the current-season guard', () => {
  it('accepts only the exact current season', () => {
    const ctx = resolveSeasonContext({
      state: { season: '2027', seasonType: 'pre', week: 0, fetchedAt: '2027-08-01T00:00:00Z' },
      now: at('2027-08-01T12:00:00Z'),
    });
    expect(isCurrentSeason('2027', ctx)).toBe(true);
    // The whole point: last season's data is not "the best we have", it is
    // simply not this season's, and no amount of it being the newest thing in
    // the table changes that.
    expect(isCurrentSeason('2026', ctx)).toBe(false);
    expect(isCurrentSeason(null, ctx)).toBe(false);
    expect(isCurrentSeason(undefined, ctx)).toBe(false);
  });

  it('steps back a season without calendar arithmetic', () => {
    expect(priorSeason('2027')).toBe('2026');
    expect(priorSeason('2000')).toBe('1999');
  });
});
