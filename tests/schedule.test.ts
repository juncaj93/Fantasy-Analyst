/**
 * The fixture list: parsed, stored idempotently, and never fetched on a read.
 *
 * This lane ingests the schedule and reads it nowhere. That makes the tests
 * about the *ingest's* promises rather than about a recommendation, and there
 * are four of them, each with a failure that would only show up much later:
 *
 *  - **two rows per game, one per team.** Every question a schedule is asked is
 *    asked from a team's point of view, and a `home` flag stored backwards is
 *    the kind of thing nobody notices until a dome check goes the wrong way in
 *    January.
 *  - **idempotent upsert.** A re-read of an unchanged file must change nothing,
 *    and a partial read must leave every row it did not mention alone.
 *    Delete-first would turn one bad morning into a schedule with holes, and a
 *    hole is indistinguishable from a bye to everything downstream.
 *  - **last-known-good on failure.** A 304, a 404 and a 503 all leave the store
 *    exactly as it was, and they are recorded differently because they mean
 *    different things.
 *  - **no read-path fetch, and no new cron.** The service is the only thing
 *    that touches the network and only the scheduled handler calls it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCHEDULE_URL,
  byeWeeks,
  parseSchedule,
  toIsoKickoff,
  weeksByTeam,
} from '../src/core/nfl/schedule.ts';
import { NflScheduleRepo, ScheduleSourceRepo } from '../src/server/repos/nflSchedule.ts';
import { ScheduleService, SCHEDULE_SOURCE } from '../src/server/services/scheduleService.ts';
import { createTestDb } from './helpers/db.ts';

/**
 * A slate written in the source's own column order and spelling.
 *
 * Deliberately awkward in three ways a real file is: a column this app does not
 * read sits in the middle, `gameday`/`gametime` are two fields rather than one,
 * and a playoff row carries no teams because the participants are not known
 * yet. All three are states the live file is in every season.
 */
const CSV = [
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,home_team,roof,temp,wind',
  '2026_01_BAL_KC,2026,REG,1,2026-09-10,Thursday,20:20,BAL,KC,outdoors,,',
  '2026_01_CAR_JAX,2026,REG,1,2026-09-13,Sunday,13:00,CAR,JAX,dome,,',
  '2026_02_KC_CAR,2026,REG,2,2026-09-20,Sunday,16:25,KC,CAR,outdoors,,',
  // Week 3: Kansas City and Carolina both rest. Baltimore and Jacksonville do not.
  '2026_03_JAX_BAL,2026,REG,3,2026-09-27,Sunday,13:00,JAX,BAL,outdoors,,',
  // A season nobody asked about, to prove the filter runs.
  '2025_01_KC_BAL,2025,REG,1,2025-09-07,Sunday,13:00,KC,BAL,outdoors,68,4',
  // A playoff slot whose participants are not known yet.
  '2026_20_TBD_TBD,2026,CON,20,2027-01-24,Sunday,15:00,,,dome,,',
  '',
].join('\n');

