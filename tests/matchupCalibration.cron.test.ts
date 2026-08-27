/**
 * The calibration ledger, now that a clock rather than a screen writes it.
 *
 * The final audit's F-01 moved the write out of `GET /api/leagues/:id/matchup`,
 * and this file is the other half of that repair: the read being pure is only
 * an improvement if the thing the read used to do still happens somewhere. A
 * probability model that nobody grades is worth nothing, and the state a
 * Sunday-afternoon win probability was computed from stops being obtainable the
 * moment the games end — so a sample not written down at the time is not hard
 * to recover, it is gone.
 *
 * Two questions, and they need different kinds of test:
 *
 *   - **Is it reached?** Structural, read off `worker/index.ts` the way
 *     `seasonMarketCron.test.ts` does, and for the same reason that file gives:
 *     `scheduled()` cannot be exercised without a live Sleeper client, and the
 *     failure being guarded against is not "the code is wrong" but "the code is
 *     never called". Production once carried an empty season-market table for
 *     exactly that reason while every unit test was green.
 *   - **Is it right?** Behavioural, over the real service and a real database:
 *     it records what it should, it is idempotent, it settles from Sleeper's
 *     own scores, and it refuses to grade a week it cannot see both sides of.
 *
 * And one question that needs no test at all but gets one anyway: nothing
 * routed can call it. That is true because `scheduled()` is not an HTTP surface
 * — but "no endpoint writes calibration" is the invariant the audit found
 * violated, so it is asserted rather than assumed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES, seedDemoData } from '../src/devserver/seed.ts';
import { MatchupService, SETTLE_WEEKS_PER_RUN } from '../src/server/services/matchupService.ts';
import { MatchupRepo } from '../src/server/repos/matchup.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { MATCHUP_MODEL_VERSION } from '../src/core/matchup/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const WORKER = readFileSync(join(import.meta.dirname, '..', 'src', 'worker', 'index.ts'), 'utf8');

/** The demo league starts QB, RB, RB, WR, WR, TE, FLEX. */
const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '0', '1007', '1011', '1017', '1019'];

function matchupRows(points: { mine?: number; theirs?: number } = {}): unknown[] {
  return [
    {
      roster_id: 1,
      matchup_id: 1,
      points: points.mine ?? 0,
      starters: MINE,
      players: [...MINE, '1009', '1014'],
      players_points: {},
    },
    {
      roster_id: 2,
      matchup_id: 1,
      points: points.theirs ?? 0,
      starters: THEIRS,
      players: ['1010', '1006', '1007', '1011', '1017', '1019', '1013', '1018'],
      players_points: {},
    },
  ];
}

function sleeperServing(byWeek: (week: number) => unknown): SleeperClient {
  return new SleeperClient({
    fetch: async (url) => {
      const match = /\/matchups\/(\d+)$/.exec(new URL(url).pathname);
      if (!match) return new Response('null', { status: 200 });
      return new Response(JSON.stringify(byWeek(Number(match[1]))), { status: 200 });
    },
  });
}

// ---------------------------------------------------------------- is it reached

/** The body of the `0 9` daily branch, which is where the ledger belongs. */
function dailyBranch(): string {
  const start = WORKER.indexOf(`event.cron.startsWith('0 9')`);
  expect(start, 'the daily 09:00 cron branch has gone').toBeGreaterThan(-1);
  const end = WORKER.indexOf('await refreshVegas(appEnv)', start);
  expect(end, 'the daily branch no longer ends before the weekly Vegas refresh').toBeGreaterThan(start);
  return WORKER.slice(start, end);
}

/** Everything after the daily branch returns: the Saturday and Sunday ticks. */
function weekendBranch(): string {
  const start = WORKER.indexOf('await refreshVegas(appEnv)');
  expect(start, 'the weekend fall-through has gone').toBeGreaterThan(-1);
  const end = WORKER.indexOf('async email(', start);
  expect(end, 'the weekend fall-through no longer ends before email()').toBeGreaterThan(start);
  return WORKER.slice(start, end);
}

