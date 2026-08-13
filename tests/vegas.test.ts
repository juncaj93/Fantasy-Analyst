import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  getPropsWithCache,
  shouldRefresh,
  type CachedSnapshot,
  type SnapshotStore,
} from '../src/core/vegas/cache.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { parseQuotes } from '../src/core/vegas/oddsApiProvider.ts';
import {
  americanToProbability,
  buildConsensus,
  devig,
  median,
  normalizeMarket,
} from '../src/core/vegas/normalize.ts';
import { VegasProviderError, type RawPropQuote, type RawPropSet, type VegasProvider } from '../src/core/vegas/types.ts';
import { TEST_INDEX } from './helpers/players.ts';

describe('normalizeMarket', () => {
  it('maps The Odds API keys to the internal vocabulary', () => {
    expect(normalizeMarket('player_pass_yds')).toBe('pass_yards');
    expect(normalizeMarket('player_pass_tds')).toBe('pass_tds');
    expect(normalizeMarket('player_rush_yds')).toBe('rush_yards');
    expect(normalizeMarket('player_receptions')).toBe('receptions');
    expect(normalizeMarket('player_reception_yds')).toBe('receiving_yards');
    expect(normalizeMarket('player_anytime_td')).toBe('anytime_td');
  });

  it('accepts vendor-neutral spellings', () => {
    expect(normalizeMarket('Passing Yards')).toBe('pass_yards');
    expect(normalizeMarket('anytime-touchdown-scorer')).toBe('anytime_td');
  });

  it('returns null for an unknown market rather than guessing', () => {
    expect(normalizeMarket('player_tackles')).toBeNull();
    expect(normalizeMarket('')).toBeNull();
  });
});

describe('odds maths', () => {
  it('converts american odds to implied probability', () => {
    expect(americanToProbability(100)).toBeCloseTo(0.5, 5);
    expect(americanToProbability(-200)).toBeCloseTo(0.6667, 3);
    expect(americanToProbability(null)).toBeNull();
  });

  it('removes the vig from a two-way market', () => {
    // +100 / -120 => raw 0.5 and 0.5454, normalised to ~0.478
    expect(devig(100, -120)).toBeCloseTo(0.478, 2);
  });

  it('returns the raw probability when only one side is priced', () => {
    expect(devig(150, null)).toBeCloseTo(0.4, 3);
  });

  it('computes medians for odd and even counts', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('buildConsensus', () => {
  const quotes: RawPropQuote[] = [
    { playerName: 'Puka Nacua', market: 'receiving_yards', line: 72.5, overPrice: -110, underPrice: -110, book: 'a' },
    { playerName: 'Puka Nacua', market: 'receiving_yards', line: 74.5, overPrice: -115, underPrice: -105, book: 'b' },
    { playerName: 'Puka Nacua', market: 'receiving_yards', line: 300, overPrice: -110, underPrice: -110, book: 'c' },
    { playerName: 'Puka Nacua', market: 'anytime_td', line: null, overPrice: 150, underPrice: -190, book: 'a' },
  ];

  it('resolves the source name to a canonical player', () => {
    const consensus = buildConsensus(quotes, TEST_INDEX);
    expect(consensus[0]?.playerId).toBe('11');
  });

  it('uses the median line and drops obvious outliers', () => {
    const rec = buildConsensus(quotes, TEST_INDEX).find((c) => c.market === 'receiving_yards');
    expect(rec?.line).toBe(73.5);
    expect(rec?.bookCount).toBe(2);
    expect(rec?.consensusMethod).toBe('median');
  });

  it('retains the contributing book names', () => {
    const rec = buildConsensus(quotes, TEST_INDEX).find((c) => c.market === 'receiving_yards');
    expect(rec?.books).toEqual(['a', 'b']);
  });

  it('devigs binary markets', () => {
    const td = buildConsensus(quotes, TEST_INDEX).find((c) => c.market === 'anytime_td');
    expect(td?.impliedProbability).toBeGreaterThan(0.3);
    expect(td?.impliedProbability).toBeLessThan(0.45);
  });

  it('keeps an unresolvable name with a null player id', () => {
    const consensus = buildConsensus(
      [{ playerName: 'Totally Unknown', market: 'receptions', line: 4.5, overPrice: -110, underPrice: -110, book: 'a' }],
      TEST_INDEX,
    );
    expect(consensus[0]?.playerId).toBeNull();
    expect(consensus[0]?.sourcePlayerName).toBe('Totally Unknown');
  });

  it('marks a single-book market as such', () => {
    const consensus = buildConsensus(
      [{ playerName: 'Puka Nacua', market: 'receptions', line: 5.5, overPrice: -110, underPrice: -110, book: 'a' }],
      TEST_INDEX,
    );
    expect(consensus[0]?.consensusMethod).toBe('single');
    expect(consensus[0]?.bookCount).toBe(1);
  });
});

describe('parseQuotes (The Odds API shape)', () => {
  it('pairs over/under outcomes into one quote per book', () => {
    const quotes = parseQuotes({
      id: 'e1',
      commence_time: '2026-09-13T17:00:00Z',
      home_team: 'A',
      away_team: 'B',
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            {
              key: 'player_reception_yds',
              outcomes: [
                { name: 'Over', description: 'Puka Nacua', price: -115, point: 72.5 },
                { name: 'Under', description: 'Puka Nacua', price: -105, point: 72.5 },
              ],
            },
          ],
        },
      ],
    });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ line: 72.5, overPrice: -115, underPrice: -105, book: 'draftkings' });
  });

  it('handles Yes/No outcomes for anytime TD', () => {
    const quotes = parseQuotes({
      id: 'e1',
      commence_time: '',
      home_team: '',
      away_team: '',
      bookmakers: [
        {
          key: 'fanduel',
          markets: [
            { key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'Puka Nacua', price: 150 }] },
          ],
        },
      ],
    });
    expect(quotes[0]?.overPrice).toBe(150);
  });

  it('drops unsupported markets instead of misclassifying them', () => {
    const quotes = parseQuotes({
      id: 'e1',
      commence_time: '',
      home_team: '',
      away_team: '',
      bookmakers: [{ key: 'x', markets: [{ key: 'player_tackles', outcomes: [{ description: 'Someone', price: 100 }] }] }],
    });
    expect(quotes).toHaveLength(0);
  });

  it('returns empty for a missing payload', () => {
    expect(parseQuotes(null)).toEqual([]);
  });
});

