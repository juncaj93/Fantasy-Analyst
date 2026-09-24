/**
 * A refresh that respects the provider's per-minute limit, and does not book
 * what it was refused.
 *
 * From 24 September 2026. Two manual refreshes bought the schedule (nine
 * requests in a second) and then fired every planned game into the plan's ten
 * requests a minute. Seven of eight came back `rate limited` at 11:44, the
 * Patriots game among them, so its players sat on a Tuesday snapshot; and each
 * refusal was booked as an entity spent, which the provider's own counter
 * showed it never was.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { RequestPacer, SGO_REQUESTS_PER_MINUTE, SGO_WINDOW_MS } from '../src/core/vegas/pacer.ts';
import { SportsGameOddsProvider } from '../src/core/vegas/sportsGameOddsProvider.ts';
import { VegasProviderError, isRateLimited, type MarketKey, type RawPropSet } from '../src/core/vegas/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { SettingsRepo, SETTING_KEYS } from '../src/server/repos/settings.ts';
import { VegasUsageRepo } from '../src/server/repos/vegasUsage.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { MOCK_GAMES, seedDemoData } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';

/** A clock that only moves when something sleeps on it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('the pacer', () => {
  it('lets the plan’s ten a minute through at once and holds the eleventh for the window', async () => {
    const clock = fakeClock();
    const pacer = new RequestPacer({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < SGO_REQUESTS_PER_MINUTE; i++) expect(await pacer.admit()).toBe(true);
    expect(clock.slept).toEqual([]);

    expect(await pacer.admit()).toBe(true);
    expect(clock.slept).toEqual([SGO_WINDOW_MS]);
  });

  it('never has more than ten in any window, across a whole pass', async () => {
    const clock = fakeClock();
    const pacer = new RequestPacer({ now: clock.now, sleep: clock.sleep, maxWaitMs: Infinity });
    const sent: number[] = [];
    for (let i = 0; i < 25; i++) {
      await pacer.admit();
      sent.push(clock.now());
      clock.advance(150);
    }
    for (const at of sent) {
      expect(sent.filter((s) => s >= at && s < at + SGO_WINDOW_MS).length).toBeLessThanOrEqual(SGO_REQUESTS_PER_MINUTE);
    }
  });

  it('holds a request back, uncounted, rather than wait past the pass’s allowance', async () => {
    const clock = fakeClock();
    const pacer = new RequestPacer({ now: clock.now, sleep: clock.sleep, limit: 2, windowMs: 60_000, maxWaitMs: 30_000 });
    expect(await pacer.admit()).toBe(true);
    expect(await pacer.admit()).toBe(true);
    expect(await pacer.admit()).toBe(false);
    expect(clock.slept).toEqual([]);
  });
});

describe('the provider', () => {
  const EVENT = {
    eventID: 'EV1',
    type: 'match',
    status: { startsAt: '2026-09-27T17:00:00Z' },
    teams: { home: { teamID: 'KANSAS_CITY_CHIEFS_NFL' }, away: { teamID: 'MIAMI_DOLPHINS_NFL' } },
    players: {},
    odds: {},
  };

  it('waits instead of firing into the limit', async () => {
    const clock = fakeClock();
    let calls = 0;
    const provider = new SportsGameOddsProvider({
      apiKey: 'k',
      pacer: new RequestPacer({ now: clock.now, sleep: clock.sleep }),
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    const teams = ['KC', 'MIA', 'BUF', 'NYJ', 'NE', 'DAL', 'PHI', 'NYG', 'WAS', 'SF', 'SEA', 'LAR'];
    await provider.getPropsForTeams(teams);
    expect(calls).toBe(12);
    expect(clock.slept).toHaveLength(1);
  });

  it('keeps the teams answered before a refusal, and names the ones never asked', async () => {
    let calls = 0;
    const provider = new SportsGameOddsProvider({
      apiKey: 'k',
      pacer: null,
      fetch: async () => {
        calls++;
        if (calls >= 2) return new Response('slow down', { status: 429 });
        return new Response(JSON.stringify({ data: [EVENT] }), { status: 200 });
      },
    });
    const result = await provider.getPropsForTeams(['KC', 'NE', 'SEA']);
    expect(result.results.map((r) => r.teamId)).toEqual(['KC']);
    expect(result.refused).toEqual(['NE', 'SEA']);
    expect(result.requests).toBe(1);
    expect(calls).toBe(2);
  });

  it('calls a held request and a provider 429 the same thing', async () => {
    const clock = fakeClock();
    const provider = new SportsGameOddsProvider({
      apiKey: 'k',
      pacer: new RequestPacer({ now: clock.now, sleep: clock.sleep, limit: 1, maxWaitMs: 0 }),
      fetch: async () => new Response(JSON.stringify({ data: [EVENT] }), { status: 200 }),
    });
    await provider.getPlayerProps('EV1');
    const held = await provider.getPlayerProps('EV1').catch((e: unknown) => e);
    expect(isRateLimited(held)).toBe(true);
  });
});

/** Answers the schedule, then refuses every game. */
class RefusingProvider extends MockVegasProvider {
  readonly asked: string[] = [];
  private discovering = false;
  constructor(private readonly refuseDiscovery = false) {
    super(MOCK_GAMES);
  }
  override async getPlayerProps(eventId: string, markets?: MarketKey[]): Promise<RawPropSet> {
    // The mock builds its schedule answer out of this; only a per-game ask is refused.
    if (this.discovering) return super.getPlayerProps(eventId, markets);
    this.asked.push(eventId);
    throw new VegasProviderError('rate limited', this.name, 'quota', 429);
  }
  override async getPropsForTeams(
    teamIds: string[],
    opts: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number } = {},
  ) {
    if (this.refuseDiscovery) return { results: [], requests: 0, entities: 0, refused: [...teamIds] };
    this.discovering = true;
    try {
      return await super.getPropsForTeams(teamIds, opts);
    } finally {
      this.discovering = false;
    }
  }
  async getAccountUsage(): Promise<unknown> {
    return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': 0 } } };
  }
}

