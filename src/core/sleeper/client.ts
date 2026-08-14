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
  SleeperPlayer,
  SleeperRoster,
  SleeperState,
  SleeperUser,
} from './types.ts';

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
}
