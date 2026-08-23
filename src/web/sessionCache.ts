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
 *
 * ## Worlds
 *
 * Demo Mode swaps the data source for the whole app, and two scenarios share a
 * league id, so a cache keyed on the path alone would hand Tuesday's board to a
 * screen labelled Wednesday. Two separate things keep that from happening, and
 * both are needed:
 *
 * **Completions are checked, not just started.** This is the one that had to be
 * added and the one everything rests on. A request captures the world and the
 * cache generation it was launched in, and both are checked again when it
 * lands. A request that outlives its world is dropped on arrival: it does not
 * store, it does not call `onFresh`, it does not call `onStaleError`, and the
 * promise handed to whoever asked for it never settles at all. There is no
 * correct answer to give a caller whose world no longer exists, and silence is
 * the only one that cannot be mistaken for the new world's truth.
 *
 * Emptying the maps on a switch is not a substitute for that, which is the bug
 * this shape exists to close: a clear only removes what has already arrived,
 * and a request still in the air a moment later wrote straight back into the
 * emptied cache, under a path-shaped key the new world was about to ask for.
 * The maps are still emptied, because Demo Mode promises that no byte of
 * fixture data outlives the scenario that produced it — but that is a promise
 * about memory, not the thing that makes the cache correct.
 *
 * **Keys carry the world.** Every entry and every in-flight promise is filed
 * under the world that asked for it. Given the clear above this is belt and
 * braces — with both in place no test can tell the two apart, and it is worth
 * saying so rather than implying it is load-bearing. What it buys is that
 * correctness here does not depend on the emptying having happened: two worlds
 * cannot read each other's answers or share one request even if some later
 * change makes the clear conditional, partial, or late.
 */

import { currentWorld, noteWorld, subscribeToWorld } from './world.ts';

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
 * against an unbounded `Map`, not a tuning knob. Keys carry the world and the
 * league and draft ids, so switching between any of them writes new keys rather
 * than overwriting old ones, and this is what stops that growing forever.
 */
const MAX_ENTRIES = 48;

const entries = new Map<string, Entry>();

/**
 * Requests currently in the air, so two callers asking at once ask once.
 *
 * Team fires three requests on mount and a fast double-tap on a tab can mount
 * it twice; without this the second mount duplicates all three. Keyed the same
 * way as the cache, which means keyed by world as well as by path — sharing one
 * request between two worlds would be handing one world the other's answer, and
 * de-duplication is not worth that.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * How many times the contents of this cache have stopped being trustworthy.
 *
 * Bumped by every clear, which is to say by every world change and by every
 * write. A request records this when it starts and it is checked when the
 * request lands, so an answer that was already in the air when the ground moved
 * cannot be filed as though it were current.
 *
 * A world change is the severe case and is handled separately below. This
 * counter is what covers the quieter one: a `POST` empties the cache precisely
 * because a write can change an answer held here, and a `GET` that was already
 * running would otherwise put the pre-write answer back a moment later.
 *
 * A number, so there is nothing to grow. Generations are compared, never kept.
 */
let generation = 0;

/**
 * The key a response is actually filed under.
 *
 * The world first, separated by a character no path contains, so that the same
 * path in two worlds is two keys rather than one contested one. A demo scenario
 * reusing a live league or draft id — which they all do, deliberately — cannot
 * therefore reach a live answer, and two scenarios cannot reach each other's,
 * whatever else is or is not true of the maps at the time.
 */
function scoped(world: string, key: string): string {
  return `${world}\u0000${key}`;
}

/**
 * Whether a request that started in this world and generation may still speak.
 *
 * The whole of the invariant, in one place: an answer may become current truth
 * only if the ground it was launched from is still the ground the app is
 * standing on.
 */
function stillCurrent(startWorld: string, startGeneration: number): boolean {
  return startWorld === currentWorld() && startGeneration === generation;
}

/**
 * Everything the cache holds was produced by a world that is no longer running.
 *
 * Emptying it is the cheap half of a world change and it is not the half that
 * matters — see the module note. Registered here rather than called by whoever
 * switches worlds so that there is no order to get wrong: the marker moves, and
 * this cache has already forgotten by the time anything can ask it a question.
 */
subscribeToWorld(() => {
  clearSessionCache();
});

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
  world: string,
  fetcher: () => Promise<T>,
  options: CacheOptions<T> = {},
): Promise<T> {
  /*
   * Announced rather than assumed.
   *
   * Whoever owns the world normally moves the marker at the moment of the
   * switch, and the subscription above has already emptied this cache by the
   * time anything asks. Telling it again here costs a string comparison and
   * means a caller that knows which world it is in is never wrong about it,
   * whether or not anybody remembered to announce the change.
   *
   * The contract that comes with that: `world` is the world in force *now*,
   * read at the call. `api.get` asks the marker on every request, which is
   * what makes this a comparison that always matches in production. A caller
   * that captured the world earlier and passed it later would be telling this
   * module the app had gone back, and it would be believed.
   */
  noteWorld(world);

  const startWorld = currentWorld();
  const startGeneration = generation;
  const id = scoped(startWorld, key);

  const entry = options.fresh ? undefined : entries.get(id);
  if (entry) {
    revalidate(id, startWorld, startGeneration, fetcher, options, entry);
    /*
     * Guarded like every other answer, even though this one needs no network.
     *
     * A cached value is handed over a microtask later than it is read, and a
     * world can change inside a microtask. The rule is worth more when it has
     * no exceptions: nothing leaves this module into a world that is not the
     * one that asked.
     */
    return onlyWhile(startWorld, Promise.resolve(entry.value as T));
  }

  const pending = inFlight.get(id);
  if (pending && !options.fresh) return onlyWhile(startWorld, pending as Promise<T>);

  const run = fetcher()
    .then((value) => {
      if (stillCurrent(startWorld, startGeneration)) store(id, value);
      return value;
    })
    .finally(() => {
      if (inFlight.get(id) === run) inFlight.delete(id);
    });
  inFlight.set(id, run);
  return onlyWhile(startWorld, run);
}

