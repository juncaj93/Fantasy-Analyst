/**
 * A tally of what one request asked of the database.
 *
 * D1's free plan is billed in rows read, and the trade check was built to read
 * few of them. A claim like that needs a measurement from the place it matters,
 * not from a test's in-memory SQLite, so this wraps the same `Database` the
 * app already uses and counts what comes back.
 *
 * It counts **rows returned**, which is a lower bound on rows read: a statement
 * that scans a table to return three rows is billed for the scan. The check's
 * statements are all key or index lookups, so for them the two are close, but
 * the figure is printed as what it is. A read served from an in-isolate memo
 * (the player dictionary) costs nothing here and nothing on D1, which is the
 * point of the memo.
 *
 * Only reads are counted, and only when asked: the route opts in with
 * `?cost=1`, so an ordinary request pays for no wrapper.
 */

import type { Database, DbResult, PreparedStatement } from './db.ts';

export interface DbCost {
  statements: number;
  rowsReturned: number;
}

export function meterDatabase(inner: Database): { db: Database; cost: () => DbCost } {
  let statements = 0;
  let rowsReturned = 0;

  const wrap = (stmt: PreparedStatement): PreparedStatement => ({
    bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
    first: async <T,>(colName?: string) => {
      const row = await stmt.first<T>(colName);
      statements += 1;
      rowsReturned += row == null ? 0 : 1;
      return row;
    },
    all: async <T,>() => {
      const result = await stmt.all<T>();
      statements += 1;
      rowsReturned += result.results.length;
      return result as DbResult<T>;
    },
    run: async () => stmt.run(),
  });

  const db: Database = {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: (list) => inner.batch(list),
    exec: (query) => inner.exec(query),
  };
  return { db, cost: () => ({ statements, rowsReturned }) };
}
