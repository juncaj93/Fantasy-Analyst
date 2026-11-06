/**
 * The stored copy of the player list (Round 10, database reads).
 *
 * A cold Worker used to walk all 3,310 players for the list on its first
 * request; it now reads a few settings rows built for the last successful
 * download. These pin the three promises that make that safe: the copy is
 * the same list a full read returns, a new download shows at once (a Worker
 * holding the old list notices within seconds), and a failed download keeps
 * the last good list.
 *
 * "Worker" here is a separate handle on the same database: the in-memory
 * memos are keyed on the handle, exactly as each real Worker isolate has its
 * own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index.ts';
import type { Database } from '../src/server/db.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';
import { meterDatabase } from '../src/server/meter.ts';
import { PlayerRepo, forgetPlayerReads } from '../src/server/repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import {
  PLAYER_LIST_STAMP_KEY,
  PLAYERS_PER_PART,
  SNAPSHOT_KEY,
  VERSION_CHECK_MS,
} from '../src/server/repos/playerListCache.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

/** Another Worker on the same database: its own memory, the same rows. */
function anotherWorker(raw: Database): Database {
  return {
    prepare: (sql) => raw.prepare(sql),
    batch: (list) => raw.batch(list),
    exec: (sql) => raw.exec(sql),
  };
}

/** Enough players to span several stored parts, with every column filled somewhere. */
function league(teamOf: (i: number) => string = () => 'KC'): CanonicalPlayer[] {
  const out: CanonicalPlayer[] = [];
  for (let i = 1; i <= PLAYERS_PER_PART * 2 + 37; i++) {
    out.push(
      player({
        id: String(1000 + i),
        fullName: `Player Number${i}`,
        team: teamOf(i),
        position: ['QB', 'RB', 'WR', 'TE', 'DEF'][i % 5]!,
        status: i % 7 === 0 ? 'Injured Reserve' : 'Active',
        active: i % 11 !== 0,
        aliases: i % 3 === 0 ? [`P. Number${i}`] : [],
        externalIds: i % 2 === 0 ? { gsis: `00-00${i}`, espn: String(i) } : {},
        searchRank: i % 4 === 0 ? null : i,
        jerseyNumber: i % 9 === 0 ? null : i % 99,
        heightInches: 70 + (i % 8),
        weightPounds: i % 13 === 0 ? null : 190 + (i % 40),
        age: 21 + (i % 15),
        yearsExp: i % 12,
      }),
    );
  }
  // A kicker the app never carries, so the copy must drop exactly what the full read drops.
  out.push(player({ id: '9999', fullName: 'Some Kicker', position: 'K' }));
  return out;
}

/** What a download leaves behind: the rows, then the stamp. */
async function download(db: Database, players: CanonicalPlayer[], at: string): Promise<void> {
  await new PlayerRepo(db).upsertMany(players);
  await new SettingsRepo(db).markPlayersSynced(at);
}

async function freshRead(raw: NodeSqliteDatabase): Promise<CanonicalPlayer[]> {
  // The full read, with no stored copy and no memory to answer from.
  const handle = anotherWorker(raw);
  await raw.prepare('DELETE FROM settings WHERE key >= ? AND key < ?').bind(SNAPSHOT_KEY, `${SNAPSHOT_KEY}/`).run();
  forgetPlayerReads(handle);
  return new PlayerRepo(handle).listAll();
}

const teamOf = (list: CanonicalPlayer[], id: string) => list.find((p) => p.id === id)?.team;

