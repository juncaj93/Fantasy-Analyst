/**
 * Walking a finished season, and keeping it out of this one.
 *
 * Two things are being held apart here, and only one of them is about speed.
 *
 * The speed half: a full season cannot be read in a single Workers invocation,
 * so the walk is resumable and these tests hold it to that — a tick does one
 * week, the cursor survives, and the whole thing converges.
 *
 * The safety half matters more. 2025 rows must never reach a 2026 decision. A
 * player who missed nine games last October and is practising fully today is
 * healthy, and the tests that say so are the ones worth keeping.
 */

import { describe, expect, it } from 'vitest';

import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { InjuryRepo, InjurySourceRepo } from '../src/server/repos/injury.ts';
import { InjuryHistoryRepo } from '../src/server/repos/injuryHistory.ts';
import { InjuryHistoryService, backfillLedgerKey } from '../src/server/services/injuryHistoryService.ts';
import { InjuryService } from '../src/server/services/injuryService.ts';
import type { Database } from '../src/server/db.ts';

const HISTORY_SEASON = '2025';
const CURRENT_SEASON = '2026';

const HEADER =
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,' +
  'report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,' +
  'practice_secondary_injury,practice_status';

interface Row {
  name: string;
  week: number;
  status: string;
  injury: string;
  practice: string;
  season?: string;
}

function csv(rows: Row[]): string {
  return [
    HEADER,
    ...rows.map((r) => {
      const [first = '', ...rest] = r.name.split(' ');
      const type = r.week > 18 ? 'POST' : 'REG';
      return (
        `${r.season ?? HISTORY_SEASON},${type},${type},KC,${r.week},,WR,${r.name},${first},${rest.join(' ')},` +
        `${r.injury},,${r.status},${r.injury},,${r.practice}`
      );
    }),
  ].join('\n');
}

const OUT = { status: 'Out', practice: 'Did Not Participate In Practice' };
const QUESTIONABLE = { status: 'Questionable', practice: 'Limited Participation in Practice' };

/**
 * The last week the fixture file contains.
 *
 * The walk stops at the file's own last week rather than at a fixed 22, because
 * that is what the file says — a season that has only played nine weeks has a
 * last week of nine. The fixture reaches week 18 so the walk is exercised over
 * a full regular season instead of a short one.
 */
const FIXTURE_LAST_WEEK = 18;

/** A full season for two players: one who lost most of the autumn, one who did not. */
function season2025(): string {
  const rows: Row[] = [];
  for (let week = 1; week <= FIXTURE_LAST_WEEK; week++) {
    // Ann Ash: out weeks 4-9 with a hamstring. Six games, unmistakably significant.
    if (week >= 4 && week <= 9) rows.push({ name: 'Ann Ash', week, injury: 'Hamstring', ...OUT });
    // Bob Birch: a questionable ankle in week 2, and a late one. Never a story.
    if (week === 2 || week === FIXTURE_LAST_WEEK) rows.push({ name: 'Bob Birch', week, injury: 'Ankle', ...QUESTIONABLE });
  }
  return csv(rows);
}

/**
 * An origin that serves the season file and honours conditional requests, the
 * way the real release asset was measured to.
 */
function origin(body: string, etag = '"season-2025"') {
  const state = { requests: 0, bodiesSent: 0, conditionalHits: 0, etag, body };
  return {
    state,
    fetch: async (_url: string, init?: RequestInit) => {
      state.requests++;
      const sent = new Headers(init?.headers as HeadersInit);
      if (sent.get('if-none-match') === state.etag) {
        state.conditionalHits++;
        return new Response(null, { status: 304, headers: { etag: state.etag } });
      }
      state.bodiesSent++;
      return new Response(state.body, {
        status: 200,
        headers: { etag: state.etag, 'last-modified': 'Wed, 18 Mar 2026 12:45:31 GMT' },
      });
    },
  };
}

