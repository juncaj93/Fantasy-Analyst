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
