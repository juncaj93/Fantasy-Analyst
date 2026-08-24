/**
 * Smart Bilateral Trades through the real service, schema and router.
 *
 * The judgements are tested without a database in `trades.bilateral.test.ts` and
 * `trades.managerFit.test.ts`. What this file pins is the wiring, and one claim
 * in particular:
 *
 * > **A Trades request adds zero Sleeper requests.**
 *
 * §20 sets the target at zero, and a target nobody measures is a wish. The
 * Sleeper client handed to the app here counts every URL it is asked for and
 * throws if anything reaches it, so the property is asserted rather than
 * reasoned about — and a future change that quietly adds a fetch to this path
 * fails here rather than in production against Cloudflare's free ceiling.
 *
 * The rest is the degradation the brief spends §18 on: a league nobody has
 * backfilled, a manager with no profile, a roster nobody has identified. None of
 * them may throw, and none of them may turn "we have not measured this" into a
 * claim about a person.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { SmartTradeService } from '../src/server/services/smartTradeService.ts';
import { ManagerLedgerRepo } from '../src/server/repos/managerLedger.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { TRADE_TENDENCY_VERSION, buildTradeTendencies } from '../src/core/managers/tradeTendencies.ts';
import type { LedgerTransaction } from '../src/core/managers/ledger.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { player } from './helpers/players.ts';
import { createTestDb } from './helpers/db.ts';

/**
 * A Sleeper client that records every request and refuses to answer one.
 *
 * Refusing rather than returning an empty body is deliberate: an empty answer
 * would let a stray fetch pass silently and only show up as a missing field
 * somewhere downstream. A throw names the offender at the call site.
 */
function forbiddenSleeper() {
  const calls: string[] = [];
  const client = new SleeperClient({
    fetch: async (url: string) => {
      calls.push(url);
      throw new Error(`Smart Trades must not call Sleeper, but asked for ${url}`);
    },
  });
  return { client, calls };
}

function makeEnv(db: NodeSqliteDatabase, sleeper: SleeperClient): AppEnv {
  return { db, sleeper, vegas: new MockVegasProvider(MOCK_GAMES), disableAuth: true };
}


/**
 * A league with two rosters that genuinely have a trade to make.
 *
 * `seedDemoData` cannot do this job: its fixture is four players against one,
 * which correctly produces no offers at all — fine for the request-counting
 * tests above, useless for anything that needs an actual offer to inspect. So
 * this writes a real league through the real repositories, with real consensus
 * props behind every player, and the engine prices it exactly as it prices
 * production.
 *
 * I am deep at receiver and missing a second running back; the partner is the
 * mirror image. The textbook bilateral trade, and the shape §22 leads with.
 */
const LEAGUE_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];

const MINE: [id: string, position: string, points: number][] = [
  ['m_qb', 'QB', 18],
  ['m_rb1', 'RB', 14],
  ['m_rb2', 'RB', 3],
  ['m_wr1', 'WR', 16],
  ['m_wr2', 'WR', 15],
  ['m_wr3', 'WR', 14],
  ['m_wr4', 'WR', 13],
  ['m_wr5', 'WR', 12],
  ['m_te', 'TE', 9],
];

const THEIRS: [id: string, position: string, points: number][] = [
  ['t_qb', 'QB', 17],
  ['t_rb1', 'RB', 15],
  ['t_rb2', 'RB', 14],
  ['t_rb3', 'RB', 13],
  ['t_rb4', 'RB', 12],
  ['t_wr1', 'WR', 4],
  ['t_wr2', 'WR', 3],
  ['t_te', 'TE', 8],
];

/** The partner's Sleeper user id, used by every history assertion below. */
const PARTNER_USER = 'partner-user';

