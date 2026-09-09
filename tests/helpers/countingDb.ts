/**
 * A database that remembers what was asked of it.
 *
 * Row counts are the currency the D1 free plan is billed in, and the defects
 * that have exhausted it here were never wrong answers — they were right
 * answers bought too many times. A test that asserts the answer passes either
 * way; a test that asserts how many times the question was asked does not.
 *
 * Wraps any `Database`, so it works over the same `node:sqlite` adapter every
 * other test uses and the code under test cannot tell the difference.
 */

import type { Database, DbResult, PreparedStatement } from '../../src/server/db.ts';

export interface QueryTally {
  /** The statement, whitespace collapsed so two formattings are one key. */
  sql: string;
  /** How many times it was executed. */
  calls: number;
  /** How many rows came back across those calls. */
  rows: number;
}

export interface CountingDb {
  db: Database;
  /** Every statement executed since the last {@link CountingDb.reset}. */
  tallies(): QueryTally[];
  /** Calls whose statement contains this fragment, whitespace-insensitive. */
  callsMatching(fragment: string): number;
  /** Rows returned by statements containing this fragment. */
  rowsMatching(fragment: string): number;
  reset(): void;
}

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export function countingDb(inner: Database): CountingDb {
  const seen = new Map<string, QueryTally>();

  const note = (sql: string, rows: number): void => {
    const key = flat(sql);
    const hit = seen.get(key) ?? { sql: key, calls: 0, rows: 0 };
    hit.calls += 1;
    hit.rows += rows;
    seen.set(key, hit);
  };

  const wrap = (sql: string, stmt: PreparedStatement): PreparedStatement => ({
    bind: (...values: unknown[]) => wrap(sql, stmt.bind(...values)),
    first: async <T,>(colName?: string) => {
      const row = await stmt.first<T>(colName);
      note(sql, row == null ? 0 : 1);
      return row;
    },
    all: async <T,>() => {
      const result = await stmt.all<T>();
      note(sql, result.results.length);
      return result as DbResult<T>;
    },
    // Writes are not counted: the allowance this guards is rows *read*.
    run: async () => stmt.run(),
  });

  const db: Database = {
    prepare: (sql: string) => wrap(sql, inner.prepare(sql)),
    batch: (statements) => inner.batch(statements),
    exec: (query) => inner.exec(query),
  };

  const matching = (fragment: string): QueryTally[] => {
    const needle = flat(fragment);
    return [...seen.values()].filter((t) => t.sql.includes(needle));
  };

  return {
    db,
    tallies: () => [...seen.values()].sort((a, b) => b.rows - a.rows),
    callsMatching: (fragment) => matching(fragment).reduce((total, t) => total + t.calls, 0),
    rowsMatching: (fragment) => matching(fragment).reduce((total, t) => total + t.rows, 0),
    reset: () => seen.clear(),
  };
}
