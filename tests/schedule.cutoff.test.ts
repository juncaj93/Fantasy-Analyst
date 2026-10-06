/**
 * A fixture-list refresh that is cut off must not be retried on the next tick.
 *
 * ## The outage this pins
 *
 * From 27 September 2026 09:15 UTC to 28 September 05:40 UTC Cloudflare ended
 * 246 consecutive five-minute ticks `exceededCpu`. Its own records say so
 * (`workersInvocationsScheduled`, probe-cron-outcomes.mjs), and the database
 * says why: the fixture list was last written at 03:10 that morning, its
 * six-hour interval came due at 09:10, and the first kill is the 09:15 tick.
 * Each killed run had already logged the injury check's 304 and died after it.
 *
 * The refresh downloaded and parsed 2.2MB -- 67-129ms of CPU in production
 * against a 10ms allowance -- and recorded that it had run only *after* doing
 * so. A kill leaves no record, so every following tick found it just as overdue
 * and was killed the same way.
 *
 * Two things now stop that, and each is held here:
 *
 *   - the attempt is written before the work, so a run that never comes back
 *     still moves `checked_at` and counts as a failure;
 *   - the parse jumps to the season's first line instead of splitting every
 *     season since 1999.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import {
  SCHEDULE_CHECK_INTERVAL_MINUTES,
  SCHEDULE_SOURCE,
  STARTED_NOTE,
  ScheduleService,
} from '../src/server/services/scheduleService.ts';
import { ScheduleSourceRepo } from '../src/server/repos/nflSchedule.ts';
import { parseSchedule } from '../src/core/nfl/schedule.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = '2026';
const KILLED_AT = new Date('2026-09-27T09:15:27.000Z');
const NEXT_TICK = new Date('2026-09-27T09:20:27.000Z');

/** The state row as it was at 09:15 that morning: last checked a day and a bit earlier. */
async function overdue(db: Database): Promise<void> {
  await new ScheduleSourceRepo(db).recordCheck(SCHEDULE_SOURCE, SEASON, {
    checkedAt: '2026-09-26T03:10:36.557Z',
    etag: '"schedule-v1"',
    outcome: 'ok',
    note: null,
  });
}

/**
 * A network that never answers: the closest a test can come to an invocation
 * the runtime stops mid-download. Nothing after the `await` ever runs, exactly
 * as nothing after the kill did.
 */
function hangingService(db: Database, now: Date, onFetch: () => void) {
  return new ScheduleService(db, {
    now: () => now,
    fetch: (() => {
      onFetch();
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
  });
}

/** Let every write that runs before the fetch settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a refresh cut off mid-download', () => {
  it('is not tried again on the next tick', async () => {
    const db = await createTestDb();
    await overdue(db);

    let fetches = 0;
    // The 09:15 tick: due, starts, and never comes back.
    void hangingService(db, KILLED_AT, () => (fetches += 1)).refreshIfDue(SEASON);
    await settle();
    expect(fetches).toBe(1);

    // The 09:20 tick. Before the fix this was due again, and was killed again,
    // 246 times. The lease has expired by then, so only the record can stop it.
    const next = hangingService(db, NEXT_TICK, () => (fetches += 1)).refreshIfDue(SEASON);
    await settle();
    expect(fetches, 'the 09:20 tick must not start a second download').toBe(1);
    const answer = await Promise.race([next, settle().then(() => 'still downloading' as const)]);
    expect(answer, 'not due: the cut-off attempt counts as the check').toBeNull();
  });

  it('is tried again once its interval has passed', async () => {
    const db = await createTestDb();
    await overdue(db);
    let fetches = 0;
    void hangingService(db, KILLED_AT, () => (fetches += 1)).refreshIfDue(SEASON);
    await settle();

    const later = new Date(KILLED_AT.getTime() + (SCHEDULE_CHECK_INTERVAL_MINUTES + 5) * 60_000);
    void hangingService(db, later, () => (fetches += 1)).refreshIfDue(SEASON);
    await settle();
    expect(fetches).toBe(2);
  });

  it('reads as a failure, not as a healthy check', async () => {
    const db = await createTestDb();
    await overdue(db);
    void hangingService(db, KILLED_AT, () => {}).refreshIfDue(SEASON);
    await settle();

    const state = await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, SEASON);
    expect(state?.checkedAt).toBe(KILLED_AT.toISOString());
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.lastNote).toBe(STARTED_NOTE);
    // What an earlier ingest established is kept.
    expect(state?.etag).toBe('"schedule-v1"');
  });

  it('is cleared by the next refresh that does come back', async () => {
    const db = await createTestDb();
    await overdue(db);
    void hangingService(db, KILLED_AT, () => {}).refreshIfDue(SEASON);
    await settle();

    const later = new Date(KILLED_AT.getTime() + (SCHEDULE_CHECK_INTERVAL_MINUTES + 5) * 60_000);
    const run = await new ScheduleService(db, {
      now: () => later,
      fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
    }).refreshIfDue(SEASON);

    expect(run?.outcome).toBe('not_modified');
    const state = await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, SEASON);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.lastOutcome).toBe('not_modified');
  });

  it('counts a real fetch failure once, not twice', async () => {
    const db = await createTestDb();
    await overdue(db);
    const run = await new ScheduleService(db, {
      now: () => KILLED_AT,
      fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    }).refresh(SEASON);

    expect(run.outcome).toBe('failed');
    expect((await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, SEASON))?.consecutiveFailures).toBe(1);
  });
});

describe('the parse starts at the season it was asked for', () => {
  const header =
    'game_id,season,game_type,week,gameday,weekday,gametime,away_team,home_team,roof';
  const older = Array.from(
    { length: 400 },
    (_, i) => `${1999 + (i % 27)}_01_AAA_BBB,${1999 + (i % 27)},REG,1,2000-09-10,Sunday,13:00,BAL,KC,outdoors`,
  ).sort();
  const current = [
    '2026_01_BAL_KC,2026,REG,1,2026-09-10,Thursday,20:20,BAL,KC,outdoors',
    '2026_02_KC_CAR,2026,REG,2,2026-09-20,Sunday,13:00,KC,CAR,outdoors',
  ];

  it('returns exactly what a whole-file scan returns', () => {
    const csv = [header, ...older.filter((l) => !l.startsWith('2026')), ...current, ''].join('\n');
    const parsed = parseSchedule(csv, { season: SEASON });

    // The reference: every line, season-checked one at a time.
    const whole = parseSchedule(csv.split('\n').filter((l, i) => i === 0 || l.includes(',2026,')).join('\n'), {
      season: SEASON,
    });
    expect(parsed).toEqual(whole);
    expect(parsed.games).toBe(2);
    expect(parsed.seasons).toEqual([SEASON]);
  });

  it('falls back to the whole file when the season marker is not where it expects', () => {
    // An id that no longer starts with the season: the jump finds nothing and
    // the per-line season check still keeps the right rows.
    const renamed = current.map((l) => l.replace(/^2026_/, 'G_'));
    const csv = [header, ...renamed, ''].join('\n');
    expect(parseSchedule(csv, { season: SEASON }).games).toBe(2);
  });

  it('never keeps a row from another season after the jump', () => {
    // A stray older row after the season starts is still filtered out.
    const csv = [header, current[0], '2025_18_NYJ_BUF,2025,REG,18,2026-01-04,Sunday,13:00,NYJ,BUF,outdoors', current[1]].join('\n');
    const parsed = parseSchedule(csv, { season: SEASON });
    expect(parsed.games).toBe(2);
    expect(parsed.rows.every((r) => r.season === SEASON)).toBe(true);
  });
});