describe('parsing the fixture list', () => {
  it('writes two rows per game, one per team, with the sides the right way round', () => {
    const parsed = parseSchedule(CSV, { season: '2026' });

    expect(parsed.games).toBe(4);
    expect(parsed.rows).toHaveLength(8);

    const opener = parsed.rows.filter((r) => r.week === 1 && (r.team === 'KC' || r.team === 'BAL'));
    expect(opener).toEqual([
      { season: '2026', week: 1, team: 'KC', opponent: 'BAL', home: true, kickoff: '2026-09-11T00:20:00.000Z', roof: 'outdoors' },
      { season: '2026', week: 1, team: 'BAL', opponent: 'KC', home: false, kickoff: '2026-09-11T00:20:00.000Z', roof: 'outdoors' },
    ]);
  });

  it('filters to the season asked for', () => {
    expect(parseSchedule(CSV, { season: '2026' }).seasons).toEqual(['2026']);
    expect(parseSchedule(CSV, { season: '2025' }).games).toBe(1);
    // And every season at once when nobody asked for one.
    expect(parseSchedule(CSV).seasons).toEqual(['2025', '2026']);
  });

  it('skips a row it cannot turn into a fixture rather than half-storing it', () => {
    const parsed = parseSchedule(CSV, { season: '2026' });

    // The unassigned playoff slot. Storing it would create a fixture against
    // nobody that a bye derivation would then have to learn to ignore.
    expect(parsed.skipped).toBe(1);
    expect(parsed.rows.some((r) => r.week === 20)).toBe(false);
  });

  it('carries the roof, which is a forecast, and no temperature, which is not', () => {
    const parsed = parseSchedule(CSV, { season: '2026' });
    const dome = parsed.rows.find((r) => r.team === 'JAX' && r.week === 1);

    expect(dome?.roof).toBe('dome');
    // `temp` and `wind` are post-game observations — blank for every unplayed
    // game and filled in afterwards. Reading one as a forecast would give this
    // app a weather model that is perfectly accurate about the past.
    expect(Object.keys(dome ?? {})).toEqual(['season', 'week', 'team', 'opponent', 'home', 'kickoff', 'roof']);
  });

  it('reads an empty or headerless file as nothing rather than throwing', () => {
    expect(parseSchedule('')).toEqual({ rows: [], games: 0, skipped: 0, seasons: [] });
    expect(parseSchedule('season,week\n').rows).toEqual([]);
    expect(parseSchedule('nothing,useful\n1,2\n').rows).toEqual([]);
  });

  it('points at the schedules release asset, by its file name', () => {
    /*
     * The file name, not just the release path.
     *
     * This assertion used to stop at the directory, and the URL under it named
     * the release rather than the asset in it — `schedules.csv`, which 404s.
     * Every daily check then read as `not_published`, which is the word for a
     * season that has not started, so a fixture list that was published in May
     * looked like one the calendar had not reached. Pinning the name is what
     * makes this test able to fail for the reason it exists.
     */
    expect(SCHEDULE_URL).toBe(
      'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',
    );
  });
});

describe('kickoff times', () => {
  it('reads the file’s Eastern wall clock as an instant', () => {
    // September is daylight time: 13:00 Eastern is 17:00 UTC.
    expect(toIsoKickoff('2026-09-13', '13:00')).toBe('2026-09-13T17:00:00.000Z');
    // January is standard time: 15:00 Eastern is 20:00 UTC.
    expect(toIsoKickoff('2027-01-24', '15:00')).toBe('2027-01-24T20:00:00.000Z');
  });

  it('returns null rather than guessing when either half is missing or malformed', () => {
    expect(toIsoKickoff(null, '13:00')).toBeNull();
    expect(toIsoKickoff('2026-09-13', null)).toBeNull();
    expect(toIsoKickoff('13 September', '13:00')).toBeNull();
    expect(toIsoKickoff('2026-09-13', 'lunchtime')).toBeNull();
  });
});

describe('byes are derived rather than stored', () => {
  it('is the absence of a fixture in a stated range', () => {
    const rows = parseSchedule(CSV, { season: '2026' }).rows;

    expect(byeWeeks(rows, 'KC', { from: 1, to: 3 })).toEqual([3]);
    expect(byeWeeks(rows, 'CAR', { from: 1, to: 3 })).toEqual([3]);
    expect(byeWeeks(rows, 'BAL', { from: 1, to: 3 })).toEqual([2]);
    expect(byeWeeks(rows, 'JAX', { from: 1, to: 3 })).toEqual([2]);
  });

  it('reports the weeks each team does play, which is the half the data has', () => {
    const weeks = weeksByTeam(parseSchedule(CSV, { season: '2026' }).rows);
    expect([...(weeks.get('KC') ?? [])].sort()).toEqual([1, 2]);
    expect([...(weeks.get('JAX') ?? [])].sort()).toEqual([1, 3]);
  });

  it('calls a team it has never heard of nothing but byes, rather than throwing', () => {
    expect(byeWeeks(parseSchedule(CSV, { season: '2026' }).rows, 'NYG', { from: 1, to: 2 })).toEqual([1, 2]);
  });
});

