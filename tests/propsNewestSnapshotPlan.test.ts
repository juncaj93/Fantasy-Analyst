/**
 * The props reads must find their rows through narrow indexes.
 *
 * History: "the newest snapshot of this game" was once found from the scope
 * index, on which nearly every snapshot is the same value, and walked every
 * game's snapshots (`d1 insights` put that at about 60% of the reads behind the
 * 1 October 2026 allowance alert). Since Round 23 a look writes only the lines
 * that changed, so the reads changed shape: lines by player, then the looks of
 * just those games. These assert the plans rather than the answers, for the
 * same reason as before: the answer can be right with a full scan underneath.
 * The test database has no statistics, so it plans as production does.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { slateWindow } from '../src/core/nfl/slateWindow.ts';

async function plans(): Promise<{ sql: string; plan: string }[]> {
  const db = await createTestDb();
  await db
    .prepare(
      `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope)
       VALUES ('m','e1','2026-10-04T17:00:00Z','2026-10-01T00:00:00Z','{}','week')`,
    )
    .run();
  await db
    .prepare(`INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, scope) VALUES (1,NULL,'A','rush_yards',50,'week')`)
    .run();
  const counting = countingDb(db);
  const repo = new PropsRepo(counting.db);
  const window = slateWindow(new Date('2026-10-01T12:00:00Z'));
  await repo.latestForPlayers(['a', 'b'], window);
  await repo.latestForPlayers(['a', 'b']);
  await repo.previousForPlayers(['a', 'b'], window);
  await repo.currentForEvent('e1');
  await repo.pricedPlayerCount();
  const out: { sql: string; plan: string }[] = [];
  for (const t of counting.tallies()) {
    if (!/player_props|prop_snapshots/.test(t.sql)) continue;
    const params = (t.sql.match(/\?/g) ?? []).map(() => null);
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${t.sql}`).bind(...params).all<{ detail: string }>();
    out.push({ sql: t.sql, plan: results.map((r) => r.detail).join(' | ') });
  }
  return out;
}

describe('the props reads', () => {
  it('never scan the whole lines table', async () => {
    const all = await plans();
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const { sql, plan } of all) {
      expect(plan, sql).not.toMatch(/SCAN (pp|player_props)\b/);
    }
  });

  it('find a game\'s looks through the event index, not the scope index', async () => {
    const all = await plans();
    const byEvent = all.filter(({ sql }) => /FROM prop_snapshots\s+WHERE event_id IN/.test(sql));
    expect(byEvent.length).toBeGreaterThan(0);
    for (const { sql, plan } of byEvent) {
      expect(plan, sql).toContain('USING INDEX idx_prop_snapshots_event');
    }
  });

  it('read a slate\'s lines from that slate\'s looks only', async () => {
    const all = await plans();
    const windowed = all.find(({ sql }) => sql.includes('ps.game_start >= ?'));
    expect(windowed?.plan).toContain('idx_prop_snapshots_window (scope=? AND game_start>? AND game_start<?)');
  });

  it('count priced players from the counted looks\' lines only', async () => {
    const all = await plans();
    const count = all.find(({ sql }) => sql.includes('AS priced'));
    expect(count?.plan).toContain('LIST SUBQUERY');
    expect(count?.plan).toContain('idx_player_props_snapshot_player');
  });
});
