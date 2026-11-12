/**
 * Round 22: the refresh button as a server job.
 *
 * What these prove, each against the real job service and a real database:
 *
 *   - the reply comes back while the work is still running, and the work
 *     finishes after the "phone" has gone (the client disconnect is simulated
 *     by never waiting on the response for anything);
 *   - a second tap while it runs, or just after, joins the first: one job,
 *     one round of Sleeper requests, one odds pass;
 *   - each source is skipped inside its freshness window and refreshed outside
 *     it;
 *   - the sources run at the same time rather than one after another;
 *   - the job row says what each source did and what the job cost in rows.
 *
 * Every one of these fails on the code before Round 22: `/api/refresh` did not
 * exist, and the old refresh answered only when every source had finished.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import {
  FRESHNESS_MINUTES,
  JOIN_DONE_SECONDS,
  LEASE_SECONDS,
  RefreshJobService,
  type RefreshJob,
} from '../src/server/services/refreshJob.ts';
import { StartSitRefreshService } from '../src/server/services/startSitRefresh.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { InjurySourceRepo } from '../src/server/repos/injury.ts';
import { INJURY_SOURCE, injurySeason } from '../src/server/services/injuryService.ts';
import { ScheduleSourceRepo } from '../src/server/repos/nflSchedule.ts';
import { SCHEDULE_SOURCE } from '../src/server/services/scheduleService.ts';
import { usageSeason } from '../src/server/services/usageService.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { costMeter } from '../src/server/services/refreshCost.ts';

/** Thursday 12 November 2026, 9 AM ET. */
const PINNED = new Date('2026-11-12T14:00:00Z');

class CountingProvider extends MockVegasProvider {
  calls = 0;
  constructor() {
    super(MOCK_GAMES);
  }
  override isConfigured(): boolean {
    return true;
  }
  override async getPropsForTeams(teamIds: string[], opts: Parameters<MockVegasProvider['getPropsForTeams']>[1] = {}) {
    this.calls++;
    return super.getPropsForTeams(teamIds, opts);
  }
  override async getPlayerProps(...args: Parameters<MockVegasProvider['getPlayerProps']>) {
    this.calls++;
    return super.getPlayerProps(...args);
  }
}

/**
 * Sleeper's documented league endpoints for the seeded demo league, through
 * the real client. `hold` parks the rosters answer until released, which is
 * how a slow source is made to still be running after the reply.
 */
