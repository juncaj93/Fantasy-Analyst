/**
 * How often the fixture list is checked, and what asking costs.
 *
 * ## The history
 *
 * The `schedule` source was once flagged degraded at 37+ hours stale while the
 * fixture list itself was fine. The check ran once a day on the 09:00 tick, and
 * `DAILY_ATTEMPT_STALE_MINUTES` calls a daily feed unhealthy after 36 hours
 * without an attempt: twelve hours of slack, and one tick that did not land
 * made a healthy pipeline read as a broken one. The fix then was a shorter
 * interval (six hours, ninety minutes during games) on the five-minute tick.
 *
 * ## What changed, and what did not
 *
 * Alex's decision in the odds-schedule round: about once a day, plus extra
 * checks after the league announces flexed games. The check still lives on the
 * five-minute tick, which is the thing that actually removed the slack: an
 * overdue check is retried on the very next tick, so a missed one costs five
 * minutes and not a day. The shorter intervals were buying a conditional GET
 * four to eight times a day for a file whose stored fields change only when a
 * game is flexed. The flex checks themselves are `core/nfl/flexCheck.ts`.
 *
 * Two things were ruled out by measurement in the first round and still hold:
 *
 *   - **Subrequest starvation.** `cron.subrequestBudget.test.ts` drives the real
 *     handler and shows the feed is reached on a healthy morning, in a Sleeper
 *     retry storm, and with every request answering 500.
 *   - **A read path keeping it warm.** There is none, structurally:
 *     `schedule.test.ts` keeps the service off every read path.
 *
 * ## And what the cadence is not for
 *
 * It is not for making Sunday's numbers fresher, because it cannot be. The
 * parser stores season, week, team, opponent, home, kickoff and roof, and not
 * one of those moves while a game is being played. The test below pins the
 * claim about the payload so nobody has to take the paragraph's word for it.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import {
  SCHEDULE_CHECK_INTERVAL_MINUTES,
  SCHEDULE_SOURCE,
  ScheduleService,
} from '../src/server/services/scheduleService.ts';
import { DAILY_ATTEMPT_STALE_MINUTES } from '../src/core/health/policy.ts';
import { D1_DAILY_ROWS_READ } from '../src/core/health/quota.ts';
import { NflScheduleRepo, ScheduleSourceRepo } from '../src/server/repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = '2026';
const WEEK = 3;

/** A Sunday afternoon slate: one o'clock Eastern in September is 17:00 UTC. */
const KICKOFF = '2026-09-20T17:00:00.000Z';
const DURING_THE_GAME = new Date('2026-09-20T18:00:00.000Z');
const A_QUIET_TUESDAY = new Date('2026-09-22T14:00:00.000Z');

/** A week of fixtures, so the window question has something real to read. */
async function seed(db: Database): Promise<void> {
  await new NflScheduleRepo(db).save(
    [
      { season: SEASON, week: WEEK, team: 'KC', opponent: 'BUF', home: true, kickoff: KICKOFF, roof: 'outdoors' },
      { season: SEASON, week: WEEK, team: 'BUF', opponent: 'KC', home: false, kickoff: KICKOFF, roof: 'outdoors' },
    ],
    '2026-09-01T09:00:00.000Z',
  );
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, {
    season: SEASON,
    seasonType: 'regular',
    week: WEEK,
    leg: WEEK,
    fetchedAt: '2026-09-20T09:00:00.000Z',
  });
}

/** Pretend the feed was last asked this many minutes before `now`. */
async function lastCheckedMinutesAgo(db: Database, minutes: number, now: Date): Promise<void> {
  await new ScheduleSourceRepo(db).recordCheck(SCHEDULE_SOURCE, SEASON, {
    checkedAt: new Date(now.getTime() - minutes * 60_000).toISOString(),
    outcome: 'not_modified',
    note: null,
  });
}

/** A service whose clock is fixed and whose network never has to be reached. */
function serviceAt(db: Database, now: Date, onFetch?: () => void) {
  return new ScheduleService(db, {
    now: () => now,
    fetch: (async (...args: unknown[]) => {
      onFetch?.();
      void args;
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch,
  });
}

describe('about once a day, and why that no longer trips the alarm', () => {
  /*
   * The cadence was six hours (ninety minutes during games) because a check
   * that ran on the 09:00 tick alone left twelve hours of slack against the
   * 36-hour alarm. Alex asked for about once a day; what makes that safe is not
   * the interval, it is where the check runs. On the five-minute tick an
   * overdue check is retried on the very next tick, so one that did not land
   * delays the next attempt by five minutes and not by a day.
   */
  it('is a day, and a day is inside the alarm', () => {
    expect(SCHEDULE_CHECK_INTERVAL_MINUTES).toBe(24 * 60);
    expect(SCHEDULE_CHECK_INTERVAL_MINUTES).toBeLessThan(DAILY_ATTEMPT_STALE_MINUTES);
  });

  it('retries an overdue check on the very next tick rather than a day later', async () => {
    const db = await createTestDb();
    await seed(db);
    // A day and one tick overdue: the 09:00 tick did not land.
    await lastCheckedMinutesAgo(db, SCHEDULE_CHECK_INTERVAL_MINUTES + 5, A_QUIET_TUESDAY);

    let fetched = 0;
    const result = await serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1)).refreshIfDue(SEASON);
    expect(result?.outcome).toBe('not_modified');
    expect(fetched).toBe(1);
  });
});

