/**
 * SportsGameOdds adapter.
 *
 * Written against the live API rather than its documentation — every field name
 * and market identifier below came out of `scripts/probe-sportsgameodds.mjs`,
 * because the specific way an odds adapter fails is silently: a wrong key name
 * parses cleanly, returns nothing, and looks exactly like "no props this week".
 *
 * What the probe established, and what this file therefore relies on:
 *
 *   - an event's kickoff is `status.startsAt`; there is no top-level start time;
 *   - `event.players` is a directory keyed by player id, carrying the full name
 *     the identity matcher needs;
 *   - odds arrive as an object keyed by an id of the form
 *     `{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}`, and the same
 *     five fields are also present on the quote itself;
 *   - the line is `bookOverUnder` and the price is `bookOdds`, both strings,
 *     with `fair*` equivalents as the provider's own de-vigged view;
 *   - `byBookmaker` is empty on the free plan, so a quote is one consensus
 *     number rather than a spread of books. That is reported honestly as a
 *     single book rather than dressed up as agreement between several.
 *
 * The key is read from the worker environment and never leaves the server.
 */

import {
  MARKET_KEYS,
  SEASON_MARKET_KEYS,
  VegasProviderError,
  type MarketKey,
  type QuotaStatus,
  type RawPropQuote,
  type RawPropSet,
  type SeasonMarketKey,
  type SeasonMarketQuote,
  type SeasonMarketSet,
  type VegasGame,
  type VegasProvider,
} from './types.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Their `statID` -> our market key.
 *
 * Confirmed present on a live NFL event: passing_yards, rushing_yards,
 * receiving_yards. The remaining three are the documented identifiers in the
 * same naming scheme; a market that never appears simply produces no quotes,
 * which is the correct degraded behaviour rather than an error.
 */
const INBOUND_MARKETS: Record<string, MarketKey> = {
  passing_yards: 'pass_yards',
  passing_touchdowns: 'pass_tds',
  rushing_yards: 'rush_yards',
  receiving_receptions: 'receptions',
  receptions: 'receptions',
  receiving_yards: 'receiving_yards',
  touchdowns: 'anytime_td',
};

/** Entities that are a side of the game rather than a player. */
const GAME_ENTITIES = new Set(['all', 'side1', 'side2', 'home', 'away']);

/**
 * Their season-long `statID` -> our season market key.
 *
 * Written from the same source as the weekly map — the live API — and none of
 * these has ever been seen in a response. That is deliberate: the provider's
 * own market catalogue (`/v2/markets?leagueID=NFL`) lists 148 active markets
 * across periods `game`, `1h`, `2h`, `1q`–`4q` and `reg`, and not one season
 * period among them, so there is currently nothing to match. The names follow
 * the catalogue's own scheme, so if a season period ever appears this map is
 * where it lands, and until then `getSeasonPlayerMarkets` returns an empty set
 * with a reason rather than an error.
 */
const INBOUND_SEASON_MARKETS: Record<string, SeasonMarketKey> = {
  passing_yards: 'season_pass_yards',
  passing_touchdowns: 'season_pass_tds',
  rushing_yards: 'season_rush_yards',
  rushing_touchdowns: 'season_rush_tds',
  receiving_receptions: 'season_receptions',
  receptions: 'season_receptions',
  receiving_yards: 'season_receiving_yards',
  receiving_touchdowns: 'season_receiving_tds',
};

/**
 * Periods that describe a whole season rather than a game.
 *
 * `reg` is the one the catalogue uses for regulation time WITHIN a game, so it
 * is deliberately not here: reading it as a season would turn a 28.5-yard line
 * into a season total, which is the exact failure this adapter exists to avoid.
 */
const SEASON_PERIODS = new Set(['season', 'full_season', 'regular_season', 'year']);

export interface SportsGameOddsOptions {
  apiKey: string | null | undefined;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Games this far ahead are considered "upcoming". */
  horizonDays?: number;
}

interface SgoPlayer {
  playerID?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  teamID?: string;
}

interface SgoOdd {
  oddID?: string;
  statID?: string;
  statEntityID?: string;
  playerID?: string;
  periodID?: string;
  betTypeID?: string;
  sideID?: string;
  marketName?: string;
  bookOverUnder?: string | number | null;
  fairOverUnder?: string | number | null;
  bookOdds?: string | number | null;
  fairOdds?: string | number | null;
  cancelled?: boolean;
}

interface SgoEvent {
  eventID?: string;
  leagueID?: string;
  type?: string;
  status?: { startsAt?: string; cancelled?: boolean; started?: boolean };
  teams?: Record<string, { teamID?: string; names?: { long?: string; short?: string } }>;
  players?: Record<string, SgoPlayer>;
  odds?: Record<string, SgoOdd>;
}

