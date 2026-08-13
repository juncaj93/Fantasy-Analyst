/**
 * The Odds API adapter.
 *
 * DISABLED BY DEFAULT. Enable only after verifying, against the live provider
 * documentation, that (a) the free tier still exists, (b) NFL player props are
 * included in it, and (c) the market keys below are current. See docs/VEGAS.md.
 *
 * Player props are served per-event (`/events/{id}/odds`), which costs one
 * request per game — that is why the cache layer, not this adapter, decides
 * when a fetch is allowed.
 *
 * The API key is read from the worker environment and never leaves the server.
 */

import { normalizeMarket } from './normalize.ts';
import {
  MARKET_KEYS,
  VegasProviderError,
  type MarketKey,
  type QuotaStatus,
  type RawPropQuote,
  type RawPropSet,
  type VegasGame,
  type VegasProvider,
} from './types.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Internal key -> The Odds API market key. Verify before enabling. */
const OUTBOUND_MARKETS: Record<MarketKey, string> = {
  pass_yards: 'player_pass_yds',
  pass_tds: 'player_pass_tds',
  rush_yards: 'player_rush_yds',
  receptions: 'player_receptions',
  receiving_yards: 'player_reception_yds',
  anytime_td: 'player_anytime_td',
};

export interface OddsApiOptions {
  apiKey: string | null | undefined;
  fetch?: FetchLike;
  baseUrl?: string;
  regions?: string;
  oddsFormat?: 'american' | 'decimal';
  sport?: string;
}

interface OddsApiEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: {
    key: string;
    title?: string;
    markets?: {
      key: string;
      outcomes?: { name?: string; description?: string; price?: number; point?: number }[];
    }[];
  }[];
}

export class OddsApiProvider implements VegasProvider {
  readonly name = 'the-odds-api';
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly regions: string;
  private readonly oddsFormat: string;
  private readonly sport: string;
  private quota: QuotaStatus = { remaining: null, used: null, lastRequestAt: null, lastError: null };

  constructor(opts: OddsApiOptions) {
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? 'https://api.the-odds-api.com/v4').replace(/\/$/, '');
    this.regions = opts.regions ?? 'us';
    this.oddsFormat = opts.oddsFormat ?? 'american';
    this.sport = opts.sport ?? 'americanfootball_nfl';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  getQuotaStatus(): QuotaStatus {
    return { ...this.quota };
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    if (!this.apiKey) {
      throw new VegasProviderError('missing API key', this.name, 'auth');
    }
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apiKey', this.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
    } catch (err) {
      this.quota.lastError = String(err);
      throw new VegasProviderError(`network failure: ${String(err)}`, this.name, 'network');
    }

    // Quota headers are informational; absence is not an error.
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    this.quota = {
      remaining: remaining == null ? this.quota.remaining : Number(remaining),
      used: used == null ? this.quota.used : Number(used),
      lastRequestAt: new Date().toISOString(),
      lastError: null,
    };

    if (res.status === 401 || res.status === 403) {
      this.quota.lastError = `auth ${res.status}`;
      throw new VegasProviderError('invalid API key', this.name, 'auth', res.status);
    }
    if (res.status === 429) {
      this.quota.lastError = 'quota exhausted';
      throw new VegasProviderError('quota exhausted', this.name, 'quota', 429);
    }
    if (!res.ok) {
      this.quota.lastError = `http ${res.status}`;
      throw new VegasProviderError(`unexpected status ${res.status}`, this.name, 'network', res.status);
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new VegasProviderError(`unparseable response: ${String(err)}`, this.name, 'parse');
    }
  }

  async getUpcomingNFLGames(): Promise<VegasGame[]> {
    const events = await this.request<OddsApiEvent[]>(`/sports/${this.sport}/events`, {});
    return (events ?? []).map((e) => ({
      eventId: e.id,
      startTime: e.commence_time,
      homeTeam: e.home_team,
      awayTeam: e.away_team,
    }));
  }

  async getPlayerProps(eventId: string, markets: MarketKey[] = MARKET_KEYS): Promise<RawPropSet> {
    const outbound = markets.map((m) => OUTBOUND_MARKETS[m]).filter(Boolean).join(',');
    const event = await this.request<OddsApiEvent>(`/sports/${this.sport}/events/${eventId}/odds`, {
      regions: this.regions,
      oddsFormat: this.oddsFormat,
      markets: outbound,
    });
    return {
      provider: this.name,
      eventId,
      gameStart: event?.commence_time ?? '',
      fetchedAt: new Date().toISOString(),
      quotes: parseQuotes(event),
      raw: event,
    };
  }
}

/**
 * Translate a provider event payload into normalized quotes.
 *
 * The Odds API puts the player name in `description` for player props and the
 * side ("Over"/"Under"/"Yes"/"No") in `name`. Unknown markets are dropped
 * rather than guessed at.
 */
export function parseQuotes(event: OddsApiEvent | null | undefined): RawPropQuote[] {
  if (!event?.bookmakers) return [];
  const byKey = new Map<string, RawPropQuote>();

  for (const bookmaker of event.bookmakers) {
    const book = bookmaker.key ?? bookmaker.title ?? 'unknown';
    for (const market of bookmaker.markets ?? []) {
      const key = normalizeMarket(market.key ?? '');
      if (!key) continue;
      for (const outcome of market.outcomes ?? []) {
        const playerName = (outcome.description ?? '').trim();
        if (!playerName) continue;
        const side = (outcome.name ?? '').trim().toLowerCase();
        const groupKey = `${book}|${key}|${playerName.toLowerCase()}`;
        const existing = byKey.get(groupKey) ?? {
          playerName,
          market: key,
          line: null,
          overPrice: null,
          underPrice: null,
          book,
        };
        if (outcome.point != null && Number.isFinite(outcome.point)) existing.line = outcome.point;
        const price = outcome.price != null && Number.isFinite(outcome.price) ? outcome.price : null;
        if (side === 'over' || side === 'yes') existing.overPrice = price;
        else if (side === 'under' || side === 'no') existing.underPrice = price;
        else if (existing.overPrice == null) existing.overPrice = price;
        byKey.set(groupKey, existing);
      }
    }
  }
  return [...byKey.values()];
}
