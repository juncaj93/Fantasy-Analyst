/**
 * The board that persists, and which world it belongs to.
 *
 * `offlineCache.ts` is the one thing in this app that outlives the tab, so it
 * is also the one place a world can leak across a reload. The collision is not
 * hypothetical and it is not an accident of naming: every demo scenario calls
 * its draft `demo-draft-2026`, because they are deliberately the same fixture
 * league at different moments. A key built from the draft id alone is therefore
 * a key that two scenarios share, and one of those scenarios seeds a real
 * capture on the way in.
 *
 * So the world is part of the key and part of the envelope, and the two halves
 * of this file check the two ways it could still go wrong: a board recalled by
 * a world that did not capture it, and a board *written* into a world that was
 * not the one holding it when the write was scheduled.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetBoard, recallBoard, rememberBoard, rememberBoardSoon, type StorageLike } from '../src/web/offlineCache.ts';
import { LIVE_WORLD, currentWorld, noteWorld } from '../src/web/world.ts';
import { demoSession, enterDemo, exitDemo } from '../src/web/demo/session.ts';
import { DEMO_DRAFT_ID } from '../src/core/demo/fixtures/world.ts';

/** A `localStorage` good enough for everything this module asks of one. */
class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * The draft id every scenario shares, read from the fixtures rather than typed.
 *
 * If this ever stops being one shared id the collision goes away — and this
 * import is what would make that visible here rather than leaving a file full
 * of tests quietly proving nothing.
 */
const SHARED_DRAFT = DEMO_DRAFT_ID;

beforeEach(() => {
  noteWorld(LIVE_WORLD);
});

describe('a board belongs to the world that captured it', () => {
  it('is unreachable from a demo, and the demo is unreachable from live', () => {
    const storage = new FakeStorage();
    rememberBoard(SHARED_DRAFT, { source: 'live' }, { storage, world: LIVE_WORLD });
    rememberBoard(SHARED_DRAFT, { source: 'demo' }, { storage, world: 'draft-mid' });

    expect(recallBoard(SHARED_DRAFT, { storage, world: LIVE_WORLD })?.value).toEqual({ source: 'live' });
    expect(recallBoard(SHARED_DRAFT, { storage, world: 'draft-mid' })?.value).toEqual({ source: 'demo' });
    // Two slots, not one contested one: the demo did not evict the reader's own
    // capture on the way past, which is what makes leaving a demo give it back.
    expect(storage.length).toBe(2);
  });

  it('cannot be recalled by the scenario that replaced it — Demo A to Demo B', () => {
    const storage = new FakeStorage();
    rememberBoard(SHARED_DRAFT, { day: 'tuesday' }, { storage, world: 'draft-early' });

    // Wednesday asks for the identical draft id, because there is only one.
    expect(recallBoard(SHARED_DRAFT, { storage, world: 'draft-late' })).toBeNull();
  });

  it('reads whichever world is in force when nobody says otherwise', () => {
    const storage = new FakeStorage();
    rememberBoard(SHARED_DRAFT, { source: 'live' }, { storage });

    noteWorld('draft-mid');
    expect(recallBoard(SHARED_DRAFT, { storage })).toBeNull();

    noteWorld(LIVE_WORLD);
    expect(recallBoard(SHARED_DRAFT, { storage })?.value).toEqual({ source: 'live' });
  });
});

describe('a deferred write belongs to the world that scheduled it', () => {
  it('files the board under the world it was captured in, not the one it lands in', () => {
    /*
     * The offline mirror of the whole finding, and the reason the world is read
     * at call time rather than at write time.
     *
     * The Draft screen hands its board over the moment it paints and lets the
     * write happen up to two seconds later, off the frame the reader is
     * watching. Two seconds is long enough to leave a demo. A write that asked
     * "which world is it?" when it ran would put a fixture board into the
     * reader's own offline slot — a demo value becoming live truth by the
     * slowest possible route.
     */
    const storage = new FakeStorage();
    let deferredWrite: (() => void) | null = null;

    noteWorld('draft-mid');
    rememberBoardSoon(SHARED_DRAFT, { day: 'tuesday' }, { storage, defer: (write) => (deferredWrite = write) });

    // The reader leaves the demo before the idle callback runs.
    noteWorld(LIVE_WORLD);
    deferredWrite!();

    expect(recallBoard(SHARED_DRAFT, { storage, world: LIVE_WORLD })).toBeNull();
    expect(recallBoard(SHARED_DRAFT, { storage, world: 'draft-mid' })?.value).toEqual({ day: 'tuesday' });
  });

  it('does not let one scenario’s deferred write land in the next scenario', () => {
    const storage = new FakeStorage();
    let deferredWrite: (() => void) | null = null;

    noteWorld('draft-early');
    rememberBoardSoon(SHARED_DRAFT, { day: 'tuesday' }, { storage, defer: (write) => (deferredWrite = write) });

    noteWorld('draft-late');
    deferredWrite!();

    expect(recallBoard(SHARED_DRAFT, { storage, world: 'draft-late' })).toBeNull();
  });
});