describe('the calibration ledger is actually reached', () => {
  it('runs on the daily tick, which is the clock that catches every pregame', () => {
    expect(
      dailyBranch(),
      'nothing on a schedule writes calibration, so the ledger fills only if somebody opens Matchup — which is the defect',
    ).toContain('refreshMatchupCalibration(');
  });

  it('runs on the weekend ticks too, for a pregame reading taken after the injury report', () => {
    expect(weekendBranch()).toContain('refreshMatchupCalibration(');
  });

  /**
   * Not on the five-minute tick, and that is a decision.
   *
   * 288 captures a day would write the same forecast 288 times to move a
   * `latest_*` column, which is precisely the write amplification moving off
   * the GET was meant to end. The first forecast — the calibration sample — is
   * written once by the database whatever the cadence, so a faster clock buys
   * nothing the ledger is graded on.
   */
  it('stays off the five-minute tick', () => {
    const start = WORKER.indexOf(`event.cron.startsWith('*/5')`);
    const end = WORKER.indexOf(`event.cron.startsWith('0 9')`, start);
    expect(WORKER.slice(start, end)).not.toContain('refreshMatchupCalibration');
  });

  /**
   * The catch moved out of this function and into the step that calls it.
   *
   * It used to hold its own `try`/`catch`. It is now called through
   * `CronRunRecorder.step`, which catches, logs and records exactly as the
   * inline catch did — and additionally writes down *that* it failed, which is
   * the whole point of the run ledger. The guarantee is unchanged and is
   * asserted where it now lives: at both call sites, and behaviourally in
   * `tests/cronRunRecord.test.ts`, which throws from one step and checks the
   * ones after it still ran.
   */
  it('cannot take the lineup feeds down with it', () => {
    for (const branch of [dailyBranch(), weekendBranch()]) {
      expect(
        branch,
        'a grading job must never be the reason an injury check does not run, so it runs inside a recorded step',
      ).toMatch(/step\('matchup-calibration'[\s\S]*?refreshMatchupCalibration\(/);
    }
  });

  /** A cap that reports nothing reads as "there was nothing left". */
  it('says what it did not get to', () => {
    const source = WORKER.slice(WORKER.indexOf('async function refreshMatchupCalibration'));
    expect(source.slice(0, source.indexOf('\n}\n'))).toContain('pending');
  });
});

// ------------------------------------------------------------ is it server-owned

describe('nothing reachable over HTTP can write calibration', () => {
  /**
   * The route table has no calibration writer in it.
   *
   * `MatchupService` is constructed in exactly one place in `server/app.ts` —
   * the Matchup GET — and the only method it reaches is `forLeague`. Read off
   * the source, because the property is about which calls exist rather than
   * about what any one of them does.
   */
  it('no route calls the capture or the settlement', () => {
    const app = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'app.ts'), 'utf8');
    // A call, not a mention: the Matchup route's docblock names
    // `MatchupService.captureCalibration` to say where the write went, and
    // pointing at the writer is the opposite of invoking it.
    expect(app, 'a route invokes the calibration capture').not.toMatch(/\.captureCalibration\s*\(/);
    expect(app, 'a route invokes the settlement').not.toMatch(/\.settleFinishedWeeks\s*\(/);
  });

  it('the ledger writers live only on the worker’s scheduled handler', () => {
    const fetchHandler = WORKER.slice(WORKER.indexOf('async fetch('), WORKER.indexOf('async scheduled('));
    expect(fetchHandler).not.toContain('MatchupService');
    expect(WORKER).toContain('async function refreshMatchupCalibration');
  });

  /**
   * And no new endpoint was added to make this possible.
   *
   * §4 of the handoff: a protected surface exposed to the browser for no reason
   * is a surface to defend for no reason. The ledger needed a *server-owned*
   * path, and a cron is one — so the API gained nothing at all.
   */
  it('adds no endpoint to the API', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const app = createApp();
    const env: AppEnv = {
      db,
      sleeper: sleeperServing(() => matchupRows()),
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    };
    for (const path of [
      '/api/leagues/demo-league/matchup/capture',
      '/api/leagues/demo-league/matchup/record',
      '/api/leagues/demo-league/matchup/settle',
      '/api/matchup/calibration/record',
    ]) {
      const res = await app(new Request(`https://app.test${path}`, { method: 'POST' }), env);
      expect(res.status, `POST ${path} must not be a route`).toBe(404);
      expect(await calibrationRows(db)).toBe(0);
    }
  });
});

// ------------------------------------------------------------------- is it right

describe('the scheduled capture', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  function service(byWeek: (week: number) => unknown = () => matchupRows(), at?: string): MatchupService {
    return new MatchupService(db, {
      sleeper: sleeperServing(byWeek),
      ...(at ? { now: () => new Date(at) } : {}),
    });
  }

  it('records the expected observation, both sides, when conditions are valid', async () => {
    const report = await service().captureCalibration('demo-league');
    expect(report).toEqual({ recorded: true, week: 1, phase: 'pregame' });

    const stored = await db
      .prepare('SELECT * FROM matchup_forecasts ORDER BY roster_id')
      .all<Record<string, unknown>>();
    expect(stored.results.map((r) => r['roster_id'])).toEqual([1, 2]);
    for (const row of stored.results) {
      expect(row['model_version']).toBe(MATCHUP_MODEL_VERSION);
      expect(row['first_phase'], 'a cron capture before kickoff is a pregame sample').toBe('pregame');
      expect(row['first_win_probability']).not.toBeNull();
      expect(row['settled_at']).toBeNull();
    }
    // Both sides, and they are each other's opponent.
    expect(stored.results.map((r) => r['opponent_roster_id'])).toEqual([2, 1]);
  });

  /**
   * Idempotence, which is what lets this sit on three clocks a day.
   *
   * Repeating the capture must not create a second observation for the same
   * roster-week. The first forecast is fixed by the database — `ON CONFLICT DO
   * NOTHING` — and the latest columns move, which is what they are for.
   */
  it('is idempotent: repeated runs create no second observation', async () => {
    const EARLY = '2026-09-10T09:00:00.000Z';
    const LATER = '2026-09-13T15:00:00.000Z';

    // Thursday's tick, and then four more runs of the same clock.
    for (let i = 0; i < 5; i++) await service(() => matchupRows(), EARLY).captureCalibration('demo-league');
    expect(await calibrationRows(db), 'five runs, one observation per roster').toBe(2);

    const first = await db
      .prepare(
        'SELECT first_forecast_at AS at, first_win_probability AS p, latest_forecast_at AS lat FROM matchup_forecasts WHERE roster_id = 1',
      )
      .first<{ at: string; p: number; lat: string }>();
    expect(first!.at).toBe(EARLY);

    // Sunday's tick, with the game under way, so the forecast genuinely differs.
    await service(
      (week) => (week === 1 ? matchupRows({ mine: 44.5, theirs: 12.1 }) : []),
      LATER,
    ).captureCalibration('demo-league');
    expect(await calibrationRows(db)).toBe(2);

    const after = await db
      .prepare(
        'SELECT first_forecast_at AS at, first_win_probability AS p, latest_forecast_at AS lat FROM matchup_forecasts WHERE roster_id = 1',
      )
      .first<{ at: string; p: number; lat: string }>();
    expect(after!.at, 'the calibration sample is written once').toBe(EARLY);
    expect(after!.p, 'and never updated').toBe(first!.p);
    expect(after!.lat, 'while the running commentary does move').toBe(LATER);
  });

  /**
   * A capture is never served from the request cache.
   *
   * The screen's fingerprint memo short-circuits before the forecast is built,
   * so a capture that used it would return a matchup and write nothing —
   * silently, and only when a request had happened to warm the memo first.
   * `buildMatchupResponse` refuses the short-circuit whenever a ledger is
   * present, and this is that refusal under the conditions that would trip it:
   * a GET first, then a capture of exactly the same state.
   */
  it('records even when a read has just warmed the cache with the same state', async () => {
    const app = createApp();
    const env: AppEnv = {
      db,
      sleeper: sleeperServing(() => matchupRows()),
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    };
    const warm = await (await app(new Request('https://app.test/api/leagues/demo-league/matchup'), env)).json();
    const again = await (await app(new Request('https://app.test/api/leagues/demo-league/matchup'), env)).json();
    expect(again.cached, 'the memo has to be warm, or this proves nothing').toBe(true);
    expect(await calibrationRows(db)).toBe(0);

    const report = await service().captureCalibration('demo-league');
    expect(report.recorded, 'a warm cache swallowed the capture').toBe(true);
    expect(await calibrationRows(db)).toBe(2);
    expect(warm.forecast.fingerprint).toBeTruthy();
  });

  /** And it does not hand the screen a forecast the screen did not ask for. */
  it('does not warm the screen’s cache with its own forecast', async () => {
    await service().captureCalibration('demo-league');
    const app = createApp();
    const body = await (
      await app(new Request('https://app.test/api/leagues/demo-league/matchup'), {
        db,
        sleeper: sleeperServing(() => matchupRows()),
        vegas: new MockVegasProvider(MOCK_GAMES),
        APP_PASSPHRASE: 'correct horse battery staple',
        SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
      })
    ).json();
    expect(body.cached, 'a cron forecast became a phone’s cached response').toBe(false);
  });

  it('records nothing, and does not throw, for a week with no matchup', async () => {
    const report = await service(() => []).captureCalibration('demo-league', { week: 7 });
    expect(report.recorded).toBe(false);
    expect(await calibrationRows(db)).toBe(0);
  });
});

