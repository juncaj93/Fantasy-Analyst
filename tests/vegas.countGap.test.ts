/**
 * Why the app's odds count and the provider's disagreed by about ten.
 *
 * Production's ledger on 6 October 2026: the provider's counter was read at
 * 11:26:29 and stood at 327; the pass that began there spent ten entities; the
 * app went on showing 327. Every other number agreed. The stored reading is
 * taken at the top of a pass, so what the pass then bought sat in the gap until
 * the next pass looked again, which on a Setup screen reads as ten calls the
 * app did not know about.
 *
 * Two smaller holes in the same books are closed alongside it, each a billed
 * call with no row behind it:
 *
 *   - a database error after the provider answered, which left the ledger write
 *     (then the last statement) unreached;
 *   - a schedule discovery that failed on its third team and threw away what the
 *     first two had bought, and with it the only count of what they cost.
 *
 * The probes under `scripts/probe-*` call the provider with the same key from
 * the Probe workflow and can never be in this ledger; the provider's counter is
 * what shows them, which is what reading it first is for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { SportsGameOddsProvider } from '../src/core/vegas/sportsGameOddsProvider.ts';
import type { MarketKey, RawPropSet } from '../src/core/vegas/types.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { VegasUsageRepo } from '../src/server/repos/vegasUsage.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { createTestDb } from './helpers/db.ts';

/**
 * A provider with a real counter: every event it sells moves it, and reading it
 * does not, which is how the real one behaves (measured).
 */
class MeteredProvider extends MockVegasProvider {
  billed: number;
  constructor(startAt: number) {
    super(MOCK_GAMES);
    this.billed = startAt;
  }
  override async getPlayerProps(eventId: string, markets?: MarketKey[]): Promise<RawPropSet> {
    this.billed += 1;
    return super.getPlayerProps(eventId, markets);
  }
  // `getPropsForTeams` buys through `getPlayerProps`, one event at a time, so
  // the counter above already has it.
  async getAccountUsage(): Promise<unknown> {
    return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': this.billed } } };
  }
}

describe('the number the app shows after it has spent', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('is the provider\'s number now, not the one it read before it spent', async () => {
    // 327 already on the provider's counter, as on 6 October.
    const provider = new MeteredProvider(327);
    const report = await new VegasRefreshService(db, provider).refresh({ manual: true });

    expect(report.spent, 'the fixture has to buy something').toBeGreaterThan(0);
    expect(provider.billed).toBe(327 + report.spent);
    // The regression in one line: before the fix this read 327.
    expect(report.budget.used).toBe(provider.billed);
    expect((await new VegasUsageRepo(db).view()).used).toBe(provider.billed);
  });

  it('says whose number it is, and that number is the provider\'s', async () => {
    const provider = new MeteredProvider(327);
    const report = await new VegasRefreshService(db, provider).refresh({ manual: true });
    expect(report.budget.source).toBe('provider');
  });

  it('still shows spending the ledger never saw', async () => {
    // A probe spends seven between two passes. The next pass reads the real
    // counter, so those seven are in the number, which is the point of reading
    // it: the ledger could never have known.
    const provider = new MeteredProvider(100);
    await new VegasRefreshService(db, provider).refresh({ manual: true });
    provider.billed += 7;
    const second = await new VegasRefreshService(db, provider).refresh({ manual: true });
    expect(second.budget.used).toBe(provider.billed);
  });

  it('reads the counter again only when something was bought', async () => {
    let reads = 0;
    class Counting extends MeteredProvider {
      override async getAccountUsage(): Promise<unknown> {
        reads += 1;
        return super.getAccountUsage();
      }
    }
    const provider = new Counting(10);
    const service = new VegasRefreshService(db, provider);
    await service.refresh({ manual: true });
    expect(reads, 'once to decide, once after buying').toBe(2);

    reads = 0;
    const idle = await service.refresh({ manual: true });
    expect(idle.spent).toBe(0);
    expect(reads, 'an idle pass reads it once').toBe(1);
  });

  it('does not report a failed closing read as an error', async () => {
    let calls = 0;
    class Flaky extends MeteredProvider {
      override async getAccountUsage(): Promise<unknown> {
        calls += 1;
        if (calls > 1) throw new Error('rate limited');
        return super.getAccountUsage();
      }
    }
    const report = await new VegasRefreshService(db, new Flaky(0)).refresh({ manual: true });
    expect(report.spent).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });
});

describe('a billed call is in the ledger even if storing it fails', () => {
  it('books the entity before the names are resolved', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const provider = new MeteredProvider(0);
    const service = new VegasRefreshService(db, provider);
    await service.refresh({ manual: true });
    // Make every game stale so the next pass buys them again.
    await db.prepare("UPDATE prop_snapshots SET fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days', '-' || id || ' seconds')").run();

    const before = (await new VegasUsageRepo(db).ledger()).entities;
    const spy = vi.spyOn(PropsRepo.prototype, 'saveConsensus').mockRejectedValue(new Error('D1 is unwell'));
    try {
      const report = await service.refresh({ manual: true });
      expect(report.errors.join(' ')).toContain('D1 is unwell');
      expect(provider.billed).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }

    const after = (await new VegasUsageRepo(db).ledger()).entities;
    expect(after - before, 'every billed entity has a row').toBeGreaterThan(0);
    const fetched = (await new VegasUsageRepo(db).recent(20)).filter((r) => r.outcome === 'fetched');
    expect(fetched.length).toBeGreaterThan(0);
  });
});

describe('a discovery that fails part-way keeps what it bought', () => {
  /** SportsGameOdds events, shaped as the live API shapes them. */
  const event = (id: string, startsAt: string) => ({
    eventID: id,
    status: { startsAt },
    teams: {},
    players: {},
    odds: {},
  });

  function provider(answer: (url: string) => Response) {
    return new SportsGameOddsProvider({
      apiKey: 'k',
      pacer: null,
      fetch: (async (url: string) => answer(String(url))) as never,
    });
  }

  it('returns the earlier answers and the reason, instead of throwing them away', async () => {
    let call = 0;
    const p = provider(() => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ data: [event('A', '2026-10-11T17:00:00Z'), event('B', '2026-10-11T20:25:00Z')] }), { status: 200 });
      return new Response('boom', { status: 500 });
    });

    const result = await p.getPropsForTeams(['KC', 'DAL', 'BUF'], { maxEvents: 9 });
    expect(result.results.map((r) => r.set.eventId)).toEqual(['A', 'B']);
    // Two events were returned and billed by the one request that worked.
    expect(result.entities).toBe(2);
    expect(result.requests).toBe(1);
    expect(result.failed).toContain('HTTP 500');
  });

  it('still throws when the very first request fails, because nothing was billed to keep', async () => {
    const p = provider(() => new Response('boom', { status: 500 }));
    await expect(p.getPropsForTeams(['KC', 'DAL'], {})).rejects.toThrow('HTTP 500');
  });

  it('is unchanged by a refusal, which was never billed', async () => {
    let call = 0;
    const p = provider(() => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ data: [event('A', '2026-10-11T17:00:00Z')] }), { status: 200 })
        : new Response('slow down', { status: 429 });
    });
    const result = await p.getPropsForTeams(['KC', 'DAL', 'BUF'], {});
    expect(result.refused).toEqual(['DAL', 'BUF']);
    expect(result.failed).toBeUndefined();
    expect(result.entities).toBe(1);
  });
});