describe('a refresh the provider refuses', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('stops at the first refusal, books nothing for it, and says what it left', async () => {
    const provider = new RefusingProvider();
    const service = new VegasRefreshService(db, provider);
    const usage = new VegasUsageRepo(db);
    // Discovery runs and stores the schedule; the games are then stale on purpose.
    await service.refresh({ manual: true, now: Date.now() });
    const before = (await usage.view()).used;

    provider.asked.length = 0;
    const report = await service.refresh({ manual: true, now: Date.now() + 6 * 3_600_000 });

    expect(provider.asked, 'it did not fire the rest into the limit').toHaveLength(1);
    expect(report.blocked.join(' ')).toContain('left for the next pass');
    const recent = await usage.recent();
    const refusals = recent.filter((r) => r.outcome === 'refused');
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((r) => r.entities === 0)).toBe(true);
    // Discovery may have been re-bought (a manual pass skips the interval); the
    // refusals themselves added nothing on top of it.
    const discoveredSince = recent
      .filter((r) => r.outcome === 'fetched' && Date.parse(r.at) >= Date.parse(recent.at(-1)!.at))
      .reduce((a, r) => a + r.entities, 0);
    expect((await usage.view()).used).toBeLessThanOrEqual(before + discoveredSince);
  });

  it('does not stamp a discovery it was refused, so the next pass asks again', async () => {
    const settings = new SettingsRepo(db);
    const before = await settings.get<string | null>(SETTING_KEYS.lastVegasSchedule, null);
    const report = await new VegasRefreshService(db, new RefusingProvider(true)).refresh({ manual: true });

    expect(await settings.get<string | null>(SETTING_KEYS.lastVegasSchedule, null)).toBe(before);
    expect(report.blocked.join(' ')).toContain('left for the next pass');
    const refused = (await new VegasUsageRepo(db).recent()).filter((r) => r.outcome === 'refused');
    expect(refused, 'no game was asked for after the schedule was refused').toHaveLength(1);
    expect(refused[0]!.entities).toBe(0);
  });

  it('logs a refusal without counting it against the month', async () => {
    const usage = new VegasUsageRepo(db);
    const before = (await usage.view()).used;
    await usage.record({ source: 'manual', eventId: 'E', entities: 0, requests: 1, outcome: 'refused', reason: 'rate limited' });
    await usage.record({ source: 'manual', eventId: 'E', entities: 1, requests: 1, outcome: 'refused', reason: 'rate limited' });
    expect((await usage.view()).used).toBe(before);
    expect((await usage.recent())[0]!.outcome).toBe('refused');
  });
});
