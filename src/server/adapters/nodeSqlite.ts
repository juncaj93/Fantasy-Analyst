/**
 * `node:sqlite` adapter implementing the D1-compatible `Database` interface.
 *
 * LOCAL/TEST ONLY — never imported by the worker bundle. It exists so the exact
 * same repository and route code that runs on D1 can be exercised by unit tests
 * and the local dev server against real SQL.
 */

import { createRequire } from 'node:module';
import type { Database, DbResult, PreparedStatement } from '../db.ts';

/**
 * `node:sqlite` is a real builtin but is still omitted from
 * `module.builtinModules`, so bundlers (Vite/Vitest/esbuild) fail to resolve a
 * static `import`. Loading it through `createRequire` keeps every toolchain
 * happy and defers the import to runtime.
 */
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
}

interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

class NodeStatement implements PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): PreparedStatement {
    return new NodeStatement(this.db, this.sql, [...this.values, ...values.map(normalize)]);
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.values as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    const plain = { ...row } as Record<string, unknown>;
    if (colName) return (plain[colName] ?? null) as T;
    return plain as T;
  }

  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.values as never[])) as Record<string, unknown>[];
    return {
      results: rows.map((r) => ({ ...r }) as T),
      success: true,
      meta: { changes: 0 },
    };
  }

  async run(): Promise<DbResult<never>> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...(this.values as never[]));
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }
}

/** Convert JS values into something node:sqlite accepts. */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export class NodeSqliteDatabase implements Database {
  readonly raw: DatabaseSync;

  constructor(location = ':memory:') {
    this.raw = new DatabaseSync(location);
    this.raw.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(query: string): PreparedStatement {
    return new NodeStatement(this.raw, query);
  }

  /**
   * D1 runs batches in a transaction; mirror that so failure semantics match.
   */
  async batch<T = unknown>(statements: PreparedStatement[]): Promise<DbResult<T>[]> {
    const out: DbResult<T>[] = [];
    this.raw.exec('BEGIN');
    try {
      for (const stmt of statements) {
        out.push((await stmt.run()) as unknown as DbResult<T>);
      }
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = Date.now();
    this.raw.exec(query);
    return { count: query.split(';').filter((s) => s.trim()).length, duration: Date.now() - start };
  }

  close(): void {
    this.raw.close();
  }
}

/** Apply a migration SQL string to a database. */
export async function applyMigration(db: NodeSqliteDatabase, sql: string): Promise<void> {
  await db.exec(sql);
}
