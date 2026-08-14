/**
 * The refresh path, end to end, against a real database.
 *
 * The unit tests prove the budget arithmetic; these prove the wiring — that a
 * refresh only ever asks for the roster's own games, that it records what it
 * spent, that a hard stop actually stops it, and that stopping it leaves the
 * app serving the lines it already had rather than an error.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import type { MarketKey, RawPropSet } from '../src/core/vegas/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { SeasonMarketService } from '../src/server/services/seasonMarketService.ts';
import { VegasUsageRepo } from '../src/server/repos/vegasUsage.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';

/** A provider that counts what was asked of it, so spending is observable. */
class CountingProvider extends MockVegasProvider {
  readonly asked: string[] = [];
  readonly teamCalls: string[][] = [];

  constructor(private readonly usageEntities: number | null = 0) {
    super(MOCK_GAMES);
  }

  override async getPlayerProps(eventId: string, markets?: MarketKey[]): Promise<RawPropSet> {
    this.asked.push(eventId);
    return super.getPlayerProps(eventId, markets);
  }

  override async getPropsForTeams(
    teamIds: string[],
    opts: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number } = {},
  ) {
    this.teamCalls.push(teamIds);
    return super.getPropsForTeams(teamIds, opts);
  }

  async getAccountUsage(): Promise<unknown> {
    if (this.usageEntities == null) throw new Error('usage endpoint unavailable');
    return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': this.usageEntities } } };
  }
}

describe('a weekly refresh', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('asks only about the teams the user actually rosters', async () => {
    const provider = new CountingProvider();
    const report = await new VegasRefreshService(db, provider).refresh();

    expect(provider.teamCalls).toHaveLength(1);
    // The demo roster is four players; whatever teams they are on, the request
    // is made per team and never for the league.
    expect(provider.teamCalls[0]!.length).toBeLessThanOrEqual(4);
    expect(report.spent).toBeLessThanOrEqual(4);
    expect(report.errors).toEqual([]);
  });

  it('records what it spent, and what asked for it', async () => {
    const provider = new CountingProvider();
    await new VegasRefreshService(db, provider).refresh();

    const usage = new VegasUsageRepo(db);
    const view = await usage.view();
    expect(view.used).toBeGreaterThan(0);
    const bySource = await usage.bySource();
    expect(Object.keys(bySource)).toContain('schedule');
    const recent = await usage.recent();
    expect(recent[0]!.outcome).toBe('fetched');
  });

  it('believes the provider’s own count over its own', async () => {
    // 2,000 spent elsewhere — a probe, another deployment — and this app has
    // recorded nothing. The guard has to see 2,000.
    const provider = new CountingProvider(2000);
    const report = await new VegasRefreshService(db, provider).refresh();
    expect(report.budget.used).toBeGreaterThanOrEqual(2000);
    expect(report.budget.source).toBe('provider');
    expect(report.budget.state).toBe('conservation');
  });

  it('stops fetching once the allowance is gone, and says so', async () => {
    const provider = new CountingProvider(2500);
    const report = await new VegasRefreshService(db, provider).refresh();

    expect(provider.teamCalls).toHaveLength(0);
    expect(provider.asked).toHaveLength(0);
    expect(report.spent).toBe(0);
    expect(report.blocked.join(' ')).toContain('exhausted');
    expect(report.budget.state).toBe('hard_stop');
  });

  it('still serves the lines it already had after a hard stop', async () => {
    // The seed stored a snapshot; a blocked refresh must not remove it.
    const before = await new (await import('../src/server/repos/props.ts')).PropsRepo(db).freshness();
    await new VegasRefreshService(db, new CountingProvider(2500)).refresh();
    const after = await new (await import('../src/server/repos/props.ts')).PropsRepo(db).freshness();
    expect(after.events).toBe(before.events);
    expect(after.fetchedAt).toBe(before.fetchedAt);
  });

  it('does not spend twice on a schedule it already knows', async () => {
    const service = new VegasRefreshService(db, new CountingProvider());
    await service.refresh();
    const second = new CountingProvider();
    const report = await new VegasRefreshService(db, second).refresh();

    // The schedule is known now, so discovery does not run again…
    expect(second.teamCalls).toHaveLength(0);
    // …and the lines it just stored are fresh, so nothing is re-fetched either.
    expect(report.spent).toBe(0);
  });

  it('carries on when the provider will not say what has been spent', async () => {
    const provider = new CountingProvider(null);
    const report = await new VegasRefreshService(db, provider).refresh();
    expect(report.errors.join(' ')).toContain('could not read provider usage');
    // Not knowing is not a reason to stop: the local ledger still guards.
    expect(report.budget.source).toBe('ledger');
  });

  it('plans without spending anything when asked to preview', async () => {
    const provider = new CountingProvider();
    const preview = await new VegasRefreshService(db, provider).preview();
    expect(provider.asked).toHaveLength(0);
    expect(provider.teamCalls).toHaveLength(0);
    expect(preview.plan.estimatedEntities).toBeGreaterThanOrEqual(0);
  });
});

describe('season-long markets, on the same allowance', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('costs two entities a run, not fifty', async () => {
    // The seed already ran one, so the delta is what this measures.
    const usage = new VegasUsageRepo(db);
    const before = (await usage.bySource())['season'] ?? 0;
    await new SeasonMarketService(db, new CountingProvider()).refresh({ force: true });
    expect(((await usage.bySource())['season'] ?? 0) - before).toBe(2);
  });

  it('stops refreshing once the draft is complete', async () => {
    const leagues = new LeagueRepo(db);
    const league = await leagues.getSelectedLeague();
    const draft = await leagues.getDraft(league!.draftId!);
    await leagues.upsertDraft({ ...draft!, status: 'complete' });

    // A day later, so the stored snapshot is past its TTL and the question is
    // genuinely "should this be refreshed" rather than "is it still fresh".
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    const result = await new SeasonMarketService(db, new CountingProvider()).refresh({ now: tomorrow });
    expect(result.fetched).toBe(false);
    expect(result.reason).toContain('draft is complete');
  });

  it('is refused when the month is spent, and says why', async () => {
    await new VegasUsageRepo(db).recordProviderUsage({ entities: 2500, limit: 2500 });
    const result = await new SeasonMarketService(db, new CountingProvider(2500)).refresh({ force: true });
    expect(result.fetched).toBe(false);
    expect(result.reason).toContain('exhausted');
  });
});