export class SportsGameOddsProvider implements VegasProvider {
  readonly name = 'sportsgameodds';

  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly horizonDays: number;
  private quota: QuotaStatus = { remaining: null, used: null, lastRequestAt: null, lastError: null };

  constructor(opts: SportsGameOddsOptions) {
    this.apiKey = opts.apiKey?.trim() || null;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = opts.baseUrl ?? 'https://api.sportsgameodds.com/v2';
    this.horizonDays = opts.horizonDays ?? 8;
  }

  isConfigured(): boolean {
    return this.apiKey != null;
  }

  getQuotaStatus(): QuotaStatus {
    return { ...this.quota };
  }

  async getUpcomingNFLGames(opts: { from?: string; to?: string } = {}): Promise<VegasGame[]> {
    const from = (opts.from ?? new Date().toISOString()).slice(0, 10);
    const to = (opts.to ?? new Date(Date.now() + this.horizonDays * 86_400_000).toISOString()).slice(0, 10);
    // `type=match` matters: an unfiltered NFL query also answers with novelty
    // events (the Puppy Bowl, with markets like "sex of the winning touchdown
    // scorer"), which are not games anybody is starting a lineup for.
    const events = await this.request<{ data?: SgoEvent[] }>(
      `/events?leagueID=NFL&type=match&startsAfter=${from}&startsBefore=${to}&oddsAvailable=true&limit=50`,
    );

    const games: VegasGame[] = [];
    for (const event of events.data ?? []) {
      const startTime = event.status?.startsAt;
      if (!event.eventID || !startTime || event.status?.cancelled) continue;
      const sides = Object.values(event.teams ?? {});
      games.push({
        eventId: event.eventID,
        startTime,
        // Team names are secondary here — identity resolution is by player, and
        // an unnamed side is not a reason to drop a game that has odds.
        homeTeam: sides[0]?.names?.long ?? sides[0]?.teamID ?? '',
        awayTeam: sides[1]?.names?.long ?? sides[1]?.teamID ?? '',
      });
    }
    return games;
  }

  async getPlayerProps(eventId: string, markets: MarketKey[] = MARKET_KEYS): Promise<RawPropSet> {
    const wanted = new Set(markets);
    const body = await this.request<{ data?: SgoEvent[] }>(
      `/events?eventID=${encodeURIComponent(eventId)}&oddsAvailable=true`,
    );
    const event = body.data?.[0];
    if (!event) {
      throw new VegasProviderError(`event ${eventId} not found`, this.name, 'parse');
    }

    const players = event.players ?? {};
    const quotes: RawPropQuote[] = [];

    for (const odd of Object.values(event.odds ?? {})) {
      if (odd.cancelled) continue;
      // Over/under only, on the full game. A first-half line is a different
      // question from the one a weekly lineup is asking.
      if (odd.betTypeID !== 'ou' || odd.periodID !== 'game') continue;
      // One row per market, not one per side: `over` carries the line, and the
      // matching `under` would duplicate it under a second identity.
      if (odd.sideID !== 'over') continue;

      const market = odd.statID ? INBOUND_MARKETS[odd.statID] : undefined;
      if (!market || !wanted.has(market)) continue;

      const entity = odd.playerID ?? odd.statEntityID ?? '';
      if (!entity || GAME_ENTITIES.has(entity)) continue;

      const playerName = nameOf(players[entity], entity);
      if (!playerName) continue;

      quotes.push({
        playerName,
        market,
        line: toNumber(odd.bookOverUnder ?? odd.fairOverUnder),
        overPrice: toNumber(odd.bookOdds ?? odd.fairOdds),
        // The provider quotes each side separately and this row is the over, so
        // the under price is genuinely absent rather than zero.
        underPrice: null,
        // `byBookmaker` is empty on the free plan: this is the provider's own
        // consensus, and calling it anything else would overstate it.
        book: this.name,
      });
    }

    return {
      provider: this.name,
      eventId,
      gameStart: event.status?.startsAt ?? '',
      fetchedAt: new Date().toISOString(),
      quotes,
      raw: event,
    };
  }

