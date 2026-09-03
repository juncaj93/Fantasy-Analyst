/**
 * The three ways this pipeline can be wrong without looking wrong.
 *
 *   1. It can miss weeks while nobody is watching, and come back with a latest
 *      week that is perfectly current sitting on top of a hole.
 *   2. It can have the source move underneath an ingest.
 *   3. It can fail every ingest for a day while `checked_at` advances every five
 *      minutes, so every freshness cue on the screen says it is fine.
 *
 * The third is the dangerous one, because it is the one a person would act on.
 */

import { describe, expect, it, vi } from 'vitest';

import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { InjuryRepo, InjurySourceRepo } from '../src/server/repos/injury.ts';
import { InjuryService, describeDataHealth, DAILY_WRITE_CEILING } from '../src/server/services/injuryService.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = '2026';
const HEADER =
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,' +
  'report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,' +
  'practice_secondary_injury,practice_status';
const DNP = 'Did Not Participate In Practice';

function csv(rows: { name: string; week: number; status?: string; practice?: string }[]): string {
  return [
    HEADER,
    ...rows.map((r) => {
      const [first = '', ...rest] = r.name.split(' ');
      return (
        `${SEASON},REG,REG,KC,${r.week},,WR,${r.name},${first},${rest.join(' ')},` +
        `Hamstring,,${r.status ?? 'Questionable'},Hamstring,,${r.practice ?? DNP}`
      );
    }),
  ].join('\n');
}

/** Weeks 1..n for one player, which is what a season file looks like by week n. */
function through(week: number): string {
  return csv(Array.from({ length: week }, (_, i) => ({ name: 'Ann Ash', week: i + 1 })));
}

async function setup(): Promise<Database> {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany([player({ id: 'p-ann', fullName: 'Ann Ash' })]);
  return db;
}

