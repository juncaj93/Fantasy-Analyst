import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs workflow script, deliberately not part of the app build
import { judgeDailyTick, rowFromWranglerJson, MAX_AGE_HOURS, SQL, DAILY_CRON } from '../scripts/daily-tick-watch.mjs';

/*
 * The 09:00 tick writes its run record last, so a tick killed part-way through
 * leaves yesterday's row standing. From 19 to 23 September 2026 that is exactly
 * what happened, and nothing said so. These pin the watch that now does.
 */

const at = (iso: string) => new Date(iso);
const row = (finished: string | null, outcome = 'partial') => ({
  cron: DAILY_CRON,
  started_at: '2026-09-24T09:00:32.000Z',
  finished_at: finished,
  outcome,
});

describe('the verdict on the 09:00 tick', () => {
  it('is quiet on a morning that finished', () => {
    const v = judgeDailyTick(row('2026-09-24T09:02:45.000Z'), at('2026-09-24T10:15:00Z'));
    expect(v.ok).toBe(true);
    expect(v.message).toContain('09:02:45');
  });

  it('is quiet when GitHub starts the watch hours late on a healthy morning', () => {
    expect(judgeDailyTick(row('2026-09-24T09:02:45.000Z'), at('2026-09-24T16:00:00Z')).ok).toBe(true);
  });

  it('fails the same morning a tick does not finish', () => {
    /*
     * The September incident on its first morning: the 19th's tick died, so at
     * 10:15 on the 19th the newest record is the 18th's, 25.2 hours old. That
     * is reported that morning, rather than five days later by somebody who
     * happened to look.
     */
    const v = judgeDailyTick(row('2026-09-18T09:02:45.811Z'), at('2026-09-19T10:15:00Z'));
    expect(v.ok).toBe(false);
    expect(v.message).toContain('Who is calling production');
  });

  it('draws the line at the limit', () => {
    const finished = '2026-09-23T08:00:00.000Z';
    const justInside = new Date(Date.parse(finished) + (MAX_AGE_HOURS * 3600 - 60) * 1000);
    const justOutside = new Date(Date.parse(finished) + (MAX_AGE_HOURS * 3600 + 60) * 1000);
    expect(judgeDailyTick(row(finished), justInside).ok).toBe(true);
    expect(judgeDailyTick(row(finished), justOutside).ok).toBe(false);
  });

  it('fails when there is no record at all, or no finish time', () => {
    expect(judgeDailyTick(null, at('2026-09-24T10:15:00Z')).ok).toBe(false);
    expect(judgeDailyTick(row(null), at('2026-09-24T10:15:00Z')).ok).toBe(false);
    expect(judgeDailyTick(row('not a date'), at('2026-09-24T10:15:00Z')).ok).toBe(false);
  });

  it('fails a fresh run on which every step failed, and not one that was only partial', () => {
    expect(judgeDailyTick(row('2026-09-24T09:02:45.000Z', 'failed'), at('2026-09-24T10:15:00Z')).ok).toBe(false);
    expect(judgeDailyTick(row('2026-09-24T09:02:45.000Z', 'partial'), at('2026-09-24T10:15:00Z')).ok).toBe(true);
  });
});

describe('reading what wrangler printed', () => {
  // The shape `wrangler d1 execute --remote --json` printed in production on 23
  // September (Who is calling production, run 35839896074), with a banner line.
  const printed = (results: unknown[]) =>
    'Resource location: remote\n' +
    JSON.stringify([{ results, success: true, meta: { rows_read: 1, rows_written: 0 } }], null, 2);

  it('finds the row', () => {
    expect(rowFromWranglerJson(printed([row('2026-09-24T09:02:45.000Z')]))).toMatchObject({
      finished_at: '2026-09-24T09:02:45.000Z',
    });
  });

  it('is not misled by a warning wrangler prints before the result', () => {
    const noisy = '▲ [WARNING] You are using an outdated wrangler config\n' + printed([row('2026-09-24T09:02:45.000Z')]);
    expect(rowFromWranglerJson(noisy)).toMatchObject({ finished_at: '2026-09-24T09:02:45.000Z' });
  });

  it('reads an empty result as no row, which the verdict then reports', () => {
    expect(rowFromWranglerJson(printed([]))).toBeNull();
  });

  it('refuses output it cannot read, rather than reporting a dead tick it did not see', () => {
    expect(() => rowFromWranglerJson('✘ [ERROR] D1 daily read limit exceeded')).toThrow();
    expect(() => rowFromWranglerJson(JSON.stringify([{ success: false }]))).toThrow();
  });

  it('asks only for the daily clock, and only reads', () => {
    expect(SQL).toContain(`cron = '${DAILY_CRON}'`);
    expect(SQL.trim().toUpperCase().startsWith('SELECT')).toBe(true);
  });
});

describe('the workflow', () => {
  const yml = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'daily-tick-watch.yml'), 'utf8');

  it('runs an hour after the tick it watches', () => {
    expect(yml).toContain("cron: '15 10 * * *'");
  });

  it('uses the script and its SQL rather than a copy of either', () => {
    expect(yml).toContain('node scripts/daily-tick-watch.mjs < record.json');
    expect(yml).toContain("import('./scripts/daily-tick-watch.mjs')");
  });
});
