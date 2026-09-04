/**
 * The reads that spent the D1 allowance, and the memo that stops them.
 *
 * `wrangler d1 insights` attributed 97.5% of a day's 5,000,000 rows to four
 * queries, all of them full passes over tables that change once a day, and the
 * largest of them driven by the Draft screen's five-second board poll. The
 * tests here are about the *count of queries*, not the shape of the answers:
 * an assertion that the data is right would have passed before this change and
 * would pass again if the memo quietly stopped memoising.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS, player } from './helpers/players.ts';
import { PlayerRepo, COUNT_TTL_MS } from '../src/server/repos/players.ts';
import { PlayerDetailRepo } from '../src/server/repos/playerDetail.ts';
import { SlowRead, SLOW_READ_TTL_MS } from '../src/server/repos/slowRead.ts';
import type { Database } from '../src/server/db.ts';

/** A database that writes down every statement prepared through it. */
function counting(inner: Database): { db: Database; asked: string[] } {
  const asked: string[] = [];
  const db: Database = {
    prepare(query: string) {
      asked.push(query.replace(/\s+/g, ' ').trim());
      return inner.prepare(query);
    },
    batch: (statements) => inner.batch(statements),
    exec: (query) => inner.exec(query),
  };
  return { db, asked };
}

const times = (asked: string[], fragment: string): number =>
  asked.filter((q) => q.includes(fragment)).length;

describe('the player dictionary is read once, not once per poll', () => {
  it('serves a burst of board polls from one read', async () => {
    const { db, asked } = counting(await createTestDb());
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    const repo = new PlayerRepo(db);

    const first = await repo.listAll();
    asked.length = 0;
    // Twelve polls is one minute of an open Draft screen.
    for (let i = 0; i < 12; i += 1) await repo.listAll();

    expect(times(asked, 'FROM players'), 'the dictionary was re-read during the burst').toBe(0);
    expect(times(asked, 'FROM player_aliases')).toBe(0);
    expect(await repo.listAll()).toEqual(first);
  });

  it('hands every caller its own objects, so one caller cannot corrupt another', async () => {
    const db = await createTestDb();
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);

    const a = await repo.listAll();
    a.sort((x, y) => x.fullName.localeCompare(y.fullName));
    a[0]!.team = 'MUTATED';

    const b = await repo.listAll();
    expect(b.some((p) => p.team === 'MUTATED')).toBe(false);
    expect(b.map((p) => p.id)).toEqual((await repo.listAll()).map((p) => p.id));
  });

  it('re-reads after a sync writes players', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    expect(await repo.listAll()).toHaveLength(TEST_PLAYERS.filter((p) => p.active).length);

    await repo.upsertMany([player({ id: '999', fullName: 'Newly Signed', team: 'NYJ', position: 'WR' })]);
    asked.length = 0;
    const after = await repo.listAll();

    expect(times(asked, 'FROM players'), 'a write must invalidate the memo').toBe(1);
    expect(after.some((p) => p.id === '999')).toBe(true);
  });

  it('re-reads after a nickname is added or removed', async () => {
    const db = await createTestDb();
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    await repo.listAll();

    await repo.addAlias('9', 'Love Guv', 'loveguv', 'user');
    expect((await repo.listAll()).find((p) => p.id === '9')?.aliases).toContain('Love Guv');

    await repo.removeAlias('9', 'loveguv');
    expect((await repo.listAll()).find((p) => p.id === '9')?.aliases).not.toContain('Love Guv');
  });
});