describe('the scheduled settlement', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  /** A forecast for `week`, as the capture would have left it. */
  async function forecastFor(week: number, season = '2026'): Promise<void> {
    const repo = new MatchupRepo(db);
    for (const [rosterId, opponentRosterId] of [
      [1, 2],
      [2, 1],
    ]) {
      await repo.record({
        leagueId: 'demo-league',
        season,
        week,
        rosterId: rosterId!,
        matchupId: 1,
        opponentRosterId: opponentRosterId!,
        modelVersion: MATCHUP_MODEL_VERSION,
        phase: 'pregame',
        winProbability: 0.62,
        projectedFinal: 118,
        actual: 0,
        confidence: 'high',
        fingerprint: `w${week}`,
        at: `${season}-09-0${Math.min(9, week)}T09:00:00.000Z`,
      });
    }
  }

  /** Tell the app the season has moved past `week`. */
  async function seasonIsAtWeek(week: number): Promise<void> {
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week });
  }

  function service(scores: Record<number, { mine: number; theirs: number }>): MatchupService {
    return new MatchupService(db, {
      sleeper: sleeperServing((week) => (scores[week] ? matchupRows(scores[week]) : [])),
    });
  }

  it('closes a finished week out with Sleeper’s own scores', async () => {
    await forecastFor(1);
    await seasonIsAtWeek(2);

    const report = await service({ 1: { mine: 121.5, theirs: 98.2 } }).settleFinishedWeeks('demo-league');
    expect(report.settled).toEqual([{ season: '2026', week: 1, rosters: 2 }]);

    const stored = await db
      .prepare('SELECT roster_id AS r, final_score AS f, opponent_final_score AS o, won FROM matchup_forecasts ORDER BY roster_id')
      .all<{ r: number; f: number; o: number; won: number }>();
    expect(stored.results).toEqual([
      { r: 1, f: 121.5, o: 98.2, won: 1 },
      { r: 2, f: 98.2, o: 121.5, won: 0 },
    ]);
  });

  /**
   * The reason settlement is on a clock at all.
   *
   * It used to happen only if a Matchup GET landed while the forecast read
   * `final` — a window of a few hours between the last whistle and Sleeper
   * rolling the week over. A week nobody looked at in that window kept its
   * forecasts and never got an outcome, and a forecast with no outcome is
   * excluded from every calibration band. Here nobody looks, and it still
   * settles.
   */
  it('settles a week nobody ever opened', async () => {
    await forecastFor(1);
    await forecastFor(2);
    await seasonIsAtWeek(3);
    await service({ 1: { mine: 101, theirs: 99 }, 2: { mine: 88, theirs: 140 } }).settleFinishedWeeks('demo-league');

    const report = await new MatchupRepo(db).calibration(MATCHUP_MODEL_VERSION);
    expect(report.sample, 'four settled pregame forecasts, gradeable at last').toBe(4);
  });

  it('is idempotent: a second run changes nothing it already closed', async () => {
    await forecastFor(1);
    await seasonIsAtWeek(2);
    const writer = service({ 1: { mine: 121.5, theirs: 98.2 } });
    await writer.settleFinishedWeeks('demo-league');
    const after = await db.prepare('SELECT * FROM matchup_forecasts ORDER BY roster_id').all();

    // A second run, with Sleeper reporting something else entirely. A settled
    // week is settled; the first outcome stands.
    const second = await service({ 1: { mine: 5, theirs: 400 } }).settleFinishedWeeks('demo-league');
    expect(second.settled, 'a settled week must not be settled again').toEqual([]);
    expect(await db.prepare('SELECT * FROM matchup_forecasts ORDER BY roster_id').all()).toEqual(after);
  });

  it('leaves a week the season has not passed alone', async () => {
    await forecastFor(2);
    await seasonIsAtWeek(2);
    const report = await service({ 2: { mine: 60, theirs: 55 } }).settleFinishedWeeks('demo-league');
    expect(report.settled).toEqual([]);
    const row = await db.prepare('SELECT settled_at AS s FROM matchup_forecasts LIMIT 1').first<{ s: string | null }>();
    expect(row!.s, 'a week still being played was graded').toBeNull();
  });

  /**
   * Both scores or neither.
   *
   * A roster whose opponent is missing from Sleeper's payload is left unsettled
   * rather than graded against a zero it never played. A fabricated loss sitting
   * in a calibration band is worse than a missing sample, because the missing
   * sample is visible in the count and the fabricated one is not.
   */
  it('refuses to grade a week it cannot see both sides of', async () => {
    await forecastFor(1);
    await seasonIsAtWeek(2);
    const halfSleeper = new SleeperClient({
      fetch: async (url) =>
        /\/matchups\/\d+$/.test(new URL(url).pathname)
          ? new Response(JSON.stringify([matchupRows({ mine: 121.5 })[0]]), { status: 200 })
          : new Response('null', { status: 200 }),
    });
    const report = await new MatchupService(db, { sleeper: halfSleeper }).settleFinishedWeeks('demo-league');
    expect(report.settled).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM matchup_forecasts WHERE settled_at IS NOT NULL').first<{ n: number }>()).toEqual({
      n: 0,
    });
  });

  /**
   * A week it tried and could not close is still outstanding, and says so.
   *
   * `pending` counts everything closeable this run did not close, not merely
   * everything past the cap — otherwise a run that attempted one week, found no
   * scores for it and closed nothing would report zero outstanding, which reads
   * as "there was nothing left".
   */
  it('does nothing at all when Sleeper answers empty, and still reports it as outstanding', async () => {
    await forecastFor(1);
    await seasonIsAtWeek(2);
    const report = await service({}).settleFinishedWeeks('demo-league');
    expect(report).toEqual({ settled: [], pending: 1 });
  });

  /** A previous season is over by arithmetic, whatever week Sleeper is reporting. */
  it('closes out a week left behind from an earlier season', async () => {
    await forecastFor(17, '2025');
    await seasonIsAtWeek(1);
    const report = await service({ 17: { mine: 130, theirs: 120 } }).settleFinishedWeeks('demo-league');
    expect(report.settled).toEqual([{ season: '2025', week: 17, rosters: 2 }]);
  });

  /**
   * The backlog is drained a few weeks at a time, and it says how much is left.
   *
   * One Sleeper request per week is not something to do an unbounded number of
   * on a tick that also syncs a player dictionary — but a cap that reports
   * nothing reads as "there was nothing left", which is how a silent truncation
   * becomes a permanently half-graded ledger.
   */
  it('bounds one run and reports what it left', async () => {
    const scores: Record<number, { mine: number; theirs: number }> = {};
    for (let week = 1; week <= SETTLE_WEEKS_PER_RUN + 2; week++) {
      await forecastFor(week);
      scores[week] = { mine: 100 + week, theirs: 100 };
    }
    await seasonIsAtWeek(SETTLE_WEEKS_PER_RUN + 3);

    const first = await service(scores).settleFinishedWeeks('demo-league');
    expect(first.settled).toHaveLength(SETTLE_WEEKS_PER_RUN);
    expect(first.settled.map((w) => w.week), 'oldest first').toEqual(
      Array.from({ length: SETTLE_WEEKS_PER_RUN }, (_, i) => i + 1),
    );
    expect(first.pending).toBe(2);

    const second = await service(scores).settleFinishedWeeks('demo-league');
    expect(second.settled.map((w) => w.week)).toEqual([SETTLE_WEEKS_PER_RUN + 1, SETTLE_WEEKS_PER_RUN + 2]);
    expect(second.pending).toBe(0);
  });

  it('does nothing for a league that does not exist', async () => {
    await expect(new MatchupService(db, { sleeper: sleeperServing(() => []) }).settleFinishedWeeks('nope')).resolves.toEqual({
      settled: [],
      pending: 0,
    });
  });
});

async function calibrationRows(db: NodeSqliteDatabase): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM matchup_forecasts').first<{ n: number }>();
  return row?.n ?? 0;
}