/**
 * Deliver this answer only if the world that asked for it is still running.
 *
 * The returned promise never settles otherwise — it does not resolve, and it
 * does not reject. That is deliberate and it is the only honest option. The
 * caller asked a question of a data source that has since been replaced; there
 * is no value that is a true answer for the world now on screen, and an error
 * is not one either. A rejection would travel into a `catch` written for a
 * failed network call and paint a banner over a world that is working fine, or
 * into a `finally` that would clear a loading flag for the screen that replaced
 * it. Silence is the one outcome no caller can act on wrongly.
 *
 * Nothing is retained by dropping the answer: the promise holds its own
 * continuations, and once whoever was waiting on it is gone — an unmounted
 * screen, a superseded effect — the whole chain is unreachable and collected.
 *
 * The rejection handler is attached in both cases, so a fetcher that failed in
 * a world that has since ended is still considered handled and never surfaces
 * as an unhandled rejection.
 */
function onlyWhile<T>(startWorld: string, run: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    run.then(
      (value) => {
        if (startWorld === currentWorld()) resolve(value);
      },
      (error: unknown) => {
        if (startWorld === currentWorld()) reject(error);
      },
    );
  });
}

/**
 * Confirm a cached answer against the server, quietly.
 *
 * Deliberately fire-and-forget: the caller has already been handed the cached
 * value and has moved on. A revalidation that is already running is not started
 * again, which is what stops a rapid back-and-forth between two tabs from
 * turning one round trip per switch into several.
 */
function revalidate<T>(
  id: string,
  startWorld: string,
  startGeneration: number,
  fetcher: () => Promise<T>,
  options: CacheOptions<T>,
  served: Entry,
): void {
  if (inFlight.has(id)) return;

  const run = fetcher()
    .then((value) => {
      /*
       * A confirmation of something nobody is looking at any more.
       *
       * Both halves are dropped together on purpose. Storing without calling
       * `onFresh` would leave the cache holding an answer the screen does not
       * show, and calling `onFresh` without storing would push a value onto a
       * screen that the next read would contradict. Neither is a state worth
       * being in, and for a world that has ended neither is even wanted.
       */
      if (!stillCurrent(startWorld, startGeneration)) return undefined as T;
      const serialised = store(id, value);
      if (serialised !== served.serialised) options.onFresh?.(value);
      return value;
    })
    .catch((error: unknown) => {
      /*
       * The stale value stays. A failed refresh is not new truth, and dropping
       * what is on screen because a later request failed would turn a quiet
       * network problem into a blank tab — which is the exact failure this
       * whole module exists to remove.
       *
       * Silent when the world has moved on: a request that failed against a
       * data source nobody is reading any more has nothing to report, and the
       * screen it would report to is not the screen on the glass.
       */
      if (stillCurrent(startWorld, startGeneration)) options.onStaleError?.(error);
      return undefined as T;
    })
    .finally(() => {
      if (inFlight.get(id) === run) inFlight.delete(id);
    });
  inFlight.set(id, run);
}

/**
 * Remember a value, and report how it serialised so callers can compare.
 *
 * Takes the key it is to be filed under rather than the path, so that there is
 * no point in this module where a world-qualified key could be reconstructed
 * from a different world than the one the request started in.
 */
function store(id: string, value: unknown): string {
  const serialised = JSON.stringify(value ?? null);
  entries.delete(id);
  entries.set(id, { value, serialised, at: Date.now() });
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
  /*
   * The counter first, and it is the part that does the work.
   *
   * Emptying the maps only disposes of what has already arrived. Anything still
   * in the air was launched against the contents being dropped here, and moving
   * the generation on is what stops it filing itself as current when it lands.
   */
  generation++;
  entries.clear();
  inFlight.clear();
}

/**
 * When a key was last confirmed by the server, or null if it is not held.
 *
 * Answers for the world in force, which is the only world a caller could
 * sensibly be asking about — every screen able to ask this question is
 * displaying that world.
 */
export function cachedAt(key: string): number | null {
  return entries.get(scoped(currentWorld(), key))?.at ?? null;
}

/** How many responses are held. For tests and diagnostics. */
export function sessionCacheSize(): number {
  return entries.size;
}
