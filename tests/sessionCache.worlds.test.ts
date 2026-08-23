/**
 * An answer from a world that has ended.
 *
 * The response cache clears itself when the world changes, and clearing is the
 * half of the problem that is easy to see. This file is about the other half.
 * A request launched a moment before the switch is still in the air when the
 * maps are emptied, and it lands afterwards holding a value that was true of a
 * data source nobody is reading any more. Its key is built from a path, and
 * demo scenarios reuse live league and draft ids on purpose — so the key it
 * would write to is exactly the key the world now on screen is about to read.
 *
 * Every test here therefore does the same three things in the same order:
 * start a request, change the world before it resolves, and only then resolve
 * it. What is asserted is always some form of "and it changed nothing" — not
 * the cache, not the caller, not the callbacks, not the next world's first
 * read.
 *
 * The requests are deferred rather than merely slow. A test that waited on a
 * timer would be asserting that the race is usually won; these hold the
 * resolution in hand and release it at the one instant that used to be wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, cachedAt, clearSessionCache, sessionCacheSize } from '../src/web/sessionCache.ts';
import { LIVE_WORLD, currentWorld, noteWorld } from '../src/web/world.ts';

/**
 * Two demo scenarios that are the same league at two different moments.
 *
 * Named after what the registry actually contains rather than `a` and `b`,
 * because the reason this file exists is that they are *not* obviously
 * different from each other at the point where it matters.
 */
const DEMO_TUESDAY = 'demo-tuesday';
const DEMO_WEDNESDAY = 'demo-wednesday';

/**
 * The paths the app really asks for, including the ones demo scenarios reuse.
 *
 * The league and draft ids here are shared across worlds on purpose: that
 * sharing is the whole mechanism by which one world's answer could be mistaken
 * for another's, so a test that used distinct ids per world would be proving
 * nothing.
 */
const OVERVIEW = '/api/overview';
const LEAGUES = '/api/leagues';
const BOARD = '/api/drafts/demo-draft-2026/board?limit=400';
const WAIVERS = '/api/leagues/L1/waivers';

/** A promise whose resolution this test holds, so the race is exact. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending microtask settle, which is where completions land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * What a caller of `cached` actually observed, including having observed nothing.
 *
 * `state` is the assertion that matters most in this file, and it has three
 * values rather than two: an answer that never arrives is the correct outcome
 * for a request whose world has ended, and it has to be distinguishable from an
 * answer of `undefined`.
 */
function watch<T>(promise: Promise<T>) {
  const seen = { state: 'pending' as 'pending' | 'resolved' | 'rejected', value: undefined as unknown };
  void promise.then(
    (value) => {
      seen.state = 'resolved';
      seen.value = value;
    },
    (error: unknown) => {
      seen.state = 'rejected';
      seen.value = error;
    },
  );
  return seen;
}

beforeEach(() => {
  noteWorld(LIVE_WORLD);
  clearSessionCache();
});