describe('the counts behind the diagnostics', () => {
  it('counts the table once however many times the overview asks', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);

    const expected = await repo.count();
    asked.length = 0;
    for (let i = 0; i < 20; i += 1) expect(await repo.count()).toBe(expected);
    for (let i = 0; i < 20; i += 1) await repo.countRanked();

    expect(times(asked, 'COUNT(*) AS n FROM players')).toBe(1); // countRanked's first ask
    expect(times(asked, 'draft_rank IS NOT NULL')).toBe(1);
  });

  it('collapses concurrent askers onto one query', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    asked.length = 0;

    // `/api/setup/status` asks for these inside one `Promise.all`.
    await Promise.all([repo.count(), repo.count(), repo.count(), repo.count()]);
    expect(times(asked, 'COUNT(*) AS n FROM players')).toBe(1);
  });

  /*
   * The hour-long window, and the one answer it must not apply to.
   *
   * These two counts were the largest queries left on the account once the
   * dictionary was fixed -- 1,018,556 rows across 308 calls in a day, 20.4% of
   * the allowance, for two integers. The memo had capped how often they ran;
   * only the window caps what that costs, because a `COUNT` with nothing to
   * narrow it walks every row every time.
   */
  it('holds the counts longer than the poll-shaped default', () => {
    expect(
      COUNT_TTL_MS,
      'the five-minute default is sized against a five-second poll, not against a count the 09:00 sync rewrites',
    ).toBeGreaterThan(SLOW_READ_TTL_MS);
    expect(COUNT_TTL_MS).toBe(60 * 60 * 1_000);
  });

  it('honours a window longer than the default, and asks again past it', async () => {
    const clock = { now: 0 };
    const memo = new SlowRead<number>(60 * 60 * 1_000, () => clock.now);
    const db = await createTestDb();

    let reads = 0;
    const countingRead = async () => {
      reads += 1;
      return 7;
    };

    await memo.get(db, 'all', countingRead);
    clock.now = 45 * 60 * 1_000; // 45 minutes: past the old window, inside this one
    await memo.get(db, 'all', countingRead);
    expect(reads, 'a non-zero count stands for the whole hour').toBe(1);

    clock.now = 61 * 60 * 1_000;
    await memo.get(db, 'all', countingRead);
    expect(reads, 'and is asked again once the hour is up').toBe(2);
  });

  /*
   * Zero is the state somebody is standing on Setup trying to leave: it is what
   * makes the screen say the player list has not been downloaded. Holding it
   * for an hour would mean an app insisting a sync never happened. It is also
   * free to re-ask -- counting an empty table reads no rows -- so there is
   * nothing on the other side of the trade.
   */
  it('never sits on an empty player table', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerRepo(db);

    expect(await repo.count()).toBe(0);
    expect(await repo.count()).toBe(0);
    expect(await repo.count()).toBe(0);
    expect(
      times(asked, 'COUNT(*) AS n FROM players'),
      'a zero total is re-read every time: it costs nothing, and it goes stale the moment a sync lands',
    ).toBe(3);
  });

  /*
   * The asymmetry, asserted, because it is the part that is easy to get wrong.
   *
   * The first draft of this change re-read *both* counts on zero, on the
   * reasoning that counting nothing costs nothing. That is true of `count()`,
   * which only returns zero for an empty table. It is false of `countRanked()`:
   * a filtered COUNT returning zero has still walked every row to establish it,
   * so a dictionary synced but not yet given an ADP import answers zero at the
   * cost of the whole table -- and re-reading on zero would have switched the
   * memo off in the one state it matters most.
   */
  it('keeps memoising a zero ranked count, because that zero was not free', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerRepo(db);
    // Players, but nothing with a draft rank: the no-ADP-imported-yet state.
    await repo.upsertMany(TEST_PLAYERS);
    asked.length = 0;

    expect(await repo.countRanked()).toBe(0);
    for (let i = 0; i < 10; i += 1) expect(await repo.countRanked()).toBe(0);
    expect(
      times(asked, 'draft_rank IS NOT NULL'),
      'zero ranked players still costs a full scan, so it is held like any other answer',
    ).toBe(1);
  });

  it('starts memoising as soon as there is something to count', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerRepo(db);

    expect(await repo.count()).toBe(0);
    await repo.upsertMany(TEST_PLAYERS);
    asked.length = 0;

    const total = await repo.count();
    expect(total).toBeGreaterThan(0);
    for (let i = 0; i < 10; i += 1) expect(await repo.count()).toBe(total);
    expect(times(asked, 'SELECT COUNT(*) AS n FROM players')).toBe(1);
  });

  it('counts a season of statistics once per season', async () => {
    const { db, asked } = counting(await createTestDb());
    const repo = new PlayerDetailRepo(db);
    await repo.saveSeasonStats(
      '2025',
      [{ playerId: '1', gamesPlayed: 17, pointsHalfPpr: 200, positionRankHalfPpr: 1, providerPositionRank: 1, position: 'RB' }],
      new Date().toISOString(),
    );
    asked.length = 0;

    for (let i = 0; i < 5; i += 1) expect(await repo.countSeasonStats('2025')).toBe(1);
    expect(times(asked, 'FROM player_season_stats WHERE season')).toBe(1);

    // A different season is a different question, and gets asked.
    expect(await repo.countSeasonStats('2024')).toBe(0);
    expect(times(asked, 'FROM player_season_stats WHERE season')).toBe(2);
  });

  it('re-counts a season after its lines are replaced', async () => {
    const db = await createTestDb();
    const repo = new PlayerDetailRepo(db);
    const now = new Date().toISOString();
    const line = (playerId: string) => ({
      playerId,
      gamesPlayed: 17,
      pointsHalfPpr: 100,
      positionRankHalfPpr: 1,
      providerPositionRank: 1,
      position: 'RB',
    });

    await repo.saveSeasonStats('2025', [line('1')], now);
    expect(await repo.countSeasonStats('2025')).toBe(1);
    await repo.saveSeasonStats('2025', [line('1'), line('2')], now);
    expect(await repo.countSeasonStats('2025')).toBe(2);
  });
});

describe('SlowRead', () => {
  it('asks again once the window has passed', async () => {
    let clock = 0;
    const memo = new SlowRead<number>(1_000, () => clock);
    const db = {} as Database;
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };

    expect(await memo.get(db, 'k', load)).toBe(1);
    clock = 999;
    expect(await memo.get(db, 'k', load)).toBe(1);
    clock = 1_000;
    expect(await memo.get(db, 'k', load)).toBe(2);
    expect(calls).toBe(2);
  });

  it('never remembers a failure', async () => {
    const memo = new SlowRead<number>();
    const db = {} as Database;
    let attempt = 0;
    const load = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('D1_ERROR: daily row read limit');
      return 42;
    };

    await expect(memo.get(db, 'k', load)).rejects.toThrow('daily row read limit');
    // The window has not passed, but a rejection is not an answer.
    expect(await memo.get(db, 'k', load)).toBe(42);
  });

  it('keeps two databases apart', async () => {
    const memo = new SlowRead<string>();
    const one = {} as Database;
    const two = {} as Database;

    expect(await memo.get(one, 'k', async () => 'one')).toBe('one');
    expect(await memo.get(two, 'k', async () => 'two')).toBe('two');
    expect(await memo.get(one, 'k', async () => 'changed')).toBe('one');
  });

  it('forgets on request', async () => {
    const memo = new SlowRead<string>();
    const db = {} as Database;
    expect(await memo.get(db, 'k', async () => 'first')).toBe('first');
    memo.forget(db);
    expect(await memo.get(db, 'k', async () => 'second')).toBe('second');
  });
});
