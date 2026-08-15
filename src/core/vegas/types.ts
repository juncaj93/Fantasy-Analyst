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

/**
 * The two numbers that describe a game rather than a player.
 *
 * They arrive in the same response as the player props and cost nothing extra:
 * this provider has no way to answer with an event's players and withhold its
 * game lines, and the bill is one entity per event either way. Discarding them
 * — which is what happened until Start/Sit needed a game script — was paying
 * for a number and throwing it away.
 *
 * A spread is carried with the team it belongs to rather than as "the home
 * spread", because "home" is a position in somebody else's payload and the sign
 * of a spread is the one thing that must not be inferred. A spread whose team
 * cannot be established is discarded: a game-script model fed a handicap with
 * the wrong sign is worse than one fed nothing at all.
 */
export interface GameLines {
  /** The over/under on the two teams' combined score. */
  total: number | null;
  /** The handicap, from `spreadTeam`'s point of view. Negative = favoured. */
  spread: number | null;
  /** Whose handicap it is, as the provider names the team. */
  spreadTeam: string | null;
}

export interface RawPropSet {
  provider: string;
  eventId: string;
  gameStart: string;
  fetchedAt: string;
  quotes: RawPropQuote[];
  /**
   * The game's own lines, when the provider published them.
   *
   * Optional because not every adapter reads them and a provider may simply not
   * have quoted the game yet. Absent is unknown, never zero.
   */
  gameLines?: GameLines;
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

/**
 * What a by-team fetch came back with.
 *
 * Each set is paired with the team it was asked for, because that pairing is
 * the schedule: it is how a rostered player's team becomes an event id. Reading
 * it back out of the payload would work for one vendor and quietly fail for the
 * next.
 */
export interface TeamPropsResult {
  results: { teamId: string; set: RawPropSet }[];
  /** Requests made, against the per-minute ceiling. */
  requests: number;
  /** Entities billed — one per event returned, and at least one per request. */
  entities: number;
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
   * The games a given set of teams are playing, with their lines, in one pass.
   *
   * The billing unit is one entity per event returned, and this provider has no
   * way to ask for an event without its odds — so discovering the schedule and
   * fetching the lines are the same request, and doing them separately would
   * pay twice. Asking by team is what keeps the bill proportional to the
   * roster rather than to the slate: eight teams, eight entities, however many
   * games the league is playing that weekend.
   *
   * Optional because it is a shape not every vendor offers; callers fall back
   * to listing and fetching per event.
   */
  getPropsForTeams?(
    teamIds: string[],
    opts?: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number },
  ): Promise<TeamPropsResult>;
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
