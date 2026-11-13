/**
 * Two more free odds sources, feeding the per-book average (Round 23, steps 3
 * and 4).
 *
 *   - **TheRundown** (free tier): game totals and spreads from BetMGM,
 *     DraftKings and FanDuel, one request per game date. No player props on the
 *     free tier, so none are asked for.
 *   - **The Odds API** (free tier, 500 credits a month): game totals and spreads
 *     for the whole slate in one request (2 credits), and player props one game
 *     at a time (about one credit per market returned).
 *
 * Both are off unless their key is set (`THERUNDOWN_API_KEY`, `ODDS_API_KEY`).
 * A source with no key is skipped quietly: nothing is asked, nothing breaks.
 *
 * Every number leaves here in the app's vocabulary: team codes as Sleeper
 * writes them, books by name, one {@link GameBookLine} per book per game. The
 * averaging and storing happen elsewhere (`combine.ts`, `server/services/lookStore.ts`).
 *
 * Keys travel only in the request (a header for TheRundown, the query string
 * for The Odds API, which is how that provider takes it) and never into a
 * message, an error or a log.
 */

import { nflTeamCode } from '../nfl/teams.ts';
import type { GameBookLine } from './combine.ts';
import type { MarketKey, RawPropQuote } from './types.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One game as a source saw it: its two sides, its kickoff and each book's lines. */
export interface ExternalGame {
  /** Both sides, app codes ("LAC", "BAL"). */
  teams: [string, string];
  kickoff: string;
  books: GameBookLine[];
  /** The source's own id for the game, for a follow-up request (props). */
  sourceId?: string;
}