async function setup(): Promise<Database> {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany([
    player({ id: 'p-ann', fullName: 'Ann Ash' }),
    player({ id: 'p-bob', fullName: 'Bob Birch' }),
  ]);
  return db;
}

/** Run the walk to completion, with a hard stop so a bug cannot spin forever. */
async function runToCompletion(service: InjuryHistoryService, season = HISTORY_SEASON): Promise<number> {
  for (let ticks = 1; ticks <= 60; ticks++) {
    const step = await service.step(season);
    if (step.error) throw new Error(`backfill failed: ${step.error}`);
    if (step.phase === 'done') return ticks;
  }
  throw new Error('backfill did not converge in 60 ticks');
}

describe('walking a finished season', () => {
  it('reads it one week at a time and converges', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });

    const first = await service.step(HISTORY_SEASON);
    expect(first.phase).toBe('weeks');
    expect(first.weeksDone).toBe(1);

    /*
     * The remaining weeks, then a page of players, then the page that finds
     * none and closes the walk. One tick was already spent above.
     */
    const ticks = await runToCompletion(service);
    expect(ticks).toBe(FIXTURE_LAST_WEEK - 1 + 2);

    const progress = await new InjuryHistoryRepo(db).progress('nflverse', HISTORY_SEASON);
    expect(progress!.phase).toBe('done');
    expect(progress!.completedAt).not.toBeNull();
    /*
     * And the cursor still says where the walk got to. Writing the row as a
     * partial patch used to reset this to 1 while summarizing players, so a
     * finished season claimed on disk to be back at week one.
     */
    expect(progress!.nextWeek).toBe(FIXTURE_LAST_WEEK + 1);
    expect(progress!.lastWeek).toBe(FIXTURE_LAST_WEEK);
  });

  it('is idempotent — running it again changes nothing', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });
    await runToCompletion(service);

    const repo = new InjuryHistoryRepo(db);
    const before = await repo.forPlayers(['p-ann', 'p-bob'], HISTORY_SEASON);
    const step = await service.step(HISTORY_SEASON);
    const after = await repo.forPlayers(['p-ann', 'p-bob'], HISTORY_SEASON);

    expect(step.note).toBe('nothing to do');
    expect([...after.values()]).toEqual([...before.values()]);
  });

  it('resumes from where a dead tick left it', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });

    await service.step(HISTORY_SEASON);
    await service.step(HISTORY_SEASON);

    const repo = new InjuryHistoryRepo(db);
    expect((await repo.progress('nflverse', HISTORY_SEASON))!.nextWeek).toBe(3);

    // A fresh instance, as a later invocation would be: no memory, just the row.
    const resumed = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });
    const step = await resumed.step(HISTORY_SEASON);
    expect(step.weeksDone).toBe(3);
  });

  it('writes only what it says it wrote', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });
    await runToCompletion(service);

    const stored = await new InjuryHistoryRepo(db).forPlayers(['p-ann', 'p-bob'], HISTORY_SEASON);
    expect(stored.get('p-ann')!.note).toBe('2025: missed 6 games with a hamstring injury');
    expect(stored.get('p-ann')!.significance).toBe('strong');
    // Bob was Questionable once and missed nothing. There is nothing to say.
    expect(stored.has('p-bob')).toBe(false);
  });

  it('keeps its spending on its own ledger', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });
    await runToCompletion(service);

    const day = new Date().toISOString().slice(0, 10);
    const repo = new InjurySourceRepo(db);
    expect(await repo.writesToday(backfillLedgerKey(day))).toBeGreaterThan(0);
    /*
     * And not a single write on the live pipeline's ledger, which is the one
     * whose ceiling protects the five-minute check.
     */
    expect(await repo.writesToday(day)).toBe(0);
  });
});

