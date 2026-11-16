/**
 * A fixed clock for tests that seed data by season.
 *
 * The app decides the season with `calendarSeason`: January still belongs to
 * the season that started in September. A test that seeds rows under
 * `new Date().getUTCFullYear()` agrees with the app from September to December
 * and disagrees from 1 January, which is week 17. These helpers pin the test to
 * that worst day and ask the app's own rule, so the answer never depends on the
 * day CI happens to run.
 */

import { vi } from 'vitest';
import { calendarSeason } from '../../src/core/season/context.ts';

/** Saturday 2 January 2027, noon Eastern: the eve of week 17. */
export const WEEK_17_EVE = new Date('2027-01-02T17:00:00Z');

/** The season the app reads on `at`. */
export function seasonOn(at: Date = WEEK_17_EVE): string {
  return calendarSeason(at);
}

/**
 * Runs `body` with `Date` pinned to `at`. Timers stay real, so waits and
 * timeouts behave as usual; only "what day is it" is fixed.
 */
export async function onDate<T>(at: Date, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}
