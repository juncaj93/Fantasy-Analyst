/** Test database helper: a real SQLite database with the production schema. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSqliteDatabase } from '../../src/server/adapters/nodeSqlite.ts';

/**
 * Every migration, applied in filename order — the same set the deployed D1
 * database gets, so tests fail if a migration is malformed or out of order.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));

export async function createTestDb(): Promise<NodeSqliteDatabase> {
  const db = new NodeSqliteDatabase(':memory:');
  for (const sql of MIGRATIONS) await db.exec(sql);
  return db;
}