describe('what is due, and when', () => {
  it('asks nothing when it was asked a moment ago', async () => {
    const db = await createTestDb();
    await seed(db);
    await lastCheckedMinutesAgo(db, 5, A_QUIET_TUESDAY);

    let fetched = 0;
    const result = await serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1)).refreshIfDue(SEASON);

    expect(result, 'not due is null, which is not the same as a check that found nothing').toBeNull();
    expect(fetched).toBe(0);
  });

  it('waits the full day, on a quiet Tuesday and in the middle of a game alike', async () => {
    /*
     * It used to check every ninety minutes while a game was on, because
     * nflverse rebuilds the file around the slate. Nothing this app stores from
     * it moves during a game, so the shorter interval bought liveness and not
     * numbers, and the five-minute tick's retry already supplies liveness.
     */
    for (const now of [A_QUIET_TUESDAY, DURING_THE_GAME]) {
      const db = await createTestDb();
      await seed(db);
      await lastCheckedMinutesAgo(db, SCHEDULE_CHECK_INTERVAL_MINUTES - 10, now);

      let fetched = 0;
      const result = await serviceAt(db, now, () => (fetched += 1)).refreshIfDue(SEASON);
      expect(result).toBeNull();
      expect(fetched).toBe(0);
    }
  });

  it('checks once the day is up', async () => {
    const db = await createTestDb();
    await seed(db);
    await lastCheckedMinutesAgo(db, SCHEDULE_CHECK_INTERVAL_MINUTES + 10, A_QUIET_TUESDAY);

    let fetched = 0;
    const result = await serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1)).refreshIfDue(SEASON);

    expect(result?.outcome).toBe('not_modified');
    expect(fetched).toBe(1);
  });

  it('checks a source it has never checked before', async () => {
    /*
     * A cold database has no state row, and waiting a day to discover that
     * would be the one case where the gate makes things worse than the cadence
     * it replaced.
     */
    const db = await createTestDb();
    await seed(db);

    let fetched = 0;
    const result = await serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1)).refreshIfDue(SEASON);

    expect(result).not.toBeNull();
    expect(fetched).toBe(1);
  });

  it('does not hammer the source when the stored clock is in the future', async () => {
    const db = await createTestDb();
    await seed(db);
    await lastCheckedMinutesAgo(db, -600, A_QUIET_TUESDAY);

    let fetched = 0;
    expect(await serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1)).refreshIfDue(SEASON)).toBeNull();
    expect(fetched).toBe(0);
  });

  it('asks straight away after a flex announcement, whatever the daily interval says', async () => {
    const db = await createTestDb();
    await seed(db);
    // Asked an hour ago, so the daily gate says no.
    await lastCheckedMinutesAgo(db, 60, A_QUIET_TUESDAY);

    let fetched = 0;
    const svc = serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1));
    expect(await svc.refreshIfDue(SEASON)).toBeNull();
    expect(fetched).toBe(0);

    const flex = await svc.refreshAfterFlexAnnouncement(SEASON);
    expect(flex.outcome).toBe('not_modified');
    expect(fetched, 'still exactly one conditional request').toBe(1);
  });
});

describe('what the gate costs, counted rather than estimated', () => {
  it('reads one row on a tick that is not due', async () => {
    /*
     * The number that matters, because it is multiplied by 288. Anything that
     * reads the fixture list on every five-minute tick would put 150,000 rows
     * a day on the allowance to answer a question whose answer is almost
     * always "not yet".
     */
    const inner = await createTestDb();
    await seed(inner);
    await lastCheckedMinutesAgo(inner, 5, A_QUIET_TUESDAY);

    const counting = countingDb(inner);
    counting.reset();
    await serviceAt(counting.db, A_QUIET_TUESDAY).refreshIfDue(SEASON);

    const rows = counting.tallies().reduce((a, t) => a + t.rows, 0);
    expect(rows, 'a not-due tick must cost one state row and nothing else').toBeLessThanOrEqual(1);
    expect(counting.rowsMatching('nfl_schedule WHERE season'), 'the fixture list must not be read').toBe(0);
  });

  it('reads no fixtures at all on the day\'s one due tick when the file has not changed', async () => {
    const inner = await createTestDb();
    await seed(inner);
    await lastCheckedMinutesAgo(inner, SCHEDULE_CHECK_INTERVAL_MINUTES + 10, A_QUIET_TUESDAY);

    const counting = countingDb(inner);
    counting.reset();
    await serviceAt(counting.db, A_QUIET_TUESDAY).refreshIfDue(SEASON);

    // A 304 stores nothing, so there is nothing to compare kickoffs against.
    expect(counting.rowsMatching('nfl_schedule WHERE season'), 'the fixture list must not be read').toBe(0);
    expect(counting.tallies().reduce((a, t) => a + t.rows, 0)).toBeLessThanOrEqual(10);
  });

  it('costs a rounding error of the daily allowance over a whole day', () => {
    /*
     * The combined figure, stated in the units the allowance is billed in:
     * 288 not-due ticks at one row, plus one due tick and three flex-window
     * checks at no more than ten.
     */
    const ticksPerDay = (24 * 60) / 5;
    const checks = 1 + 3;
    const worstCaseRows = ticksPerDay * 1 + checks * 10;

    expect(worstCaseRows).toBeLessThan(400);
    expect(worstCaseRows / D1_DAILY_ROWS_READ).toBeLessThan(0.0001);
  });
});

describe('what the feed actually carries, which is why the window is not about freshness', () => {
  it('stores nothing that moves while a game is being played', async () => {
    /*
     * The claim the cadence comment makes, held by the schema rather than by
     * the comment. If a future ingest starts storing a score or a game state,
     * this fails and the reasoning above has to be rewritten rather than
     * quietly outlived.
     */
    const db = await createTestDb();
    await seed(db);
    const stored = await new NflScheduleRepo(db).forWeek(SEASON, WEEK);

    expect(Object.keys(stored[0] ?? {}).sort()).toEqual(
      ['home', 'kickoff', 'opponent', 'roof', 'season', 'team', 'week'].sort(),
    );
  });
});
