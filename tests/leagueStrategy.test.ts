/**
 * The strategy layer end to end: storage, the service, and the routes.
 *
 * Everything here runs against the real schema and the real router. The
 * judgements are tested without a database in `faab.test.ts`, `trending.test.ts`
 * and the rest; what these tests pin is the wiring — that a settled week is
 * fetched once, that a capture two minutes after the last one is not treated as
 * a velocity measurement, and that a league with no FAAB gets an honest
 * sentence rather than a dollar figure.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { LeagueStrategyService, readFinalWeek } from '../src/server/services/leagueStrategyService.ts';
import { TransactionRepo } from '../src/server/repos/transactions.ts';
import { TrendingRepo } from '../src/server/repos/trending.ts';
import { ManagerProfileRepo } from '../src/server/repos/managerProfiles.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import type { SleeperTransaction } from '../src/core/sleeper/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

function waiver(over: Partial<SleeperTransaction> = {}): SleeperTransaction {
  return {
    transaction_id: 'w1',
    type: 'waiver',
    status: 'complete',
    leg: 3,
    roster_ids: [2],
    adds: { '1005': 2 },
    settings: { waiver_bid: 14 },
    ...over,
  };
}

/**
 * A Sleeper client that answers from a script and counts what was asked.
 *
 * The count is the point: the "a settled week is fetched once" test is a
 * statement about request volume, and it can only be made by a stub that
 * remembers.
 */
function stubSleeper(script: {
  transactions?: Record<number, SleeperTransaction[]>;
  trending?: { player_id: string; count: number }[];
}) {
  const calls: string[] = [];
  const client = new SleeperClient({
    fetch: async (url: string) => {
      calls.push(url);
      const txnMatch = /\/transactions\/(\d+)$/.exec(url);
      if (txnMatch) {
        return new Response(JSON.stringify(script.transactions?.[Number(txnMatch[1])] ?? []), { status: 200 });
      }
      if (url.includes('/trending/')) {
        return new Response(JSON.stringify(script.trending ?? []), { status: 200 });
      }
      return new Response('null', { status: 200 });
    },
  });
  return { client, calls };
}

function makeEnv(db: NodeSqliteDatabase, sleeper: SleeperClient): AppEnv {
  return {
    db,
    sleeper,
    vegas: new MockVegasProvider(MOCK_GAMES),
    disableAuth: true,
  };
}

describe('transaction storage', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('marks a finished week settled and never fetches it again', async () => {
    const { client, calls } = stubSleeper({ transactions: { 1: [waiver({ leg: 1 })], 2: [], 3: [waiver({ leg: 3 })] } });
    const service = new LeagueStrategyService(db, { sleeper: client });

    const first = await service.syncTransactions({
      leagueId: 'demo-league',
      sleeperLeagueId: 'demo-league',
      season: '2026',
      week: 3,
    });
    expect(first.weeksFetched.sort()).toEqual([1, 2, 3]);

    calls.length = 0;
    const second = await service.syncTransactions({
      leagueId: 'demo-league',
      sleeperLeagueId: 'demo-league',
      season: '2026',
      week: 3,
    });
    // Weeks 1 and 2 are over and can never change; week 3 still can.
    expect(second.weeksFetched).toEqual([3]);
    expect(calls).toHaveLength(1);
  });

  it('bounds how many weeks one refresh may fetch, newest first', async () => {
    const { client } = stubSleeper({});
    const result = await new LeagueStrategyService(db, { sleeper: client }).syncTransactions({
      leagueId: 'demo-league',
      sleeperLeagueId: 'demo-league',
      season: '2026',
      week: 14,
      maxWeeks: 3,
    });
    expect(result.weeksFetched).toEqual([14, 13, 12]);
  });

  it('lets a pending claim become complete rather than freezing it', async () => {
    const repo = new TransactionRepo(db);
    await repo.saveWeek({
      leagueId: 'demo-league',
      season: '2026',
      week: 3,
      transactions: [waiver({ status: 'pending', settings: {} })],
      settled: false,
    });
    await repo.saveWeek({
      leagueId: 'demo-league',
      season: '2026',
      week: 3,
      transactions: [waiver({ status: 'complete', settings: { waiver_bid: 14 } })],
      settled: true,
    });
    const stored = await repo.list('demo-league', { season: '2026' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('complete');
  });

  it('tells "nobody claimed anybody" apart from "we have not looked"', async () => {
    const repo = new TransactionRepo(db);
    await repo.saveWeek({ leagueId: 'demo-league', season: '2026', week: 2, transactions: [], settled: true });
    const weeks = await repo.weeksRead('demo-league', '2026');
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.transactionsSeen).toBe(0);
    expect(await repo.weeksToFetch({ leagueId: 'demo-league', season: '2026', throughWeek: 2 })).toEqual([1]);
  });
});

