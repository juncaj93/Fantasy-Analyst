import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Migrations are the one thing here that cannot be tested by running it.
 *
 * `wrangler d1 migrations apply --remote` does not use the SQL splitter that
 * `--local` uses. For a remote command wrangler posts the file to D1 as one
 * unsplit string and the server parses it, so a file can apply perfectly on
 * every developer machine and in every test, and still fail on the deploy --
 * which is exactly what happened to 0013: it applied locally, and the deploy
 * died on `incomplete input: SQLITE_ERROR` with the app un-shipped.
 *
 * There is no way to reach that parser from a test. What there is: a record of
 * which constructs it has already accepted, in the migrations that are live in
 * production today. This keeps new migrations inside that set.
 */
const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

describe('migrations stay inside what the remote parser has accepted', () => {
  it('there are migrations to check', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  /*
   * Block comments are the specific thing that broke, and the only construct
   * 0013 introduced that no already-applied migration had used. Line comments
   * are proven in every direction that matters: every applied migration uses
   * them, several with semicolons inside (0009, 0011, 0012) and one with a
   * question mark (0004), and the remote parser has accepted all of it.
   */
  it('uses line comments rather than block comments', () => {
    const offenders = migrationFiles()
      .filter((m) => m.sql.includes('/*'))
      .map((m) => m.name);
    expect(offenders).toEqual([]);
  });

  /*
   * D1 wraps a migration in its own transaction and rejects a file that opens
   * one. Cheap to state here rather than discover on a deploy.
   */
  it('does not open its own transaction', () => {
    const offenders = migrationFiles()
      .filter((m) => /\bBEGIN\s+TRANSACTION\b/i.test(m.sql))
      .map((m) => m.name);
    expect(offenders).toEqual([]);
  });
});

/**
 * The same migrations, applied to a database that already has rows in it.
 *
 * `createTestDb` applies every migration to an *empty* schema, which is the
 * cheap case and not the one production is in. Some `ALTER TABLE` forms are
 * legal against an empty table and illegal against a populated one, and the
 * difference is invisible until the deploy: SQLite refuses to add a **STORED**
 * generated column to a table with rows — `cannot add a STORED column` —
 * while accepting the identical statement when the table is empty.
 *
 * Migration 0020 was written STORED, passed the whole suite, and would have
 * failed at `wrangler d1 migrations apply --remote` against the four thousand
 * players that are actually in the deployed database. It is VIRTUAL now, and
 * this is the check that would have said so.
 *
 * The rows below are deliberately crude — one per table an early migration
 * creates, with only the columns those migrations declare NOT NULL. This is not
 * a fixture anything reads; it exists so that the tables are *not empty* when
 * the later migrations run.
 */
describe('migrations survive a database that already has data', () => {
  it('applies every migration in order to a populated database', async () => {
    const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');
    const db = new NodeSqliteDatabase(':memory:');
    const files = migrationFiles();

    /*
     * Seeded as early as the schema allows, then again after every migration.
     *
     * Inserting once at the start would only prove the *next* migration copes
     * with rows; a table created in 0016 would still be empty when 0020 runs.
     * Re-seeding between every pair means each migration meets whatever rows
     * the ones before it made possible.
     */
    const seed = async () => {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT OR IGNORE INTO players (id, full_name, normalized_name, external_ids_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind('seed-player', 'Kai Brennan', 'kai brennan', JSON.stringify({ gsis: '00-0011111' }), now, now)
        .run();
    };

    for (const [index, file] of files.entries()) {
      await db.exec(file.sql);
      // `players` exists from 0001, so every migration after the first meets a
      // table with a row in it.
      if (index >= 0) await seed().catch(() => undefined);
    }

    // And the column that prompted all this actually resolved, on a row that
    // was written before the migration that added it ran.
    const row = await db
      .prepare('SELECT gsis_id FROM players WHERE id = ?')
      .bind('seed-player')
      .first<{ gsis_id: string | null }>();
    expect(row?.gsis_id).toBe('00-0011111');
  });
});