function fakeSleeper() {
  const asked: string[] = [];
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = new SleeperClient({
    retries: 0,
    fetch: async (url: string) => {
      const path = new URL(String(url)).pathname;
      asked.push(path);
      if (path.endsWith('/league/demo-league')) {
        return json({
          league_id: 'demo-league',
          name: 'Demo League',
          season: '2026',
          status: 'in_season',
          total_rosters: 2,
          roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'],
          scoring_settings: { rec: 0.5, pass_td: 6 },
          settings: { type: 0 },
        });
      }
      if (path.endsWith('/rosters')) {
        if (held) await held;
        return json([
          { roster_id: 1, owner_id: 'demo-user', players: ['1001', '1002'], starters: ['1001'], reserve: [], settings: { wins: 6 } },
          { roster_id: 2, owner_id: 'rival', players: ['1006'], starters: ['1006'], reserve: [], settings: { wins: 4 } },
        ]);
      }
      if (path.endsWith('/users')) return json([{ user_id: 'demo-user', display_name: 'demo' }, { user_id: 'rival', display_name: 'rival' }]);
      if (path.endsWith('/drafts')) return json([]);
      if (path.endsWith('/state/nfl')) return json({ week: 10, season: '2026', season_type: 'regular', display_week: 10 });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    client,
    asked,
    leagueReads: () => asked.filter((p) => p.endsWith('/league/demo-league')).length,
    hold() {
      held = new Promise<void>((resolve) => (release = resolve));
    },
    release() {
      release?.();
      held = null;
    },
  };
}

describe('the refresh job (Round 22)', () => {
  let db: NodeSqliteDatabase;
  let now: Date;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = new Date(PINNED);
    vi.setSystemTime(now);
    // No live feed in a unit test: the injury report and schedule fail at once.
    vi.stubGlobal('fetch', async () => {
      throw new Error('no network in this test');
    });
    db = await createTestDb();
    await seedDemoData(db);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const service = (sleeper: SleeperClient, vegas = new CountingProvider(), background?: (p: Promise<unknown>) => void) =>
    new RefreshJobService(db, { sleeper, vegas, now: () => now, ...(background ? { background } : {}) });

  it('answers at once and keeps going after the phone leaves', async () => {
    const sleeper = fakeSleeper();
    sleeper.hold();
    const background: Promise<unknown>[] = [];
    const env: AppEnv = {
      db,
      sleeper: sleeper.client,
      vegas: new CountingProvider(),
      disableAuth: true,
      waitUntil: (task) => background.push(task),
    };
    const app = createApp();

    // The tap. The roster answer is parked, so the work cannot be finished yet.
    const res = await app(new Request('http://x/api/refresh', { method: 'POST', body: JSON.stringify({ kind: 'startsit' }) }), env);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: RefreshJob };
    expect(job.state).toBe('running');
    expect(background).toHaveLength(1);

    // The phone is gone: nobody reads anything more from that request.
    // The server finishes on its own once Sleeper answers.
    sleeper.release();
    await Promise.all(background);

    const status = await app(new Request('http://x/api/refresh/status?kind=startsit'), env);
    const after = ((await status.json()) as { job: RefreshJob }).job;
    expect(after.id).toBe(job.id);
    expect(after.state).toBe('done');
    expect(after.finishedAt).not.toBeNull();
    expect(after.sources.find((s) => s.source === 'roster')?.outcome).toBe('updated');
  });

  it('a second tap while it runs joins the first', async () => {
    const sleeper = fakeSleeper();
    sleeper.hold();
    const vegas = new CountingProvider();
    const jobs = service(sleeper.client, vegas);

    const first = await jobs.start('startsit');
    const second = await jobs.start('startsit');
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(second.job.id).toBe(first.job.id);

    sleeper.release();
    await first.finished;
    expect(sleeper.leagueReads(), 'one round of Sleeper requests for two taps').toBe(1);
  });

  it('a tap just after one finished gets that one, and a later tap runs again', async () => {
    const sleeper = fakeSleeper();
    const jobs = service(sleeper.client);
    const first = await jobs.start('startsit');
    await first.finished;

    now = new Date(PINNED.getTime() + (JOIN_DONE_SECONDS - 5) * 1_000);
    const soon = await jobs.start('startsit');
    expect(soon.joined).toBe(true);
    expect(soon.job.id).toBe(first.job.id);

    now = new Date(PINNED.getTime() + (JOIN_DONE_SECONDS + 5) * 1_000);
    const later = await jobs.start('startsit');
    expect(later.joined).toBe(false);
    expect(later.job.id).not.toBe(first.job.id);
  });

  it('skips sources refreshed inside their window and refreshes stale ones', async () => {
    const settings = new SettingsRepo(db);
    // Odds bought a minute ago: inside the window.
    await settings.set(SETTING_KEYS.lastVegasRefresh, new Date(now.getTime() - 60_000).toISOString());
    // Injury report checked a minute ago by its cron: inside the window.
    await new InjurySourceRepo(db).recordCheck(INJURY_SOURCE, injurySeason(now), {
      checkedAt: new Date(now.getTime() - 60_000).toISOString(),
      outcome: 'not_modified',
      note: null,
    });
    // Schedule checked a day ago: outside its six-hour window.
    await new ScheduleSourceRepo(db).recordCheck(SCHEDULE_SOURCE, usageSeason(now), {
      checkedAt: new Date(now.getTime() - 24 * 3_600_000).toISOString(),
      outcome: 'not_modified',
      note: null,
    });

    const sleeper = fakeSleeper();
    const vegas = new CountingProvider();
    const jobs = service(sleeper.client, vegas);
    const run = await jobs.start('startsit');
    const done = (await run.finished)!;
    const outcome = (source: string) => done.sources.find((s) => s.source === source)!;

    expect(outcome('vegas').outcome).toBe('current');
    expect(vegas.calls, 'no odds bought inside the window').toBe(0);
    expect(outcome('injury').outcome).toBe('current');
    // Stale: asked (and, with no network here, reported as not answering).
    expect(outcome('schedule').outcome).toBe('unavailable');
    expect(outcome('roster').outcome).toBe('updated');

    // A tap after the join window but inside the roster's own window skips the roster too.
    now = new Date(now.getTime() + (JOIN_DONE_SECONDS + 10) * 1_000);
    expect((JOIN_DONE_SECONDS + 10) / 60).toBeLessThan(FRESHNESS_MINUTES.roster);
    const again = (await (await jobs.start('startsit')).finished)!;
    expect(again.sources.find((s) => s.source === 'roster')!.outcome).toBe('current');
    expect(sleeper.leagueReads(), 'the roster was not re-read inside its window').toBe(1);

    // Past the window it is read again.
    now = new Date(now.getTime() + FRESHNESS_MINUTES.roster * 60_000 + 1_000);
    const third = (await (await jobs.start('startsit')).finished)!;
    expect(third.sources.find((s) => s.source === 'roster')!.outcome).toBe('updated');
    expect(sleeper.leagueReads()).toBe(2);
  });

  it('refreshes only what start/sit needs', async () => {
    const run = await service(fakeSleeper().client).start('startsit');
    const done = (await run.finished)!;
    expect(done.sources.map((s) => s.source).sort()).toEqual(['injury', 'roster', 'schedule', 'vegas']);
  });

  it('runs the sources at the same time', async () => {
    // The roster is parked; if the sources ran in turn, nothing after it could finish first.
    const sleeper = fakeSleeper();
    sleeper.hold();
    const jobs = service(sleeper.client);
    const run = await jobs.start('startsit');
    let settled = false;
    void run.finished.then(() => (settled = true));
    // Give the other three sources time to finish while the roster waits.
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    sleeper.release();
    const done = (await run.finished)!;
    const roster = done.sources.find((s) => s.source === 'roster')!;
    const others = done.sources.filter((s) => s.source !== 'roster');
    // Each of the others took less time than the whole job: they did not queue behind the roster.
    for (const s of others) expect(s.ms).toBeLessThanOrEqual(roster.ms);
  });

  it('a running row past its lease reads as finished, so a screen never spins for ever', async () => {
    const sleeper = fakeSleeper();
    sleeper.hold();
    const jobs = service(sleeper.client);
    await jobs.start('startsit');
    now = new Date(PINNED.getTime() + (LEASE_SECONDS + 5) * 1_000);
    const status = await jobs.status('startsit');
    expect(status?.state).toBe('done');
    expect(status?.complete).toBe(false);
    // And a new tap may start over.
    const fresh = await jobs.start('startsit');
    expect(fresh.joined).toBe(false);
    sleeper.release();
  });

  it('records what the job cost the database, and starting and status stay tiny', async () => {
    const counted = countingDb(db);
    const JOB_ROW = 'SELECT value_json, updated_at FROM settings WHERE key = ?';
    const sleeper = fakeSleeper();
    sleeper.hold();
    const jobs = new RefreshJobService(counted.db, { sleeper: sleeper.client, vegas: new CountingProvider(), now: () => now });
    const run = await jobs.start('startsit');
    expect(counted.callsMatching(JOB_ROW), 'starting reads the job row once').toBe(1);
    await jobs.status('startsit');
    expect(counted.callsMatching(JOB_ROW), 'a status check is one more read of it').toBe(2);
    sleeper.release();
    const done = (await run.finished)!;
    expect(done.cost).not.toBeNull();
    expect(done.cost!.statements).toBeGreaterThan(0);
    expect(done.cost!.rowsWritten).toBeGreaterThan(0);
  });

  it('the Waivers job refreshes its own Sleeper sources and nothing that costs odds', async () => {
    const sleeper = fakeSleeper();
    const vegas = new CountingProvider();
    const run = await service(sleeper.client, vegas).start('waivers');
    const done = (await run.finished)!;
    expect(done.sources.map((s) => s.source).sort()).toEqual(['points', 'projections', 'transactions', 'trending']);
    expect(vegas.calls).toBe(0);
  });

  /*
   * Rows read and written by one tap, old refresh against new, on the same
   * seeded database with nothing fresh. Printed for the round's report; the
   * assertion is only that the new job is not more expensive.
   */
  it('reads no more rows than the old refresh for the same data', async () => {
    const measure = async (work: (db: NodeSqliteDatabase) => Promise<unknown>) => {
      const fresh = await createTestDb();
      await seedDemoData(fresh);
      // Reads: rows returned, the project's usual count (`helpers/countingDb.ts`). Writes: rows changed.
      const writes = costMeter(fresh);
      const counted = countingDb(writes.db);
      await work(counted.db as NodeSqliteDatabase);
      const rows = counted.tallies().reduce((sum, t) => sum + t.rows, 0);
      return { rows, written: writes.cost().rowsWritten, statements: counted.tallies().reduce((sum, t) => sum + t.calls, 0) };
    };
    const old = await measure((d) => new StartSitRefreshService(d, { sleeper: fakeSleeper().client, vegas: new CountingProvider(), now: () => now }).refresh());
    const neu = await measure(async (d) => {
      const jobs = new RefreshJobService(d, { sleeper: fakeSleeper().client, vegas: new CountingProvider(), now: () => now });
      const run = await jobs.start('startsit');
      await run.finished;
      // The phone's status checks while it runs: a few one-row reads.
      for (let i = 0; i < 3; i++) await jobs.status('startsit');
    });
    console.log(`per refresh (seeded db): old read ${old.rows} rows in ${old.statements} statements, wrote ${old.written}; new read ${neu.rows} in ${neu.statements}, wrote ${neu.written}`);
    expect(neu.rows).toBeLessThanOrEqual(old.rows);
    expect(neu.statements).toBeLessThan(old.statements);
  });
});