let raw: NodeSqliteDatabase;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
  raw = await createTestDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stored player list', () => {
  it('uses the same stamp a successful download writes', () => {
    expect(PLAYER_LIST_STAMP_KEY).toBe(SETTING_KEYS.playersLastSuccess);
  });

  it('returns the same list as a fresh read, and a cold Worker reads a few rows for it', async () => {
    await download(raw, league(), '2026-11-05T10:00:00.000Z');
    await new PlayerRepo(raw).addAlias('1003', 'The Third', 'the third', 'user');
    expect((await new PlayerRepo(raw).refreshStoredList()).outcome).toBe('written');

    const metered = meterDatabase(anotherWorker(raw));
    const cached = await new PlayerRepo(metered.db).listAll();
    const cost = metered.cost();

    const fresh = await freshRead(raw);
    expect(fresh.length).toBeGreaterThan(PLAYERS_PER_PART); // more than one stored part
    expect(cached).toEqual(fresh);
    expect(cached.find((p) => p.id === '1003')?.aliases).toContain('The Third');
    // The stamp, the copy (a header and two parts) and the taught nicknames, not 800-odd players.
    expect(cost.rowsReturned).toBeLessThanOrEqual(8);
  });

  it('shows a new download within seconds on a Worker that already holds the old list', async () => {
    await download(raw, league(), '2026-11-05T10:00:00.000Z');
    await new PlayerRepo(raw).refreshStoredList();

    const reader = anotherWorker(raw);
    expect(teamOf(await new PlayerRepo(reader).listAll(), '1001')).toBe('KC');

    // 5 AM ET: the download lands on a different Worker (the cron's).
    vi.setSystemTime(new Date('2026-11-05T10:01:00Z'));
    const cron = anotherWorker(raw);
    await download(cron, league(() => 'BUF'), '2026-11-05T10:01:00.000Z');

    // Before the copy is rebuilt: the old copy is never served, the full read answers.
    vi.setSystemTime(new Date(Date.now() + VERSION_CHECK_MS + 1));
    expect(teamOf(await new PlayerRepo(reader).listAll(), '1001')).toBe('BUF');

    // After the tick rebuilds it, a cold Worker gets the new list from the copy.
    expect((await new PlayerRepo(cron).refreshStoredList()).outcome).toBe('written');
    const metered = meterDatabase(anotherWorker(raw));
    expect(teamOf(await new PlayerRepo(metered.db).listAll(), '1001')).toBe('BUF');
    expect(metered.cost().rowsReturned).toBeLessThanOrEqual(8);
  });

  it('keeps the last good list when a download fails part way', async () => {
    await download(raw, league(), '2026-11-05T10:00:00.000Z');
    await new PlayerRepo(raw).refreshStoredList();

    // The next download writes its first batch and then the database refuses the rest.
    let batches = 0;
    const flaky: Database = {
      ...anotherWorker(raw),
      batch: async (list) => {
        batches += 1;
        if (batches > 1) throw new Error('D1 went away');
        return raw.batch(list);
      },
    };
    await expect(new PlayerRepo(flaky).upsertMany(league(() => 'NYJ'))).rejects.toThrow('D1 went away');
    // Half the table now says NYJ, and no new download was recorded.
    expect((await raw.prepare("SELECT COUNT(*) AS n FROM players WHERE team = 'NYJ'").first<{ n: number }>())?.n).toBe(200);

    vi.setSystemTime(new Date(Date.now() + VERSION_CHECK_MS + 1));
    const list = await new PlayerRepo(anotherWorker(raw)).listAll();
    expect(list.filter((p) => p.team === 'NYJ')).toHaveLength(0);
    expect(teamOf(list, '1001')).toBe('KC');
  });

  it('checks the stamp at most every few seconds, one row each time', async () => {
    await download(raw, league(), '2026-11-05T10:00:00.000Z');
    await new PlayerRepo(raw).refreshStoredList();
    const handle = anotherWorker(raw);
    await new PlayerRepo(handle).listAll();

    const again = meterDatabase(handle);
    await new PlayerRepo(again.db).listAll();
    expect(again.cost().rowsReturned).toBe(0);

    vi.setSystemTime(new Date(Date.now() + VERSION_CHECK_MS + 1));
    const later = meterDatabase(handle);
    await new PlayerRepo(later.db).listAll();
    expect(later.cost()).toMatchObject({ statements: 1, rowsReturned: 1 });
  });
});

describe('rebuilding the copy', () => {
  it('does nothing before any download, and one small read when the copy is current', async () => {
    await new PlayerRepo(raw).upsertMany(league());
    expect((await new PlayerRepo(raw).refreshStoredList()).outcome).toBe('no-download');

    await new SettingsRepo(raw).markPlayersSynced('2026-11-05T10:00:00.000Z');
    expect((await new PlayerRepo(raw).refreshStoredList()).outcome).toBe('written');
    const metered = meterDatabase(raw);
    expect((await new PlayerRepo(metered.db).refreshStoredList()).outcome).toBe('fresh');
    expect(metered.cost()).toMatchObject({ statements: 1 });
    expect(metered.cost().rowsReturned).toBeLessThanOrEqual(3);
  });

  it('does not retry a failed build on every tick', async () => {
    await download(raw, league(), '2026-11-05T10:00:00.000Z');
    const broken: Database = {
      ...anotherWorker(raw),
      batch: async () => {
        throw new Error('too big');
      },
    };
    await expect(new PlayerRepo(broken).refreshStoredList()).rejects.toThrow('too big');
    expect((await new PlayerRepo(raw).refreshStoredList()).outcome).toBe('skipped');
    vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1_000));
    expect((await new PlayerRepo(raw).refreshStoredList()).outcome).toBe('written');
  });

  it('is built by the five-minute tick after a download', async () => {
    await download(raw, league(), '2026-11-05T10:00:00.000Z');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('null', { status: 404 })) as typeof fetch;
    try {
      // Thursday 2:02 PM ET: no feed, no league read on this tick.
      const at = '2026-11-05T19:02:00Z';
      vi.setSystemTime(new Date(at));
      await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.parse(at) }, { DB: raw } as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    const header = await raw.prepare('SELECT value_json FROM settings WHERE key = ?').bind(SNAPSHOT_KEY).first<{ value_json: string }>();
    expect(JSON.parse(header!.value_json)).toMatchObject({ version: JSON.stringify('2026-11-05T10:00:00.000Z') });
  });
});