describe('forgetting is world-qualified too', () => {
  it('leaves the reader’s own board alone when a demo drops its capture', () => {
    const storage = new FakeStorage();
    rememberBoard(SHARED_DRAFT, { source: 'live' }, { storage, world: LIVE_WORLD });
    rememberBoard(SHARED_DRAFT, { source: 'demo' }, { storage, world: 'offline-draft' });

    // What leaving a demo does, from a point where the marker already says live.
    noteWorld(LIVE_WORLD);
    forgetBoard(SHARED_DRAFT, storage, 'offline-draft');

    expect(recallBoard(SHARED_DRAFT, { storage, world: 'offline-draft' })).toBeNull();
    expect(recallBoard(SHARED_DRAFT, { storage, world: LIVE_WORLD })?.value).toEqual({ source: 'live' });
  });
});

/**
 * The seam the app actually switches worlds at.
 *
 * Everything above drives the marker directly, which is the right level for a
 * cache test but proves nothing about whether the app moves the marker at the
 * right moment. These drive `enterDemo` and `exitDemo` themselves — the real
 * functions the Settings screen calls — against a stand-in `window`, so the
 * ordering inside them is what is under test.
 */
describe('entering and leaving a scenario', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
    (globalThis as { window?: unknown }).window = { localStorage: storage };
  });

  afterEach(async () => {
    await exitDemo();
    delete (globalThis as { window?: unknown }).window;
  });

  it('moves the marker in the same breath as the session, in both directions', async () => {
    expect(currentWorld()).toBe(LIVE_WORLD);

    await enterDemo('draft-mid');
    expect(demoSession()?.scenario.id).toBe('draft-mid');
    expect(currentWorld()).toBe('draft-mid');

    await enterDemo('draft-late');
    expect(demoSession()?.scenario.id).toBe('draft-late');
    expect(currentWorld()).toBe('draft-late');

    await exitDemo();
    expect(demoSession()).toBeNull();
    expect(currentWorld()).toBe(LIVE_WORLD);
  });

  it('seeds the offline scenario’s capture into the offline scenario', async () => {
    await enterDemo('offline-draft');

    // In its own world, where the scenario's own Draft screen will find it.
    expect(recallBoard(SHARED_DRAFT, { storage, world: 'offline-draft' })).not.toBeNull();
    // And nowhere else. This is the one thing a scenario writes to the browser.
    expect(recallBoard(SHARED_DRAFT, { storage, world: LIVE_WORLD })).toBeNull();
  });

  it('takes the capture with it when it leaves for another scenario', async () => {
    await enterDemo('offline-draft');
    expect(recallBoard(SHARED_DRAFT, { storage, world: 'offline-draft' })).not.toBeNull();

    /*
     * Moving between two scenarios does not pass through `exitDemo`, which is
     * how the capture used to survive the scenario that made it — and it would
     * then be sitting at the key the next scenario reads, because there is only
     * one draft id between them.
     */
    await enterDemo('draft-mid');

    expect(recallBoard(SHARED_DRAFT, { storage, world: 'offline-draft' })).toBeNull();
    expect(recallBoard(SHARED_DRAFT, { storage, world: 'draft-mid' })).toBeNull();
  });

  it('takes the capture with it when it leaves for live', async () => {
    // The reader's own board for a real draft, captured before any of this.
    rememberBoard('1234567890', { source: 'the reader’s draft' }, { storage, world: LIVE_WORLD });

    await enterDemo('offline-draft');
    await exitDemo();

    expect(recallBoard(SHARED_DRAFT, { storage, world: 'offline-draft' })).toBeNull();
    expect(recallBoard(SHARED_DRAFT, { storage, world: LIVE_WORLD })).toBeNull();
    // Untouched. Nothing a demo does is allowed to cost the reader their own.
    expect(recallBoard('1234567890', { storage, world: LIVE_WORLD })?.value).toEqual({
      source: 'the reader’s draft',
    });
  });
});
