/**
 * Season-long market expectations: normalisation, identity, storage, and the
 * modest effect they are allowed to have on a draft board.
 *
 * The provider the app is configured for publishes no season-long NFL markets
 * today — that is established against the live API by
 * `scripts/probe-sgo-season-markets.mjs` and `probe-sgo-market-catalogue.mjs`,
 * and asserted here against the adapter. Everything downstream is therefore
 * exercised with the deterministic mock, which is the same code path a real
 * provider would take the day it starts publishing them.
 */

import { describe, expect, it } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { SportsGameOddsProvider } from '../src/core/vegas/sportsGameOddsProvider.ts';
import {
  marketExpectationScore,
  resolveSeasonMarkets,
  seasonBaseline,
  seasonHeadline,
} from '../src/core/vegas/season.ts';
import { SEASON_MARKET_KEYS } from '../src/core/vegas/types.ts';
import { PlayerIndex } from '../src/core/identity/index.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SeasonMarketsRepo } from '../src/server/repos/seasonMarkets.ts';
import { SeasonMarketService, seasonFor } from '../src/server/services/seasonMarketService.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const FULL_PPR = buildScoringProfile({ rec: 1, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

const WR = player({ id: 'wr1', fullName: 'Field Stretcher', position: 'WR', team: 'CIN' });

describe('season baseline', () => {
  it('converts market lines into this league’s points', () => {
    const baseline = seasonBaseline(
      'WR',
      [
        { market: 'season_receiving_yards', line: 1085 },
        { market: 'season_receptions', line: 84 },
        { market: 'season_receiving_tds', line: 7.5 },
      ],
      HALF_PPR,
    );
    // 1085 × 0.1 + 84 × 0.5 + 7.5 × 6
    expect(baseline.points).toBeCloseTo(108.5 + 42 + 45, 2);
    expect(baseline.coverage).toBe(1);
    expect(baseline.missing).toEqual([]);
    expect(baseline.note).toContain('complete');
  });

  it('uses the league’s own scoring, not a default', () => {
    const markets = [{ market: 'season_receptions' as const, line: 100 }];
    const half = seasonBaseline('WR', markets, HALF_PPR).points!;
    const full = seasonBaseline('WR', markets, FULL_PPR).points!;
    expect(full).toBeCloseTo(half * 2, 5);
  });

  it('pays a tight-end premium when the league has one', () => {
    const premium = buildScoringProfile({ rec: 0.5, bonus_rec_te: 0.5 }, []);
    const markets = [{ market: 'season_receptions' as const, line: 80 }];
    expect(seasonBaseline('TE', markets, premium).points).toBeCloseTo(80, 5);
    expect(seasonBaseline('WR', markets, premium).points).toBeCloseTo(40, 5);
  });

  /** The rule that matters most: a missing market is unknown, never zero. */
  it('reports partial coverage instead of assuming the rest is zero', () => {
    const baseline = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 900 }], HALF_PPR);
    expect(baseline.points).toBeCloseTo(90, 5);
    expect(baseline.coverage).toBeLessThan(1);
    expect(baseline.missing).toContain('season_receptions');
    expect(baseline.note).toContain('partial');
    expect(baseline.note).toContain('no market for');
  });

  it('says nothing at all when nothing is priced', () => {
    const baseline = seasonBaseline('WR', [], HALF_PPR);
    expect(baseline.points).toBeNull();
    expect(baseline.coverage).toBe(0);
    expect(baseline.note).toContain('no season market');
  });

  it('ignores a market with no line rather than treating it as zero', () => {
    const baseline = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: null }], HALF_PPR);
    expect(baseline.points).toBeNull();
  });
});

