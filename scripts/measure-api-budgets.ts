/**
 * What an API read costs, in bytes on the wire and in serialized round trips.
 *
 * ## Why this exists
 *
 * `scripts/perf-budget.mjs` weighs the built site, which is the half of the
 * problem a phone feels on first load. It says nothing about the half a phone
 * feels on every tap afterwards: how big an answer is, and how many times the
 * server had to go and ask the database before it could send it.
 *
 * That second number is the one that grew unnoticed. `/api/players/:id/detail`
 * reached seventeen serialized statements to assemble eight hundred bytes —
 * every one of them waiting on the one before it for no reason other than
 * having been written on a separate line. On D1 a statement is a network hop,
 * so seventeen waves is seventeen round trips whatever the query costs, and
 * nothing in the repository would have failed if it had become thirty.
 *
 * ## What a "wave" is
 *
 * A wave is a statement that had to wait for a previous one. Statements issued
 * together — `Promise.all`, or anything else that starts them before the first
 * resolves — share a wave, because on a real database they share a round trip's
 * worth of latency rather than paying for one each. So the wave count is not
 * "how many queries" (that is `statements`, also reported) but "how deep the
 * dependency chain is", which is the thing latency multiplies.
 *
 * It is measured rather than declared: `countingDatabase` wraps the same
 * `Database` interface D1 implements and watches when each statement starts
 * against what is still in flight. A refactor that merely renames a query
 * changes nothing here; one that adds an `await` in a chain shows up
 * immediately.
 *
 * ## What the timings are, and are not
 *
 * The in-memory SQLite this runs against answers in microseconds, so wall clock
 * over it would report that seventeen waves and three cost the same — which is
 * true here and false everywhere the app actually runs. `latencyMs` therefore
 * injects a fixed delay per round trip, so the reported milliseconds are a real
 * measurement of a modelled database rather than a guess about a real one.
 * Compare two runs of this script; do not compare its numbers to production.
 *
 * Usage:
 *   node --experimental-transform-types scripts/measure-api-budgets.ts
 *   node --experimental-transform-types scripts/measure-api-budgets.ts --json
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { seedDemoData } from '../src/devserver/seed.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import type { Database, DbResult, PreparedStatement } from '../src/server/db.ts';

/** How many round trips a statement was made to wait for, and how many ran. */
export interface QueryCounts {
  /** Statements that had to wait for a previous one: the depth of the chain. */
  waves: number;
  /** Every statement executed, whether it waited or not. */
  statements: number;
  /** The SQL, in the order it was issued — for reading a regression, not for asserting on. */
  sql: string[];
}

export interface CountingDatabase extends Database {
  counts(): QueryCounts;
  reset(): void;
}

/**
 * The same database, watched.
 *
 * Wave accounting is deliberately about *starting*, not about finishing: a
 * statement issued while nothing is in flight had to wait for whatever came
 * before it, and one issued while another is still running did not. That is the
 * distinction latency charges for, and it is visible from here without the
 * caller knowing it is being measured.
 *
 * `latencyMs` makes each round trip cost something, so a chain of seventeen is
 * distinguishable from a chain of three by a clock as well as by a counter.
 */
export function countingDatabase(db: Database, opts: { latencyMs?: number } = {}): CountingDatabase {
  const latencyMs = opts.latencyMs ?? 0;
  let inFlight = 0;
  let waves = 0;
  let statements = 0;
  const sql: string[] = [];

  const enter = (query: string): void => {
    if (inFlight === 0) waves++;
    inFlight++;
    statements++;
    sql.push(query.replace(/\s+/g, ' ').trim().slice(0, 120));
  };

  const leave = async (): Promise<void> => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    inFlight--;
  };

  const wrap = (statement: PreparedStatement, query: string): PreparedStatement => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values), query),
    first: async <T,>(colName?: string) => {
      enter(query);
      try {
        return (colName === undefined
          ? await statement.first<T>()
          : await statement.first<T>(colName)) as T | null;
      } finally {
        await leave();
      }
    },
    all: async <T,>() => {
      enter(query);
      try {
        return (await statement.all<T>()) as DbResult<T>;
      } finally {
        await leave();
      }
    },
    run: async () => {
      enter(query);
      try {
        return await statement.run();
      } finally {
        await leave();
      }
    },
  });

  return {
    prepare: (query: string) => wrap(db.prepare(query), query),
    // A batch is one trip on D1, and is counted as one here.
    batch: async <T,>(list: PreparedStatement[]) => {
      enter(`batch of ${list.length}`);
      try {
        return (await db.batch<T>(list)) as DbResult<T>[];
      } finally {
        await leave();
      }
    },
    exec: (query: string) => db.exec(query),
    counts: () => ({ waves, statements, sql: [...sql] }),
    reset: () => {
      waves = 0;
      statements = 0;
      sql.length = 0;
      inFlight = 0;
    },
  };
}

/** One measured read. */
export interface EndpointMeasurement {
  /** Matches a `name` in `perf-budgets.json` under `apis`. */
  name: string;
  path: string;
  status: number;
  waves: number;
  statements: number;
  rawBytes: number;
  gzipBytes: number;
  /** Median wall clock over the runs, against the modelled per-trip latency. */
  ms: number;
  sql: string[];
}

/**
 * The reads worth a ceiling.
 *
 * Player detail because it is opened constantly and was the one that had grown
 * a seventeen-deep chain; the board because it is the largest answer this API
 * sends and the one whose payload nobody was watching.
 */
