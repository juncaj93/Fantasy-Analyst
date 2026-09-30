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
import { PropsRepo } from '../src/server/repos/props.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { VegasEventsRepo } from '../src/server/repos/vegasEvents.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';

/** A provider with no games on offer, as before the books post a week. */
class EmptyProvider extends MockVegasProvider {
  constructor() {
    super([]);
  }
}

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
    /*
     * The demo roster is five: four skill players and the defence the league
     * starts. Whatever teams they are on, the ask is made **per team and never
     * for the league**, which is the invariant this test is really about — the
     * bound tracks the fixture's roster and the shape of the request does not.
     *
     * The defence costs one team fetch like anybody else, and it has to: a
     * defence's whole projection is the game's total and spread, and those
     * arrive in the same answer as the props. That is a cost on the refresh
     * path, which is metered and scheduled — not on a recommendation read,
     * which still buys nothing at all.
     */
    expect(provider.teamCalls[0]!.length).toBeLessThanOrEqual(5);
    expect(report.spent).toBeLessThanOrEqual(5);
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

  /**
   * The discovery interval is a politeness rule, and a person may skip it —
   * but only to learn a schedule the app does not have.
   *
   * `lastVegasSchedule` is stamped *before* the provider is called, so a
   * discovery that came back with nothing locks the clock out of re-asking for
   * three days. A person looking at a stale screen may go past that. What they
   * may not do is re-buy the games already on file, which is what every manual
   * refresh did until 30 September 2026: 155 of the 195 entities seventeen
   * manual refreshes spent that month were the same nine games bought again.
   */
  it('lets a person re-ask for a schedule that is genuinely unknown', async () => {
    const t0 = Date.now();
    // The first look finds nothing: the books have not posted the week.
    await new VegasRefreshService(db, new EmptyProvider()).refresh({ now: t0 });

    const scheduled = new CountingProvider();
    await new VegasRefreshService(db, scheduled).refresh({ now: t0 + 3_600_000 });
    expect(scheduled.teamCalls, 'a scheduled pass still waits out the interval').toHaveLength(0);

    const soon = new CountingProvider();
    await new VegasRefreshService(db, soon).refresh({ manual: true, now: t0 + 3_600_000 });
    expect(soon.teamCalls, 'an hour later, the same empty answer is not bought again').toHaveLength(0);

    const later = new CountingProvider();
    await new VegasRefreshService(db, later).refresh({ manual: true, now: t0 + 7 * 3_600_000 });
    expect(later.teamCalls, 'a person asking later gets a fresh discovery').toHaveLength(1);
  });

  it('does not re-buy the week on a second manual refresh', async () => {
    const first = new CountingProvider();
    await new VegasRefreshService(db, first).refresh({ manual: true });
    expect(first.teamCalls).toHaveLength(1);

    const second = new CountingProvider();
    const report = await new VegasRefreshService(db, second).refresh({ manual: true });
    expect(second.teamCalls, 'every roster team is either scheduled or known to have nothing').toHaveLength(0);
    expect(report.discovered).toBe(0);

    const ledger = await new VegasUsageRepo(db).recent(50);
    expect(ledger.filter((r) => r.source === 'schedule' && r.outcome === 'fetched')).toHaveLength(1);
  });

  it('files a game two roster teams share under both of them', async () => {
    // KC and DAL both have a demo player in demo-game-1.
    await new VegasRefreshService(db, new CountingProvider()).refresh({ manual: true });
    const row = (await new VegasEventsRepo(db).forEvents(['demo-game-1'])).get('demo-game-1');
    expect([row?.homeTeam, row?.awayTeam].sort()).toEqual(['DAL', 'KC']);
  });

  it('does not ask about a team the schedule says is on a bye', async () => {
    const now = Date.now();
    const week = (team: string, w: number, opponent: string | null, days: number | null) => ({
      season: '2026',
      week: w,
      team,
      opponent,
      home: true,
      kickoff: days == null ? null : new Date(now + days * 86_400_000).toISOString(),
      roof: null,
    });
    await new NflScheduleRepo(db).save(
      [week('KC', 4, 'CIN', 3), week('DET', 4, null, null), week('DET', 5, 'GB', 10)],
      new Date(now).toISOString(),
    );

    const provider = new CountingProvider();
    await new VegasRefreshService(db, provider).refresh({ manual: true, now });
    expect(provider.teamCalls).toHaveLength(1);
    expect(provider.teamCalls[0]).not.toContain('DET');
    // No schedule stored for NYJ: not knowing is a reason to ask, as before.
    expect(provider.teamCalls[0]).toContain('NYJ');
  });

  /**
   * And it skips the interval, never the ceiling.
   *
   * The one way this change could have been wrong: a manual refresh that also
   * walked past `canSpend` would let a frustrated owner tapping a button spend
   * a month's allowance in an afternoon. The budget is the invariant; the
   * interval is a courtesy.
   */
  it('still refuses a person when the month’s allowance is gone', async () => {
    const provider = new CountingProvider(2500);
    const report = await new VegasRefreshService(db, provider).refresh({ manual: true });

    expect(provider.teamCalls).toHaveLength(0);
    expect(provider.asked).toHaveLength(0);
    expect(report.spent).toBe(0);
    expect(report.budget.state).toBe('hard_stop');
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

describe('how old a player\'s lines are', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  /*
   * His own game's age, not the newest purchase anywhere.
   *
   * On 24 September 2026 production held a Patriots snapshot from Tuesday,
   * bought before most of its board was posted, and never bought it again:
   * every player's age was read off the newest snapshot of *any* game, so one
   * purchase for another fixture made the Patriots look minutes old.
   */
  it('ages each game on its own, so a stale game is planned again', async () => {
    const service = new VegasRefreshService(db, new CountingProvider());
    await service.refresh();

    const before = await service.preview();
    const priced = before.players.filter((p) => p.eventId != null && p.ageMinutes != null);
    expect(priced.length, 'the fixture needs a priced game').toBeGreaterThan(0);
    const staleEvent = priced[0]!.eventId!;

    /* His game was last bought three days ago… */
    await db
      .prepare(
        // A second apart per row: (provider, event, fetched_at) is unique.
        "UPDATE prop_snapshots SET fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days', '-' || id || ' seconds') " +
          "WHERE event_id = ? AND scope = 'week'",
      )
      .bind(staleEvent)
      .run();
    /* …and some other game was bought a minute ago. */
    await new PropsRepo(db).put({
      provider: 'mock',
      eventId: 'another-game',
      gameStart: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      raw: { provider: 'mock', eventId: 'another-game', gameStart: '', fetchedAt: '', quotes: [] } as never,
    });

    const after = await service.preview();
    const aged = after.players.filter((p) => p.eventId === staleEvent && p.ageMinutes != null);
    expect(aged.length).toBeGreaterThan(0);
    for (const p of aged) expect(p.ageMinutes!).toBeGreaterThan(3 * 1440 - 5);
    expect(after.plan.events.map((e) => e.eventId)).toContain(staleEvent);
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