describe('trending storage', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('refuses to compare two captures taken minutes apart', async () => {
    const repo = new TrendingRepo(db);
    await repo.save({
      capturedAt: '2026-09-10T12:00:00.000Z',
      type: 'add',
      lookbackHours: 24,
      rows: [{ playerId: 'a', rank: 1, count: 240 }],
    });
    await repo.save({
      capturedAt: '2026-09-10T12:20:00.000Z',
      type: 'add',
      lookbackHours: 24,
      rows: [{ playerId: 'a', rank: 1, count: 250 }],
    });
    const current = (await repo.capture('add'))!;
    expect(current.capturedAt).toBe('2026-09-10T12:20:00.000Z');
    // Twenty minutes apart is twenty minutes of a twenty-four-hour window.
    expect(await repo.comparablePrevious(current)).toBeNull();
  });

  it('finds a capture a full window back', async () => {
    const repo = new TrendingRepo(db);
    await repo.save({
      capturedAt: '2026-09-09T12:00:00.000Z',
      type: 'add',
      lookbackHours: 24,
      rows: [{ playerId: 'a', rank: 2, count: 240 }],
    });
    await repo.save({
      capturedAt: '2026-09-10T12:00:00.000Z',
      type: 'add',
      lookbackHours: 24,
      rows: [{ playerId: 'a', rank: 1, count: 1440 }],
    });
    const current = (await repo.capture('add'))!;
    const previous = await repo.comparablePrevious(current);
    expect(previous?.capturedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('prunes captures beyond the retention window', async () => {
    const repo = new TrendingRepo(db);
    await repo.save({
      capturedAt: '2026-08-01T12:00:00.000Z',
      type: 'add',
      lookbackHours: 24,
      rows: [{ playerId: 'a', rank: 1, count: 1 }],
    });
    expect(await repo.prune(14, new Date('2026-09-10T12:00:00.000Z'))).toBe(1);
    expect((await repo.coverage('add')).captures).toBe(0);
  });
});

describe('manager profile cache', () => {
  it('keeps the sample size out of the JSON so it can be checked cheaply', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const repo = new ManagerProfileRepo(db);
    await repo.saveTradeProfile('demo-league', {
      rosterId: 2,
      ownerName: 'Rival',
      sample: 2,
      minSample: 4,
      confident: false,
      initiationRate: null,
      tradesPerSeason: null,
      prefersConsolidation: false,
      tradesPicks: false,
      tradesFaab: false,
      acquiresPositions: [],
      sendsPositions: [],
      negotiation: 'unknown',
      notes: ['Only 2 completed trade(s) on record.'],
      seasonsObserved: ['2025'],
    });
    const cached = (await repo.tradeProfiles('demo-league')).get(2);
    expect(cached?.sample).toBe(2);
    expect(cached?.confident).toBe(false);
    expect(cached?.stale).toBe(false);
    expect(cached?.profile.notes[0]).toContain('Only 2 completed trade(s)');
  });
});

describe('season bounds', () => {
  it('reads the last useful waiver week from the playoff start', () => {
    expect(readFinalWeek({ playoff_week_start: 15 })).toBe(14);
    expect(readFinalWeek({ playoff_week_start: 16 })).toBe(15);
  });

  it('falls back rather than going silent when the league does not say', () => {
    expect(readFinalWeek({})).toBe(14);
    expect(readFinalWeek(null)).toBe(14);
    expect(readFinalWeek({ playoff_week_start: 'nonsense' })).toBe(14);
  });
});

describe('strategy routes', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', week: 5, season_type: 'regular' });
    env = makeEnv(db, stubSleeper({ transactions: { 5: [waiver({ leg: 5 })] }, trending: [{ player_id: '1005', count: 4800 }] }).client);
    app = createApp();
  });

  it('prices waiver upgrades against the league’s own budget', async () => {
    await app(new Request('https://app.test/api/leagues/demo-league/strategy/refresh', { method: 'POST' }), env);
    const res = await app(new Request('https://app.test/api/leagues/demo-league/waivers'), env);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body['faab']).not.toBeNull();
    expect(body['faab'].rule.usesFaab).toBe(true);
    expect(body['faab'].rule.total).toBe(100);
    // Seeded spend of $35 out of $100.
    expect(body['faab'].mine.remaining).toBe(65);
  });

  it('says plainly that a priority league has no bid advice', async () => {
    const leagues = new LeagueRepo(db);
    const league = (await leagues.getLeague('demo-league'))!;
    await leagues.upsertLeague({ ...league, leagueSettings: { waiver_type: 0 } });

    const res = await app(new Request('https://app.test/api/leagues/demo-league/waivers'), env);
    const body = (await res.json()) as Record<string, any>;
    expect(body['faab'].rule.usesFaab).toBe(false);
    expect(body['faab'].notes.join(' ')).toContain('does not use FAAB');
    for (const bid of body['faab'].bids) expect(bid.recommended).toBeNull();
  });

  it('serves manager profiles, empty until they are built', async () => {
    const res = await app(new Request('https://app.test/api/leagues/demo-league/managers'), env);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body['managers']).toHaveLength(2);
    expect(body['managers'][0].trade).toBeNull();
    expect(body['room']).toBeNull();
  });

  it('values the bench and never offers a starter as a drop', async () => {
    const res = await app(new Request('https://app.test/api/leagues/demo-league/bench'), env);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body['found']).toBe(true);
    const starters = ['1001', '1004'];
    for (const candidate of body['dropCandidates']) expect(starters).not.toContain(candidate.playerId);
  });

  it('rate limits the strategy refresh like every other manual refresh', async () => {
    const results: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app(
        new Request('https://app.test/api/leagues/demo-league/strategy/refresh', { method: 'POST' }),
        env,
      );
      results.push(res.status);
    }
    expect(results).toContain(429);
  });

  it('404s a league that does not exist rather than inventing one', async () => {
    const res = await app(new Request('https://app.test/api/leagues/nope/bench'), env);
    expect(res.status).toBe(404);
  });

  it('builds a trade ladder in order for a player somebody else holds', async () => {
    // '1002' sits on the rival roster in the demo league.
    const res = await app(new Request('https://app.test/api/leagues/demo-league/trades/ladder?playerId=1002'), env);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    if (!body['found']) {
      // A blocked ladder is a valid outcome and says why.
      expect(body['reason']).toBeTruthy();
      return;
    }
    const ladder = body['ladder'];
    expect(ladder.advisory).toBe('never auto-sent');
    if (!ladder.blocked) {
      expect(ladder.opening).toBeLessThanOrEqual(ladder.fair.low);
      expect(ladder.fair.low).toBeLessThanOrEqual(ladder.fair.high);
      expect(ladder.fair.high).toBeLessThanOrEqual(ladder.doNotExceed);
    }
  });

  it('calls an unrostered player an add rather than a trade', async () => {
    const res = await app(new Request('https://app.test/api/leagues/demo-league/trades/ladder?playerId=1005'), env);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body['found']).toBe(false);
    expect(body['reason']).toContain('an add, not a trade');
  });

  it('requires a target rather than guessing one', async () => {
    const res = await app(new Request('https://app.test/api/leagues/demo-league/trades/ladder'), env);
    expect(res.status).toBe(400);
  });

  it('carries the role assessment on a waiver candidate, so pricing need not read prose', async () => {
    /*
     * The coupling this replaced: the bid strategy used to infer role stability
     * by string-matching the candidate's reason phrases, which put a bid one
     * rewording away from silently changing.
     */
    const res = await app(new Request('https://app.test/api/leagues/demo-league/waivers'), env);
    const body = (await res.json()) as Record<string, any>;
    for (const upgrade of body['upgrades']) {
      for (const candidate of upgrade.candidates) {
        expect(candidate.role).toBeDefined();
        expect(typeof candidate.role.trend).toBe('string');
        expect(typeof candidate.role.games).toBe('number');
      }
    }
  });
});

describe('player detail additions', () => {
  it('carries the takeaway and the profile block, both inert by construction', async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    const app = createApp();
    const env = makeEnv(db, stubSleeper({}).client);

    const res = await app(new Request('https://app.test/api/players/1001/detail'), env);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('newsletterTakeaway');
    expect(body['profile'].scoreDelta).toBe(0);
    // No measurement in the demo dictionary, so no physical flag can fire, so
    // nothing is displayed — which is the rule, not an accident of the fixture.
    expect(body['profile'].showMeasurements).toBe(false);
    expect(body['profile'].heightInches).toBeNull();
    for (const flag of body['profile'].flags) expect(flag.weight).toBe('context');
  });
});
