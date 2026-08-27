/**
 * What the scheduler writes down about itself.
 *
 * The run record exists because "did the scheduled refresh run, and did the
 * manager backfill yield because the feeds above it spent the budget" was a
 * question this app could not answer about itself: `scheduled()` logged it to
 * Cloudflare's tail and nowhere else.
 *
 * The two claims worth asserting behaviourally rather than by reading the
 * worker's source are the ones a regression would break silently:
 *
 *   1. **a step that throws does not stop the steps after it.** That guarantee
 *      used to be eleven inline `try`/`catch` blocks; it is now one recorder,
 *      so it is now one thing that can break;
 *   2. **a deferral is recorded as a deferral.** Reporting the manager backfill
 *      yielding as a failure would send somebody diagnosing a healthy system;
 *      reporting it as a success would leave a thin `Next%` unexplained.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { CronRunRecorder, CronRunRepo, errorCategory } from '../src/server/repos/cronRuns.ts';
import { BudgetExhaustedError } from '../src/core/sleeper/budget.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';

const NOW = new Date('2026-09-15T09:00:00.000Z');

function recorder(db: Awaited<ReturnType<typeof createTestDb>>) {
  return new CronRunRecorder(db, {
    cron: '0 9 * * *',
    label: 'Daily refresh',
    releaseSha: 'deadbeef',
    now: () => NOW,
  });
}

describe('one feed failing cannot take the rest of the tick down', () => {
  it('runs every step after one that throws, and records which one it was', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    const ran: string[] = [];

    await run.step('a', 'A', async () => {
      ran.push('a');
    });
    await run.step('b', 'B', async () => {
      ran.push('b');
      throw new Error('the source exploded');
    });
    await run.step('c', 'C', async () => {
      ran.push('c');
    });

    expect(ran, 'a step that threw stopped the steps after it').toEqual(['a', 'b', 'c']);
    const record = await run.finish(null);
    expect(record.outcome).toBe('partial');
    expect(record.steps.map((s) => [s.id, s.outcome])).toEqual([
      ['a', 'succeeded'],
      ['b', 'failed'],
      ['c', 'succeeded'],
    ]);
  });

  /**
   * The exception's own words never reach the row.
   *
   * This record is read by a support screen and copied into a support snapshot,
   * and a message from a failed fetch can carry the URL it was made to. What is
   * stored is a category; the exception goes to the log.
   */
  it('stores a bounded category rather than the exception', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('vegas', 'Vegas lines', async () => {
      throw new Error('GET https://api.example.com/odds?apiKey=SECRET-VALUE failed with 401');
    });
    const record = await run.finish(null);
    const note = record.steps[0]!.note ?? '';
    expect(note).not.toContain('SECRET-VALUE');
    expect(note).not.toContain('https://');
    expect(note).toBe('the source refused the request');
  });

  it.each([
    [new BudgetExhaustedError(48, 48), /refresh budget spent/],
    [new Error('request timed out after 10s'), /did not answer in time/],
    [new Error('404 Not Found'), /nothing published/],
    [new Error('503 Service Unavailable'), /returned an error/],
    [new Error('something nobody anticipated'), /did not complete/],
  ])('names the category rather than the message', (err, expected) => {
    expect(errorCategory(err)).toMatch(expected);
  });
});

describe('deferred work is recorded as deferred', () => {
  it('makes the whole run deferred rather than succeeded, and says why in plain language', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('injuries', 'Injuries', async () => ({ outcome: 'succeeded' as const }));
    await run.step('manager-intel', 'Manager tendencies', async () => ({
      outcome: 'deferred' as const,
      note: 'refresh budget reserved for higher-priority data (48/48 already spent)',
    }));

    const record = await run.finish({ limit: 48, used: 48, remaining: 0 });
    expect(record.outcome).toBe('deferred');
    expect(record.steps.find((s) => s.id === 'manager-intel')?.note).toMatch(/higher-priority/);
  });

  /** A deferral is not a failure, so it must not erase when the clock last worked. */
  it('still counts as a run that worked', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('manager-intel', 'Manager tendencies', async () => ({ outcome: 'deferred' as const }));
    const record = await run.finish(null);
    expect(record.lastSuccessAt).toBe(record.finishedAt);
  });
});

describe('the budget, where there is one', () => {
  it('records the transport counters exactly as the invocation spent them', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('a', 'A', async () => ({ outcome: 'succeeded' as const }));
    await run.finish({ limit: 48, used: 41, remaining: 7 });

    const stored = await new CronRunRepo(db).latest();
    expect(stored?.budget).toEqual({ limit: 48, used: 41, remaining: 7 });
  });

  /**
   * A clock with no ceiling to defend says so, rather than reporting zeroes.
   *
   * The weekend ticks make four external calls between them and pass the
   * unmetered transport. `0/0` would read as "spent nothing"; null reads as
   * "this clock does not have a budget", which is the truth.
   */
  it('is null on a clock that has none, rather than three zeroes', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('a', 'A', async () => ({ outcome: 'succeeded' as const }));
    await run.finish(null);
    expect((await new CronRunRepo(db).latest())?.budget).toBeNull();
  });
});

