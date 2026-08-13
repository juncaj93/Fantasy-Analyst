/** Test database helper: a real SQLite database with the production schema. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeSqliteDatabase } from '../../src/server/adapters/nodeSqlite.ts';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../migrations/0001_init.sql', import.meta.url)),
  'utf8',
);

export async function createTestDb(): Promise<NodeSqliteDatabase> {
  const db = new NodeSqliteDatabase(':memory:');
  await db.exec(MIGRATION);
  return db;
}