describe('a request that outlives the world that launched it', () => {
  it('cannot repopulate the cache it was cleared out of — live to Demo', async () => {
    const live = deferred<unknown>();
    const onFresh = vi.fn();
    const asked = watch(cached(OVERVIEW, LIVE_WORLD, () => live.promise, { onFresh }));

    // The reader enters a demo while the live overview is still in the air.
    noteWorld(DEMO_TUESDAY);

    live.resolve({ leagues: 4, source: 'live' });
    await settle();

    expect(sessionCacheSize()).toBe(0);
    expect(cachedAt(OVERVIEW)).toBeNull();
    expect(onFresh).not.toHaveBeenCalled();
    /*
     * And the caller heard nothing at all.
     *
     * There is no true answer to give somebody who asked a question of a data
     * source that has since been replaced, and an error is not one either — it
     * would travel into a `catch` written for a failed network call and paint a
     * banner over a world that is working perfectly well.
     */
    expect(asked.state).toBe('pending');
  });

  it('cannot repopulate the cache it was cleared out of — Demo to live', async () => {
    noteWorld(DEMO_TUESDAY);
    const demo = deferred<unknown>();
    const asked = watch(cached(OVERVIEW, DEMO_TUESDAY, () => demo.promise));

    noteWorld(LIVE_WORLD);

    demo.resolve({ leagues: 99, source: 'fixture' });
    await settle();

    expect(sessionCacheSize()).toBe(0);
    expect(cachedAt(OVERVIEW)).toBeNull();
    expect(asked.state).toBe('pending');
  });

  it('cannot seed the scenario that replaced it — Demo A to Demo B', async () => {
    /*
     * The case the path-keyed cache could not tell apart at all. Both scenarios
     * are the same fixture league, so the id in the path is identical and the
     * only thing separating Tuesday's board from Wednesday's is which world
     * asked for it.
     */
    noteWorld(DEMO_TUESDAY);
    const tuesday = deferred<unknown>();
    const asked = watch(cached(BOARD, DEMO_TUESDAY, () => tuesday.promise));

    noteWorld(DEMO_WEDNESDAY);

    tuesday.resolve({ day: 'tuesday' });
    await settle();

    expect(sessionCacheSize()).toBe(0);
    expect(asked.state).toBe('pending');

    // And Wednesday's first read of the identical path goes to the server.
    const wednesday = vi.fn(() => Promise.resolve({ day: 'wednesday' }));
    expect(await cached(BOARD, DEMO_WEDNESDAY, wednesday)).toEqual({ day: 'wednesday' });
    expect(wednesday).toHaveBeenCalledTimes(1);
  });

  it('does not become what the new world reads back, even when it lands last', async () => {
    /*
     * The ordering that made this a defect rather than a curiosity.
     *
     * The new world's request is issued first and answers first; the old one
     * lands afterwards. Under a path-shaped key the last write won, so the
     * value the reader was left holding was the one from the world they had
     * already left.
     */
    const live = deferred<unknown>();
    watch(cached(LEAGUES, LIVE_WORLD, () => live.promise));

    noteWorld(DEMO_TUESDAY);
    expect(await cached(LEAGUES, DEMO_TUESDAY, () => Promise.resolve({ leagues: ['fixture'] }))).toEqual({
      leagues: ['fixture'],
    });

    live.resolve({ leagues: ['the reader’s real league'] });
    await settle();

    /*
     * What the demo world reads back is still the demo world's own answer.
     *
     * Read through the cache exactly as a revisited tab would, so this is the
     * value a screen would paint in its first frame. A background revalidation
     * runs behind it, as it should — the assertion is about what was served,
     * which is the thing the reader actually sees.
     */
    expect(await cached(LEAGUES, DEMO_TUESDAY, () => Promise.resolve({ leagues: ['fixture'] }))).toEqual({
      leagues: ['fixture'],
    });
  });

  it('is not shared with the new world as an in-flight request', async () => {
    /*
     * De-duplication is keyed by world as well as by path, so the second world
     * asking for the same path starts its own request rather than joining one
     * launched against a data source it is not reading. Sharing here would hand
     * the new world the old world's answer through the front door, with no
     * stale completion involved at all.
     */
    const live = deferred<unknown>();
    const liveFetcher = vi.fn(() => live.promise);
    watch(cached(WAIVERS, LIVE_WORLD, liveFetcher));

    noteWorld(DEMO_TUESDAY);
    const demoFetcher = vi.fn(() => Promise.resolve({ wire: 'fixture' }));
    expect(await cached(WAIVERS, DEMO_TUESDAY, demoFetcher)).toEqual({ wire: 'fixture' });

    expect(liveFetcher).toHaveBeenCalledTimes(1);
    expect(demoFetcher).toHaveBeenCalledTimes(1);
  });

  it('says nothing when it fails, either', async () => {
    /*
     * A stale-world failure is as inert as a stale-world success. The screen
     * that would have been told about it is not the screen on the glass, and
     * `onStaleError` is what the draft refresh controller counts towards
     * "sync delayed" — a count that must not include a world nobody is in.
     */
    const first = vi.fn(() => Promise.resolve({ n: 1 }));
    await cached(OVERVIEW, LIVE_WORLD, first);

    const revalidation = deferred<unknown>();
    const onStaleError = vi.fn();
    const onFresh = vi.fn();
    await cached(OVERVIEW, LIVE_WORLD, () => revalidation.promise, { onFresh, onStaleError });

    noteWorld(DEMO_TUESDAY);
    revalidation.reject(new Error('the live server, which we are no longer reading'));
    await settle();

    expect(onStaleError).not.toHaveBeenCalled();
    expect(onFresh).not.toHaveBeenCalled();
  });

  it('cannot correct a screen in the world that replaced it', async () => {
    // The revalidation half of the same race: a background confirmation that
    // resolves after the switch must not push its value at anybody.
    const onFresh = vi.fn();
    await cached(BOARD, DEMO_TUESDAY, () => Promise.resolve({ day: 'tuesday', picks: 1 }));

    const revalidation = deferred<unknown>();
    await cached(BOARD, DEMO_TUESDAY, () => revalidation.promise, { onFresh });

    noteWorld(DEMO_WEDNESDAY);
    revalidation.resolve({ day: 'tuesday', picks: 2 });
    await settle();

    expect(onFresh).not.toHaveBeenCalled();
    expect(sessionCacheSize()).toBe(0);
  });
});