// ------------------------------------------------------------------ storage

/** A fetch that answers once with a body, then 304s like the real asset does. */
function conditionalFetch(body: string, opts: { etag?: string } = {}) {
  const etag = opts.etag ?? '"schedule-v1"';
  const calls: { headers: Record<string, string> }[] = [];
  const fetchLike = async (_url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ headers });
    if (headers['if-none-match'] === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { etag, 'last-modified': 'Mon, 01 Jun 2026 12:00:00 GMT' },
    });
  };
  return { fetch: fetchLike as never, calls };
}

describe('the ingest', () => {
  it('stores two rows per game and reports what it did', async () => {
    const db = await createTestDb();
    const { fetch } = conditionalFetch(CSV);
    const run = await new ScheduleService(db, { fetch }).refresh('2026');

    expect(run.outcome).toBe('ok');
    expect(run.games).toBe(4);
    expect(run.rowsWritten).toBe(8);

    const coverage = await new NflScheduleRepo(db).coverage('2026');
    expect(coverage.rows).toBe(8);
    expect(coverage.teams).toBe(4);
    expect(coverage.weeks).toBe(3);
  });

  it('is idempotent: the same file twice leaves the same rows', async () => {
    const db = await createTestDb();
    const repo = new NflScheduleRepo(db);
    const rows = parseSchedule(CSV, { season: '2026' }).rows;

    await repo.save(rows, '2026-06-01T00:00:00.000Z');
    const first = await repo.season('2026');
    await repo.save(rows, '2026-06-02T00:00:00.000Z');
    const second = await repo.season('2026');

    expect(second).toEqual(first);
    expect((await repo.coverage('2026')).rows).toBe(8);
    // The only thing that moved is when it was last seen.
    expect((await repo.coverage('2026')).fetchedAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('upserts rather than replacing, so a partial read cannot punch a hole', async () => {
    const db = await createTestDb();
    const repo = new NflScheduleRepo(db);
    await repo.save(parseSchedule(CSV, { season: '2026' }).rows, '2026-06-01T00:00:00.000Z');

    // A later read that only mentions week 1 — a truncated body, or a source
    // that has only half-published. Weeks 2 and 3 must survive it.
    const partial = parseSchedule(CSV, { season: '2026' }).rows.filter((r) => r.week === 1);
    await repo.save(partial, '2026-06-02T00:00:00.000Z');

    expect((await repo.coverage('2026')).rows).toBe(8);
    expect((await repo.forTeam('2026', 'KC')).map((r) => r.week)).toEqual([1, 2]);
  });

  it('rewrites a fixture that actually moved', async () => {
    const db = await createTestDb();
    const repo = new NflScheduleRepo(db);
    await repo.save(parseSchedule(CSV, { season: '2026' }).rows, '2026-06-01T00:00:00.000Z');

    // The league flexes the Sunday-night game — the one thing that does change
    // about a fixture list after May.
    const flexed = CSV.replace('2026-09-13,Sunday,13:00,CAR,JAX', '2026-09-13,Sunday,20:20,CAR,JAX');
    await repo.save(parseSchedule(flexed, { season: '2026' }).rows, '2026-06-02T00:00:00.000Z');

    const jax = await repo.forTeam('2026', 'JAX');
    expect(jax[0]?.kickoff).toBe('2026-09-14T00:20:00.000Z');
    expect((await repo.coverage('2026')).rows).toBe(8);
  });

  it('reads one team’s season in week order', async () => {
    const db = await createTestDb();
    await new NflScheduleRepo(db).save(parseSchedule(CSV, { season: '2026' }).rows, '2026-06-01T00:00:00.000Z');

    const kc = await new NflScheduleRepo(db).forTeam('2026', 'kc');
    expect(kc.map((r) => [r.week, r.opponent, r.home])).toEqual([
      [1, 'BAL', true],
      [2, 'CAR', false],
    ]);
  });
});

describe('the conditional check', () => {
  it('sends the stored validator and downloads nothing when the file has not moved', async () => {
    const db = await createTestDb();
    const { fetch, calls } = conditionalFetch(CSV);
    const service = new ScheduleService(db, { fetch });

    await service.refresh('2026');
    const second = await service.refresh('2026');

    expect(second.outcome).toBe('not_modified');
    expect(second.rowsWritten).toBe(0);
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(calls[1]?.headers['if-none-match']).toBe('"schedule-v1"');
    // And the stored schedule is untouched by the check.
    expect((await new NflScheduleRepo(db).coverage('2026')).rows).toBe(8);
  });

  it('records the check without pretending the data got newer', async () => {
    const db = await createTestDb();
    const { fetch } = conditionalFetch(CSV);
    const service = new ScheduleService(db, { fetch });
    await service.refresh('2026');
    const ingestedAt = (await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, '2026'))?.ingestedAt;

    await service.refresh('2026');
    const state = await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, '2026');

    expect(state?.lastOutcome).toBe('not_modified');
    expect(state?.ingestedAt).toBe(ingestedAt);
    expect(state?.consecutiveFailures).toBe(0);
  });
});

describe('failure preserves the last known good schedule', () => {
  const good = async () => {
    const db = await createTestDb();
    await new ScheduleService(db, { fetch: conditionalFetch(CSV).fetch }).refresh('2026');
    return db;
  };

  it('leaves every row in place when the fetch fails', async () => {
    const db = await good();
    const failing = (async () => new Response('nope', { status: 503 })) as never;

    const run = await new ScheduleService(db, { fetch: failing }).refresh('2026');

    expect(run.outcome).toBe('failed');
    expect((await new NflScheduleRepo(db).coverage('2026')).rows).toBe(8);
    expect((await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, '2026'))?.consecutiveFailures).toBe(1);
  });

  it('leaves every row in place when the network throws', async () => {
    const db = await good();
    const throwing = (async () => {
      throw new Error('connection reset');
    }) as never;

    const run = await new ScheduleService(db, { fetch: throwing }).refresh('2026');

    expect(run.outcome).toBe('failed');
    expect((await new NflScheduleRepo(db).coverage('2026')).rows).toBe(8);
  });

  it('treats a 404 as a fact about the calendar rather than an alarm', async () => {
    const db = await createTestDb();
    const missing = (async () => new Response(null, { status: 404 })) as never;

    const run = await new ScheduleService(db, { fetch: missing }).refresh('2027');

    expect(run.outcome).toBe('not_published');
    expect((await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, '2027'))?.consecutiveFailures).toBe(0);
  });

  it('refuses to let an empty parse replace a good schedule', async () => {
    const db = await good();
    // A file that is fine and simply has no fixtures for this season yet —
    // ordinary in the spring, and indistinguishable from a truncated download.
    const emptySeason = conditionalFetch(CSV, { etag: '"schedule-v2"' });
    const run = await new ScheduleService(db, { fetch: emptySeason.fetch }).refresh('2028');

    expect(run.outcome).toBe('not_published');
    expect(run.rowsWritten).toBe(0);
    expect((await new NflScheduleRepo(db).coverage('2026')).rows).toBe(8);
  });

  it('does not ingest twice at once', async () => {
    const db = await createTestDb();
    const now = new Date('2026-06-01T09:00:00.000Z');
    const held = await new ScheduleSourceRepo(db).acquireLock(SCHEDULE_SOURCE, '2026', 'somebody-else', now, 120);
    expect(held).toBe(true);

    const run = await new ScheduleService(db, {
      fetch: conditionalFetch(CSV).fetch,
      now: () => now,
    }).refresh('2026');

    expect(run.outcome).toBe('skipped');
    expect(run.note).toContain('lease');
  });

  it('stops writing when the day’s ceiling is spent', async () => {
    const db = await createTestDb();
    const now = new Date('2026-06-01T09:00:00.000Z');
    await new ScheduleSourceRepo(db).addWrites('2026-06-01', 10_000, now.toISOString());

    const run = await new ScheduleService(db, {
      fetch: conditionalFetch(CSV).fetch,
      now: () => now,
    }).refresh('2026');

    expect(run.outcome).toBe('skipped');
    expect(run.note).toContain('write ceiling');
  });
});

