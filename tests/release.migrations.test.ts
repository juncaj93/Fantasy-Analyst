/**
 * Expand / contract, enforced where it can be.
 *
 * Rolling the code back does not roll the database back: `wrangler d1
 * migrations apply` only goes forwards, and D1 has no point-in-time restore to
 * fall back on. So the thing that makes a rollback safe is not a down
 * migration — inventing one would be pretending — it is that the schema the
 * new code created is a schema the *previous* code can still live with.
 *
 * That holds automatically for an additive migration and not at all for a
 * destructive one. A migration that drops a column, renames one or deletes rows
 * breaks the code that was reading them, which means the release before it can
 * no longer be put back: the rollback path is closed by the migration, hours
 * before anybody discovers they need it.
 *
 * This is the half of the policy that can be checked mechanically. A migration
 * that does something destructive has to say so in a comment — one line, naming
 * what has already been true long enough for it to be safe. The point is not
 * the marker; it is that the question gets asked while the migration is being
 * written rather than during an incident.
 *
 * See docs/RELEASE.md for the policy itself.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'migrations');

/**
 * Statements that leave the previous release unable to read what it wrote.
 *
 * `DROP INDEX` is deliberately absent: an index is invisible to the code, so
 * dropping one costs speed and nothing else. `CREATE`, `ALTER TABLE ... ADD`
 * and `INSERT` are the expand half of the policy and are always fine.
 */
const DESTRUCTIVE = [
  { pattern: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { pattern: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { pattern: /\bRENAME\s+(COLUMN|TO)\b/i, what: 'RENAME' },
  { pattern: /\bDELETE\s+FROM\b/i, what: 'DELETE FROM' },
];

/** The one-line acknowledgement a destructive migration has to carry. */
const CONTRACT_MARKER = /^\s*--\s*contract:/im;

/*
 * Migrations written before this policy existed, listed rather than exempted by
 * a rule so that the list can only get shorter. Both predate the release
 * hardening lane and neither is being rewritten: history that has already been
 * applied to production is not a thing to edit.
 *
 *   0005 renamed two cache columns — the cache is derived and rebuildable, and
 *        the rename shipped with the code that reads the new names.
 *   0029 deleted flag rows at level zero, which is a data cleanup rather than a
 *        schema contraction.
 */
const BEFORE_THE_POLICY = new Set([
  '0005_recent_window_30_days.sql',
  '0029_queue_belongs_to_a_draft.sql',
]);

const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();

/** SQL with comments removed, so a marker cannot be mistaken for a statement. */
function statements(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('migrations are expand-first', () => {
  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files)('%s either expands, or says why it contracts', (name) => {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    const body = statements(sql);
    const found = DESTRUCTIVE.filter(({ pattern }) => pattern.test(body)).map(({ what }) => what);

    if (found.length === 0) return;
    if (BEFORE_THE_POLICY.has(name)) return;

    expect(
      CONTRACT_MARKER.test(sql),
      [
        `${name} contains ${found.join(', ')}, which the release before it cannot survive.`,
        '',
        'Expand first: add the new shape, let the new code start using it, and contract in a',
        'later migration once the rollback window has passed. If that window HAS passed and this',
        'really is the contract step, say so at the top of the file:',
        '',
        '  -- contract: <what has been unused since, and since when>',
        '',
        'See docs/RELEASE.md.',
      ].join('\n'),
    ).toBe(true);
  });

  /*
   * The message above tells an author to write `-- contract:`. If the document
   * describing the policy stopped mentioning it, the two would drift and the
   * marker would become folklore.
   */
  it('the marker this asks for is documented', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'RELEASE.md'), 'utf8');
    expect(doc).toContain('-- contract:');
    expect(doc.toLowerCase()).toContain('expand');
  });

  /*
   * The grandfathered list is a list of two known files, not a wildcard. If one
   * is ever renamed or removed, the entry has to go with it — otherwise the set
   * quietly becomes a way to exempt a *new* migration by reusing a filename.
   */
  it('grandfathers only migrations that still exist', () => {
    for (const name of BEFORE_THE_POLICY) expect(files).toContain(name);
  });
});