describe('the screen tree being rebuilt is not what makes this safe', () => {
  it('holds even when the asker is long gone and a new asker is already waiting', async () => {
    /*
     * The app remounts its screens when the world changes, and that is a good
     * thing to do for reasons of its own — but it is not this guarantee. What
     * is modelled here is the sequence remounting produces: the old screen's
     * request is orphaned, the new screen asks for the identical path
     * immediately, and the orphaned answer arrives afterwards.
     */
    const orphaned = deferred<unknown>();
    watch(cached(BOARD, DEMO_TUESDAY, () => orphaned.promise));

    noteWorld(DEMO_WEDNESDAY);

    const replacement = deferred<unknown>();
    const newScreen = watch(cached(BOARD, DEMO_WEDNESDAY, () => replacement.promise));

    orphaned.resolve({ day: 'tuesday' });
    await settle();
    expect(newScreen.state).toBe('pending');

    replacement.resolve({ day: 'wednesday' });
    await settle();

    expect(newScreen.state).toBe('resolved');
    expect(newScreen.value).toEqual({ day: 'wednesday' });
    expect(cachedAt(BOARD)).toBeTypeOf('number');
  });
});

describe('everything that was already true stays true', () => {
  it('stores normally when the world has not moved', async () => {
    const slow = deferred<unknown>();
    const asked = watch(cached(OVERVIEW, LIVE_WORLD, () => slow.promise));

    slow.resolve({ leagues: 4 });
    await settle();

    expect(asked.state).toBe('resolved');
    expect(asked.value).toEqual({ leagues: 4 });
    expect(cachedAt(OVERVIEW)).toBeTypeOf('number');
    expect(sessionCacheSize()).toBe(1);
  });

  it('still asks once for two callers in the same world', async () => {
    const slow = deferred<unknown>();
    const fetcher = vi.fn(() => slow.promise);
    const first = watch(cached(OVERVIEW, LIVE_WORLD, fetcher));
    const second = watch(cached(OVERVIEW, LIVE_WORLD, fetcher));

    slow.resolve({ leagues: 4 });
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.value).toEqual({ leagues: 4 });
    expect(second.value).toEqual({ leagues: 4 });
  });

  it('still serves from cache and corrects behind the screen in the same world', async () => {
    const server = { value: { picks: 1 } as unknown };
    await cached(BOARD, DEMO_TUESDAY, () => Promise.resolve(server.value));

    server.value = { picks: 2 };
    const onFresh = vi.fn();
    // Instant, from what the app already had — the point of the cache.
    expect(await cached(BOARD, DEMO_TUESDAY, () => Promise.resolve(server.value), { onFresh })).toEqual({ picks: 1 });
    await settle();
    expect(onFresh).toHaveBeenCalledWith({ picks: 2 });
    expect(await cached(BOARD, DEMO_TUESDAY, () => Promise.resolve(server.value))).toEqual({ picks: 2 });
  });

  it('keeps the last known value when a same-world revalidation fails', async () => {
    await cached(OVERVIEW, LIVE_WORLD, () => Promise.resolve({ leagues: 4 }));

    const onStaleError = vi.fn();
    await cached(OVERVIEW, LIVE_WORLD, () => Promise.reject(new Error('offline')), { onStaleError });
    await settle();

    expect(onStaleError).toHaveBeenCalledTimes(1);
    expect(await cached(OVERVIEW, LIVE_WORLD, () => Promise.resolve({ leagues: 999 }))).toEqual({ leagues: 4 });
  });
});