export interface SourceAnswer<T> {
  value: T;
  requests: number;
  /** In the source's own unit: TheRundown data points, The Odds API credits. */
  cost: number;
  /** What the source says is left this period, when it says. */
  remaining: number | null;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/** Book names folded onto the ones SportsGameOdds uses, so one book is one vote. */
const BOOK_ALIASES: Record<string, string> = {
  williamhillus: 'caesars',
  williamhill: 'caesars',
  caesarssportsbook: 'caesars',
  betmgmsportsbook: 'betmgm',
  mgm: 'betmgm',
  draftkingssportsbook: 'draftkings',
  fanduelsportsbook: 'fanduel',
  espnbet: 'espnbet',
};

export function canonicalBook(name: string): string {
  const key = (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return BOOK_ALIASES[key] ?? key;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ TheRundown

/** TheRundown's id for the NFL. */
const RUNDOWN_NFL = 2;

/**
 * TheRundown writes "no line" as 0.0001 (and sometimes 0) rather than leaving
 * the field out. A real total is never under 10 and a spread of exactly zero
 * is a pick'em that the moneyline already says; neither is worth guessing at.
 */
function rundownValue(value: unknown): number | null {
  const n = num(value);
  if (n == null || Math.abs(n) < 0.01) return null;
  return n;
}

interface RundownTeam {
  name?: string;
  mascot?: string;
  abbreviation?: string;
  is_home?: boolean;
  is_away?: boolean;
}

interface RundownLine {
  affiliate?: { affiliate_name?: string; affiliate_id?: number };
  spread?: { point_spread_home?: number | string; point_spread_away?: number | string };
  total?: { total_over?: number | string };
}

interface RundownEvent {
  event_id?: string;
  event_date?: string;
  teams_normalized?: RundownTeam[];
  teams?: RundownTeam[];
  lines?: Record<string, RundownLine>;
}

export interface RundownOptions {
  apiKey: string | null | undefined;
  fetch?: FetchLike;
  baseUrl?: string;
  /** How to pause between requests; tests pass a fake clock. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * TheRundown's free tier allows one request a second (`x-rate-limit: 1`), so
 * dates are asked a little over a second apart, and a 429 gets one more try
 * after two seconds. A pass asks for two or three dates, so this adds a few
 * seconds of waiting, not work.
 */
const RUNDOWN_GAP_MS = 1_100;
const RUNDOWN_RETRY_MS = 2_000;

export class TheRundownSource {
  readonly name = 'therundown';
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(opts: RundownOptions) {
    this.apiKey = opts.apiKey?.trim() || null;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? 'https://therundown.io/api/v1').replace(/\/$/, '');
    this.wait = opts.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  isConfigured(): boolean {
    return this.apiKey != null;
  }

  /**
   * The NFL games on each Eastern date, with each book's total and spread.
   * One request per date. `offsetMinutes` is how far Eastern time is behind UTC
   * that day (300 in winter), which is how TheRundown is told whose calendar a
   * date is on.
   */
  async gameLines(dates: readonly { date: string; offsetMinutes: number }[]): Promise<SourceAnswer<ExternalGame[]>> {
    if (!this.apiKey) throw new SourceError('no key', this.name);
    const games: ExternalGame[] = [];
    let requests = 0;
    let cost = 0;
    let remaining: number | null = null;
    for (const { date, offsetMinutes } of dates) {
      const url = `${this.baseUrl}/sports/${RUNDOWN_NFL}/events/${encodeURIComponent(date)}?offset=${offsetMinutes}`;
      if (requests > 0) await this.wait(RUNDOWN_GAP_MS);
      const ask = async (): Promise<Response> => {
        try {
          return await this.fetchImpl(url, { headers: { 'X-TheRundown-Key': this.apiKey!, accept: 'application/json' } });
        } catch (err) {
          throw new SourceError(`network error: ${err instanceof Error ? err.message : String(err)}`, this.name);
        }
      };
      let res = await ask();
      requests++;
      if (res.status === 429) {
        await this.wait(RUNDOWN_RETRY_MS);
        res = await ask();
      }
      if (!res.ok) throw new SourceError(`HTTP ${res.status}`, this.name, res.status);
      const points = num(res.headers.get('x-datapoints') ?? res.headers.get('x-datapoints-used'));
      if (points != null) cost += points;
      const left = num(res.headers.get('x-datapoints-remaining') ?? res.headers.get('x-ratelimit-remaining'));
      if (left != null) remaining = left;
      let body: { events?: RundownEvent[] };
      try {
        body = (await res.json()) as { events?: RundownEvent[] };
      } catch {
        throw new SourceError('answer was not JSON', this.name);
      }
      const at = new Date().toISOString();
      for (const event of body.events ?? []) {
        const game = rundownGame(event, at);
        if (game) games.push(game);
      }
    }
    return { value: games, requests, cost, remaining };
  }
}

/** One TheRundown event as an {@link ExternalGame}, or null when its sides cannot be named. */
export function rundownGame(event: RundownEvent, at: string): ExternalGame | null {
  const sides = event.teams_normalized ?? event.teams ?? [];
  const code = (t: RundownTeam | undefined) =>
    t ? nflTeamCode(t.abbreviation) || nflTeamCode([t.name, t.mascot].filter(Boolean).join(' ')) || nflTeamCode(t.mascot) : '';
  // The live answer may carry only `is_home`, so the away side is the other one.
  const homeSide = sides.find((t) => t.is_home === true);
  const home = code(homeSide);
  const away = code(sides.find((t) => t.is_away === true) ?? sides.find((t) => t !== homeSide));
  if (!home || !away || !event.event_date) return null;
  const books: GameBookLine[] = [];
  for (const [id, line] of Object.entries(event.lines ?? {})) {
    const book = canonicalBook(line.affiliate?.affiliate_name ?? `rundown-${id}`);
    const total = rundownValue(line.total?.total_over);
    const homeSpread = rundownValue(line.spread?.point_spread_home);
    if (total == null && homeSpread == null) continue;
    books.push({ book, total, spread: homeSpread, spreadTeam: homeSpread == null ? null : home, at, source: 'therundown' });
  }
  return { teams: [home, away], kickoff: new Date(event.event_date).toISOString(), books, sourceId: event.event_id };
}

// ------------------------------------------------------------------ The Odds API

/** Our market -> The Odds API's player market key. */
export const ODDS_API_PROP_MARKETS: Record<MarketKey, string> = {
  pass_yards: 'player_pass_yds',
  pass_tds: 'player_pass_tds',
  rush_yards: 'player_rush_yds',
  receptions: 'player_receptions',
  receiving_yards: 'player_reception_yds',
  anytime_td: 'player_anytime_td',
};
const INBOUND_PROP: Record<string, MarketKey> = Object.fromEntries(
  Object.entries(ODDS_API_PROP_MARKETS).map(([ours, theirs]) => [theirs, ours as MarketKey]),
);

interface OddsApiOutcome {
  name?: string;
  description?: string;
  price?: number;
  point?: number;
}
interface OddsApiEvent {
  id?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: { key?: string; title?: string; markets?: { key?: string; outcomes?: OddsApiOutcome[] }[] }[];
}

export interface OddsApiExtraOptions {
  apiKey: string | null | undefined;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class OddsApiExtraSource {
  readonly name = 'the-odds-api';
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: OddsApiExtraOptions) {
    this.apiKey = opts.apiKey?.trim() || null;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? 'https://api.the-odds-api.com/v4').replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return this.apiKey != null;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<{ body: T; cost: number; remaining: number | null }> {
    if (!this.apiKey) throw new SourceError('no key', this.name);
    const query = new URLSearchParams({ ...params, apiKey: this.apiKey }).toString();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}?${query}`, { headers: { accept: 'application/json' } });
    } catch (err) {
      // The message of a failed fetch can carry the URL, and the URL carries the key.
      void err;
      throw new SourceError('network error', this.name);
    }
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`, this.name, res.status);
    const cost = num(res.headers.get('x-requests-last')) ?? 0;
    const remaining = num(res.headers.get('x-requests-remaining'));
    try {
      return { body: (await res.json()) as T, cost, remaining };
    } catch {
      throw new SourceError('answer was not JSON', this.name);
    }
  }

  /** Totals and spreads for every upcoming NFL game, in one request (2 credits). */
  async gameLines(): Promise<SourceAnswer<ExternalGame[]>> {
    const { body, cost, remaining } = await this.get<OddsApiEvent[]>('/sports/americanfootball_nfl/odds', {
      regions: 'us',
      markets: 'totals,spreads',
      oddsFormat: 'american',
      dateFormat: 'iso',
    });
    const at = new Date().toISOString();
    const games: ExternalGame[] = [];
    for (const event of Array.isArray(body) ? body : []) {
      const home = nflTeamCode(event.home_team);
      const away = nflTeamCode(event.away_team);
      if (!home || !away || !event.commence_time) continue;
      const books: GameBookLine[] = [];
      for (const bm of event.bookmakers ?? []) {
        let total: number | null = null;
        let spread: number | null = null;
        for (const market of bm.markets ?? []) {
          if (market.key === 'totals') {
            total = num(market.outcomes?.find((o) => (o.name ?? '').toLowerCase() === 'over')?.point);
          } else if (market.key === 'spreads') {
            spread = num(market.outcomes?.find((o) => nflTeamCode(o.name) === home)?.point);
          }
        }
        if (total == null && spread == null) continue;
        books.push({ book: canonicalBook(bm.key ?? bm.title ?? ''), total, spread, spreadTeam: spread == null ? null : home, at, source: this.name });
      }
      games.push({ teams: [home, away], kickoff: new Date(event.commence_time).toISOString(), books, sourceId: event.id });
    }
    return { value: games, requests: 1, cost, remaining };
  }

  /**
   * Player props for one game, one quote per book per player per market.
   * Billed about one credit per market returned, so only the markets asked for.
   */
  async playerProps(oddsEventId: string, markets: readonly MarketKey[]): Promise<SourceAnswer<RawPropQuote[]>> {
    const wanted = markets.map((m) => ODDS_API_PROP_MARKETS[m]).join(',');
    const { body, cost, remaining } = await this.get<OddsApiEvent>(
      `/sports/americanfootball_nfl/events/${encodeURIComponent(oddsEventId)}/odds`,
      { regions: 'us', markets: wanted, oddsFormat: 'american', dateFormat: 'iso' },
    );
    return { value: oddsApiQuotes(body), requests: 1, cost, remaining };
  }
}

/** The over side of every player market in one event's answer, one quote per book. */
export function oddsApiQuotes(event: OddsApiEvent): RawPropQuote[] {
  const quotes: RawPropQuote[] = [];
  for (const bm of event?.bookmakers ?? []) {
    const book = canonicalBook(bm.key ?? bm.title ?? '');
    for (const market of bm.markets ?? []) {
      const ours = INBOUND_PROP[market.key ?? ''];
      if (!ours) continue;
      for (const o of market.outcomes ?? []) {
        const side = (o.name ?? '').toLowerCase();
        const player = (o.description ?? '').trim();
        if (!player) continue;
        // Anytime touchdown is quoted Yes/No with no point; the rest Over/Under.
        if (ours === 'anytime_td' ? side !== 'yes' && side !== 'over' : side !== 'over') continue;
        quotes.push({
          playerName: player,
          market: ours,
          line: ours === 'anytime_td' ? (num(o.point) ?? 0.5) : num(o.point),
          overPrice: num(o.price),
          underPrice: null,
          book,
        });
      }
    }
  }
  return quotes;
}
