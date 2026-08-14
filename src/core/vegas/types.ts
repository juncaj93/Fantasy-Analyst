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

/**
 * Which horizon a quote describes.
 *
 * One pipeline serves both: a week's game props for start/sit, and season-long
 * totals for the draft. They are stored in the same tables, normalised by the
 * same adapters and cached by the same policy — the scope is what keeps a
 * season total from ever being read as Sunday's line.
 */
export type MarketScope = 'week' | 'season';

/**
 * Season-long market vocabulary.
 *
 * Deliberately separate from the weekly keys: `pass_yards` for a game and for a
 * season are different questions with different magnitudes, and a single key
 * would eventually let one be shown as the other.
 */
export type SeasonMarketKey =
  | 'season_pass_yards'
  | 'season_pass_tds'
  | 'season_rush_yards'
  | 'season_rush_tds'
  | 'season_receptions'
  | 'season_receiving_yards'
  | 'season_receiving_tds';

export const SEASON_MARKET_KEYS: SeasonMarketKey[] = [
  'season_pass_yards',
  'season_pass_tds',
  'season_rush_yards',
  'season_rush_tds',
  'season_receptions',
  'season_receiving_yards',
  'season_receiving_tds',
];

/** One provider quote for one player's season-long total. */
export interface SeasonMarketQuote {
  /** Player name exactly as the provider spelled it. Never normalised in place. */
  playerName: string;
  market: SeasonMarketKey;
  /** The over/under line — the number the market expects. */
  line: number | null;
  overPrice: number | null;
  underPrice: number | null;
  book: string;
}

export interface SeasonMarketSet {
  provider: string;
  /** The season these totals settle on, e.g. "2026". */
  season: string;
  fetchedAt: string;
  quotes: SeasonMarketQuote[];
  /**
   * Why the set is empty, when it is.
   *
   * A provider that publishes no season-long markets is a fact worth showing,
   * and it is not the same fact as a failed request. Never a guess.
   */
  note: string | null;
  /** Untouched provider payload, persisted for audit. */
  raw: unknown;
}

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
  /**
   * Season-long player totals, for the draft.
   *
   * Optional because not every provider publishes them — and an adapter that
   * asks and is told "no such market" must answer with an empty set and a
   * reason rather than with an error or with invented numbers.
   */
  getSeasonPlayerMarkets?(season: string, markets?: SeasonMarketKey[]): Promise<SeasonMarketSet>;
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
