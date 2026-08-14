/**
 * Season-long market refresh.
 *
 * Draft-time market context, on a deliberately slow clock. A season total does
 * not move minute to minute, the free plan is metered, and the weekly Start/Sit
 * layer will need most of that allowance once games start — so this fetches at
 * most once a day, records what it cost, and serves the last good snapshot the
 * rest of the time.
 *
 * It never invents. A provider that publishes no season markets produces an
 * empty snapshot carrying the reason it was empty, which is a different fact
 * from a failed request and is shown as such.
 */

import { resolveSeasonMarkets } from '../../core/vegas/season.ts';
import type { SeasonMarketSet, VegasProvider } from '../../core/vegas/types.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import type { Database } from '../db.ts';

/**
 * How long a stored season snapshot is considered current.
 *
 * A day. Season lines move over weeks, and every fetch is quota a live Sunday
 * will want back.
 */
export const SEASON_TTL_MINUTES = 24 * 60;

export interface SeasonRefreshResult {
  provider: string;
  season: string;
  /** Whether the provider was actually asked this time. */
  fetched: boolean;
  quotes: number;
  players: number;
  unresolved: number;
  fetchedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  /** Why it did what it did — surfaced verbatim in Setup. */
  reason: string;
  error: string | null;
}

/** The NFL season a date belongs to: the league year rolls over in March. */
export function seasonFor(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  return String(now.getUTCMonth() >= 2 ? year : year - 1);
}

export class SeasonMarketService {
  private readonly markets: SeasonMarketsRepo;
  private readonly players: PlayerRepo;

  constructor(
    db: Database,
    private readonly provider: VegasProvider,
  ) {
    this.markets = new SeasonMarketsRepo(db);
    this.players = new PlayerRepo(db);
  }

  /**
   * Refresh if the stored snapshot is older than the TTL, or if asked to.
   *
   * `force` still respects the provider being unconfigured — there is nothing
   * to force when there is no key.
   */
  async refresh(opts: { force?: boolean; now?: Date } = {}): Promise<SeasonRefreshResult> {
    const now = opts.now ?? new Date();
    const season = seasonFor(now);
    const existing = await this.markets.latestSnapshot(season);
    const ageMinutes = existing ? Math.round((now.getTime() - Date.parse(existing.fetchedAt)) / 60_000) : null;

    const base = async (over: Partial<SeasonRefreshResult>): Promise<SeasonRefreshResult> => {
      const coverage = await this.markets.coverage(season);
      return {
        provider: this.provider.name,
        season,
        fetched: false,
        quotes: coverage.quotes,
        players: coverage.players,
        unresolved: coverage.unresolved,
        fetchedAt: existing?.fetchedAt ?? null,
        ageMinutes,
        stale: ageMinutes == null ? true : ageMinutes > SEASON_TTL_MINUTES,
        reason: '',
        error: null,
        ...over,
      };
    };

    if (typeof this.provider.getSeasonPlayerMarkets !== 'function') {
      return base({ reason: `${this.provider.name} has no season-long market support` });
    }
    if (!this.provider.isConfigured()) {
      return base({ reason: `${this.provider.name} is not configured, so nothing was fetched` });
    }
    if (!opts.force && ageMinutes != null && ageMinutes <= SEASON_TTL_MINUTES) {
      return base({ reason: `served from the snapshot taken ${ageMinutes} minute(s) ago` });
    }

    let set: SeasonMarketSet;
    try {
      set = await this.provider.getSeasonPlayerMarkets(season);
    } catch (err) {
      // The last good snapshot stays exactly where it is.
      return base({
        error: err instanceof Error ? err.message : String(err),
        reason: existing
          ? `fetch failed; showing the snapshot from ${existing.fetchedAt}`
          : 'fetch failed and nothing has ever been stored',
      });
    }

    const index = await this.players.buildIndex();
    const resolved = resolveSeasonMarkets(set.quotes, index);
    await this.markets.saveSnapshot(set, resolved);

    const coverage = await this.markets.coverage(season);
    return {
      provider: set.provider,
      season,
      fetched: true,
      quotes: coverage.quotes,
      players: coverage.players,
      unresolved: coverage.unresolved,
      fetchedAt: set.fetchedAt,
      ageMinutes: 0,
      stale: false,
      reason: set.note ?? `fetched ${resolved.length} season market(s)`,
      error: null,
    };
  }

  /** What is stored right now, without asking the provider anything. */
  async status(now: Date = new Date()): Promise<SeasonRefreshResult> {
    const season = seasonFor(now);
    const existing = await this.markets.latestSnapshot(season);
    const coverage = await this.markets.coverage(season);
    const ageMinutes = existing ? Math.round((now.getTime() - Date.parse(existing.fetchedAt)) / 60_000) : null;
    return {
      provider: existing?.provider ?? this.provider.name,
      season,
      fetched: false,
      quotes: coverage.quotes,
      players: coverage.players,
      unresolved: coverage.unresolved,
      fetchedAt: existing?.fetchedAt ?? null,
      ageMinutes,
      stale: ageMinutes == null ? true : ageMinutes > SEASON_TTL_MINUTES,
      reason: existing?.note ?? (existing ? 'stored' : 'nothing stored yet'),
      error: null,
    };
  }

  /** The stored lines for a set of players, newest snapshot only. */
  async linesFor(playerIds: string[], now: Date = new Date()) {
    return this.markets.latestForPlayers(seasonFor(now), playerIds);
  }
}
