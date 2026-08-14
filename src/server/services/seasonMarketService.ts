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
import { canSpend } from '../../core/vegas/budget.ts';
import type { SeasonMarketSet, VegasProvider } from '../../core/vegas/types.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import { VegasUsageRepo } from '../repos/vegasUsage.ts';
import type { Database } from '../db.ts';

/**
 * What one season probe costs.
 *
 * Two requests, each capped at a single event, so two entities — down from the
 * fifty a `limit=25` pair used to cost. On a daily schedule that is the
 * difference between 60 entities a month and 1,500 of a 2,500 allowance, spent
 * on markets this provider does not publish.
 */
export const SEASON_PROBE_ENTITIES = 2;

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
  private readonly usage: VegasUsageRepo;

  constructor(
    private readonly db: Database,
    private readonly provider: VegasProvider,
  ) {
    this.markets = new SeasonMarketsRepo(db);
    this.players = new PlayerRepo(db);
    this.usage = new VegasUsageRepo(db);
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

    /*
     * Draft-time context stops being worth quota once the draft is over.
     *
     * From then on the same allowance is what the weekly Start/Sit layer runs
     * on, and a season total nobody is drafting against is the cheapest thing
     * in the app to stop paying for.
     */
    if (!opts.force && (await this.draftIsDone())) {
      return base({ reason: 'the draft is complete, so season-long markets are no longer refreshed' });
    }

    // Small, but it is quota, and quota is spent in one place or it is not
    // guarded at all.
    const view = await this.usage.view();
    const decision = canSpend(view, { entities: SEASON_PROBE_ENTITIES, priority: 'low' });
    if (!decision.allowed) {
      await this.usage.record({
        source: 'season',
        entities: 0,
        requests: 0,
        outcome: 'blocked',
        reason: decision.reason,
      });
      return base({ reason: `not fetched: ${decision.reason}` });
    }

    let set: SeasonMarketSet;
    try {
      set = await this.provider.getSeasonPlayerMarkets(season);
      await this.usage.record({
        source: 'season',
        entities: SEASON_PROBE_ENTITIES,
        requests: 2,
        outcome: 'fetched',
        reason: 'season-market probe',
      });
    } catch (err) {
      await this.usage.record({
        source: 'season',
        entities: SEASON_PROBE_ENTITIES,
        requests: 2,
        outcome: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      });
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

  /**
   * Is the selected league's draft finished?
   *
   * Sleeper's own status is the source of truth. Anything unexpected counts as
   * "not finished", because the cost of being wrong in that direction is two
   * entities and the cost of being wrong in the other is a draft board with no
   * market context on the one day it matters.
   */
  private async draftIsDone(): Promise<boolean> {
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    if (!league?.draftId) return false;
    const draft = await new LeagueRepo(this.db).getDraft(league.draftId);
    return draft?.status === 'complete';
  }

  /** The stored lines for a set of players, newest snapshot only. */
  async linesFor(playerIds: string[], now: Date = new Date()) {
    return this.markets.latestForPlayers(seasonFor(now), playerIds);
  }
}
