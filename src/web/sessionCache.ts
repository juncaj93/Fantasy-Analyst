/**
 * What the app already knows, kept for as long as the app is open.
 *
 * ## The problem this exists for
 *
 * Every tab in this app is mounted by `App.tsx` as `{tab === 'draft' ? <Draft/>
 * : null}`, so leaving a tab destroys the screen and everything it was holding,
 * and coming back builds a new one whose data starts at `null`. Each screen
 * then fetches on mount and renders nothing until the response lands. Measured
 * on the seeded fixture league with a fixed delay added to every `/api/` call:
 *
 *   | revisit          | +0ms  | +250ms | +600ms |
 *   | Team -> Draft    |  25ms |  276ms |  626ms |
 *   | Draft -> Team    |  26ms |  276ms |  627ms |
 *   | Team -> Players  | 244ms |  494ms |  843ms |
 *
 * The tab itself lights up in 3-11ms in every one of those. The whole of the
 * delay is between the tab lighting up and there being anything to look at, it
 * scales exactly with the round trip, and the request count per revisit is
 * fixed — which is what makes it a caching problem rather than a slow-query
 * one. On a phone, against a Worker that also has to query D1 and score a
 * board, that is the one to two seconds the app actually feels like.
 *
 * ## What it does
 *
 * Stale-while-revalidate, at the one seam every screen already goes through.
 * A repeat `GET` resolves immediately with what the app last saw, and a
 * revalidation runs behind it; when the fresh answer differs, the caller's
 * `onFresh` is invoked and the screen replaces its content. So a revisited tab
 * paints known-good state in the next frame and corrects itself quietly a round
 * trip later, instead of showing nothing for that round trip.
 *
 * **This is a cache of responses, not of decisions.** Nothing here scores,
 * ranks, tiers or projects anything — it stores what the server said and hands
 * the same bytes back. Every number in this app is still computed by the server
 * from the server's data.
 *
 * ## What it deliberately does not do
 *
 * It does not survive a reload: this is a `Map`, not storage. Persisting it
 * would be a second answer to a question `offlineCache.ts` already answers for
 * the Draft board — with a schema, an age limit and a banner that says the
 * board is a capture — and two caches disagreeing about what the last known
 * board was is worse than one round trip.
 *
 * It does not decide anything is too old to show. Age gating belongs to whoever
 * is displaying the data and knows what stale costs there; here, everything
 * cached is shown and everything shown is revalidated.
 */

/** One remembered response. */
interface Entry {
  value: unknown;
  /** Serialised, so "did the answer change" is a comparison and not a guess. */
  serialised: string;
  /** When the value was last confirmed by the server. */
  at: number;
}

/**
 * How many responses to keep.
 *
 * Every screen in the app is a handful of endpoints and the whole bar is eight
 * tabs, so this is several times what a session can reach — it is a backstop
 * against an unbounded `Map`, not a tuning knob. Paths carry league and draft
 * ids, so switching leagues writes new keys rather than overwriting old ones,
 * and this is what stops that growing forever.
 */
const MAX_ENTRIES = 48;

const entries = new Map<string, Entry>();

/**
 * Requests currently in the air, so two callers asking at once ask once.
 *
 * Team fires three requests on mount and a fast double-tap on a tab can mount
 * it twice; without this the second mount duplicates all three. Keyed the same
 * way as the cache.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Which world these responses came from.
 *
 * Demo Mode substitutes the whole data source at this seam, and two scenarios
 * share a league id — the same fixture league at two different moments — so a
 * cache keyed on the path alone would show Tuesday's board under an indicator
 * naming Wednesday. Rather than key every entry, the whole cache is dropped
 * when the world changes: it is a session cache, worlds change by hand, and
 * emptying it costs one round trip per screen.
 */
let world = '';

