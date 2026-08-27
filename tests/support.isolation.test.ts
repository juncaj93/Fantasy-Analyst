/**
 * A diagnostic must not change the thing being diagnosed.
 *
 * The rule is easy to state and easy to break by accident, because a capture
 * reaches through the same services the screens do and any one of them could
 * grow a write. So this is asserted twice over, the way `matchup.readPurity`
 * asserts the Matchup GET:
 *
 *   1. **the whole database is unchanged** — every row of every table,
 *      snapshotted before and after and compared;
 *   2. **no mutating statement was even attempted** — the database is wrapped in
 *      a recorder that watches every `prepare()`. A snapshot alone cannot see an
 *      `INSERT … ON CONFLICT DO NOTHING` against a row that already exists, and
 *      that is exactly how this would come back.
 *
 * The list the brief names — no lineup submitted, no Start/Sit refreshed, no
 * claim created, no FAAB spent, no trade proposed, no favourite altered, no
 * manager intelligence mutated, no support data written to D1, no provider
 * refresh triggered — is every one of those covered by (2): all of them are
 * writes, and none of them can happen without a statement.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { Database, DbResult, PreparedStatement } from '../src/server/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { IN_SEASON_KINDS } from '../src/core/support/contexts.ts';

const MUTATING = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i;

/** Everything in every table, as a comparable value. */
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

/** The database, plus a note of every statement anybody prepared against it. */
function watched(db: Database): { db: Database; mutations: () => string[] } {
  const statements: string[] = [];
  const wrapper: Database = {
    prepare(query: string): PreparedStatement {
      statements.push(query);
      return db.prepare(query);
    },
    batch<T = unknown>(list: PreparedStatement[]): Promise<DbResult<T>[]> {
      return db.batch<T>(list);
    },
    exec(query: string) {
      statements.push(query);
      return db.exec(query);
    },
  };
  return { db: wrapper, mutations: () => statements.filter((q) => MUTATING.test(q)) };
}

const MINE = ['1003', '1001', '1008', '1002', '1005', '1004', '1012'];
const THEIRS = ['1010', '1006', '1007', '1011', '1017', '1019', '1013'];

/** Every Sleeper request the capture makes, so a fetch can be counted. */
function countingSleeper(): { client: SleeperClient; paths: string[] } {
  const paths: string[] = [];
  const rows = [
    { roster_id: 1, matchup_id: 1, points: 0, starters: MINE, players: [...MINE, '1009'], players_points: {} },
    { roster_id: 2, matchup_id: 1, points: 0, starters: THEIRS, players: [...THEIRS, '1018'], players_points: {} },
  ];
  const client = new SleeperClient({
    fetch: async (url) => {
      const { pathname } = new URL(url);
      paths.push(pathname);
      return /\/matchups\/\d+$/.test(pathname)
        ? new Response(JSON.stringify(rows), { status: 200 })
        : new Response('null', { status: 200 });
    },
  });
  return { client, paths };
}

describe('capturing a snapshot changes nothing', () => {
  let real: NodeSqliteDatabase;
  const app = createApp();

  beforeEach(async () => {
    real = await createTestDb();
    await seedDemoData(real);
  });

  it.each(IN_SEASON_KINDS)('%s leaves the database exactly as it found it', async (context) => {
    const before = await snapshotDb(real);
    const { db, mutations } = watched(real);
    const sleeper = countingSleeper();
    const env: AppEnv = {
      db,
      sleeper: sleeper.client,
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
      releaseSha: 'abc',
    };

    const res = await app(
      new Request(`https://app.test/api/leagues/demo-league/support-snapshot?context=${context}`),
      env,
    );
    expect(res.status, await res.clone().text()).toBe(200);

    expect(mutations(), `capturing ${context} prepared a mutating statement`).toEqual([]);
    expect(await snapshotDb(real)).toEqual(before);
  });

  it.each(IN_SEASON_KINDS)('%s triggers no provider refresh', async (context) => {
    const { db } = watched(real);
    const sleeper = countingSleeper();
    const env: AppEnv = {
      db,
      sleeper: sleeper.client,
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
      releaseSha: 'abc',
    };

    await app(new Request(`https://app.test/api/leagues/demo-league/support-snapshot?context=${context}`), env);

    /*
     * One exception, and it is the scoreboard.
     *
     * `matchups` is the identical request the Matchup screen makes every time it
     * is opened: Sleeper owns the score, this app never recomputes it, and a
     * snapshot that invented the scoreboard would be a snapshot of a different
     * game. Nothing is written as a result and nothing is ingested. Every other
     * context must reach Sleeper not at all.
     */
    const allowed = context === 'matchup' ? /\/matchups\/\d+$/ : null;
    const unexpected = sleeper.paths.filter((path) => allowed == null || !allowed.test(path));
    expect(unexpected, `capturing ${context} reached Sleeper`).toEqual([]);
  });

  it('is a public read, like every other read in this app', async () => {
    const env: AppEnv = {
      db: real,
      sleeper: countingSleeper().client,
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
      releaseSha: 'abc',
    };
    const res = await app(
      new Request('https://app.test/api/leagues/demo-league/support-snapshot?context=lineup'),
      env,
    );
    expect(res.status).toBe(200);
  });
});

/**
 * None of the capture or replay machinery reaches a browser chunk.
 *
 * A structural claim, so it is read off the source tree rather than inferred
 * from a bundle size. The one permitted contact is a *type* import: the six
 * decision words are a union, it erases at build time, and the support row has
 * to name them.
 */
describe('the browser ships no support machinery', () => {
  it('no web module imports a value from core/support', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '..', 'src', 'web');

    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(entry) ? [full] : [];
      });

    const offenders: string[] = [];
    for (const file of files(root)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/from '[^']*core\/support\//.test(line)) continue;
        /*
         * `import type` is erased and is the one permitted form. A bare
         * `import { … }` from the same directory would pull a capture adapter —
         * and the engines behind it — into the render path.
         */
        if (/^\s*import\s+type\s/.test(line)) continue;
        offenders.push(`${path.relative(root, file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
