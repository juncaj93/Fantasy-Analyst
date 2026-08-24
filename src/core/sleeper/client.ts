/**
 * Sleeper API client.
 *
 * `fetch` is injected so every consumer (worker, tests, dev server) can supply
 * its own transport. No API key exists for Sleeper's public read endpoints.
 */

import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperPlayer,
  SleeperRoster,
  SleeperState,
  SleeperTransaction,
  SleeperTrendingPlayer,
  SleeperUser,
} from './types.ts';
import { sleeperProjectionPath } from './weeklyProjections.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SleeperClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** Total attempts for transient failures (5xx / network). */
  retries?: number;
}

export class SleeperError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'SleeperError';
  }
}

const DEFAULT_BASE = 'https://api.sleeper.app/v1';

export class SleeperClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly retries: number;

  constructor(opts: SleeperClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.retries = opts.retries ?? 2;
  }

  /**
   * The same client, with its transport wrapped.
   *
   * The one supported way to observe or gate this client's traffic. It exists
   * for the request budget (`core/sleeper/budget.ts`), which has to count what
   * actually goes out rather than what was asked for — a call retried twice is
   * three subrequests against Cloudflare's free-plan ceiling, and a counter
   * that sits above `get` would report one.
   *
   * Returns a new client rather than mutating this one, so a caller holding the
   * shared unmetered client keeps it. `wrap` receives the transport in force
   * here, which means wrappers compose.
   */
  withFetch(wrap: (inner: FetchLike) => FetchLike): SleeperClient {
    return new SleeperClient({ fetch: wrap(this.fetchImpl), baseUrl: this.baseUrl, retries: this.retries });
  }

  private async get<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
        if (res.status === 404) return null;
        if (res.status >= 500) {
          lastError = new SleeperError(`Sleeper ${res.status}`, res.status, url);
          continue;
        }
        if (!res.ok) throw new SleeperError(`Sleeper ${res.status}`, res.status, url);
        const text = await res.text();
        // Sleeper returns the literal `null` body for some empty resources.
        if (!text || text === 'null') return null;
        return JSON.parse(text) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof SleeperError && err.status < 500) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new SleeperError('Sleeper request failed', 0, url);
  }

  getUserByName(username: string): Promise<SleeperUser | null> {
    return this.get<SleeperUser>(`/user/${encodeURIComponent(username)}`);
  }

  async getLeaguesForUser(userId: string, season: string): Promise<SleeperLeague[]> {
    return (await this.get<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${season}`)) ?? [];
  }

  getLeague(leagueId: string): Promise<SleeperLeague | null> {
    return this.get<SleeperLeague>(`/league/${encodeURIComponent(leagueId)}`);
  }

  async getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return (await this.get<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`)) ?? [];
  }

  async getLeagueUsers(leagueId: string): Promise<SleeperUser[]> {
    return (await this.get<SleeperUser[]>(`/league/${encodeURIComponent(leagueId)}/users`)) ?? [];
  }

  async getLeagueDrafts(leagueId: string): Promise<SleeperDraft[]> {
    return (await this.get<SleeperDraft[]>(`/league/${encodeURIComponent(leagueId)}/drafts`)) ?? [];
  }

  getDraft(draftId: string): Promise<SleeperDraft | null> {
    return this.get<SleeperDraft>(`/draft/${encodeURIComponent(draftId)}`);
  }

  async getDraftPicks(draftId: string): Promise<SleeperDraftPick[]> {
    return (await this.get<SleeperDraftPick[]>(`/draft/${encodeURIComponent(draftId)}/picks`)) ?? [];
  }

  /** ~5MB payload. Sync at most once per day, never during a live draft poll. */
  async getAllPlayers(): Promise<Record<string, SleeperPlayer>> {
    return (await this.get<Record<string, SleeperPlayer>>('/players/nfl')) ?? {};
  }

  getState(): Promise<SleeperState | null> {
    return this.get<SleeperState>('/state/nfl');
  }

  /**
   * One week of a league's transactions — adds, drops, waiver claims, trades.
   *
   * Sleeper indexes these by `round`, which for an in-season league is the
   * week. There is no all-weeks endpoint, so a full history is one request per
   * week and callers are expected to bound the range themselves rather than
   * walk eighteen weeks on a page load.
   *
   * This is the only supported source of waiver bid amounts and of the FAAB
   * that changed hands in a trade.
   */
  async getTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]> {
    return (
      (await this.get<SleeperTransaction[]>(
        `/league/${encodeURIComponent(leagueId)}/transactions/${encodeURIComponent(String(week))}`,
      )) ?? []
    );
  }

  /**
   * One week of a league's head-to-head matchups, every roster in one call.
   *
   * The authoritative answer to who is playing whom, what the lineups are and
   * what the score is. It is small — one row per roster — and it is the only
   * endpoint whose numbers change while games are running, which is why the
   * scoreboard may be re-read often while everything derived from it is
   * recomputed only when this actually changes.
   *
   * A week the league has not scheduled comes back empty rather than 404, and
   * an empty list is a fact about the calendar rather than a failure.
   */
  async getMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
    return (
      (await this.get<SleeperMatchup[]>(
        `/league/${encodeURIComponent(leagueId)}/matchups/${encodeURIComponent(String(week))}`,
      )) ?? []
    );
  }

  /**
   * What all of Sleeper is adding or dropping right now.
   *
   * A market-attention signal and nothing more: it counts what other people are
   * doing, not what anybody's model thinks. `lookbackHours` and `limit` are
   * Sleeper's own bounds; both are capped here so a caller cannot turn one card
   * into a several-megabyte response.
   */
  async getTrendingPlayers(
    type: 'add' | 'drop',
    opts: { lookbackHours?: number; limit?: number } = {},
  ): Promise<SleeperTrendingPlayer[]> {
    const hours = clamp(opts.lookbackHours ?? 24, 1, 168);
    const limit = clamp(opts.limit ?? 50, 1, 200);
    return (
      (await this.get<SleeperTrendingPlayer[]>(
        `/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`,
      )) ?? []
    );
  }

  /**
   * Every player's totals for one finished regular season, in one request.
   *
   * ~2MB and about eight thousand rows, most of which are nobody. A finished
   * season stops changing, so this runs on the nightly clock beside the player
   * dictionary and never on a request path.
   */
  async getSeasonStats(season: string): Promise<Record<string, Record<string, number | null>>> {
    return (
      (await this.get<Record<string, Record<string, number | null>>>(
        `/stats/nfl/regular/${encodeURIComponent(season)}`,
      )) ?? {}
    );
  }

  /**
   * One week of published projections — Rotowire's model, distributed by Sleeper.
   *
   * The only endpoint here that does **not** live under `/v1`, so it is built
   * from the base's origin rather than by appending to it. Passing a full
   * `baseUrl` in a test still works: the origin is taken from whatever was
   * configured, so a fixture server is reached the same way the real one is.
   *
   * Returned raw. Deciding which rows are worth keeping, and which of the three
   * published totals a league is entitled to read, belongs to
   * `core/sleeper/weeklyProjections.ts` — this method only fetches.
   */
  async getWeeklyProjections(season: string, week: number): Promise<unknown> {
    const origin = new URL(this.baseUrl).origin;
    const url = `${origin}${sleeperProjectionPath(season, week)}`;
    return this.getAbsolute<unknown>(url);
  }

  /** `get`, for the one resource that is not under the versioned base. */
  private async getAbsolute<T>(url: string): Promise<T | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
        if (res.status === 404) return null;
        if (res.status >= 500) {
          lastError = new SleeperError(`Sleeper ${res.status}`, res.status, url);
          continue;
        }
        if (!res.ok) throw new SleeperError(`Sleeper ${res.status}`, res.status, url);
        const text = await res.text();
        if (!text || text === 'null') return null;
        return JSON.parse(text) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof SleeperError && err.status < 500) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new SleeperError('Sleeper request failed', 0, url);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
