/**
 * Vegas provider abstraction.
 *
 * Nothing outside `src/core/vegas/` may reference a vendor-specific field name.
 * Adapters translate their vendor's vocabulary into these types.
 */

/** Internal market vocabulary. Adapters map onto exactly these keys. */
export type MarketKey =
  | 'pass_yards'
  | 'pass_tds'
  | 'rush_yards'
  | 'receptions'
  | 'receiving_yards'
  | 'anytime_td';

export const MARKET_KEYS: MarketKey[] = [
  'pass_yards',
  'pass_tds',
  'rush_yards',
  'receptions',
  'receiving_yards',
  'anytime_td',
];

export interface VegasGame {
  eventId: string;
  /** ISO kickoff time. */
  startTime: string;
  homeTeam: string;
  awayTeam: string;
}

/** One book's quote for one player/market. */
export interface RawPropQuote {
  /** Player name exactly as the provider spelled it. Never normalised in place. */
  playerName: string;
  market: MarketKey;
  /** Over/under line. Null for binary markets such as anytime TD. */
  line: number | null;
  /** American odds. */
  overPrice: number | null;
  underPrice: number | null;
  book: string;
}

export interface RawPropSet {
  provider: string;
  eventId: string;
  gameStart: string;
  fetchedAt: string;
  quotes: RawPropQuote[];
  /** Untouched provider payload, persisted for audit. */
  raw: unknown;
}

/** Consensus across books for one player/market, after identity resolution. */
export interface PlayerProp {
  playerId: string | null;
  sourcePlayerName: string;
  market: MarketKey;
  line: number | null;
  overPrice: number | null;
  underPrice: number | null;
  /** Number of books contributing to the consensus. */
  bookCount: number;
  consensusMethod: 'median' | 'single' | 'none';
  /** Books that contributed, for auditability. */
  books: string[];
  /** De-vigged probability for binary markets (anytime TD). */
  impliedProbability: number | null;
}

export interface QuotaStatus {
  /** Requests remaining in the current period, when the provider reports it. */
  remaining: number | null;
  used: number | null;
  /** ISO timestamp of the last successful request. */
  lastRequestAt: string | null;
  lastError: string | null;
}

export interface VegasProvider {
  readonly name: string;
  /** False when no API key/config is present; callers fall back to cache. */
  isConfigured(): boolean;
  getUpcomingNFLGames(opts?: { from?: string; to?: string }): Promise<VegasGame[]>;
  getPlayerProps(eventId: string, markets?: MarketKey[]): Promise<RawPropSet>;
  getQuotaStatus?(): QuotaStatus | null;
}

export class VegasProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly kind: 'quota' | 'auth' | 'network' | 'unsupported' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VegasProviderError';
  }
}