describe('a write is a smaller version of the same race', () => {
  it('does not let a read that predates it put the pre-write answer back', async () => {
    /*
     * A `POST` empties the cache precisely because a write can change an answer
     * held in it. A `GET` that was already running when the write landed is
     * carrying the answer from before, and filing it afterwards would undo the
     * invalidation the write asked for — the same shape as the world race, one
     * notch quieter.
     */
    const read = deferred<unknown>();
    const asked = watch(cached(WAIVERS, LIVE_WORLD, () => read.promise));

    clearSessionCache(); // what `api.post` does when a write lands

    read.resolve({ claims: 'before the write' });
    await settle();

    expect(cachedAt(WAIVERS)).toBeNull();
    expect(sessionCacheSize()).toBe(0);
    /*
     * The caller is still answered, and that is the difference between a write
     * and a world change. The reader is in the world they asked from; the value
     * is a real answer from it. It simply is not one worth remembering.
     */
    expect(asked.state).toBe('resolved');
    expect(asked.value).toEqual({ claims: 'before the write' });
  });

  it('does not let a revalidation that predates it correct the screen', async () => {
    await cached(WAIVERS, LIVE_WORLD, () => Promise.resolve({ claims: 1 }));

    const revalidation = deferred<unknown>();
    const onFresh = vi.fn();
    await cached(WAIVERS, LIVE_WORLD, () => revalidation.promise, { onFresh });

    clearSessionCache();
    revalidation.resolve({ claims: 2 });
    await settle();

    expect(onFresh).not.toHaveBeenCalled();
    expect(sessionCacheSize()).toBe(0);
  });
});

describe('nothing accumulates', () => {
  it('holds one world at a time however many times the world changes', async () => {
    const stranded = [] as Array<{ resolve: (value: unknown) => void }>;
    const WORLDS = 40;
    for (let i = 0; i < WORLDS; i++) {
      const world = `scenario-${i}`;
      noteWorld(world);
      const pending = deferred<unknown>();
      stranded.push(pending);
      watch(cached(OVERVIEW, world, () => pending.promise));
      await cached(`${LEAGUES}?i=${i}`, world, () => Promise.resolve({ i }));
    }

    // Each world left exactly its own last read behind, and the world before it
    // was dropped whole rather than accumulated. Worlds are not kept around to
    // be compared against; a generation is a number, and only the current one
    // has anything filed under it.
    expect(sessionCacheSize()).toBe(1);

    /*
     * Thirty-nine stranded requests, released at once, land on nothing.
     *
     * The last one is held back deliberately: its world is still the world in
     * force, so it is not stale and storing it is the correct outcome. Letting
     * it go with the rest would make this assertion pass for the wrong reason.
     */
    for (const pending of stranded.slice(0, -1)) pending.resolve({ stale: true });
    await settle();
    expect(sessionCacheSize()).toBe(1);
    expect(cachedAt(OVERVIEW)).toBeNull();

    // And the one whose world never ended is remembered like any other.
    stranded[stranded.length - 1]!.resolve({ stale: false });
    await settle();
    expect(cachedAt(OVERVIEW)).toBeTypeOf('number');
    expect(sessionCacheSize()).toBe(2);
  });

  it('still evicts the least recently confirmed once a single world fills up', async () => {
    for (let i = 0; i < 60; i++) await cached(`/p${i}`, LIVE_WORLD, () => Promise.resolve({ i }));
    expect(sessionCacheSize()).toBeLessThanOrEqual(48);
    expect(cachedAt('/p0')).toBeNull();
    expect(cachedAt('/p59')).toBeTypeOf('number');
  });
});

describe('the marker itself', () => {
  it('starts live and reports whichever world was last announced', () => {
    expect(currentWorld()).toBe(LIVE_WORLD);
    expect(noteWorld(DEMO_TUESDAY)).toBe(true);
    expect(currentWorld()).toBe(DEMO_TUESDAY);
    // Being told the world we are already in is not a change, so a caller can
    // announce the current world as often as it likes without emptying caches.
    expect(noteWorld(DEMO_TUESDAY)).toBe(false);
  });

  it('empties the cache the moment it moves, without waiting to be asked', async () => {
    await cached(OVERVIEW, LIVE_WORLD, () => Promise.resolve({ leagues: 4 }));
    expect(sessionCacheSize()).toBe(1);

    noteWorld(DEMO_TUESDAY);

    // Not on the next read: now. Nothing has called `cached` since.
    expect(sessionCacheSize()).toBe(0);
  });
});
