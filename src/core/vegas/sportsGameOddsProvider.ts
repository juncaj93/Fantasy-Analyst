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
 *   - `byBookmaker` was empty on the free plan when this adapter was written,
 *     and is not any more: an August 2026 probe of regular-season fixtures
 *     returned named books (fanduel, draftkings, caesars) on many quotes. The
 *     adapter still reports one book, deliberately — `bookOverUnder` is the
 *     provider's own consensus and using it understates how many opinions are
 *     behind a line, which is the safe direction to be wrong in. Reading the
 *     per-book spread is a real improvement and a real change to what
 *     `bookCount` and `consensusMethod` mean, so it is its own piece of work;
 *   - the team filter answers only to this provider's team ids, never to
 *     Sleeper's codes. See `PROVIDER_TEAM_IDS`.
 *
 * The key is read from the worker environment and never leaves the server.
 */

import {
  MARKET_KEYS,
  SEASON_MARKET_KEYS,
  VegasProviderError,
  type GameLines,
  type MarketKey,
  type QuotaStatus,
  type RawPropQuote,
  type RawPropSet,
  type SeasonMarketKey,
  type SeasonMarketQuote,
  type SeasonMarketSet,
  type TeamPropsResult,
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
 * Sleeper's team code -> this provider's team id.
 *
 * The rest of the app speaks Sleeper, because Sleeper is the source of truth
 * for who is on the roster. This provider speaks `SAN_FRANCISCO_49ERS_NFL`, and
 * its `teamID` filter matches on nothing else: `teamID=SF` answers 200 with an
 * empty list, which is indistinguishable from "no fixtures this week" at every
 * layer above this one — and is still billed one entity. That is precisely the
 * kind of silent mismatch this adapter's header exists to warn about, so the
 * translation lives here, where the vendor's vocabulary is already allowed.
 *
 * Taken from the provider's own `/v2/teams?leagueID=NFL` rather than derived by
 * upshouting a club name, because a naming rule inferred from a sample is a
 * guess and this is a fact. `scripts/probe-sgo-team-table.mjs` prints it; the
 * read costs 34 entities, which is why the answer is a literal here rather than
 * a lookup the app repeats.
 *
 * Thirty-one of the thirty-two codes are identical in both vocabularies. The
 * Rams are the exception — Sleeper says `LAR`, the provider says `LA` — and one
 * exception is the whole reason this is a table and not a `+ '_NFL'`.
 */
const PROVIDER_TEAM_IDS: Record<string, string> = {
  ARI: 'ARIZONA_CARDINALS_NFL',
  ATL: 'ATLANTA_FALCONS_NFL',
  BAL: 'BALTIMORE_RAVENS_NFL',
  BUF: 'BUFFALO_BILLS_NFL',
  CAR: 'CAROLINA_PANTHERS_NFL',
  CHI: 'CHICAGO_BEARS_NFL',
  CIN: 'CINCINNATI_BENGALS_NFL',
  CLE: 'CLEVELAND_BROWNS_NFL',
  DAL: 'DALLAS_COWBOYS_NFL',
  DEN: 'DENVER_BRONCOS_NFL',
  DET: 'DETROIT_LIONS_NFL',
  GB: 'GREEN_BAY_PACKERS_NFL',
  HOU: 'HOUSTON_TEXANS_NFL',
  IND: 'INDIANAPOLIS_COLTS_NFL',
  JAX: 'JACKSONVILLE_JAGUARS_NFL',
  KC: 'KANSAS_CITY_CHIEFS_NFL',
  LAC: 'LOS_ANGELES_CHARGERS_NFL',
  LAR: 'LOS_ANGELES_RAMS_NFL',
  LV: 'LAS_VEGAS_RAIDERS_NFL',
  MIA: 'MIAMI_DOLPHINS_NFL',
  MIN: 'MINNESOTA_VIKINGS_NFL',
  NE: 'NEW_ENGLAND_PATRIOTS_NFL',
  NO: 'NEW_ORLEANS_SAINTS_NFL',
  NYG: 'NEW_YORK_GIANTS_NFL',
  NYJ: 'NEW_YORK_JETS_NFL',
  PHI: 'PHILADELPHIA_EAGLES_NFL',
  PIT: 'PITTSBURGH_STEELERS_NFL',
  SEA: 'SEATTLE_SEAHAWKS_NFL',
  SF: 'SAN_FRANCISCO_49ERS_NFL',
  TB: 'TAMPA_BAY_BUCCANEERS_NFL',
  TEN: 'TENNESSEE_TITANS_NFL',
  WAS: 'WASHINGTON_COMMANDERS_NFL',
};

/**
 * The provider's id for a team, from whichever vocabulary the caller had.
 *
 * A caller that already holds a provider id — a stored event, a retry — gets it
 * back untouched, so this is safe to apply to anything. A code it cannot place
 * returns null rather than a guess: an unrecognised code sent as a filter costs
 * an entity and returns nothing, which is worse than not asking.
 */
export function providerTeamId(team: string | null | undefined): string | null {
  const raw = (team ?? '').trim();
  if (!raw) return null;
  if (raw.toUpperCase().endsWith('_NFL')) return raw.toUpperCase();
  return PROVIDER_TEAM_IDS[raw.toUpperCase()] ?? null;
}

/**
 * Their season-long `statID` -> our season market key.
 *
 * Written from the same source as the weekly map — the live API — and none of
 * these has ever been seen in a response. That is deliberate: the provider's
 * own market catalogue (`/v2/markets?leagueID=NFL`) listed 148 active markets
 * when this was written and lists 344 as of August 2026, across periods `game`,
 * `1h`, `2h`, `1q`–`4q` and `reg` — and still not one season period among them.
 * The catalogue growing is more ways to bet on a game, not the first way to bet
 * on a season, so there is still nothing here to match. The names follow
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
  /*
   * The handicap fields, read defensively.
   *
   * The provider's own schema puts a spread in `bookSpread`, and every adapter
   * here has learned the same lesson about somebody else's field names: if it
   * is absent the over/under field is tried, and if that is absent too the
   * spread is simply unknown and the game-script component says so. A wrong
   * guess about a field name must degrade to "no line", never to a number.
   */
  bookSpread?: string | number | null;
  fairSpread?: string | number | null;
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

  /**
   * The account's own accounting, straight from the provider.
   *
   * Costs nothing: reading it was measured not to move either the request or
   * the entity counter. That makes it the right thing to check before every
   * refresh — it is the only number that also sees spending from a probe or
   * from another deployment sharing the key.
   */
  async getAccountUsage(): Promise<unknown> {
    const body = await this.request<{ data?: unknown }>('/account/usage');
    return body.data ?? null;
  }

  /**
   * The slate. Bounded, and deliberately not what the refresh uses.
   *
   * One entity per event returned, so an unbounded listing is an unbounded
   * bill: `limit=50` used to be up to a fifth of the month in a single call.
   * The weekly refresh asks by team instead (`getPropsForTeams`), which costs
   * what the roster spans; this is left for the cases that genuinely want the
   * slate, with a cap small enough that nobody can spend a month by accident.
   */
  async getUpcomingNFLGames(opts: { from?: string; to?: string; maxEvents?: number } = {}): Promise<VegasGame[]> {
    const from = (opts.from ?? new Date().toISOString()).slice(0, 10);
    const to = (opts.to ?? new Date(Date.now() + this.horizonDays * 86_400_000).toISOString()).slice(0, 10);
    const limit = Math.max(1, Math.min(opts.maxEvents ?? 8, 16));
    // `type=match` matters: an unfiltered NFL query also answers with novelty
    // events (the Puppy Bowl, with markets like "sex of the winning touchdown
    // scorer"), which are not games anybody is starting a lineup for.
    const events = await this.request<{ data?: SgoEvent[] }>(
      `/events?leagueID=NFL&type=match&startsAfter=${from}&startsBefore=${to}&oddsAvailable=true&limit=${limit}`,
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
    const body = await this.request<{ data?: SgoEvent[] }>(
      `/events?eventID=${encodeURIComponent(eventId)}&oddsAvailable=true`,
    );
    const event = body.data?.[0];
    if (!event) {
      throw new VegasProviderError(`event ${eventId} not found`, this.name, 'parse');
    }
    return this.toPropSet(event, eventId, new Set(markets));
  }

  /** One event's odds board, reduced to the quotes this app keeps. */
  private toPropSet(event: SgoEvent, eventId: string, wanted: Set<MarketKey>): RawPropSet {
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
        // The provider's own consensus number, called one book because that is
        // what it is. `byBookmaker` does now carry named books on many quotes;
        // until their spread is actually read, one is the honest count — it
        // understates the agreement behind a line rather than inventing it.
        book: this.name,
      });
    }

    return {
      provider: this.name,
      eventId,
      gameStart: event.status?.startsAt ?? '',
      fetchedAt: new Date().toISOString(),
      quotes,
      gameLines: toGameLines(event),
      raw: event,
    };
  }

  /**
   * The roster's games, and their lines, in one pass.
   *
   * Measured behaviour, not documented behaviour (see docs/VEGAS.md): the plan
   * bills one *entity* per event returned, and `/events` always answers with an
   * event's odds attached — there is no cheaper "schedule only" shape. So the
   * cheapest correct thing is to ask by team, once per team, and treat what
   * comes back as both the schedule and the fetch.
   *
   * `teamID` is honoured server-side — verified against a real team id and a
   * nonsense one, because a filter that is quietly ignored would return the
   * whole slate and charge for it. The nonsense id answered with no events, at
   * a cost of one entity: an empty response still costs, which is why the
   * request count is reported back for the ledger rather than inferred from the
   * number of events.
   */
  async getPropsForTeams(
    teamIds: string[],
    opts: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number } = {},
  ): Promise<TeamPropsResult> {
    const from = (opts.from ?? new Date().toISOString()).slice(0, 10);
    const to = (opts.to ?? new Date(Date.now() + this.horizonDays * 86_400_000).toISOString()).slice(0, 10);
    const wanted = new Set(opts.markets ?? MARKET_KEYS);
    const maxEvents = opts.maxEvents ?? 12;

    const results: { teamId: string; set: RawPropSet }[] = [];
    const unmapped: string[] = [];
    const seen = new Set<string>();
    let requests = 0;
    let entities = 0;

    for (const teamId of [...new Set(teamIds)].filter(Boolean)) {
      if (results.length >= maxEvents) break;

      /*
       * Callers speak Sleeper; the filter only answers to this provider's ids.
       *
       * A code that cannot be placed is collected and skipped rather than sent
       * as-is. Sending it would cost an entity and come back empty, which reads
       * downstream as "this team has no fixtures" — a wrong answer that is also
       * paid for. Reported back so it can be said out loud instead.
       */
      const providerId = providerTeamId(teamId);
      if (!providerId) {
        unmapped.push(teamId);
        continue;
      }

      const body = await this.request<{ data?: SgoEvent[] }>(
        `/events?leagueID=NFL&type=match&teamID=${encodeURIComponent(providerId)}` +
          `&startsAfter=${from}&startsBefore=${to}&oddsAvailable=true&limit=4`,
      );
      requests++;
      const events = body.data ?? [];
      entities += Math.max(1, events.length);

      for (const event of events) {
        if (!event.eventID || seen.has(event.eventID) || event.status?.cancelled) continue;
        seen.add(event.eventID);
        // Keyed by the code the caller asked with, not the id we translated to:
        // that pairing is how a rostered player's team becomes an event id, and
        // the caller only holds the one vocabulary.
        results.push({ teamId, set: this.toPropSet(event, event.eventID, wanted) });
      }
    }

    return { results, requests, entities, unmapped };
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

    /*
     * `limit=1`, not 25, and that is a quota decision as much as a correctness
     * one.
     *
     * The bill is one entity per event returned, so the old `limit=25` pair
     * cost up to fifty entities every time it ran — 1,500 a month on a daily
     * schedule, against an allowance of 2,500, for markets this provider does
     * not publish. The question being asked is "does a season-shaped event
     * exist at all", and one event answers it exactly as well as
     * twenty-five do. If one ever comes back, the limit is the thing to raise.
     */
    const props = await this.request<{ data?: SgoEvent[] }>(
      `/events?leagueID=NFL&type=prop&oddsAvailable=true&limit=1`,
    );
    events.push(...(props.data ?? []));

    // …and any event that quotes a season-length period, whatever its type.
    const seasonal = await this.request<{ data?: SgoEvent[] }>(
      `/events?leagueID=NFL&season=${encodeURIComponent(season)}&oddsAvailable=true&limit=1`,
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

/**
 * The game's own total and spread, out of the board already paid for.
 *
 * Both are read from the same `odds` map the player props come from, filtered
 * to a *game* entity rather than a player. Two rules keep this honest:
 *
 *   - the same period filter as everywhere else. A first-half total is a
 *     different question from the one a lineup is asking.
 *   - the home side decides the sign. `side1`/`home` is quoted from the home
 *     team's point of view, and a spread whose direction cannot be established
 *     is discarded rather than assumed — a game script model fed a spread with
 *     the wrong sign is worse than one fed nothing.
 */
function toGameLines(event: SgoEvent): GameLines {
  let total: number | null = null;
  let spread: number | null = null;
  let spreadTeam: string | null = null;

  // Whose spread it is, established from the event's own team map before any
  // number is read. No team, no spread.
  const teamFor = (entity: string): string | null => {
    const side = event.teams?.[entity];
    const id = side?.teamID ?? side?.names?.short ?? null;
    return id ? id.toUpperCase() : null;
  };

  for (const odd of Object.values(event.odds ?? {})) {
    if (odd.cancelled) continue;
    if (odd.periodID !== 'game') continue;
    if (odd.statID !== 'points') continue;
    if (odd.playerID) continue;
    const entity = odd.statEntityID ?? '';

    if (odd.betTypeID === 'ou' && odd.sideID === 'over' && (entity === 'all' || entity === 'game')) {
      total ??= toNumber(odd.bookOverUnder ?? odd.fairOverUnder);
      continue;
    }
    if (odd.betTypeID === 'sp' && spread == null) {
      const team = teamFor(entity);
      if (!team) continue;
      const value = toNumber(odd.bookSpread ?? odd.fairSpread ?? odd.bookOverUnder ?? odd.fairOverUnder);
      if (value == null) continue;
      spread = value;
      spreadTeam = team;
    }
  }

  return { total, spread, spreadTeam };
}

/** Lines and prices arrive as strings; anything unparseable is absent, not zero. */
function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}
