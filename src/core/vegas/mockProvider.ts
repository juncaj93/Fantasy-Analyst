/**
 * Deterministic fake Vegas provider.
 *
 * Default provider in development and tests. Produces stable, obviously-fake
 * lines derived from a hash of the player name so results never change between
 * runs. It reports itself as `mock` everywhere so the UI can label the data.
 */

import { stableHash } from '../newsletter/fingerprint.ts';
import type {
  MarketKey,
  RawPropQuote,
  RawPropSet,
  VegasGame,
  VegasProvider,
} from './types.ts';
import { MARKET_KEYS } from './types.ts';

export interface MockRoster {
  eventId: string;
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  /** Players to generate props for. */
  players: { name: string; position: string; team: string }[];
}

const BOOKS = ['mockbook_a', 'mockbook_b'];

/** Positions that get each market. */
const MARKETS_BY_POSITION: Record<string, MarketKey[]> = {
  QB: ['pass_yards', 'pass_tds', 'rush_yards', 'anytime_td'],
  RB: ['rush_yards', 'receiving_yards', 'receptions', 'anytime_td'],
  WR: ['receiving_yards', 'receptions', 'anytime_td'],
  TE: ['receiving_yards', 'receptions', 'anytime_td'],
};

const BASE_LINE: Record<MarketKey, number> = {
  pass_yards: 235,
  pass_tds: 1.5,
  rush_yards: 45,
  receptions: 4.5,
  receiving_yards: 55,
  anytime_td: 0,
};

function jitter(seed: string, spread: number): number {
  const h = parseInt(stableHash(seed).slice(0, 8), 16);
  return ((h % 2000) / 1000 - 1) * spread;
}

function roundToHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

export class MockVegasProvider implements VegasProvider {
  readonly name = 'mock';

  constructor(private readonly games: MockRoster[]) {}

  isConfigured(): boolean {
    return true;
  }

  async getUpcomingNFLGames(): Promise<VegasGame[]> {
    return this.games.map((g) => ({
      eventId: g.eventId,
      startTime: g.startTime,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
    }));
  }

  async getPlayerProps(eventId: string, markets: MarketKey[] = MARKET_KEYS): Promise<RawPropSet> {
    const game = this.games.find((g) => g.eventId === eventId);
    const wanted = new Set(markets);
    const quotes: RawPropQuote[] = [];

    for (const player of game?.players ?? []) {
      const positionMarkets = MARKETS_BY_POSITION[player.position] ?? [];
      for (const market of positionMarkets) {
        if (!wanted.has(market)) continue;
        for (const book of BOOKS) {
          const seed = `${eventId}|${player.name}|${market}|${book}`;
          if (market === 'anytime_td') {
            const base = player.position === 'QB' ? 250 : 130;
            const price = Math.round(base + jitter(seed, 60));
            quotes.push({
              playerName: player.name,
              market,
              line: null,
              overPrice: price,
              underPrice: -Math.round(price * 1.35),
              book,
            });
            continue;
          }
          const line = roundToHalf(BASE_LINE[market] * (1 + jitter(seed, 0.22)));
          quotes.push({
            playerName: player.name,
            market,
            line,
            overPrice: -110 + Math.round(jitter(seed, 8)),
            underPrice: -110 - Math.round(jitter(seed, 8)),
            book,
          });
        }
      }
    }

    return {
      provider: this.name,
      eventId,
      gameStart: game?.startTime ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      quotes,
      raw: { mock: true, eventId, playerCount: game?.players.length ?? 0 },
    };
  }

  getQuotaStatus() {
    return { remaining: null, used: null, lastRequestAt: null, lastError: null };
  }
}