async function seedTradingLeague(db: NodeSqliteDatabase): Promise<string> {
  const all = [...MINE, ...THEIRS];
  await new PlayerRepo(db).upsertMany(
    all.map(([id, position]) => player({ id, fullName: id.toUpperCase(), position, team: 'NE' })),
  );

  /*
   * Props at lines that convert to the points each player is specified at — the
   * same arithmetic `tests/helpers/startsit.ts` uses, run through the database
   * this time so the service reads them the way production does.
   */
  const props: PlayerProp[] = all.map(([id, position, points]) => ({
    playerId: id,
    sourcePlayerName: id.toUpperCase(),
    market: position === 'QB' ? 'pass_yards' : 'receiving_yards',
    line: position === 'QB' ? points / 0.04 : points * 10,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: null,
  }));

  const propsRepo = new PropsRepo(db);
  const fetchedAt = '2026-09-10T12:00:00.000Z';
  await propsRepo.put({
    provider: 'test',
    eventId: 'evt-1',
    gameStart: '2026-09-13T17:00:00.000Z',
    fetchedAt,
    raw: {
      provider: 'test',
      eventId: 'evt-1',
      gameStart: '2026-09-13T17:00:00.000Z',
      fetchedAt,
      quotes: [],
      raw: null,
    },
  });
  const snapshotId = await propsRepo.snapshotId('test', 'evt-1', fetchedAt);
  if (snapshotId != null) await propsRepo.saveConsensus(snapshotId, props);

  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'trade-league',
    sleeperLeagueId: 'trade-league',
    name: 'Trading League',
    season: '2026',
    totalRosters: 2,
    scoringSettings: { rec: 0.5, rec_yd: 0.1, pass_yd: 0.04, rush_yd: 0.1, pass_td: 4, rush_td: 6, rec_td: 6 },
    rosterPositions: LEAGUE_POSITIONS,
    leagueSettings: { playoff_week_start: 15 },
    draftId: null,
    lastSyncedAt: '2026-09-10T12:00:00.000Z',
  });
  await leagues.selectLeague('trade-league');
  await leagues.replaceRosters('trade-league', [
    {
      leagueId: 'trade-league',
      rosterId: 1,
      ownerId: 'me-user',
      ownerName: 'You',
      playerIds: MINE.map((p) => p[0]),
      starterIds: [],
      reserveIds: [],
      isMine: true,
      settings: null,
    },
    {
      leagueId: 'trade-league',
      rosterId: 2,
      ownerId: PARTNER_USER,
      ownerName: 'Dermot',
      playerIds: THEIRS.map((p) => p[0]),
      starterIds: [],
      reserveIds: [],
      isMine: false,
      settings: null,
    },
  ]);

  return 'trade-league';
}