export const MEASURED_ENDPOINTS: { name: string; path: string }[] = [
  { name: 'player detail', path: '/api/players/1001/detail' },
  { name: 'draft board', path: '/api/drafts/demo-draft/board' },
];

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

async function freshDb(): Promise<NodeSqliteDatabase> {
  const db = new NodeSqliteDatabase(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/**
 * A Sleeper that is reachable, slowly, and has nothing to say.
 *
 * The outlook endpoint answering `null` is the ordinary case for most of a
 * player dictionary, and the latency is the point: this is the third-party call
 * that used to sit on the request path, and a stub that answered instantly
 * would have measured it as free.
 */
function slowSleeperFetch(delayMs: number): typeof fetch {
  return (async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { get_player_outlook: null } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

export interface MeasureOptions {
  /** Modelled cost of one database round trip. D1 in-colo is low single digits. */
  latencyMs?: number;
  /** Modelled cost of the Sleeper GraphQL call behind a cold outlook. */
  outlookLatencyMs?: number;
  /** How many times to run each endpoint; the median is reported. */
  runs?: number;
  /**
   * Whether to clear the outlook cache before each run.
   *
   * True measures the cold open — the "first open is slow, second is instant"
   * complaint. False measures the warm one.
   */
  coldOutlook?: boolean;
}

export async function measureEndpoints(opts: MeasureOptions = {}): Promise<EndpointMeasurement[]> {
  const latencyMs = opts.latencyMs ?? 0;
  const outlookLatencyMs = opts.outlookLatencyMs ?? 0;
  const runs = opts.runs ?? 5;
  const coldOutlook = opts.coldOutlook ?? true;

  const raw = await freshDb();
  await seedDemoData(raw);
  const db = countingDatabase(raw, { latencyMs });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = slowSleeperFetch(outlookLatencyMs);

  /*
   * Background work, held rather than let loose.
   *
   * A route that defers work — the outlook refresh does — hands it to
   * `waitUntil`, and a measurement that let those promises run loose would
   * charge the next endpoint for the previous one's round trips. Collected
   * here, drained between endpoints, and counted against neither.
   */
  const deferred: Promise<unknown>[] = [];
  const env: AppEnv = {
    db,
    sleeper: new SleeperClient({ fetch: slowSleeperFetch(outlookLatencyMs) as never }),
    vegas: new MockVegasProvider([]),
    disableAuth: true,
    waitUntil: (task) => {
      deferred.push(task);
    },
  };
  const app = createApp();
  const drain = async (): Promise<void> => {
    while (deferred.length > 0) await Promise.allSettled(deferred.splice(0, deferred.length));
  };

  try {
    const out: EndpointMeasurement[] = [];
    for (const endpoint of MEASURED_ENDPOINTS) {
      const timings: number[] = [];
      let last: { status: number; body: string; counts: QueryCounts } | null = null;
      for (let i = 0; i < runs; i++) {
        if (coldOutlook) {
          await raw.prepare('DELETE FROM player_outlooks').run();
          await raw.prepare('DELETE FROM player_outlook_misses').run();
        }
        db.reset();
        const started = performance.now();
        const res = await app(new Request(`https://measure.test${endpoint.path}`), env);
        const body = await res.text();
        timings.push(performance.now() - started);
        last = { status: res.status, body, counts: db.counts() };
        // What the reader waited for is measured above; what the response
        // deferred is settled here, before the next measurement starts.
        await drain();
      }
      const body = Buffer.from(last!.body, 'utf8');
      timings.sort((a, b) => a - b);
      out.push({
        name: endpoint.name,
        path: endpoint.path,
        status: last!.status,
        waves: last!.counts.waves,
        statements: last!.counts.statements,
        rawBytes: body.length,
        gzipBytes: gzipSync(body, { level: 9 }).length,
        ms: Math.round(timings[Math.floor(timings.length / 2)]! * 10) / 10,
        sql: last!.counts.sql,
      });
    }
    return out;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

/** Run directly: print the table, or `--json` for the machine-readable form. */
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const json = process.argv.includes('--json');
  const latencyMs = Number(process.env['FA_MEASURE_LATENCY_MS'] ?? 2);
  const outlookLatencyMs = Number(process.env['FA_MEASURE_OUTLOOK_MS'] ?? 250);

  const cold = await measureEndpoints({ latencyMs, outlookLatencyMs, coldOutlook: true });
  const warm = await measureEndpoints({ latencyMs, outlookLatencyMs, coldOutlook: false });

  if (json) {
    console.log(JSON.stringify({ latencyMs, outlookLatencyMs, cold, warm }, null, 2));
  } else {
    console.log(`\nmodelled: ${latencyMs}ms per database round trip, ${outlookLatencyMs}ms for the outlook fetch\n`);
    console.log(`${'endpoint'.padEnd(16)}  ${'cache'.padEnd(5)}  ${'waves'.padStart(5)}  ${'stmts'.padStart(5)}  ${'gzip'.padStart(8)}  ${'ms'.padStart(8)}`);
    console.log('-'.repeat(62));
    for (const [label, rows] of [['cold', cold], ['warm', warm]] as const) {
      for (const row of rows) {
        console.log(
          `${row.name.padEnd(16)}  ${label.padEnd(5)}  ${String(row.waves).padStart(5)}  ${String(row.statements).padStart(5)}  ${`${(row.gzipBytes / 1000).toFixed(2)}kB`.padStart(8)}  ${String(row.ms).padStart(8)}`,
        );
      }
    }
    console.log('');
  }
}