describe('the one line a card shows', () => {
  it('gives a quarterback all four of his, in reading order', () => {
    expect(
      seasonHeadline('QB', [
        { market: 'season_rush_tds', line: 3.5 },
        { market: 'season_pass_tds', line: 29.5 },
        { market: 'season_rush_yards', line: 385 },
        { market: 'season_pass_yards', line: 4050 },
      ]),
    ).toBe('4,050 pass yd · 29.5 pass TD · 385 rush yd · 3.5 rush TD');
  });

  it('combines a runner’s two halves into scrimmage yards and touchdowns', () => {
    expect(
      seasonHeadline('RB', [
        { market: 'season_rush_yards', line: 1020 },
        { market: 'season_receiving_yards', line: 420 },
        { market: 'season_rush_tds', line: 8.5 },
        { market: 'season_receiving_tds', line: 2 },
      ]),
    ).toBe('1,440 scrim yd · 10.5 TD');
  });

  it('shows one when only one exists, and nothing when none do', () => {
    expect(seasonHeadline('RB', [{ market: 'season_rush_yards', line: 1020 }])).toBe('1,020 rush yd');
    expect(seasonHeadline('RB', [])).toBeNull();
    // Receptions are not part of a receiver's summary, but a priced player
    // still gets a line — see marketProps.test.ts for why.
    expect(seasonHeadline('WR', [{ market: 'season_receptions', line: 84 }])).toBe('84 rec');
  });
});

describe('identity', () => {
  const index = new PlayerIndex([WR, player({ id: 'rb1', fullName: 'Lead Back', position: 'RB', team: 'KC' })]);

  it('resolves provider names through the app’s own identity ladder', () => {
    const [market] = resolveSeasonMarkets(
      [
        {
          playerName: 'Field Stretcher',
          market: 'season_receiving_yards',
          line: 1085,
          overPrice: -110,
          underPrice: -110,
          book: 'mock',
        },
      ],
      index,
    );
    expect(market!.playerId).toBe('wr1');
  });

  it('never guesses a player it cannot resolve', () => {
    const [market] = resolveSeasonMarkets(
      [
        {
          playerName: 'Somebody Nobodyknows',
          market: 'season_receiving_yards',
          line: 900,
          overPrice: null,
          underPrice: null,
          book: 'mock',
        },
      ],
      index,
    );
    expect(market!.playerId).toBeNull();
    // Kept, so it can be audited and repaired rather than silently dropped.
    expect(market!.sourcePlayerName).toBe('Somebody Nobodyknows');
  });

  it('takes the median when several books quote the same market', () => {
    const quotes = [1000, 1100, 1200].map((line) => ({
      playerName: 'Field Stretcher',
      market: 'season_receiving_yards' as const,
      line,
      overPrice: null,
      underPrice: null,
      book: `book-${line}`,
    }));
    const [market] = resolveSeasonMarkets(quotes, index);
    expect(market!.line).toBe(1100);
    expect(market!.bookCount).toBe(3);
  });
});