describe('the free-plan promise', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('adds no Sleeper requests to a Trades page load', async () => {
    const { client, calls } = forbiddenSleeper();
    const app = createApp();
    const env = makeEnv(db, client);

    const board = await app(new Request('http://x/api/trades'), env);
    const smart = await app(new Request('http://x/api/trades/smart'), env);

    expect(board.status).toBe(200);
    expect(smart.status).toBe(200);
    // The whole point of the file, in one line.
    expect(calls).toEqual([]);
  });

  it('adds none to the diagnostics read either', async () => {
    const { client, calls } = forbiddenSleeper();
    const res = await createApp()(
      new Request('http://x/api/diagnostics/smart-trades'),
      makeEnv(db, client),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe('the board it returns', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedTradingLeague(db);
  });

  it('finds the textbook trade and explains it', async () => {
    const board = await new SmartTradeService(db).build();

    expect(board.league?.id).toBe('trade-league');
    expect(board.found).toBe(true);
    const best = board.offers[0]!;
    expect(best.user.starterGain).toBeGreaterThan(0);
    // Both sides improve: I get a running back, he gets a receiver.
    expect(best.get.some((p) => p.position === 'RB')).toBe(true);
    expect(best.give.some((p) => p.position === 'WR')).toBe(true);
    expect(best.reasons.length).toBeGreaterThan(0);
  });

  it('publishes its own search bounds, so nothing is silently truncated', async () => {
    const board = await new SmartTradeService(db).build();

    expect(board.search.bounds.offersTotal).toBeGreaterThan(0);
    expect(board.search.partners).toBe(1);
    expect(board.search.scored).toBeLessThanOrEqual(
      board.search.bounds.scoredPerPartner * Math.max(1, board.search.partners),
    );
    expect(board.offers.length).toBeLessThanOrEqual(board.search.bounds.offersTotal);
  });

  it('honours a caller-supplied limit without exceeding the engine ceiling', async () => {
    const one = await new SmartTradeService(db).build({ limit: 1 });
    expect(one.offers.length).toBeLessThanOrEqual(1);
  });

  it('carries the arithmetic beside the composite it never prints', async () => {
    /*
     * §15 permits an internal composite and forbids an unexplained one. The
     * screen does not print `score`; this asserts the payload always carries
     * the terms beside it, so a probe or a person can ask why.
     */
    const board = await new SmartTradeService(db).build();
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.breakdown.total).toBeCloseTo(offer.score, 5);
      expect(offer.reasons.length).toBeGreaterThan(0);
    }
  });

  it('keeps behaviour out of the answer when no history has been derived', async () => {
    const board = await new SmartTradeService(db).build();

    expect(board.history.profiles).toBe(0);
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.managerFit.activity).toBe('unknown');
      expect(offer.managerFit.contribution).toBe(0);
    }
    expect(board.warnings.join(' ')).toMatch(/no manager trade history/i);
  });

  it('returns a board rather than an error when no league is selected', async () => {
    const empty = await createTestDb();
    const board = await new SmartTradeService(empty).build();

    expect(board.league).toBeNull();
    expect(board.found).toBe(false);
    expect(board.offers).toEqual([]);
    expect(board.notes.join(' ')).toMatch(/no league is selected/i);
  });

  it('explains every rejection it made, by name', async () => {
    const detail = await new SmartTradeService(db).explain();
    expect(detail.rejections.length).toBeGreaterThan(0);
    for (const rejection of detail.rejections) {
      expect(rejection.reason).toBeTruthy();
      expect(rejection.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('reading the stored history', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedTradingLeague(db);
  });

  /** Store a derived trade profile exactly as `ManagerIntelService.derive` does. */
  async function storeProfile(leagueId: string, userId: string, trades: number, seasons: string[]) {
    const transactions: LedgerTransaction[] = Array.from({ length: trades }, (_, i) => ({
      transactionId: `t${i}`,
      season: seasons[i % seasons.length]!,
      week: 4,
      type: 'trade',
      status: 'complete',
      createdAtMs: null,
      userIds: [userId, 'other'],
      rosterIds: [1, 2],
      creatorUserId: userId,
      addsByUser: new Map([[userId, [`a${i}`]], ['other', [`b${i}`]]]),
      dropsByUser: new Map([[userId, [`b${i}`]], ['other', [`a${i}`]]]),
      waiverBid: null,
      faabTraded: 0,
      draftPicksMoved: 0,
    }));

    const tendencies = buildTradeTendencies({
      transactions,
      seasonsByUser: new Map([[userId, seasons], ['other', seasons]]),
      positionOf: () => 'RB',
      latestSeason: seasons.at(-1)!,
    });

    const profile = tendencies.get(userId)!;
    await new ManagerLedgerRepo(db).saveProfile(leagueId, 'trade', {
      userId,
      displayName: null,
      sample: profile.sample,
      usable: profile.usable,
      seasons: profile.seasons,
      coverage: {},
      profile,
      version: TRADE_TENDENCY_VERSION,
      derivedAt: '',
    });
  }

  /** Mark a season's transaction walk finished, the way the backfill does. */
  async function settleSeason(leagueId: string, season: string, rosterId: number, userId: string) {
    const ledger = new ManagerLedgerRepo(db);
    await ledger.saveRosterIdentities(leagueId, [
      { sleeperLeagueId: `L${season}`, season, rosterId, userId, displayName: null, teamName: null },
    ]);
    await ledger.recordSuccess({
      leagueId,
      dataset: 'transactions',
      sleeperLeagueId: `L${season}`,
      season,
      cursor: null,
      completed: true,
      requestsUsed: 1,
    });
  }

  it('treats a stored profile whose seasons are unsettled as provisional', async () => {
    /*
     * The exact production shape of §10's failure mode: a profile exists, so the
     * naive reading is "we know this manager". No season of his has been read to
     * the end, so we do not — and the confidence must be halved and the fit
     * marked uncertain rather than applied at full strength.
     */
    await storeProfile('trade-league', PARTNER_USER, 8, ['2024', '2025']);

    const board = await new SmartTradeService(db).build();
    expect(board.history.profiles).toBe(1);
    expect(board.history.seasonsComplete).toEqual([]);
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.managerFit.evidence.historyComplete).toBe(false);
      expect(offer.managerFit.uncertain).toBe(true);
    }
  });

  it('counts a season as observed once its transaction walk is checkpointed complete', async () => {
    await storeProfile('trade-league', PARTNER_USER, 8, ['2024', '2025']);
    await settleSeason('trade-league', '2024', 2, PARTNER_USER);
    await settleSeason('trade-league', '2025', 2, PARTNER_USER);

    const board = await new SmartTradeService(db).build();
    expect(board.history.seasonsComplete).toEqual(['2024', '2025']);
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.managerFit.evidence.seasonsObserved).toBe(2);
      expect(offer.managerFit.activity).toBe('active');
      expect(offer.managerFit.contribution).toBeGreaterThan(0);
    }
  });

  it('reads a manager with settled seasons and no profile as a measured non-trader', async () => {
    /*
     * The other half of §10, and the one no single table can answer: no trade
     * profile exists for him, and two seasons of his have been read to the end.
     * That is a measurement of a quiet manager, not an absence of evidence — and
     * it must lower his rank rather than leave him neutral.
     */
    await settleSeason('trade-league', '2024', 2, PARTNER_USER);
    await settleSeason('trade-league', '2025', 2, PARTNER_USER);

    const board = await new SmartTradeService(db).build();
    expect(board.history.profiles).toBe(0);
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.managerFit.activity).toBe('effectively_inactive');
      expect(offer.managerFit.contribution).toBeLessThan(0);
      expect(offer.caveats.join(' ')).toMatch(/rarely trades/i);
    }
  });

  it('leaves a manager with one settled season unknown rather than inactive', async () => {
    await settleSeason('trade-league', '2025', 2, PARTNER_USER);

    const board = await new SmartTradeService(db).build();
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.managerFit.evidence.seasonsObserved).toBe(1);
      expect(offer.managerFit.activity).toBe('unknown');
      expect(offer.managerFit.contribution).toBe(0);
    }
  });
});