describe('catching up after an outage', () => {
  /**
   * The app reads week 1, goes away for a month, and comes back to a file that
   * is now on week 5. The steady-state window is one week, so it reads week 5 —
   * correct, current, and sitting on a three-week hole.
   */
  it('fills the hole one week per tick, oldest first', async () => {
    const db = await setup();
    let body = through(1);
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
    });

    await service.refresh(SEASON);
    expect((await new InjuryRepo(db).weeksFor('p-ann', SEASON, 10)).map((w) => w.week)).toEqual([1]);

    // A month passes. The file is on week 5 now.
    body = through(5);
    await service.refresh(SEASON);
    const afterReturn = await new InjuryRepo(db).weeksFor('p-ann', SEASON, 10);
    expect(afterReturn.map((w) => w.week), 'current is right, history has a hole').toEqual([1, 5]);

    // One tick, one week, oldest first.
    expect(await service.catchUpOneWeek(SEASON)).toMatchObject({ week: 2 });
    expect(await service.catchUpOneWeek(SEASON)).toMatchObject({ week: 3 });
    expect(await service.catchUpOneWeek(SEASON)).toMatchObject({ week: 4 });

    const filled = await new InjuryRepo(db).weeksFor('p-ann', SEASON, 10);
    expect(filled.map((w) => w.week)).toEqual([1, 2, 3, 4, 5]);
  });

  it('says there is nothing to do once the gap is closed', async () => {
    const db = await setup();
    let body = through(3);
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
    });
    await service.refresh(SEASON);
    body = through(4);
    await service.refresh(SEASON);

    while (await service.catchUpOneWeek(SEASON)) {
      /* fill it */
    }
    expect(await service.catchUpOneWeek(SEASON)).toBeNull();
  });

  /*
   * The read that exhausted the database.
   *
   * `missingWeekBefore` reads every row a season holds. It rides the
   * five-minute tick, so once the last gap is filled it asked a settled
   * question 288 times a day — against a table the backfill had just filled
   * with a whole season. On 2026-09-01 that reached D1's 5,000,000 daily
   * row-read limit and the app began erroring on every request that touched
   * the database.
   *
   * The count is the assertion, not the return value: `catchUpOneWeek` has
   * always returned null here, and did so while scanning. Only the number of
   * scans tells the two apart.
   */
  it('asks whether a week is missing once, not on every tick', async () => {
    const db = await setup();
    let body = through(3);
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
    });
    await service.refresh(SEASON);
    body = through(4);
    await service.refresh(SEASON);

    while (await service.catchUpOneWeek(SEASON)) {
      /* fill it */
    }

    const scan = vi.spyOn(InjuryRepo.prototype, 'missingWeekBefore');
    try {
      for (let tick = 0; tick < 20; tick++) {
        expect(await service.catchUpOneWeek(SEASON)).toBeNull();
      }
      expect(scan, 'twenty ticks, and the season is scanned at most once').toHaveBeenCalledTimes(0);
    } finally {
      scan.mockRestore();
    }
  });

  /*
   * And the case the watermark must not swallow.
   *
   * A gap is created by a week arriving while an earlier one is missing, so the
   * feed moving past the verified point is exactly when the scan has to run
   * again. A watermark that suppressed it would turn a cheap tick into a
   * permanently blind one.
   */
  it('scans again once the feed moves past the point it verified', async () => {
    const db = await setup();
    let body = through(2);
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
    });
    await service.refresh(SEASON);

    while (await service.catchUpOneWeek(SEASON)) {
      /* settle, and write the watermark */
    }
    expect(await service.catchUpOneWeek(SEASON)).toBeNull();

    // The source jumps to week 5, leaving 3 and 4 behind it unread.
    body = through(5);
    await service.refresh(SEASON);

    const scan = vi.spyOn(InjuryRepo.prototype, 'missingWeekBefore');
    try {
      expect(await service.catchUpOneWeek(SEASON), 'the hole is found again').toMatchObject({ week: 3 });
      expect(scan).toHaveBeenCalled();
    } finally {
      scan.mockRestore();
    }

    while (await service.catchUpOneWeek(SEASON)) {
      /* fill the rest */
    }
    /*
     * Two, not one. The steady-state refresh stores the file's latest week
     * only, so the first one stored week 2 and week 1 was never read — and
     * catch-up fills *between* the weeks it holds rather than reaching below
     * the oldest of them. The hole this closes is 3 and 4.
     */
    const filled = await new InjuryRepo(db).weeksFor('p-ann', SEASON, 10);
    expect(filled.map((w) => w.week)).toEqual([2, 3, 4, 5]);
  });

  /** Catch-up is history. It must not move a card or spend an event. */
  it('writes rows without touching current state', async () => {
    const db = await setup();
    let body = through(1);
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(body, { status: 200, headers: { etag: `"v${++version}"` } }),
    });
    await service.refresh(SEASON);
    body = through(4);
    await service.refresh(SEASON);

    const currentBefore = await new InjuryRepo(db).latestFor(['p-ann'], SEASON);
    const eventsBefore = await new InjurySourceRepo(db).recentEvents();

    await service.catchUpOneWeek(SEASON);

    expect((await new InjuryRepo(db).latestFor(['p-ann'], SEASON)).get('p-ann')!.week).toBe(
      currentBefore.get('p-ann')!.week,
    );
    expect(await new InjurySourceRepo(db).recentEvents()).toHaveLength(eventsBefore.length);
  });

  it('never runs before anything has been ingested', async () => {
    const db = await setup();
    const service = new InjuryService(db, { log: () => {}, fetch: async () => new Response('', { status: 404 }) });
    await service.refresh(SEASON);
    expect(await service.catchUpOneWeek(SEASON)).toBeNull();
  });
});