describe('MockVegasProvider', () => {
  const provider = new MockVegasProvider([
    {
      eventId: 'g1',
      startTime: '2026-09-13T17:00:00Z',
      homeTeam: 'LAR',
      awayTeam: 'ATL',
      players: [
        { name: 'Puka Nacua', position: 'WR', team: 'LAR' },
        { name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
      ],
    },
  ]);

  it('is deterministic across calls', async () => {
    const a = await provider.getPlayerProps('g1');
    const b = await provider.getPlayerProps('g1');
    expect(a.quotes).toEqual(b.quotes);
  });

  it('emits position-appropriate markets', async () => {
    const props = await provider.getPlayerProps('g1');
    const wrMarkets = new Set(props.quotes.filter((q) => q.playerName === 'Puka Nacua').map((q) => q.market));
    expect(wrMarkets).toContain('receiving_yards');
    expect(wrMarkets).toContain('receptions');
    expect(wrMarkets).not.toContain('pass_yards');
  });
});

// --------------------------------------------------------------- caching ---
class MemoryStore implements SnapshotStore {
  private readonly map = new Map<string, CachedSnapshot>();
  async get(eventId: string) {
    return this.map.get(eventId) ?? null;
  }
  async put(snapshot: CachedSnapshot) {
    this.map.set(snapshot.eventId, snapshot);
  }
}

function snapshot(fetchedAt: string, gameStart = '2026-09-13T17:00:00Z'): CachedSnapshot {
  return {
    provider: 'mock',
    eventId: 'g1',
    gameStart,
    fetchedAt,
    raw: { provider: 'mock', eventId: 'g1', gameStart, fetchedAt, quotes: [], raw: null } as RawPropSet,
  };
}

describe('shouldRefresh', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');

  it('refreshes when nothing is cached', () => {
    expect(shouldRefresh(null, { now }).refresh).toBe(true);
  });

  it('serves cache inside the TTL', () => {
    const decision = shouldRefresh(snapshot('2026-09-10T10:00:00Z'), { now });
    expect(decision.refresh).toBe(false);
    expect(decision.reason).toContain('fresh');
  });

  it('refreshes past the TTL', () => {
    expect(shouldRefresh(snapshot('2026-09-09T12:00:00Z'), { now }).refresh).toBe(true);
  });

  it('uses a shorter TTL near kickoff', () => {
    const nearNow = Date.parse('2026-09-13T14:00:00Z'); // 3h before kickoff
    const cached = snapshot('2026-09-13T11:30:00Z'); // 150 min old
    expect(shouldRefresh(cached, { now: nearNow }).refresh).toBe(true);
    expect(DEFAULT_POLICY.nearGameTtlMinutes).toBeLessThan(DEFAULT_POLICY.ttlMinutes);
  });

  it('enforces the manual refresh cooldown', () => {
    const decision = shouldRefresh(snapshot('2026-09-10T11:55:00Z'), { now, manual: true });
    expect(decision.refresh).toBe(false);
    expect(decision.reason).toContain('cooldown');
  });

  it('allows a manual refresh once the cooldown expires', () => {
    expect(shouldRefresh(snapshot('2026-09-10T11:00:00Z'), { now, manual: true }).refresh).toBe(true);
  });
});

