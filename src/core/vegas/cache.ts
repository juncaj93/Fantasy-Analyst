/**
 * Vegas fetch policy: aggressive caching, quota protection, stale fallback.
 *
 * The app never polls continuously. A refresh is permitted only when:
 *   - there is no cached snapshot, or
 *   - the cached snapshot is older than the TTL for its scheduled window, or
 *   - the user asked for a manual refresh and the cooldown has elapsed.
 *
 * On any provider failure (quota, auth, network) the last cached snapshot is
 * returned and explicitly marked stale — never fabricated, never empty.
 */

import { manualRefreshThresholdMinutes } from './staleness.ts';
import { isRateLimited, type RawPropSet, type VegasProvider } from './types.ts';

export interface CachedSnapshot {
  provider: string;
  eventId: string;
  gameStart: string;
  fetchedAt: string;
  raw: RawPropSet;
}

export interface SnapshotStore {
  get(eventId: string): Promise<CachedSnapshot | null>;
  put(snapshot: CachedSnapshot): Promise<void>;
}

export interface RefreshPolicy {
  /** Normal cache lifetime in minutes. */
  ttlMinutes: number;
  /** Shorter TTL once kickoff is close (inside `nearGameHours`). */
  nearGameTtlMinutes: number;
  nearGameHours: number;
  /** Minimum gap between user-triggered refreshes of the same event. */
  manualCooldownMinutes: number;
}

export const DEFAULT_POLICY: RefreshPolicy = {
  // Scheduled cadence is Saturday evening + Sunday morning; a 6h TTL means an
  // out-of-band request between those runs is served from cache.
  ttlMinutes: 360,
  nearGameTtlMinutes: 90,
  nearGameHours: 6,
  manualCooldownMinutes: 15,
};

export type PropsOrigin = 'fresh' | 'cache' | 'stale_cache' | 'unavailable';

export interface PropsResult {
  origin: PropsOrigin;
  /** Null only when nothing has ever been cached and the fetch failed. */
  snapshot: CachedSnapshot | null;
  /** True whenever the data shown is not known to be current. */
  stale: boolean;
  /** Age of the returned data in minutes, or null when unavailable. */
  ageMinutes: number | null;
  /** Present when a fetch was attempted and failed. */
  error: string | null;
  /**
   * The failure was a refusal — "not now" — and was not billed. Set only on a
   * failed fetch. See `isRateLimited`.
   */
  rateLimited?: boolean;
  /** Why the layer did what it did — surfaced in the UI freshness badge. */
  reason: string;
}

function minutesBetween(a: string, b: number): number {
  const t = Date.parse(a);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (b - t) / 60_000;
}

/** Decide whether a refresh is allowed right now. */
export function shouldRefresh(
  cached: CachedSnapshot | null,
  opts: { now: number; manual?: boolean; perGame?: boolean; kickoff?: string | null; policy?: RefreshPolicy },
): { refresh: boolean; reason: string } {
  const policy = opts.policy ?? DEFAULT_POLICY;
  if (!cached) return { refresh: true, reason: 'no cached snapshot' };

  const age = minutesBetween(cached.fetchedAt, opts.now);
  /*
   * The scheduled kickoff job judges staleness by the same per-game table a
   * person's tap does. The TTL below is the old weekend clock's rule: its
   * ninety-minute near-game wait would quietly cancel the half-hour checkpoint,
   * and its six-hour wait the second of two passes a few hours apart.
   */
  if (opts.perGame && !opts.manual) {
    // The caller's kickoff when it has a better one: a game the league moved
    // is still stored under the provider's old time until it is bought again.
    const wait = manualRefreshThresholdMinutes((Date.parse(opts.kickoff ?? cached.gameStart) - opts.now) / 3_600_000);
    if (wait === null) return { refresh: false, reason: 'game has started; the line is closed' };
    if (age < wait) return { refresh: false, reason: `lines are ${Math.round(age)} min old, under this game's ${wait} min wait` };
    return { refresh: true, reason: 'due on the kickoff clock' };
  }
  if (opts.manual) {
    // Per game, by time to kickoff; see `manualRefreshThresholdMinutes`.
    const wait = manualRefreshThresholdMinutes((Date.parse(cached.gameStart) - opts.now) / 3_600_000);
    if (wait === null) return { refresh: false, reason: 'game has started; the line is closed' };
    if (age < wait) {
      return {
        refresh: false,
        reason: `manual refresh on cooldown (${Math.ceil(wait - age)} min left)`,
      };
    }
    return { refresh: true, reason: 'manual refresh' };
  }

  const hoursToKickoff = (Date.parse(cached.gameStart) - opts.now) / 3_600_000;
  const ttl =
    Number.isFinite(hoursToKickoff) && hoursToKickoff <= policy.nearGameHours && hoursToKickoff > 0
      ? policy.nearGameTtlMinutes
      : policy.ttlMinutes;

  if (age >= ttl) return { refresh: true, reason: `cache older than ${ttl} min` };
  return { refresh: false, reason: `cache fresh (${Math.round(age)} min old)` };
}

/**
 * Fetch props for an event through the cache.
 * Never throws: provider failures degrade to the cached snapshot.
 */
export async function getPropsWithCache(
  eventId: string,
  provider: VegasProvider,
  store: SnapshotStore,
  opts: { now?: number; manual?: boolean; perGame?: boolean; kickoff?: string | null; policy?: RefreshPolicy } = {},
): Promise<PropsResult> {
  const now = opts.now ?? Date.now();
  const cached = await store.get(eventId);

  if (!provider.isConfigured()) {
    return cached
      ? {
          origin: 'stale_cache',
          snapshot: cached,
          stale: true,
          ageMinutes: Math.round(minutesBetween(cached.fetchedAt, now)),
          error: null,
          reason: `provider "${provider.name}" is not configured; serving cached data`,
        }
      : {
          origin: 'unavailable',
          snapshot: null,
          stale: true,
          ageMinutes: null,
          error: null,
          reason: `provider "${provider.name}" is not configured and nothing is cached`,
        };
  }

  const decision = shouldRefresh(cached, {
    now,
    manual: opts.manual ?? false,
    perGame: opts.perGame ?? false,
    kickoff: opts.kickoff ?? null,
    policy: opts.policy,
  });
  if (!decision.refresh && cached) {
    return {
      origin: 'cache',
      snapshot: cached,
      stale: false,
      ageMinutes: Math.round(minutesBetween(cached.fetchedAt, now)),
      error: null,
      reason: decision.reason,
    };
  }

  try {
    const raw = await provider.getPlayerProps(eventId);
    const snapshot: CachedSnapshot = {
      provider: provider.name,
      eventId,
      gameStart: raw.gameStart,
      fetchedAt: raw.fetchedAt || new Date(now).toISOString(),
      raw,
    };
    await store.put(snapshot);
    return {
      origin: 'fresh',
      snapshot,
      stale: false,
      ageMinutes: 0,
      error: null,
      reason: decision.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refused = isRateLimited(err) ? { rateLimited: true } : {};
    if (cached) {
      return {
        ...refused,
        origin: 'stale_cache',
        snapshot: cached,
        stale: true,
        ageMinutes: Math.round(minutesBetween(cached.fetchedAt, now)),
        error: message,
        reason: `provider failed (${message}); serving last cached snapshot`,
      };
    }
    return {
      ...refused,
      origin: 'unavailable',
      snapshot: null,
      stale: true,
      ageMinutes: null,
      error: message,
      reason: `provider failed (${message}) and nothing is cached`,
    };
  }
}
