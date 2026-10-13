/**
 * The odds job's staleness read buys fewer rows and makes the same decisions.
 *
 * `snapshotAges` used to read every line every planned player had ever carried
 * (no date window) to learn one thing: does he carry a line at all. It now asks
 * with the slate window the screens use, and asks again without it only for a
 * player the window did not find. This runs the planner both ways over the same
 * stored data, including the one shape where a windowed read alone would differ
 * (a player with lines only from a past week while his current game has been
 * bought), and requires identical plans, ages and planned lookups.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';

type Internals = {
  props: PropsRepo;
  snapshotAges(eventOf: ReadonlyMap<string, { eventId: string } | null>, now: number, byEvent: boolean): Promise<Map<string, number>>;
  rosterPlayers(now: number, byEvent?: boolean): Promise<unknown[]>;
};

/** The staleness read as it was before this round, kept here as the reference. */
async function legacySnapshotAges(
  this: Internals,
  eventOf: ReadonlyMap<string, { eventId: string } | null>,
  now: number,
  byEvent: boolean,
): Promise<Map<string, number>> {
  const playerIds = [...eventOf.keys()];
  const eventIds = [...eventOf.values()].map((e) => e?.eventId).filter((id): id is string => id != null);
  const [props, fetched] = await Promise.all([this.props.latestForPlayers(playerIds), this.props.newestFetchByEvent(eventIds)]);
  const out = new Map<string, number>();
  for (const id of playerIds) {
    if (!byEvent && (props.get(id)?.length ?? 0) === 0) continue;
    const eventId = eventOf.get(id)?.eventId;
    const at = eventId ? Date.parse(fetched.get(eventId) ?? '') : NaN;
    if (Number.isFinite(at)) out.set(id, (now - at) / 60_000);
  }
  return out;
}

describe('snapshotAges: same decisions, fewer rows', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    await new VegasRefreshService(db, new MockVegasProvider(MOCK_GAMES)).refresh({ manual: true });
  });

  async function bothWays(database: NodeSqliteDatabase | ReturnType<typeof countingDb>['db'], now: number) {
    const provider = new MockVegasProvider(MOCK_GAMES);
    const current = new VegasRefreshService(database as never, provider) as unknown as Internals;
    const legacy = new VegasRefreshService(database as never, provider) as unknown as Internals;
    legacy.snapshotAges = legacySnapshotAges.bind(legacy);
    const out: Record<string, unknown> = {};
    for (const byEvent of [false, true]) {
      out[`after/${byEvent}`] = await current.rosterPlayers(now, byEvent);
      out[`before/${byEvent}`] = await legacy.rosterPlayers(now, byEvent);
    }
    return out;
  }

  it('plans identically on the stored week', async () => {
    const r = await bothWays(db, Date.now());
    expect(r['after/false']).toEqual(r['before/false']);
    expect(r['after/true']).toEqual(r['before/true']);
    expect((r['after/false'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('plans identically when a player has lines only from a past week', async () => {
    // A player with a quote in a long-gone game and none in the current one,
    // while the current game has been bought: the shape a windowed read alone
    // would judge differently.
    const row = await db.prepare('SELECT player_id, snapshot_id FROM player_props WHERE player_id IS NOT NULL LIMIT 1').first<{ player_id: string; snapshot_id: number }>();
    expect(row).not.toBeNull();
    const past = new Date(Date.now() - 20 * 86_400_000).toISOString();
    await db.prepare(`INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope) VALUES ('mock','old-game',?,?,'{}','week')`).bind(past, past).run();
    const old = await db.prepare(`SELECT id FROM prop_snapshots WHERE event_id = 'old-game'`).first<{ id: number }>();
    await db.prepare(`INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, scope) VALUES (?,?,?,?,?, 'week')`).bind(old!.id, row!.player_id, 'x', 'player_reception_yds', 40).run();
    // Remove his quotes from the current game so only the past week carries him.
    await db.prepare('DELETE FROM player_props WHERE player_id = ? AND snapshot_id != ?').bind(row!.player_id, old!.id).run();

    const r = await bothWays(db, Date.now());
    expect(r['after/false']).toEqual(r['before/false']);
    expect(r['after/true']).toEqual(r['before/true']);
  });

  it('reads fewer rows, and none of the lines at all in the kickoff-clock pass', async () => {
    const legacyCounting = countingDb(db);
    const newCounting = countingDb(db);
    const now = Date.now();
    const provider = new MockVegasProvider(MOCK_GAMES);
    const legacy = new VegasRefreshService(legacyCounting.db, provider) as unknown as Internals;
    legacy.snapshotAges = legacySnapshotAges.bind(legacy);
    const current = new VegasRefreshService(newCounting.db, provider) as unknown as Internals;
    await legacy.rosterPlayers(now, true);
    await current.rosterPlayers(now, true);
    const pp = 'SELECT pp.* FROM player_props pp';
    expect(legacyCounting.callsMatching(pp)).toBeGreaterThan(0);
    expect(newCounting.callsMatching(pp)).toBe(0);
  });
});