describe('getPropsWithCache', () => {
  const workingProvider: VegasProvider = {
    name: 'mock',
    isConfigured: () => true,
    getUpcomingNFLGames: async () => [],
    getPlayerProps: async () => ({
      provider: 'mock',
      eventId: 'g1',
      gameStart: '2026-09-13T17:00:00Z',
      fetchedAt: '2026-09-10T12:00:00.000Z',
      quotes: [],
      raw: null,
    }),
  };

  const failingProvider: VegasProvider = {
    ...workingProvider,
    getPlayerProps: async () => {
      throw new VegasProviderError('quota exhausted', 'mock', 'quota', 429);
    },
  };

  it('fetches and caches when nothing is stored', async () => {
    const store = new MemoryStore();
    const result = await getPropsWithCache('g1', workingProvider, store);
    expect(result.origin).toBe('fresh');
    expect(result.stale).toBe(false);
    expect(await store.get('g1')).not.toBeNull();
  });

  it('serves the cache without calling the provider again', async () => {
    const store = new MemoryStore();
    const now = Date.parse('2026-09-10T12:30:00Z');
    await store.put(snapshot('2026-09-10T12:00:00Z'));
    const result = await getPropsWithCache('g1', workingProvider, store, { now });
    expect(result.origin).toBe('cache');
    expect(result.stale).toBe(false);
  });

  it('falls back to the cached snapshot when the provider fails, marking it stale', async () => {
    const store = new MemoryStore();
    await store.put(snapshot('2026-09-01T12:00:00Z'));
    const result = await getPropsWithCache('g1', failingProvider, store, { now: Date.parse('2026-09-10T12:00:00Z') });
    expect(result.origin).toBe('stale_cache');
    expect(result.stale).toBe(true);
    expect(result.error).toContain('quota');
    expect(result.snapshot).not.toBeNull();
  });

  it('reports unavailable rather than fabricating data', async () => {
    const result = await getPropsWithCache('g1', failingProvider, new MemoryStore());
    expect(result.origin).toBe('unavailable');
    expect(result.snapshot).toBeNull();
    expect(result.stale).toBe(true);
  });

  it('serves cache when the provider has no credentials', async () => {
    const store = new MemoryStore();
    await store.put(snapshot('2026-09-01T12:00:00Z'));
    const unconfigured: VegasProvider = { ...workingProvider, isConfigured: () => false };
    const result = await getPropsWithCache('g1', unconfigured, store);
    expect(result.origin).toBe('stale_cache');
    expect(result.reason).toContain('not configured');
  });

  it('never throws', async () => {
    const exploding: VegasProvider = {
      ...workingProvider,
      getPlayerProps: async () => {
        throw new Error('kaboom');
      },
    };
    await expect(getPropsWithCache('g1', exploding, new MemoryStore())).resolves.toBeTruthy();
  });
});
