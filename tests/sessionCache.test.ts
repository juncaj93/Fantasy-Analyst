/**
 * The same-session response cache.
 *
 * What is being defended here is a promise about *when*, not about what: a path
 * the app has already read resolves without waiting for the network, and the
 * network answer replaces it only if it differs. Every assertion below is one
 * of the two halves of that — either "this resolved without a round trip" or
 * "this was corrected once the round trip landed".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, cachedAt, clearSessionCache, sessionCacheSize } from '../src/web/sessionCache.ts';

const WORLD = 'live';

/** A fetcher that answers whatever it is currently told to, and counts calls. */
function server(initial: unknown) {
  const state = { value: initial, calls: 0, fail: null as unknown };
  return {
    state,
    fetcher: () => {
      state.calls++;
      if (state.fail) return Promise.reject(state.fail);
      return Promise.resolve(state.value);
    },
  };
}

/** Let every pending microtask settle, which is where revalidation finishes. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  clearSessionCache();
});

describe('a first read', () => {
  it('goes to the server and is remembered', async () => {
    const { state, fetcher } = server({ n: 1 });
    expect(await cached('/a', WORLD, fetcher)).toEqual({ n: 1 });
    expect(state.calls).toBe(1);
    expect(cachedAt('/a')).toBeTypeOf('number');
  });

  it('is shared by callers that ask while it is still in the air', async () => {
    const { state, fetcher } = server({ n: 1 });
    const [first, second] = await Promise.all([cached('/a', WORLD, fetcher), cached('/a', WORLD, fetcher)]);
    expect(first).toEqual(second);
    /*
     * Team asks for three things the moment it mounts, and a fast double-tap on
     * a tab can mount it twice before any of them return. Without this that is
     * six requests for three answers.
     */
    expect(state.calls).toBe(1);
  });
});

describe('a repeat read', () => {
  it('resolves without waiting for the server', async () => {
    const { fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);

    /*
     * The assertion this whole module exists for. `Promise.race` against an
     * already-resolved promise cannot be won by anything that has to wait for a
     * timer, let alone a network — so "cached" here means "in this microtask",
     * which is the same frame the tab lights up in.
     */
    const raced = await Promise.race([
      cached('/a', WORLD, fetcher),
      Promise.resolve().then(() => 'took longer than a microtask'),
    ]);
    expect(raced).toEqual({ n: 1 });
  });

  it('still asks the server, in the background', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);
    await cached('/a', WORLD, fetcher);
    await settle();
    // Freshness is not traded away for speed: the request still happens, it
    // just stops being the thing the screen waits on.
    expect(state.calls).toBe(2);
  });

  it('reports newer truth through onFresh', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);

    state.value = { n: 2 };
    const onFresh = vi.fn();
    expect(await cached('/a', WORLD, fetcher, { onFresh })).toEqual({ n: 1 });
    await settle();
    expect(onFresh).toHaveBeenCalledWith({ n: 2 });
  });

  it('says nothing when the answer has not changed', async () => {
    const { fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);

    const onFresh = vi.fn();
    await cached('/a', WORLD, fetcher, { onFresh });
    await settle();
    /*
     * A screen that re-rendered identically is churn nobody asked for. On Draft
     * it would mean rebuilding four hundred rows to draw the same four hundred
     * rows, and it would do it on every single tab switch.
     */
    expect(onFresh).not.toHaveBeenCalled();
  });

  it('keeps the stale value when the refresh fails', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);

    state.fail = new Error('offline');
    const onStaleError = vi.fn();
    const onFresh = vi.fn();
    expect(await cached('/a', WORLD, fetcher, { onFresh, onStaleError })).toEqual({ n: 1 });
    await settle();

    expect(onStaleError).toHaveBeenCalled();
    expect(onFresh).not.toHaveBeenCalled();
    // And the next read is still answered, rather than the failure having
    // poisoned the entry — a blank tab is exactly what this must never cause.
    state.fail = null;
    expect(await cached('/a', WORLD, fetcher)).toEqual({ n: 1 });
  });

  it('does not stack revalidations when a tab is tapped repeatedly', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);

    await Promise.all([
      cached('/a', WORLD, fetcher),
      cached('/a', WORLD, fetcher),
      cached('/a', WORLD, fetcher),
    ]);
    await settle();
    expect(state.calls).toBe(2);
  });
});