describe('the source moving underneath an ingest', () => {
  /**
   * Latest intent wins, and it does so without any extra machinery: each tick
   * stores the validator belonging to the body it actually parsed, so a
   * republish that lands mid-tick is simply the next tick's work.
   */
  it('stores the validator of the file it actually read', async () => {
    const db = await setup();
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(through(2), { status: 200, headers: { etag: '"read-this-one"' } }),
    });
    await service.refresh(SEASON);
    expect((await new InjurySourceRepo(db).get('nflverse', SEASON))!.etag).toBe('"read-this-one"');
  });

  it('lets the next tick pick up a file that changed during the last one', async () => {
    const db = await setup();
    let etag = '"v1"';
    let body = through(2);
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async (_u, init) => {
        const sent = new Headers(init?.headers as HeadersInit);
        if (sent.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
        return new Response(body, { status: 200, headers: { etag } });
      },
    });

    await service.refresh(SEASON);
    // Republished while nobody was looking.
    etag = '"v2"';
    body = csv([{ name: 'Ann Ash', week: 2, status: 'Out' }]);

    const run = await service.refresh(SEASON);
    expect(run.changedPlayerIds).toEqual(['p-ann']);
    expect((await new InjurySourceRepo(db).get('nflverse', SEASON))!.etag).toBe('"v2"');
  });

  it('does not let a duplicate tick ingest the same file twice', async () => {
    const db = await setup();
    let bodies = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => {
        bodies++;
        return new Response(through(2), { status: 200, headers: { etag: `"v${bodies}"` } });
      },
    });
    const [a, b] = await Promise.all([service.refresh(SEASON), service.refresh(SEASON)]);
    const notes = [a.note, b.note];
    expect(notes.some((n) => n === 'another ingest is already running')).toBe(true);
  });
});

describe('a recent check cannot vouch for stale data', () => {
  it('counts consecutive failed ingests', async () => {
    const db = await setup();
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      // A new validator every time, and a body that always explodes on read.
      fetch: async () => {
        version++;
        return new Response(through(2), { status: 200, headers: { etag: `"v${version}"` } });
      },
    });
    await service.refresh(SEASON);
    expect((await new InjurySourceRepo(db).get('nflverse', SEASON))!.consecutiveFailures).toBe(0);

    // Force the expensive path to refuse, twice, the way the budget guard does.
    await new InjurySourceRepo(db).addWrites(new Date().toISOString().slice(0, 10), DAILY_WRITE_CEILING, new Date().toISOString());
    await service.refresh(SEASON);
    await service.refresh(SEASON);

    const state = (await new InjurySourceRepo(db).get('nflverse', SEASON))!;
    expect(state.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(state.failingSince, 'and remembers when it started going wrong').not.toBeNull();
    // The check itself is still happening, which is exactly the trap.
    expect(state.checkedAt).not.toBeNull();
  });

  it('clears the count as soon as an ingest completes', async () => {
    const db = await setup();
    const repo = new InjurySourceRepo(db);
    let version = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(through(2), { status: 200, headers: { etag: `"v${++version}"` } }),
    });
    await service.refresh(SEASON);
    await repo.recordIngestFailure('nflverse', SEASON, new Date().toISOString(), 'pretend');
    expect((await repo.get('nflverse', SEASON))!.consecutiveFailures).toBe(1);

    await service.refresh(SEASON);
    const state = (await repo.get('nflverse', SEASON))!;
    expect(state.consecutiveFailures).toBe(0);
    expect(state.failingSince).toBeNull();
  });

  it('says so in a sentence, rather than leaving it to be worked out', () => {
    expect(describeDataHealth({ consecutiveFailures: 4, failingSince: '2026-09-10T14:00:00Z', ingestedAt: 'x' }, null)).toContain(
      'the last 4 injury ingests did not complete',
    );
    expect(describeDataHealth({ consecutiveFailures: 1, ingestedAt: 'x' }, null)).toContain('did not complete');
    expect(describeDataHealth({ consecutiveFailures: 0, ingestedAt: 'x' }, { outcome: 'ok' })).toContain('current');
    expect(describeDataHealth({ consecutiveFailures: 0, ingestedAt: null }, { outcome: 'not_published' })).toContain(
      'No injury report is published',
    );
  });

  it('never claims to be current while it is failing', () => {
    const failing = describeDataHealth({ consecutiveFailures: 3, ingestedAt: 'x' }, { outcome: 'ok' });
    expect(failing).not.toMatch(/is current/);
  });
});