  /**
   * Season-long player totals.
   *
   * Everything this provider publishes for the NFL is a single game: `type`
   * accepts only `match`, `prop` and `tournament`, and both `prop` and
   * `tournament` are empty for the league across the whole year. This asks the
   * two places a season market could be — a non-match event, and any event
   * quoting a season period — and reports emptiness as a fact with a reason,
   * because "the provider has no such market" and "the request failed" are
   * different things and only one of them is worth retrying.
   *
   * Two requests, both small. See docs/VEGAS.md for the probe that established
   * this and what would have to change for it to start returning quotes.
   */
  async getSeasonPlayerMarkets(
    season: string,
    markets: SeasonMarketKey[] = SEASON_MARKET_KEYS,
  ): Promise<SeasonMarketSet> {
    const wanted = new Set(markets);
    const fetchedAt = new Date().toISOString();
    const quotes: SeasonMarketQuote[] = [];
    const events: SgoEvent[] = [];

    // Anything that is not a single game. Empty for the NFL today.
    const props = await this.request<{ data?: SgoEvent[] }>(
      `/events?leagueID=NFL&type=prop&oddsAvailable=true&limit=25`,
    );
    events.push(...(props.data ?? []));

    // …and any event that quotes a season-length period, whatever its type.
    const seasonal = await this.request<{ data?: SgoEvent[] }>(
      `/events?leagueID=NFL&season=${encodeURIComponent(season)}&oddsAvailable=true&limit=25`,
    );
    events.push(...(seasonal.data ?? []));

    for (const event of events) {
      const players = event.players ?? {};
      for (const odd of Object.values(event.odds ?? {})) {
        if (odd.cancelled) continue;
        if (odd.betTypeID !== 'ou' || odd.sideID !== 'over') continue;
        if (!odd.periodID || !SEASON_PERIODS.has(odd.periodID)) continue;

        const market = odd.statID ? INBOUND_SEASON_MARKETS[odd.statID] : undefined;
        if (!market || !wanted.has(market)) continue;

        const entity = odd.playerID ?? odd.statEntityID ?? '';
        if (!entity || GAME_ENTITIES.has(entity)) continue;
        const playerName = nameOf(players[entity], entity);
        if (!playerName) continue;

        quotes.push({
          playerName,
          market,
          line: toNumber(odd.bookOverUnder ?? odd.fairOverUnder),
          overPrice: toNumber(odd.bookOdds ?? odd.fairOdds),
          underPrice: null,
          book: this.name,
        });
      }
    }

    return {
      provider: this.name,
      season,
      fetchedAt,
      quotes,
      note:
        quotes.length > 0
          ? null
          : `${this.name} publishes no season-long NFL player markets: every NFL event is a single game, and its market catalogue has no season period.`,
      raw: { events: events.length },
    };
  }

  private async request<T>(path: string): Promise<T> {
    if (!this.apiKey) {
      throw new VegasProviderError('no API key configured', this.name, 'auth');
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { 'X-Api-Key': this.apiKey, accept: 'application/json' },
      });
    } catch (err) {
      this.quota.lastError = err instanceof Error ? err.message : String(err);
      throw new VegasProviderError(`network error: ${this.quota.lastError}`, this.name, 'network');
    }

    this.quota.lastRequestAt = new Date().toISOString();
    const remaining = res.headers.get('x-ratelimit-remaining') ?? res.headers.get('ratelimit-remaining');
    if (remaining != null) this.quota.remaining = Number(remaining);

    if (res.status === 401 || res.status === 403) {
      this.quota.lastError = `auth failed (${res.status})`;
      throw new VegasProviderError(this.quota.lastError, this.name, 'auth', res.status);
    }
    if (res.status === 429) {
      this.quota.lastError = 'rate limited';
      throw new VegasProviderError('rate limited', this.name, 'quota', 429);
    }
    if (!res.ok) {
      this.quota.lastError = `HTTP ${res.status}`;
      throw new VegasProviderError(`HTTP ${res.status}`, this.name, 'network', res.status);
    }

    try {
      const json = (await res.json()) as T;
      this.quota.lastError = null;
      return json;
    } catch (err) {
      this.quota.lastError = 'response was not JSON';
      throw new VegasProviderError(
        `could not parse response: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
        'parse',
      );
    }
  }
}

/**
 * The player's name as the provider spells it.
 *
 * Falls back to un-shouting the id (`TONY_POLLARD_1_NFL` -> `Tony Pollard`)
 * when the directory has no entry, because the identity matcher can work with a
 * name and can do nothing at all with an id.
 */
function nameOf(player: SgoPlayer | undefined, entityId: string): string | null {
  const direct = player?.name ?? [player?.firstName, player?.lastName].filter(Boolean).join(' ');
  if (direct && direct.trim()) return direct.trim();

  const parts = entityId
    .replace(/_\d+_NFL$/i, '')
    .split('_')
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join(' ');
}

/** Lines and prices arrive as strings; anything unparseable is absent, not zero. */
function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}
