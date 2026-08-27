/**
 * Observation must not change the thing being observed.
 *
 * §18 states the guarantee: reading data health must not run cron, refresh
 * providers, mutate D1, start manager ingestion, publish, alter snapshots or
 * change fantasy decisions. "We were careful" is a claim that decays on the
 * next commit, so it is asserted three ways — the same three
 * `support.isolation.test.ts` uses for a capture, because this is the same
 * class of promise about the same kind of surface:
 *
 *   1. **the whole database is unchanged** — every row of every table,
 *      snapshotted before and after;
 *   2. **no mutating statement was even attempted** — a snapshot alone cannot
 *      see an `INSERT … ON CONFLICT DO NOTHING` against a row that already
 *      exists, and that is exactly how this would come back;
 *   3. **nothing left the process** — every transport the endpoint could reach
 *      throws, so a green test is the proof that none was used.
 *
 * The list §18 names is covered by (2): every one of those is a write, and none
 * of them can happen without a statement.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { createTestDb } from './helpers/db.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import type { Database, DbResult, PreparedStatement } from '../src/server/db.ts';

const MUTATING = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i;

async function snapshotDb(db: Database): Promise<Record<string, unknown[]>> {
  const tables = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables.results) {
    const contents = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    out[name] = contents.results.map((row) => JSON.stringify(row)).sort();
  }
  return out;
}

function watched(db: Database): { db: Database; statements: () => string[] } {
  const statements: string[] = [];
  const wrapper: Database = {
    prepare(query: string): PreparedStatement {
      statements.push(query);
      return db.prepare(query);
    },
    batch<T = unknown>(list: PreparedStatement[]): Promise<DbResult<T>[]> {
      statements.push('BATCH');
      return db.batch<T>(list);
    },
    exec(query: string) {
      statements.push(query);
      return db.exec(query);
    },
  };
  return { db: wrapper, statements: () => statements };
}

/** A Sleeper client that fails the test rather than answering. */
const forbiddenSleeper = new SleeperClient({
  fetch: async (url) => {
    throw new Error(`data health reached the network: ${String(url)}`);
  },
});

describe('reading data health changes nothing', () => {
  let real: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    real = await createTestDb();
    await seedDemoData(real);
  });

  it('leaves the database exactly as it found it', async () => {
    const before = await snapshotDb(real);
    const { db, statements } = watched(real);
    const env: AppEnv = {
      db,
      sleeper: forbiddenSleeper,
      vegas: new MockVegasProvider(MOCK_GAMES),
      releaseSha: 'abc',
    };

    const res = await app(new Request('https://app.test/api/data-health'), env);
    expect(res.status, await res.clone().text()).toBe(200);

    expect(
      statements().filter((q) => MUTATING.test(q)),
      'reading data health prepared a mutating statement',
    ).toEqual([]);
    expect(await snapshotDb(real)).toEqual(before);
  });

  /**
   * The two things that would be easiest to reach for by accident.
   *
   * `SeasonMarketService` and `InjuryService` both have a `refresh` beside the
   * read this uses, and both spend quota or bandwidth. Asserted by name because
   * a service that ran one would leave the same fingerprint as one that did
   * not — the failure would be a provider bill rather than a broken test.
   */
  it('runs no cron step and refreshes no provider', async () => {
    const { db, statements } = watched(real);
    await new DataHealthService(db, { vegas: new MockVegasProvider(MOCK_GAMES) }).view();

    const seen = statements().join('\n');
    expect(seen).not.toMatch(/INSERT INTO cron_run_state/i);
    expect(seen).not.toMatch(/INSERT INTO prop_snapshots/i);
    expect(seen).not.toMatch(/INSERT INTO injury_source_state/i);
    expect(seen).not.toMatch(/INSERT INTO manager_history_checkpoints/i);
  });

  it('makes no external request, even with a transport that would answer', async () => {
    const { db } = watched(real);
    await expect(
      new DataHealthService(db, { vegas: new MockVegasProvider(MOCK_GAMES) }).view(),
    ).resolves.toBeTruthy();
  });

  /**
   * A source that cannot be read is `unknown`, not an exception.
   *
   * A health screen that goes blank because one of twelve reads threw is the
   * screen failing at the moment it is most needed.
   */
  it('survives a database that cannot answer one of the reads', async () => {
    const brittle: Database = {
      prepare(query: string) {
        if (/FROM prop_snapshots/i.test(query)) throw new Error('table is gone');
        return real.prepare(query);
      },
      batch: (list) => real.batch(list),
      exec: (query) => real.exec(query),
    };
    const view = await new DataHealthService(brittle).view();
    expect(view.sources.length).toBeGreaterThan(0);
    expect(view.sources.map((s) => s.id)).not.toContain('vegas');
  });
});

describe('the service has no way to write', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/server/services/dataHealthService.ts', import.meta.url)),
    'utf8',
  );

  /**
   * Read off the source rather than the behaviour, because behaviour tests can
   * only check the cases somebody thought of and this has to hold for the
   * source somebody adds next year.
   */
  it('names no refresh, no fetch and no write anywhere in it', () => {
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/\.refresh\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.advance\s*\(/);
    expect(code).not.toMatch(/\.save\s*\(/);
    expect(code).not.toMatch(/\.record\w*\s*\(/);
  });

  /** And it never constructs the two services whose whole job is to spend. */
  it('never constructs the refresh orchestrators', () => {
    expect(source).not.toMatch(/new VegasRefreshService/);
    expect(source).not.toMatch(/new StartSitRefreshService/);
    expect(source).not.toMatch(/new ManagerIntelService/);
  });
});
