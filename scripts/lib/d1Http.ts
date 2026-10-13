/**
 * The app's `Database` interface over Cloudflare's D1 HTTP query API, read-only.
 *
 * Lets a probe run the app's own repositories (`PlayerRepo`, `UsageRepo`...)
 * against production so it maps rows exactly the way the Worker does. Refuses
 * anything that is not a SELECT, and counts the rows D1 reports reading so a
 * probe can say what it cost.
 *
 * Env: CLOUDFLARE_API_TOKEN, and ACCOUNT_ID (or the token's first account).
 */

import type { Database, DbResult, PreparedStatement } from '../../src/server/db.ts';

const CF = 'https://api.cloudflare.com/client/v4';

export interface D1Http extends Database {
  rowsRead(): number;
  statements(): number;
}

export async function d1Http(name = 'fantasy_analyst'): Promise<D1Http> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${CF}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    return (await res.json()) as { success: boolean; result: unknown; errors?: unknown };
  };
  const account =
    process.env.ACCOUNT_ID || ((await call('/accounts')).result as { id: string }[] | undefined)?.[0]?.id;
  if (!account) throw new Error('no Cloudflare account');
  const dbs = (await call(`/accounts/${account}/d1/database?name=${name}`)).result as { name: string; uuid: string }[];
  const uuid = dbs?.find((d) => d.name === name)?.uuid;
  if (!uuid) throw new Error(`no D1 database called ${name}`);

  let rows = 0;
  let count = 0;
  const query = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
    if (!/^\s*(select|with)\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql.slice(0, 80)}`);
    const body = await call(`/accounts/${account}/d1/database/${uuid}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, params }),
    });
    if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 300)}`);
    const first = (body.result as { results: Record<string, unknown>[]; meta?: { rows_read?: number } }[])[0];
    rows += Number(first?.meta?.rows_read ?? 0);
    count += 1;
    return first?.results ?? [];
  };

  const statement = (sql: string, params: unknown[] = []): PreparedStatement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async <T,>(col?: string) => {
      const [row] = await query(sql, params);
      if (!row) return null;
      return (col ? (row[col] as T) : (row as T)) ?? null;
    },
    all: async <T,>() => ({ results: (await query(sql, params)) as T[], success: true, meta: {} }) as DbResult<T>,
    run: async () => {
      throw new Error('read-only adapter');
    },
  });

  return {
    prepare: (sql: string) => statement(sql),
    batch: async () => {
      throw new Error('read-only adapter');
    },
    exec: async () => {
      throw new Error('read-only adapter');
    },
    rowsRead: () => rows,
    statements: () => count,
  };
}