describe('the real published lifecycle, proven on a season that exists', () => {
  it('takes the body while it is walking and the validator only at the end', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });

    await service.step(HISTORY_SEASON);
    // Nothing is stored mid-walk: a half-read season must not look ingested.
    expect((await new InjurySourceRepo(db).get('nflverse', HISTORY_SEASON))?.etag ?? null).toBeNull();

    await runToCompletion(service);

    const state = await new InjurySourceRepo(db).get('nflverse', HISTORY_SEASON);
    expect(state!.etag).toBe('"season-2025"');
    expect(state!.ingestedAt).not.toBeNull();
    expect(source.state.conditionalHits, 'it never asked conditionally while walking').toBe(0);
  });

  it('gets a real 304 once it holds the validator, and writes nothing more', async () => {
    const db = await setup();
    const source = origin(season2025());
    const service = new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} });
    await runToCompletion(service);

    const day = new Date().toISOString().slice(0, 10);
    const repo = new InjurySourceRepo(db);
    const spentBefore = await repo.writesToday(backfillLedgerKey(day));
    const bodiesBefore = source.state.bodiesSent;
    const historyBefore = await new InjuryHistoryRepo(db).forPlayers(['p-ann', 'p-bob'], HISTORY_SEASON);

    const verified = await service.verifyUnchanged(HISTORY_SEASON);

    expect(verified.sentValidator).toBe(true);
    expect(verified.outcome).toBe('not_modified');
    expect(source.state.conditionalHits).toBe(1);
    expect(source.state.bodiesSent, 'no bytes of the file were sent').toBe(bodiesBefore);
    expect(await repo.writesToday(backfillLedgerKey(day))).toBe(spentBefore);
    expect(await new InjuryHistoryRepo(db).forPlayers(['p-ann', 'p-bob'], HISTORY_SEASON)).toEqual(historyBefore);
  });
});

describe('last season never becomes this season', () => {
  /**
   * The test this whole feature has to pass.
   *
   * Ann Ash lost six games to a hamstring in 2025 and Sleeper says she is fine
   * today. "Fine today" is the answer, and the 2025 rows must not soften it.
   */
  it('leaves a player with a bad 2025 healthy in 2026', async () => {
    const db = await setup();
    const source = origin(season2025());
    await runToCompletion(new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} }));

    /*
     * Asked exactly as a screen asks it: Sleeper says nothing is wrong, and the
     * question is what the app makes of that with a bad 2025 in the database.
     */
    const ann = await new InjuryService(db, { log: () => {} }).stateFor('p-ann', 'Active', {
      season: CURRENT_SEASON,
    });

    expect(ann.designation).not.toBe('out');
    expect(ann.bodyPart).toBeNull();
  });

  it('stores the weeks under 2025, where the current reader does not look', async () => {
    const db = await setup();
    const source = origin(season2025());
    await runToCompletion(new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} }));

    const repo = new InjuryRepo(db);
    expect((await repo.coverage(HISTORY_SEASON)).players).toBeGreaterThan(0);
    // And nothing at all under the current season.
    expect(await repo.coverage(CURRENT_SEASON)).toEqual({ players: 0, latestWeek: null });
    expect((await repo.latestFor(['p-ann'], CURRENT_SEASON)).size).toBe(0);
  });

  it('does not let a 2026 ingest disturb the 2025 history', async () => {
    const db = await setup();
    const source = origin(season2025());
    await runToCompletion(new InjuryHistoryService(db, { fetch: source.fetch, log: () => {} }));
    const before = await new InjuryHistoryRepo(db).forPlayers(['p-ann'], HISTORY_SEASON);

    // The current season publishes, and Ann is fine in it.
    const current = csv([{ name: 'Ann Ash', week: 1, injury: '', status: '', practice: 'Full Participation in Practice', season: CURRENT_SEASON }]);
    await new InjuryService(db, {
      log: () => {},
      fetch: async () => new Response(current, { status: 200, headers: { etag: '"2026-v1"' } }),
    }).refresh(CURRENT_SEASON);

    expect(await new InjuryHistoryRepo(db).forPlayers(['p-ann'], HISTORY_SEASON)).toEqual(before);
  });
});
