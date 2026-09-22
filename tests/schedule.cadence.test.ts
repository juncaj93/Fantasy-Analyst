/**
 * How often the fixture list is checked, and what asking costs.
 *
 * ## The report this answers
 *
 * The `schedule` source was flagged degraded at 37+ hours stale. The fixture
 * list itself was fine. What was wrong was the arithmetic between two numbers
 * that had never been compared: the feed was checked once a day, on the 09:00
 * tick, and `DAILY_ATTEMPT_STALE_MINUTES` calls a daily feed unhealthy after
 * 36 hours without an attempt. Twelve hours of slack. One tick that did not
 * land — a deploy, a Cloudflare hiccup, an invocation that started late — and
 * a healthy pipeline reads as a broken one.
 *
 * Two things were ruled out by measurement before the cadence was touched, and
 * they are recorded because the obvious fix for each would have been wrong:
 *
 *   - **Subrequest starvation.** The 09:00 tick spends 46 of its 48 and the
 *     schedule feed is a redirecting GitHub fetch costing 2, so being crowded
 *     out was the first suspicion. Driving the real handler over a real
 *     database says otherwise: the feed is reached on a healthy morning, in a
 *     Sleeper retry storm, and with every request answering 500 — the budget
 *     refuses the manager backfill below it, never the feeds above.
 *     `cron.subrequestBudget.test.ts` is what holds that.
 *   - **A read path keeping it warm.** There is none, structurally:
 *     `schedule.test.ts` keeps the service off every read path.
 *
 * ## And what the new cadence is not for
 *
 * It is not for making Sunday's numbers fresher, because it cannot be. The
 * parser stores season, week, team, opponent, home, kickoff and roof, and not
 * one of those moves while a game is being played. The live-window interval
 * exists because nflverse regenerates `games.csv` around the slate, so that is
 * when a check is most likely to find something and when a stalled ingest is
 * worth noticing soonest. The test below pins the claim about the payload so
 * nobody has to take the paragraph's word for it.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import {
  SCHEDULE_CHECK_INTERVAL_MINUTES,
  SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES,
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

describe('the cadence answers the alarm it was tripping', () => {
  it('leaves more than one missed tick between healthy and stale', () => {
    /*
     * The arithmetic that is the whole point. At 24 hours a single missed
     * check is 48 hours of silence, which is past the 36-hour alarm; at six
     * it takes six missed checks to get there.
     */
    const missesBeforeAlarm = DAILY_ATTEMPT_STALE_MINUTES / SCHEDULE_CHECK_INTERVAL_MINUTES;
    expect(missesBeforeAlarm).toBeGreaterThan(2);
    // And the old cadence, for the contrast: 36/24 is one and a half.
    expect(DAILY_ATTEMPT_STALE_MINUTES / (24 * 60)).toBeLessThan(2);
  });

  it('checks more often while football is being played than when it is not', () => {
    expect(SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES).toBeLessThan(SCHEDULE_CHECK_INTERVAL_MINUTES);
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

  it('waits the full interval on a day with no football on', async () => {
    const db = await createTestDb();
    await seed(db);
    // Past the live interval, well short of the quiet one.
    await lastCheckedMinutesAgo(db, SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES + 10, A_QUIET_TUESDAY);

    let fetched = 0;
    const result = await serviceAt(db, A_QUIET_TUESDAY, () => (fetched += 1)).refreshIfDue(SEASON);

    expect(result).toBeNull();
    expect(fetched).toBe(0);
  });

  it('checks on the shorter interval while a game is in progress', async () => {
    const db = await createTestDb();
    await seed(db);
    await lastCheckedMinutesAgo(db, SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES + 10, DURING_THE_GAME);

    let fetched = 0;
    const result = await serviceAt(db, DURING_THE_GAME, () => (fetched += 1)).refreshIfDue(SEASON);

    expect(result?.outcome).toBe('not_modified');
    expect(fetched).toBe(1);
  });

  it('checks on the quiet day too, once the longer interval is up', async () => {
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
     * A cold database has no state row, and waiting six hours to discover
     * that would be the one case where the gate makes things worse than the
     * cadence it replaced.
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

  it('stays on the slow cadence when the week is unknown', async () => {
    /*
     * No NFL state means the window question cannot be answered, and the
     * conservative direction is the cheap one: an unknown week must not buy
     * the tighter interval on the off-chance.
     */
    const db = await createTestDb();
    await new NflScheduleRepo(db).save(
      [{ season: SEASON, week: WEEK, team: 'KC', opponent: 'BUF', home: true, kickoff: KICKOFF, roof: null }],
      '2026-09-01T09:00:00.000Z',
    );
    await lastCheckedMinutesAgo(db, SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES + 10, DURING_THE_GAME);

    let fetched = 0;
    expect(await serviceAt(db, DURING_THE_GAME, () => (fetched += 1)).refreshIfDue(SEASON)).toBeNull();
    expect(fetched).toBe(0);
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

  it('reads the week only on the ticks where the window could change the answer', async () => {
    const inner = await createTestDb();
    await seed(inner);
    await lastCheckedMinutesAgo(inner, SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES + 10, A_QUIET_TUESDAY);

    const counting = countingDb(inner);
    counting.reset();
    await serviceAt(counting.db, A_QUIET_TUESDAY).refreshIfDue(SEASON);

    const rows = counting.tallies().reduce((a, t) => a + t.rows, 0);
    // The state row, the settings row, and one week of fixtures.
    expect(rows).toBeLessThanOrEqual(40);
  });

  it('costs a rounding error of the daily allowance over a whole day', () => {
    /*
     * The combined figure, stated in the units the allowance is billed in.
     * 288 not-due ticks at one row, plus the handful that look the window up.
     */
    const ticksPerDay = (24 * 60) / 5;
    const windowChecks = (24 * 60) / SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES;
    const worstCaseRows = ticksPerDay * 1 + windowChecks * 40;

    expect(worstCaseRows).toBeLessThan(1_000);
    expect(worstCaseRows / D1_DAILY_ROWS_READ).toBeLessThan(0.0005);
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
