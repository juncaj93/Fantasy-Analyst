/**
 * Minimal database interface, structurally compatible with Cloudflare D1.
 *
 * The worker passes `env.DB` straight through; tests and the local dev server
 * pass a `node:sqlite`-backed adapter (see tests/helpers/sqlite.ts). Repository
 * code therefore runs unchanged in every environment.
 */

export interface DbMeta {
  changes?: number;
  last_row_id?: number;
  duration?: number;
}

export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: DbMeta;
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run(): Promise<DbResult<never>>;
}

export interface Database {
  prepare(query: string): PreparedStatement;
  batch<T = unknown>(statements: PreparedStatement[]): Promise<DbResult<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

/** JSON helpers used across repositories. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Chunk large insert batches — D1 caps statements per batch. */
/**
 * How many bound parameters one D1 statement may carry.
 *
 * D1 caps this at 100 and fails the whole query with
 * `too many SQL variables` when exceeded — so any `IN (?, ?, ...)` built from a
 * caller-supplied list has to be batched, however small that list usually is.
 * Set below the limit to leave room for other bound values in the same
 * statement.
 */
export const MAX_BOUND_PARAMS = 90;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
