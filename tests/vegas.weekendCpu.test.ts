/**
 * The weekend Vegas cron fits inside its CPU allowance.
 *
 * Cloudflare killed the Saturday 23:00 and Sunday 15:00 UTC refresh for CPU on
 * every weekend from 19 September 2026 (787-1,315ms at the kill). Measured on
 * production the same week, each stored game was 1.24-1.37 MB, 99% of it the
 * provider's own payload next to about 9 KB of the quotes the app reads, and
 * each game stored rebuilt the whole 3,309-player dictionary. A ten-game run
 * spent about 50ms of CPU per game on those two things and nothing else.
 *
 * These pin the three changes: the payload is not stored, the cache check does
 * not read it back, and the dictionary is indexed once per refresh.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import type { MarketKey, RawPropSet } from '../src/core/vegas/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';

/** The provider's answer is big; this stands in for it. */
const PAYLOAD = { odds: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`odd${i}`, { byBookmaker: { a: 1, b: 2 } }])) };

class PayloadProvider extends MockVegasProvider {
  constructor() {
    super(MOCK_GAMES);
  }
  override async getPlayerProps(eventId: string, markets?: MarketKey[]): Promise<RawPropSet> {
    return { ...(await super.getPlayerProps(eventId, markets)), raw: PAYLOAD };
  }
  async getAccountUsage(): Promise<unknown> {
    return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': 0 } } };
  }
}

describe('a weekend refresh', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('stores the quotes and game lines, and not the provider payload', async () => {
    const report = await new VegasRefreshService(db, new PayloadProvider()).refresh();
    expect(report.fetched + report.discovered).toBeGreaterThan(0);

    // Every row this refresh wrote, not only the newest: some mock games quote nobody.
    const rows = await db
      .prepare("SELECT raw_json FROM prop_snapshots WHERE scope = 'week' AND raw_json LIKE '%\"raw\":null%'")
      .all<{ raw_json: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    const stored = rows.results.map((r) => JSON.parse(r.raw_json) as RawPropSet);
    expect(stored.some((s) => s.quotes.length > 0)).toBe(true);
    const written = await db.prepare('SELECT raw_json FROM prop_snapshots').all<{ raw_json: string }>();
    expect(written.results.some((r) => r.raw_json.includes('byBookmaker'))).toBe(false);
  });

  it('checks a game’s age without reading an old row’s payload back', async () => {
    // A row written before the payload stopped being stored.
    await db
      .prepare(
        `INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope)
         VALUES ('mock', 'legacy-game', '2026-10-04T17:00:00.000Z', '2026-10-03T23:00:00.000Z', ?, 'week')`,
      )
      .bind(JSON.stringify({ provider: 'mock', eventId: 'legacy-game', quotes: [{ playerName: 'A' }], raw: PAYLOAD }))
      .run();

    const cached = await new PropsRepo(db).get('legacy-game');
    expect(cached?.fetchedAt).toBe('2026-10-03T23:00:00.000Z');
    expect(cached?.raw.quotes).toHaveLength(1);
    expect(cached?.raw.raw ?? null).toBeNull();
  });

  it('indexes the player dictionary once, however many games it stores', async () => {
    const spy = vi.spyOn(PlayerRepo.prototype, 'buildIndex');
    try {
      const report = await new VegasRefreshService(db, new PayloadProvider()).refresh();
      expect(report.fetched + report.discovered).toBeGreaterThan(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