describe('last attempt and last success, for a clock', () => {
  /**
   * The same distinction every source state in this database keeps, applied to
   * the scheduler: a clock that has been failing since Tuesday must keep saying
   * when it last worked.
   */
  it('a failing run does not erase when the clock last worked', async () => {
    const db = await createTestDb();
    const repo = new CronRunRepo(db);

    await repo.record({
      cron: '0 9 * * *',
      label: 'Daily refresh',
      trigger: 'schedule',
      startedAt: '2026-09-14T09:00:00.000Z',
      finishedAt: '2026-09-14T09:01:00.000Z',
      outcome: 'succeeded',
      budget: null,
      steps: [],
      releaseSha: null,
    });
    await repo.record({
      cron: '0 9 * * *',
      label: 'Daily refresh',
      trigger: 'schedule',
      startedAt: '2026-09-15T09:00:00.000Z',
      finishedAt: '2026-09-15T09:01:00.000Z',
      outcome: 'failed',
      budget: null,
      steps: [],
      releaseSha: null,
    });

    const stored = await repo.latest();
    expect(stored?.startedAt).toBe('2026-09-15T09:00:00.000Z');
    expect(stored?.outcome).toBe('failed');
    expect(stored?.lastSuccessAt).toBe('2026-09-14T09:01:00.000Z');
  });

  /** One row per clock, for ever — this is a current view, not a history. */
  it('keeps one row per clock rather than growing a ledger', async () => {
    const db = await createTestDb();
    const repo = new CronRunRepo(db);
    for (let i = 0; i < 5; i++) {
      await repo.record({
        cron: '0 9 * * *',
        label: 'Daily refresh',
        trigger: 'schedule',
        startedAt: `2026-09-1${i}T09:00:00.000Z`,
        finishedAt: null,
        outcome: 'succeeded',
        budget: null,
        steps: [],
        releaseSha: null,
      });
    }
    expect((await repo.all()).length).toBe(1);
  });

  it('keeps the three clocks apart', async () => {
    const db = await createTestDb();
    const repo = new CronRunRepo(db);
    for (const cron of ['0 9 * * *', '0 23 * * SAT', '0 15 * * SUN']) {
      await repo.record({
        cron,
        label: cron,
        trigger: 'schedule',
        startedAt: '2026-09-15T09:00:00.000Z',
        finishedAt: null,
        outcome: 'succeeded',
        budget: null,
        steps: [],
        releaseSha: null,
      });
    }
    expect((await repo.all()).length).toBe(3);
  });
});

describe('the run reaches the health view', () => {
  it('as the most recent run, with its summary in plain language', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('injuries', 'Injuries', async () => ({ outcome: 'succeeded' as const }));
    await run.step('usage', 'Usage', async () => ({ outcome: 'not_published' as const }));
    await run.step('manager-intel', 'Manager tendencies', async () => ({ outcome: 'deferred' as const }));
    await run.finish({ limit: 48, used: 46, remaining: 2 });

    const view = await new DataHealthService(db, { now: () => NOW }).view();
    expect(view.lastRun?.label).toBe('Daily refresh');
    expect(view.lastRun?.outcome).toBe('deferred');
    expect(view.lastRun?.summary).toMatch(/Manager tendencies deferred/);
    expect(view.lastRun?.summary).toMatch(/Usage waiting on the source/);
    expect(view.lastRun?.budget).toEqual({ limit: 48, used: 46, remaining: 2 });
    expect(view.lastRun?.releaseSha).toBe('deadbeef');
  });

  /**
   * And the manager-tendencies row reads `Deferred · background` because of it.
   *
   * This is the one source whose current state is a fact about the scheduler
   * rather than about its own table: the ledger looks identical whether the
   * batch ran and found nothing or never started, and only the run record tells
   * the two apart.
   */
  it('and makes the deferral visible on the source row it explains', async () => {
    const db = await createTestDb();
    await db
      .prepare(
        `INSERT INTO leagues (id, sleeper_league_id, name, season, total_rosters, scoring_settings_json,
                              roster_positions_json, league_settings_json, is_selected, last_synced_at)
         VALUES ('L','S','L','2026',12,'{}','[]','{}',1,'2026-09-15T00:00:00.000Z')`,
      )
      .run();

    const run = recorder(db);
    await run.step('manager-intel', 'Manager tendencies', async () => ({
      outcome: 'deferred' as const,
      note: 'refresh budget reserved for higher-priority data (48/48 already spent)',
    }));
    await run.finish({ limit: 48, used: 48, remaining: 0 });

    const view = await new DataHealthService(db, { now: () => NOW }).view();
    const intel = view.sources.find((s) => s.id === 'manager-intel');
    expect(intel?.state).toBe('deferred');
    expect(intel?.severity).toBe('background');
    expect(intel?.note).toMatch(/higher-priority/);
  });
});

describe('nothing that comes off a wire is stored', () => {
  it('truncates a note that could become a log', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('a', 'A', async () => ({ outcome: 'succeeded' as const, note: 'x'.repeat(1_000) }));
    await run.finish(null);
    const stored = await new CronRunRepo(db).latest();
    expect(stored!.steps[0]!.note!.length).toBeLessThanOrEqual(160);
  });

  it('records nothing at all until the run finishes', async () => {
    const db = await createTestDb();
    const run = recorder(db);
    await run.step('a', 'A', async () => ({ outcome: 'succeeded' as const }));
    expect(await new CronRunRepo(db).latest()).toBeNull();
    await run.finish(null);
    expect(await new CronRunRepo(db).latest()).not.toBeNull();
  });
});