/** Everything the cache needs to know about how to fetch. */
export interface CacheOptions<T> {
  /**
   * Called when a background revalidation returns something different from what
   * was served from cache. Not called when the answer is unchanged, which is
   * the common case — a screen that re-rendered identically is churn nobody
   * asked for, and on Draft it would mean rebuilding four hundred rows to draw
   * the same four hundred rows.
   */
  onFresh?: (value: T) => void;
  /**
   * Called if the background revalidation fails.
   *
   * Optional, and silence is the right default: content is already on screen
   * and a failed refresh has not earned a red banner across it. Draft passes
   * one because its refresh controller is the thing that knows how to back off
   * and eventually say "sync delayed".
   */
  onStaleError?: (error: unknown) => void;
  /**
   * Skip the cache: ask the server and wait for it.
   *
   * This is what an explicit refresh means. A pull-to-refresh that returned the
   * cached answer instantly would be a lie told very quickly.
   */
  fresh?: boolean;
}

/**
 * Fetch through the cache.
 *
 * `fetcher` is the real request. This module never talks to the network itself
 * — it decides *when* the caller's fetcher runs and what to hand back in the
 * meantime, which keeps Demo Mode's substitution, credentials, error mapping
 * and every other property of the real client exactly where they already are.
 */
export function cached<T>(
  key: string,
  currentWorld: string,
  fetcher: () => Promise<T>,
  options: CacheOptions<T> = {},
): Promise<T> {
  if (currentWorld !== world) {
    world = currentWorld;
    clearSessionCache();
  }

  const entry = options.fresh ? undefined : entries.get(key);
  if (entry) {
    revalidate(key, fetcher, options, entry);
    return Promise.resolve(entry.value as T);
  }

  const pending = inFlight.get(key);
  if (pending && !options.fresh) return pending as Promise<T>;

  const run = fetcher()
    .then((value) => {
      store(key, value);
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
  inFlight.set(key, run);
  return run;
}

/**
 * Confirm a cached answer against the server, quietly.
 *
 * Deliberately fire-and-forget: the caller has already been handed the cached
 * value and has moved on. A revalidation that is already running is not started
 * again, which is what stops a rapid back-and-forth between two tabs from
 * turning one round trip per switch into several.
 */
function revalidate<T>(key: string, fetcher: () => Promise<T>, options: CacheOptions<T>, served: Entry): void {
  if (inFlight.has(key)) return;

  const run = fetcher()
    .then((value) => {
      const serialised = store(key, value);
      if (serialised !== served.serialised) options.onFresh?.(value);
      return value;
    })
    .catch((error: unknown) => {
      /*
       * The stale value stays. A failed refresh is not new truth, and dropping
       * what is on screen because a later request failed would turn a quiet
       * network problem into a blank tab — which is the exact failure this
       * whole module exists to remove.
       */
      options.onStaleError?.(error);
      return undefined as T;
    })
    .finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
  inFlight.set(key, run);
}

/** Remember a value, and report how it serialised so callers can compare. */
function store(key: string, value: unknown): string {
  const serialised = JSON.stringify(value ?? null);
  entries.delete(key);
  entries.set(key, { value, serialised, at: Date.now() });
  // Map iterates in insertion order, and the delete above re-inserts on every
  // write, so the first key is always the least recently confirmed.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
  return serialised;
}

/**
 * Forget everything.
 *
 * Called when the world changes, and after any write. A write is the one event
 * that can change an answer this cache holds without the cache hearing about
 * it, and working out *which* answers a given write invalidates would mean
 * teaching this module what every endpoint means. Dropping everything is
 * correct without that knowledge, and it costs one round trip per screen at a
 * moment when the user has just changed something and expects an update.
 */
export function clearSessionCache(): void {
  entries.clear();
  inFlight.clear();
}

/** When a key was last confirmed by the server, or null if it is not held. */
export function cachedAt(key: string): number | null {
  return entries.get(key)?.at ?? null;
}

/** How many responses are held. For tests and diagnostics. */
export function sessionCacheSize(): number {
  return entries.size;
}
