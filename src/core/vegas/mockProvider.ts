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
  SeasonMarketKey,
  SeasonMarketQuote,
  SeasonMarketSet,
  TeamPropsResult,
  VegasGame,
  VegasProvider,
} from './types.ts';
import { MARKET_KEYS, SEASON_MARKET_KEYS } from './types.ts';

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

/**
 * Season-long equivalents, so the draft-side pipeline has something to run on
 * in development. Same hash, same determinism, and the same `mock` provider
 * name everywhere so nothing can mistake these for real market expectations.
 */
const SEASON_MARKETS_BY_POSITION: Record<string, SeasonMarketKey[]> = {
  QB: ['season_pass_yards', 'season_pass_tds', 'season_rush_yards'],
  RB: ['season_rush_yards', 'season_rush_tds', 'season_receptions', 'season_receiving_yards'],
  WR: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
  TE: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
};

const SEASON_BASE_LINE: Record<SeasonMarketKey, number> = {
  season_pass_yards: 3950,
  season_pass_tds: 26.5,
  season_rush_yards: 780,
  season_rush_tds: 7.5,
  season_receptions: 68.5,
  season_receiving_yards: 880,
  season_receiving_tds: 6.5,
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

  /**
   * The same shape the real provider has: ask by team, get the games and their
   * lines together. Costed the same way too — one entity per event returned —
   * so the budget arithmetic under test is the arithmetic that will run.
   */
  async getPropsForTeams(
    teamIds: string[],
    opts: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number } = {},
  ): Promise<TeamPropsResult> {
    const results: { teamId: string; set: RawPropSet }[] = [];
    const seen = new Set<string>();
    for (const teamId of [...new Set(teamIds)].filter(Boolean)) {
      if (results.length >= (opts.maxEvents ?? 12)) break;
      const key = teamId.toUpperCase();
      for (const game of this.games) {
        if (seen.has(game.eventId)) continue;
        // A team is in a game if the game names it or if one of its players is
        // on that team — the fixtures carry both spellings, and so does life.
        const involved =
          [game.homeTeam, game.awayTeam].some((t) => t.toUpperCase() === key) ||
          game.players.some((p) => (p.team ?? '').toUpperCase() === key);
        if (!involved) continue;
        seen.add(game.eventId);
        results.push({ teamId, set: await this.getPlayerProps(game.eventId, opts.markets) });
      }
    }
    return { results, requests: Math.max(1, teamIds.length), entities: Math.max(1, results.length) };
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
      /*
       * A game line, derived from the same seed the props are.
       *
       * Deterministic per event, and inside the range a real slate occupies —
       * totals in the low forties to low fifties, spreads inside a touchdown
       * and a half — so the development seed exercises the game-script
       * component instead of leaving it permanently unknown.
       */
      gameLines: game
        ? {
            total: roundToHalf(45 + jitter(`${eventId}|total`, 6)),
            spread: roundToHalf(jitter(`${eventId}|spread`, 7)),
            spreadTeam: game.homeTeam,
          }
        : { total: null, spread: null, spreadTeam: null },
      raw: { mock: true, eventId, playerCount: game?.players.length ?? 0 },
    };
  }

  /**
   * Season-long totals for every player in the mock slate.
   *
   * Rounded the way a book rounds them — whole yards, half touchdowns — so the
   * formatting the draft card has to do is the formatting it would really do.
   */
  async getSeasonPlayerMarkets(
    season: string,
    markets: SeasonMarketKey[] = SEASON_MARKET_KEYS,
  ): Promise<SeasonMarketSet> {
    const wanted = new Set(markets);
    const quotes: SeasonMarketQuote[] = [];
    const seen = new Set<string>();

    for (const game of this.games) {
      for (const player of game.players) {
        if (seen.has(player.name)) continue;
        seen.add(player.name);
        for (const market of SEASON_MARKETS_BY_POSITION[player.position] ?? []) {
          if (!wanted.has(market)) continue;
          const seed = `${season}|${player.name}|${market}`;
          const raw = SEASON_BASE_LINE[market] * (1 + jitter(seed, 0.3));
          quotes.push({
            playerName: player.name,
            market,
            line: raw >= 100 ? Math.round(raw) : roundToHalf(raw),
            overPrice: -110 + Math.round(jitter(seed, 8)),
            underPrice: -110 - Math.round(jitter(seed, 8)),
            book: this.name,
          });
        }
      }
    }

    return {
      provider: this.name,
      season,
      fetchedAt: new Date().toISOString(),
      quotes,
      note: quotes.length === 0 ? 'no mock players configured' : null,
      raw: { mock: true, season, playerCount: seen.size },
    };
  }

  getQuotaStatus() {
    return { remaining: null, used: null, lastRequestAt: null, lastError: null };
  }
}