describe('health', () => {
  it('says how much is stored, and says when nothing is', async () => {
    const db = await createTestDb();
    expect((await new ScheduleService(db).health('2026')).dataHealth).toContain('No 2026 schedule');

    await new ScheduleService(db, { fetch: conditionalFetch(CSV).fetch }).refresh('2026');
    expect((await new ScheduleService(db).health('2026')).dataHealth).toContain('4 teams across 3 weeks');
  });
});

describe('the free-tier promises, as facts about the wiring', () => {
  const wrangler = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
  const worker = readFileSync(fileURLToPath(new URL('../src/worker/index.ts', import.meta.url)), 'utf8');

  it('adds no cron trigger', () => {
    // Four of the account's five: the five-minute injury tick, two game-day
    // Vegas windows, and the daily 09:00 that the schedule rides. The spare
    // one is deliberately spare -- last season's backfill rides the `*/5`
    // branch rather than claim it, because a finite walk that converges in a
    // couple of hours should not hold a trigger slot forever.
    const crons = /crons\s*=\s*\[(.*?)\]/s.exec(wrangler)?.[1] ?? '';
    expect(crons.split(',').filter((c) => c.trim().length > 0)).toHaveLength(4);
    expect(crons).toContain('0 9 * * *');
  });

  /*
   * The tourniquet is off, and this is the test that used to hold it on.
   *
   * It asserted the opposite for the length of the D1 quota incident: the
   * five-minute tick was removed from `crons` as the loudest thing on the
   * schedule, and this test existed so that restoring it had to be somebody's
   * decision rather than a line reappearing quietly in a merge.
   *
   * The measurement then said the tick was 0.4% of the daily row reads and
   * never the cause, the real causes were fixed, and a full clean day came
   * back at 49.2% of the allowance. So the decision was made, here, and the
   * assertion is inverted rather than deleted -- the pairing it really cares
   * about is that the trigger and its handler branch agree. A `crons` entry
   * with no branch is a tick that fires and does nothing; a branch with no
   * entry is the state this incident left behind for a day.
   */
  it('runs the five-minute injury tick, and has a branch to answer it', () => {
    const crons = /crons\s*=\s*\[(.*?)\]/s.exec(wrangler)?.[1] ?? '';
    expect(crons, 'the injury tick was restored once the real causes were fixed').toContain('*/5');
    expect(worker).toContain("event.cron.startsWith('*/5')");
  });

  /**
   * The catch is the recorded step now, and it is the same catch.
   *
   * This used to read the inline `try`/`catch` around the call. That block
   * became `run.step('schedule', ...)`, which catches, logs and additionally
   * writes down that the step failed — so the guarantee it was asserting is
   * intact and the run ledger can now say which feed it was. The behavioural
   * half lives in `tests/cronRunRecord.test.ts`, where a step that throws is
   * checked not to stop the steps after it.
   */
  it('is called from the daily tick, inside a recorded step of its own', () => {
    const daily = worker.slice(worker.indexOf("event.cron.startsWith('0 9')"));
    expect(
      daily,
      'a fixture list that fails to refresh must not take down the feeds a lineup depends on',
    ).toMatch(/step\('schedule'[\s\S]*?new ScheduleService\(env\.DB, \{ fetch: meteredRedirectingFetch \}\)/);
  });

  it('is never reached from a read path', () => {
    /*
     * The promise that keeps a slow nflverse from making a screen slow: every
     * read of a schedule goes to D1, and the only thing that fetches is the
     * service, and the only caller of the service is the scheduled handler.
     * Asserted over the whole source tree rather than by inspection, because
     * the next person to need a schedule will reach for the service first.
     */
    const app = readFileSync(fileURLToPath(new URL('../src/server/app.ts', import.meta.url)), 'utf8');
    expect(app).not.toContain('ScheduleService');
    expect(app).not.toContain('scheduleService');
  });
});
