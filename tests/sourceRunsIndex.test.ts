/**
 * The "what did this feed last do?" reads must not scan the ledger.
 *
 * Both `latestRun()` implementations ask for one row ordered by two keys. Both
 * tables carried an index on the first key only, and SQLite will not use a
 * partial ordering to satisfy a two-key sort -- it scans the table and builds a
 * temp B-tree over every row before the LIMIT takes one of them.
 *
 * That cost 876,966 rows across 79 calls on the night of 2 September, 17.5% of
 * the daily D1 allowance, to answer a freshness line on a diagnostics screen.
 *
 * These tests assert the *query plan*, not the answer. An assertion about the
 * returned row passed before the fix and would pass again if the index were
 * dropped -- which is precisely how this went unnoticed while the table grew.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { InjuryRepo } from '../src/server/repos/injury.ts';
import { UsageRepo } from '../src/server/repos/usage.ts';

/** How SQLite says it will answer a query, as one string. */
async function planOf(db: Awaited<ReturnType<typeof createTestDb>>, sql: string): Promise<string> {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

const LATEST_INJURY = 'SELECT * FROM injury_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1';
const LATEST_USAGE = 'SELECT * FROM usage_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1';

describe('the latest-run reads are answered from an index', () => {
  it('does not sort the whole injury ledger to find its newest row', async () => {
    const db = await createTestDb();
    const plan = await planOf(db, LATEST_INJURY);
    expect(
      plan,
      'a temp B-tree here means every row is read to return one — the 11,101-rows-a-call defect',
    ).not.toContain('TEMP B-TREE');
    expect(plan).toContain('USING INDEX');
  });

  it('does not sort the whole usage ledger either', async () => {
    const db = await createTestDb();
    const plan = await planOf(db, LATEST_USAGE);
    expect(plan, 'the same defect, on the twin table').not.toContain('TEMP B-TREE');
    expect(plan).toContain('USING INDEX');
  });

  /**
   * The index changes the plan and nothing else.
   *
   * `fetched_at` ties are what the `id DESC` tie-break exists for, so the rows
   * here deliberately share a timestamp: the newest row must still be the one
   * with the highest id, exactly as before.
   */
  it('still returns the newest run, and breaks ties by id', async () => {
    const db = await createTestDb();
    const repo = new InjuryRepo(db);
    const at = '2026-09-02T12:00:00.000Z';

    const run = (fetchedAt: string, note: string) => ({
      source: 'nflverse',
      season: '2026',
      latestWeek: null,
      fetchedAt,
      publishedAt: null,
      rowsReturned: 1,
      matchedById: 1,
      matchedByName: 0,
      unmatched: 0,
      outcome: 'ok' as const,
      note,
    });

    await repo.recordRun(run('2026-09-01T12:00:00.000Z', 'older'));
    await repo.recordRun(run(at, 'tie-first'));
    await repo.recordRun(run(at, 'tie-last'));

    const latest = await repo.latestRun();
    expect(latest?.note, 'the highest id among rows sharing the newest timestamp').toBe('tie-last');
  });

  it('says nothing rather than guessing when the ledger is empty', async () => {
    const db = await createTestDb();
    expect(await new InjuryRepo(db).latestRun()).toBeNull();
    expect(await new UsageRepo(db).latestRun()).toBeNull();
  });
});