describe('SportsGameOdds season markets', () => {
  /**
   * The provider's own market catalogue lists 148 active NFL markets across
   * periods game / 1h / 2h / 1q–4q / reg, and no season period at all. The
   * adapter must report that as an empty set with a reason, not as an error and
   * certainly not as numbers.
   */
  it('reports honestly that the provider has no season-long markets', async () => {
    const provider = new SportsGameOddsProvider({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const set = await provider.getSeasonPlayerMarkets('2026');
    expect(set.quotes).toEqual([]);
    expect(set.note).toContain('no season-long NFL player markets');
    expect(set.provider).toBe('sportsgameodds');
  });

  /** A game line must never be read as a season total. */
  it('ignores a game-period quote even when the stat matches', async () => {
    const event = {
      eventID: 'evt1',
      players: { P1: { playerID: 'P1', name: 'Field Stretcher' } },
      odds: {
        a: {
          statID: 'receiving_yards',
          periodID: 'game',
          betTypeID: 'ou',
          sideID: 'over',
          playerID: 'P1',
          bookOverUnder: '34.5',
        },
        b: {
          statID: 'receiving_yards',
          periodID: 'reg',
          betTypeID: 'ou',
          sideID: 'over',
          playerID: 'P1',
          bookOverUnder: '38.5',
        },
      },
    };
    const provider = new SportsGameOddsProvider({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ success: true, data: [event] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const set = await provider.getSeasonPlayerMarkets('2026');
    expect(set.quotes).toEqual([]);
  });

  it('parses a season-period quote if one ever appears', async () => {
    const event = {
      eventID: 'evt-season',
      players: { P1: { playerID: 'P1', name: 'Field Stretcher' } },
      odds: {
        a: {
          statID: 'receiving_yards',
          periodID: 'season',
          betTypeID: 'ou',
          sideID: 'over',
          playerID: 'P1',
          bookOverUnder: '1085.5',
          bookOdds: '-110',
        },
        // The under side of the same market must not become a second quote.
        b: {
          statID: 'receiving_yards',
          periodID: 'season',
          betTypeID: 'ou',
          sideID: 'under',
          playerID: 'P1',
          bookOverUnder: '1085.5',
        },
      },
    };
    const provider = new SportsGameOddsProvider({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ success: true, data: [event] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const set = await provider.getSeasonPlayerMarkets('2026');
    // Both requests return the same event, so it is seen twice; the quote is
    // the same line either way and de-duplicates on resolution.
    expect(set.quotes.length).toBeGreaterThan(0);
    expect(set.quotes[0]).toMatchObject({
      playerName: 'Field Stretcher',
      market: 'season_receiving_yards',
      line: 1085.5,
    });
    expect(set.note).toBeNull();
  });
});

describe('storage and refresh', () => {
  async function seeded() {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany([WR]);
    return db;
  }

  const games = [
    {
      eventId: 'g1',
      startTime: new Date().toISOString(),
      homeTeam: 'CIN',
      awayTeam: 'KC',
      players: [{ name: 'Field Stretcher', position: 'WR', team: 'CIN' }],
    },
  ];

  it('stores a snapshot with its resolved lines and reads them back', async () => {
    const db = await seeded();
    const service = new SeasonMarketService(db, new MockVegasProvider(games));
    const result = await service.refresh({ force: true });

    expect(result.fetched).toBe(true);
    expect(result.quotes).toBeGreaterThan(0);
    expect(result.players).toBe(1);
    expect(result.unresolved).toBe(0);

    const lines = await service.linesFor(['wr1']);
    const markets = (lines.get('wr1') ?? []).map((m) => m.market);
    expect(markets).toContain('season_receiving_yards');
  });

  it('is idempotent: the same fetch does not double the stored rows', async () => {
    const db = await seeded();
    const repo = new SeasonMarketsRepo(db);
    const set = {
      provider: 'mock',
      season: '2026',
      fetchedAt: '2026-08-01T00:00:00.000Z',
      quotes: [],
      note: null,
      raw: {},
    };
    const rows = [
      {
        playerId: 'wr1',
        sourcePlayerName: 'Field Stretcher',
        market: 'season_receiving_yards' as const,
        line: 1085,
        book: 'mock',
        bookCount: 1,
      },
    ];
    const first = await repo.saveSnapshot(set, rows);
    const second = await repo.saveSnapshot(set, rows);
    expect(second).toBe(first);
    expect((await repo.coverage('2026')).quotes).toBe(1);
  });

  it('keeps every snapshot, so a line’s movement stays available', async () => {
    const db = await seeded();
    const repo = new SeasonMarketsRepo(db);
    const base = { provider: 'mock', season: '2026', quotes: [], note: null, raw: {} };
    const row = (line: number) => [
      {
        playerId: 'wr1',
        sourcePlayerName: 'Field Stretcher',
        market: 'season_receiving_yards' as const,
        line,
        book: 'mock',
        bookCount: 1,
      },
    ];
    await repo.saveSnapshot({ ...base, fetchedAt: '2026-07-01T00:00:00.000Z' }, row(950));
    await repo.saveSnapshot({ ...base, fetchedAt: '2026-08-01T00:00:00.000Z' }, row(1085));

    const snapshots = await db
      .prepare("SELECT COUNT(*) AS n FROM prop_snapshots WHERE scope = 'season'")
      .first<{ n: number }>();
    expect(Number(snapshots!.n)).toBe(2);
    // …and the newest is what is read.
    const latest = await repo.latestForPlayers('2026', ['wr1']);
    expect(latest.get('wr1')![0]!.line).toBe(1085);
  });

  it('serves the stored snapshot rather than refetching inside the TTL', async () => {
    const db = await seeded();
    let calls = 0;
    const provider = new MockVegasProvider(games);
    const counting = {
      ...provider,
      name: provider.name,
      isConfigured: () => true,
      getUpcomingNFLGames: () => provider.getUpcomingNFLGames(),
      getPlayerProps: (id: string) => provider.getPlayerProps(id),
      getSeasonPlayerMarkets: async (season: string) => {
        calls++;
        return provider.getSeasonPlayerMarkets(season);
      },
    };
    const service = new SeasonMarketService(db, counting);
    await service.refresh({ force: true });
    await service.refresh();
    expect(calls, 'a season total does not move often enough to ask twice a day').toBe(1);
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    const db = await seeded();
    const provider = new MockVegasProvider(games);
    const service = new SeasonMarketService(db, provider);
    await service.refresh({ force: true });
    const before = await service.linesFor(['wr1']);

    const failing = new SeasonMarketService(db, {
      ...provider,
      name: 'mock',
      isConfigured: () => true,
      getUpcomingNFLGames: () => provider.getUpcomingNFLGames(),
      getPlayerProps: (id: string) => provider.getPlayerProps(id),
      getSeasonPlayerMarkets: async () => {
        throw new Error('provider is down');
      },
    });
    const result = await failing.refresh({ force: true });

    expect(result.error).toContain('provider is down');
    expect(result.quotes).toBeGreaterThan(0);
    const after = await failing.linesFor(['wr1']);
    expect(after.get('wr1')!.length).toBe(before.get('wr1')!.length);
  });

  it('does not weigh weekly game lines and season totals together', async () => {
    const db = await seeded();
    await new SeasonMarketService(db, new MockVegasProvider(games)).refresh({ force: true });
    // The weekly repo must not see the season rows.
    const { PropsRepo } = await import('../src/server/repos/props.ts');
    const weekly = await new PropsRepo(db).latestForPlayers(['wr1']);
    expect(weekly.get('wr1') ?? []).toEqual([]);
    expect((await new PropsRepo(db).freshness()).fetchedAt).toBeNull();
  });

  it('says which season it is asking about', () => {
    expect(seasonFor(new Date('2026-08-14T00:00:00Z'))).toBe('2026');
    // January belongs to the season that started the previous autumn.
    expect(seasonFor(new Date('2027-01-10T00:00:00Z'))).toBe('2026');
  });
});

describe('what the market is allowed to do to the board', () => {
  const ctx = {
    currentPick: 20,
    nextPick: 40,
    shape: SHAPE,
    profile: HALF_PPR,
    rosterCounts: { QB: 1, RB: 2, WR: 2, TE: 1 },
    totalPicks: 180,
  };

  function pool(overrides: Partial<AvailablePlayerInput>[] = []): AvailablePlayerInput[] {
    return ['a', 'b', 'c', 'd'].map((id, i) => ({
      player: player({ id, fullName: `Receiver ${id.toUpperCase()}`, position: 'WR', team: 'CIN' }),
      adp: 20 + i * 2,
      adpRank: 20 + i * 2,
      signal: null,
      ...(overrides[i] ?? {}),
    }));
  }

  it('scores nothing at all when a player has no market', () => {
    const [top] = rankAvailablePlayers(pool(), ctx);
    const market = top!.components.find((c) => c.key === 'market_expectation')!;
    expect(market.unknown).toBe(true);
    expect(market.contribution).toBe(0);
    expect(top!.marketHeadline).toBeNull();
  });

  it('separates two players the draft market rates the same', () => {
    const strong = [{ market: 'season_receiving_yards' as const, line: 1400 }];
    const weak = [{ market: 'season_receiving_yards' as const, line: 600 }];
    const ranked = rankAvailablePlayers(
      pool([
        { seasonMarkets: weak },
        { seasonMarkets: strong },
        { seasonMarkets: [{ market: 'season_receiving_yards', line: 800 }] },
        { seasonMarkets: [{ market: 'season_receiving_yards', line: 900 }] },
      ]),
      // Same ADP for the first two, so only the market can separate them.
      { ...ctx },
    );
    const a = ranked.find((r) => r.playerId === 'a')!;
    const b = ranked.find((r) => r.playerId === 'b')!;
    expect(b.total).toBeGreaterThan(a.total);
  });

  it('cannot outweigh a materially stronger recommendation', () => {
    /*
     * Bounded, which is not the same as inert.
     *
     * This component is *meant* to move players the rest of the board rates
     * alike — that is what a second opinion is for. What it may not do is
     * overturn a recommendation that is materially stronger on everything else,
     * and a twenty-pick ADP bargain against the strongest possible market
     * signal is that case.
     */
    const ranked = rankAvailablePlayers(
      [
        {
          player: player({ id: 'bargain', fullName: 'Fallen Star', position: 'WR', team: 'CIN' }),
          adp: 5,
          adpRank: 5,
          signal: null,
          seasonMarkets: [{ market: 'season_receiving_yards', line: 500 }],
        },
        ...pool([{ seasonMarkets: [{ market: 'season_receiving_yards', line: 1600 }] }]).slice(0, 3),
      ],
      ctx,
    );
    expect(ranked[0]!.playerId).toBe('bargain');
  });

  it('lets a partial baseline move a player less than a complete one', () => {
    const receiver = (yards: number, receptions: number, tds: number) =>
      seasonBaseline(
        'WR',
        [
          { market: 'season_receiving_yards', line: yards },
          { market: 'season_receptions', line: receptions },
          { market: 'season_receiving_tds', line: tds },
        ],
        HALF_PPR,
      );
    const complete = receiver(1400, 100, 10);
    const partial = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 1400 }], HALF_PPR);
    // Peers priced on everything, so both players have a pool to be read against.
    const pool = [complete, partial, receiver(800, 60, 4), receiver(900, 65, 5), receiver(1000, 70, 6)];

    const completeScore = marketExpectationScore(complete, pool)!;
    const partialScore = marketExpectationScore(partial, pool)!;
    // Same player, same 1,400 yards. The partial read is damped by its coverage
    // and keeps the sign the complete one had — it is quieter, not negative.
    expect(Math.sign(partialScore)).toBe(Math.sign(completeScore));
    expect(Math.abs(partialScore)).toBeLessThan(Math.abs(completeScore));
  });

  it('will not score against a pool too small to compare with', () => {
    const one = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 1200 }], HALF_PPR);
    const two = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 1000 }], HALF_PPR);
    const three = seasonBaseline('WR', [{ market: 'season_receiving_yards', line: 900 }], HALF_PPR);
    expect(marketExpectationScore(one, [two, three])).toBeNull();
    expect(marketExpectationScore(null, [one, two, three])).toBeNull();
  });

  it('covers every season market key with a scoring rate', () => {
    for (const market of SEASON_MARKET_KEYS) {
      const baseline = seasonBaseline('WR', [{ market, line: 10 }], HALF_PPR);
      expect(baseline.points, `${market} produced no points`).not.toBeNull();
    }
  });
});
