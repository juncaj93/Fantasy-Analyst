/**
 * What one background refresh cost the database, in D1's own numbers.
 *
 * D1 reports `rows_read` and `rows_written` on every statement's meta, and
 * those are the units the free plan bills (5M read, 100k written a day, shared
 * by every site on the account). This wraps the database a refresh job uses
 * and adds them up, so the job record can say exactly what the refresh cost
 * rather than what somebody estimated.
 *
 * `first()` is answered through `all()` because only `all()` and `run()` carry
 * meta; D1 reads the same rows either way. Statements handed to `batch()` are
 * unwrapped first, since D1 only accepts its own prepared statements there.
 *
 * Off D1 (tests, the dev server) the meta has no row counts, so a read counts
 * the rows it returned and a write counts `changes`: a lower bound, labelled
 * as such nowhere because nothing outside tests reads it.
 */

import type { Database, DbResult, PreparedStatement } from '../db.ts';
import { MEMO_KEY } from '../repos/slowRead.ts';

export interface RefreshCost {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
}

export function costMeter(inner: Database): { db: Database; cost: () => RefreshCost } {
  let rowsRead = 0;
  let rowsWritten = 0;
  let statements = 0;
  const innerOf = new WeakMap<PreparedStatement, PreparedStatement>();

  const tally = (result: DbResult<unknown> | null | undefined, returned: number): void => {
    statements += 1;
    const meta = (result?.meta ?? {}) as Record<string, unknown>;
    rowsRead += typeof meta['rows_read'] === 'number' ? (meta['rows_read'] as number) : returned;
    rowsWritten +=
      typeof meta['rows_written'] === 'number'
        ? (meta['rows_written'] as number)
        : returned === 0 && typeof meta['changes'] === 'number'
          ? (meta['changes'] as number)
          : 0;
  };

  const wrap = (stmt: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: async <T,>(colName?: string) => {
        const result = await stmt.all<Record<string, unknown>>();
        tally(result, result.results.length);
        const row = result.results[0] ?? null;
        if (row == null) return null;
        return (colName ? ((row[colName] ?? null) as T) : (row as T)) as T | null;
      },
      all: async <T,>() => {
        const result = await stmt.all<T>();
        tally(result as DbResult<unknown>, result.results.length);
        return result;
      },
      run: async () => {
        const result = await stmt.run();
        tally(result as DbResult<unknown>, 0);
        return result;
      },
    };
    innerOf.set(wrapped, stmt);
    return wrapped;
  };

  const db: Database = {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: async <T,>(list: PreparedStatement[]) => {
      const results = await inner.batch<T>(list.map((s) => innerOf.get(s) ?? s));
      for (const r of results) tally(r as DbResult<unknown>, (r?.results ?? []).length);
      return results;
    },
    exec: (query: string) => inner.exec(query),
  };
  // In-isolate memos key on the real database, so a memoised read here still hits.
  (db as unknown as { [MEMO_KEY]: Database })[MEMO_KEY] = inner;

  return { db, cost: () => ({ rowsRead, rowsWritten, statements }) };
}
