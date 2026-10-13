/**
 * A read-only `Database` that talks to production D1 through Cloudflare's REST
 * API, so a probe can run the app's own repositories and services against the
 * real stored data and see D1's own `rows_read` for every statement.
 *
 * SELECT, WITH and EXPLAIN only. Anything else throws, so nothing a service
 * tries to store (a best-effort count, a memo row) can reach the database.
 *
 * Every statement is logged with its wall time and rows read, which is the raw
 * material for "where does the time go" and "what did that change cost".
 */

import type { Database, DbResult, PreparedStatement } from '../../src/server/db.ts';

export interface StatementLog {
  sql: string;
  ms: number;
  rowsRead: number;
  rowsReturned: number;
}

export interface RestD1 {
  db: Database;
  log: StatementLog[];
  /** Sum of rows read and statements since `mark()`. */
  since(mark: number): { statements: number; rowsRead: number; ms: number };
  mark(): number;
}

const READ_ONLY = /^\s*(select|with|explain)\b/i;

export async function openRestD1(token: string, accountId?: string, name = 'fantasy_analyst'): Promise<RestD1> {
  const base = 'https://api.cloudflare.com/client/v4';
  const call = async (path: string, init: RequestInit = {}): Promise<any> => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return res.json().catch(() => null);
  };
  const account = accountId || (await call('/accounts'))?.result?.[0]?.id;
  const dbs = await call(`/accounts/${account}/d1/database?name=${name}`);
  const uuid = dbs?.result?.find((d: any) => d.name === name)?.uuid;
  if (!account || !uuid) throw new Error('could not resolve the D1 database through the Cloudflare API');

  const log: StatementLog[] = [];

  class Statement implements PreparedStatement {
    constructor(
      private readonly sql: string,
      private readonly params: unknown[] = [],
    ) {}
    bind(...values: unknown[]): PreparedStatement {
      return new Statement(this.sql, [...this.params, ...values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v))]);
    }
    private async exec(): Promise<{ results: any[]; rowsRead: number }> {
      if (!READ_ONLY.test(this.sql)) throw new Error(`read-only probe refused: ${this.sql.slice(0, 80)}`);
      const started = Date.now();
      const r = await call(`/accounts/${account}/d1/database/${uuid}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: this.sql, params: this.params }),
      });
      if (!r?.success) throw new Error(JSON.stringify(r?.errors ?? r).slice(0, 300));
      const first = r.result?.[0] ?? {};
      const rowsRead = Number(first.meta?.rows_read ?? 0);
      log.push({
        sql: this.sql.replace(/\s+/g, ' ').trim(),
        ms: Date.now() - started,
        rowsRead,
        rowsReturned: (first.results ?? []).length,
      });
      return { results: first.results ?? [], rowsRead };
    }
    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const { results } = await this.exec();
      const row = results[0];
      if (!row) return null;
      return (colName ? (row[colName] ?? null) : row) as T;
    }
    async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
      const { results } = await this.exec();
      return { results: results as T[], success: true, meta: {} };
    }
    async run(): Promise<DbResult<never>> {
      await this.exec();
      return { results: [], success: true, meta: {} };
    }
  }

  const db: Database = {
    prepare: (sql: string) => new Statement(sql),
    batch: async <T = unknown>(statements: PreparedStatement[]) => {
      const out: DbResult<T>[] = [];
      for (const s of statements) out.push((await s.all<T>()) as DbResult<T>);
      return out;
    },
    exec: async () => {
      throw new Error('read-only probe refused exec');
    },
  };

  return {
    db,
    log,
    mark: () => log.length,
    since: (mark: number) => {
      const part = log.slice(mark);
      return {
        statements: part.length,
        rowsRead: part.reduce((a, l) => a + l.rowsRead, 0),
        ms: part.reduce((a, l) => a + l.ms, 0),
      };
    },
  };
}

/** Group a slice of the log by the start of the statement, biggest time first. */
export function topStatements(log: StatementLog[], limit = 8): string[] {
  const groups = new Map<string, { calls: number; ms: number; rows: number }>();
  for (const l of log) {
    const key = l.sql.slice(0, 110);
    const g = groups.get(key) ?? { calls: 0, ms: 0, rows: 0 };
    g.calls += 1;
    g.ms += l.ms;
    g.rows += l.rowsRead;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([sql, g]) => `${String(g.calls).padStart(4)} calls ${String(g.ms).padStart(6)} ms ${String(g.rows).padStart(8)} rows  ${sql}`);
}