describe('freshness', () => {
  it('fresh: true waits for the server and ignores what is held', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);

    state.value = { n: 2 };
    /*
     * What an explicit refresh means. A pull-to-refresh that returned the
     * cached answer instantly would be a lie told very quickly.
     */
    expect(await cached('/a', WORLD, fetcher, { fresh: true })).toEqual({ n: 2 });
  });

  it('a fresh read updates what the next cached read serves', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);
    state.value = { n: 2 };
    await cached('/a', WORLD, fetcher, { fresh: true });
    expect(await cached('/a', WORLD, fetcher)).toEqual({ n: 2 });
  });

  /*
   * `fresh` and `store` are different questions, and everything until the
   * support snapshot wanted the first without the second.
   *
   * A manual refresh should not *read* a stale answer and should absolutely
   * leave the fresh one behind for the next screen. A one-shot artifact is the
   * other case: a support snapshot is a claim about a single moment, so serving
   * one from a cache would be serving the wrong moment, and it is a couple of
   * hundred kilobytes that would take one of the forty-eight slots — and be
   * stringified a second time to do it — for an answer nothing will ask for
   * again.
   */
  it('store: false answers without leaving anything behind', async () => {
    const { state, fetcher } = server({ n: 1 });
    expect(await cached('/a', WORLD, fetcher, { fresh: true, store: false })).toEqual({ n: 1 });

    // Nothing was remembered, so the next read is a request rather than a hit.
    state.value = { n: 2 };
    expect(await cached('/a', WORLD, fetcher)).toEqual({ n: 2 });
    expect(state.calls).toBe(2);
  });

  it('store: false does not evict what is already held', async () => {
    const { state, fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);
    state.value = { n: 2 };
    await cached('/a', WORLD, fetcher, { fresh: true, store: false });

    // The earlier entry is untouched: a read that declined to remember its own
    // answer has no business forgetting somebody else's.
    expect(await cached('/a', WORLD, fetcher)).toEqual({ n: 1 });
  });
});

describe('invalidation', () => {
  it('a different world is a different set of answers', async () => {
    const { state, fetcher } = server({ league: 'tuesday' });
    await cached('/api/leagues/demo/roster', 'scenario-a', fetcher);

    state.value = { league: 'wednesday' };
    /*
     * Two demo scenarios share a league id — the same fixture league at two
     * different moments — so a cache keyed on the path alone would show
     * Tuesday's roster under an indicator naming Wednesday.
     */
    expect(await cached('/api/leagues/demo/roster', 'scenario-b', fetcher)).toEqual({ league: 'wednesday' });
  });

  it('clearing drops everything held', async () => {
    const { fetcher } = server({ n: 1 });
    await cached('/a', WORLD, fetcher);
    await cached('/b', WORLD, fetcher);
    expect(sessionCacheSize()).toBe(2);

    clearSessionCache();
    expect(sessionCacheSize()).toBe(0);
    expect(cachedAt('/a')).toBeNull();
  });

  it('a league or draft change is a different path, not a stale answer', async () => {
    const { state, fetcher } = server({ roster: 'first' });
    await cached('/api/leagues/one/roster', WORLD, fetcher);

    state.value = { roster: 'second' };
    // Nothing special is needed for this: the id is in the path, so it is a
    // different key. The test is here because it is the property that makes
    // "do not cache across contexts incorrectly" true by construction.
    expect(await cached('/api/leagues/two/roster', WORLD, fetcher)).toEqual({ roster: 'second' });
  });
});

describe('the cache stays bounded', () => {
  it('forgets the least recently confirmed entry', async () => {
    const { fetcher } = server({ n: 1 });
    for (let i = 0; i < 60; i++) await cached(`/p${i}`, WORLD, fetcher);

    expect(sessionCacheSize()).toBeLessThanOrEqual(48);
    expect(cachedAt('/p0')).toBeNull();
    expect(cachedAt('/p59')).toBeTypeOf('number');
  });

  it('re-reading an entry keeps it', async () => {
    const { fetcher } = server({ n: 1 });
    await cached('/keep', WORLD, fetcher);
    for (let i = 0; i < 30; i++) await cached(`/p${i}`, WORLD, fetcher);
    await cached('/keep', WORLD, fetcher);
    // The re-read is served from cache and confirmed in the background, and it
    // is the confirmation that moves the entry to the young end. Wait for it,
    // rather than relying on microtask ordering to have got there in time.
    await settle();
    for (let i = 30; i < 60; i++) await cached(`/p${i}`, WORLD, fetcher);

    expect(cachedAt('/keep')).toBeTypeOf('number');
  });
});
