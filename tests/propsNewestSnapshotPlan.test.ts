/**
 * "The newest snapshot of this game" must be found from the game, not the scope.
 *
 * The three props reads that ask it (`latestForPlayers`, `previousForPlayers`,
 * `pricedPlayerCount`) had two indexes to choose from: `(event_id, fetched_at)`
 * and `(scope, fetched_at)`. D1 keeps no table statistics, so SQLite took the
 * scope index, on which nearly every snapshot is the same value, and walked
 * every game's snapshots to find each one game's newest. `d1 insights` put the
 * props reads at about 60% of the two days behind the 1 October 2026 allowance
 * alert, the unwindowed one at 21,786 rows a call.
 *
 * These assert the plan rather than the answer, like `sourceRunsIndex.test.ts`
 * and for the same reason: the answer was always right, and an assertion about
 * it would pass with the defect back in place. The test database has no
 * statistics either, so it plans exactly as production did; this fails on the
 * code before the fix.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { slateWindow } from '../src/core/nfl/slateWindow.ts';

async function propsStatements(): Promise<{ db: Awaited<ReturnType<typeof createTestDb>>; sqls: string[] }> {
  const db = await createTestDb();
  const counting = countingDb(db);
  const repo = new PropsRepo(counting.db);
  const window = slateWindow(new Date('2026-10-01T12:00:00Z'));
  await repo.latestForPlayers(['a', 'b'], window);
  await repo.latestForPlayers(['a', 'b']);
  await repo.previousForPlayers(['a', 'b'], window);
  await repo.pricedPlayerCount();
  const sqls = counting
    .tallies()
    .map((t) => t.sql)
    .filter((sql) => sql.includes('ORDER BY s2.fetched_at DESC'));
  return { db, sqls };
}

describe('the newest-snapshot subquery', () => {
  it('is asked by every read that should ask it', async () => {
    const { sqls } = await propsStatements();
    expect(sqls).toHaveLength(4);
  });

  it('finds each game’s newest snapshot through the event index', async () => {
    const { db, sqls } = await propsStatements();
    for (const sql of sqls) {
      const params = (sql.match(/\?/g) ?? []).map(() => null);
      const { results } = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join(' | ');
      expect(plan, sql).toContain('SEARCH s2 USING INDEX idx_prop_snapshots_event');
      expect(plan, `the scope index walks every game's snapshots: ${sql}`).not.toContain(
        's2 USING INDEX idx_prop_snapshots_scope',
      );
    }
  });
});
