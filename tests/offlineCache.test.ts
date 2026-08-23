/**
 * The board in a dead zone.
 *
 * Two halves, and the second is the important one. That a value survives a
 * round trip through storage is table stakes; that the cache can never take the
 * screen down with it, and can never be mistaken for live data, is the reason
 * it is allowed to exist at all.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_AGE_MS,
  MAX_ENTRY_CHARS,
  describeAge,
  forgetBoard,
  forgetOtherDrafts,
  recallBoard,
  rememberBoard,
  rememberBoardSoon,
  type StorageLike,
} from '../src/web/offlineCache.ts';

/**
 * Where a live board for draft `D1` actually lives.
 *
 * Boards are filed per world as well as per draft, because every demo scenario
 * names its draft the same thing. `live` is the world these tests run in — they
 * never enter a demo — and naming the key once here keeps the assertions about
 * sweeping and about bad payloads pointed at the real slot.
 */
const LIVE_KEY = 'fa.draft.board.live.D1';

/** A `localStorage` that can be told to misbehave in each of the ways real ones do. */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  setThrows: 'never' | 'always' | 'until-swept' = 'never';

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
    if (this.setThrows === 'always') throw new Error('QuotaExceededError');
    if (this.setThrows === 'until-swept' && this.map.size > 0) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

const board = { league: { name: 'The Junculator' }, recommendations: [{ playerId: 'p1', name: 'Kai Brennan' }] };

describe('remembering and recalling a board', () => {
  it('returns what was stored, marked as a capture', () => {
    const storage = new FakeStorage();
    expect(rememberBoard('D1', board, { storage, now: 1_000 })).toBe(true);

    const recalled = recallBoard<typeof board>('D1', { storage, now: 61_000 });
    expect(recalled?.value).toEqual(board);
    expect(recalled?.capturedAt).toBe(1_000);
    expect(recalled?.ageMs).toBe(60_000);
    // Not a boolean the caller has to remember to check — a field they cannot
    // destructure the value out of without seeing.
    expect(recalled?.stale).toBe(true);
  });

  it('keeps two drafts apart', () => {
    const storage = new FakeStorage();
    rememberBoard('D1', { a: 1 }, { storage });
    rememberBoard('D2', { a: 2 }, { storage });
    expect(recallBoard<{ a: number }>('D1', { storage })?.value).toEqual({ a: 1 });
    expect(recallBoard<{ a: number }>('D2', { storage })?.value).toEqual({ a: 2 });
  });

  it('has nothing for a draft it was never given', () => {
    expect(recallBoard('D9', { storage: new FakeStorage() })).toBeNull();
  });

  it('forgets on request', () => {
    const storage = new FakeStorage();
    rememberBoard('D1', board, { storage });
    forgetBoard('D1', storage);
    expect(recallBoard('D1', { storage })).toBeNull();
  });
});

describe('a board old enough to mislead is not shown at all', () => {
  it('drops an entry past the age limit', () => {
    const storage = new FakeStorage();
    rememberBoard('D1', board, { storage, now: 0 });
    expect(recallBoard('D1', { storage, now: MAX_AGE_MS + 1 })).toBeNull();
    // And it is gone, not merely hidden: a board from last week is not a
    // degraded board, it is a different draft.
    expect(storage.keys()).toHaveLength(0);
  });

  it('keeps one just inside it', () => {
    const storage = new FakeStorage();
    rememberBoard('D1', board, { storage, now: 0 });
    expect(recallBoard('D1', { storage, now: MAX_AGE_MS - 1 })).not.toBeNull();
  });

  it('survives the clock going backwards', () => {
    // A timezone change or an NTP correction between write and read. Losing the
    // board over a clock adjustment would be a cost with no benefit.
    const storage = new FakeStorage();
    rememberBoard('D1', board, { storage, now: 10_000 });
    const recalled = recallBoard('D1', { storage, now: 5_000 });
    expect(recalled).not.toBeNull();
    expect(recalled?.ageMs).toBe(0);
  });
});

describe('the cache can never take the screen down with it', () => {
  it('returns nothing rather than throwing on corrupt JSON', () => {
    const storage = new FakeStorage();
    storage.setItem(LIVE_KEY, '{not json');
    expect(recallBoard('D1', { storage })).toBeNull();
    // Swept, so it cannot fail the same way on every subsequent render.
    expect(storage.getItem(LIVE_KEY)).toBeNull();
  });

  it('rejects an entry written by a previous deploy', () => {
    const storage = new FakeStorage();
    storage.setItem(
      LIVE_KEY,
      JSON.stringify({ schema: 1, capturedAt: Date.now(), draftId: 'D1', world: 'live', value: board }),
    );
    expect(recallBoard('D1', { storage })).toBeNull();
  });

  it('rejects an entry that names a different draft', () => {
    // Belt and braces against a key collision: the draft id is inside the
    // envelope as well as in the key, and a mismatch is a miss.
    const storage = new FakeStorage();
    storage.setItem(
      LIVE_KEY,
      JSON.stringify({ schema: 3, capturedAt: Date.now(), draftId: 'SOMETHING_ELSE', world: 'live', value: board }),
    );
    expect(recallBoard('D1', { storage })).toBeNull();
  });

  it('rejects an entry that names a different world', () => {
    /*
     * The same belt and braces, for the fact that actually collides. Every demo
     * scenario names its draft the same thing, so the world is what separates
     * one scenario's capture from the next one's — and it is in the envelope as
     * well as in the key so that a key builder that changes shape between two
     * deploys cannot hand one world another's board.
     */
    const storage = new FakeStorage();
    storage.setItem(
      LIVE_KEY,
      JSON.stringify({ schema: 3, capturedAt: Date.now(), draftId: 'D1', world: 'demo-scenario', value: board }),
    );
    expect(recallBoard('D1', { storage })).toBeNull();
  });

  it('rejects an entry written before boards were kept per world', () => {
    // A key from a deploy that predates the world in the key. Unreadable rather
    // than misleading, which is the only property that matters: it is reclaimed
    // by the quota sweep like anything else here.
    const storage = new FakeStorage();
    storage.setItem(
      'fa.draft.board.D1',
      JSON.stringify({ schema: 3, capturedAt: Date.now(), draftId: 'D1', value: board }),
    );
    expect(recallBoard('D1', { storage })).toBeNull();
  });

  it('reports failure rather than throwing when storage refuses to write', () => {
    const storage = new FakeStorage();
    storage.setThrows = 'always';
    expect(rememberBoard('D1', board, { storage })).toBe(false);
  });

  it('sweeps other drafts once and retries when the quota is full', () => {
    const storage = new FakeStorage();
    rememberBoard('OLD', board, { storage });
    storage.setThrows = 'until-swept';
    // The likely cause of a full quota is a board for a draft that finished
    // last August. One sweep, one retry, and no loop.
    expect(rememberBoard('D1', board, { storage })).toBe(true);
    expect(recallBoard('OLD', { storage })).toBeNull();
    expect(recallBoard('D1', { storage })).not.toBeNull();
  });

  it('refuses a payload too large to be sane', () => {
    const storage = new FakeStorage();
    const huge = { blob: 'x'.repeat(MAX_ENTRY_CHARS + 1) };
    expect(rememberBoard('D1', huge, { storage })).toBe(false);
    expect(storage.keys()).toHaveLength(0);
  });

  it('refuses a value that will not serialise', () => {
    const storage = new FakeStorage();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(rememberBoard('D1', circular, { storage })).toBe(false);
  });

  it('does nothing at all without a draft id', () => {
    const storage = new FakeStorage();
    expect(rememberBoard('', board, { storage })).toBe(false);
    expect(recallBoard('', { storage })).toBeNull();
  });

  it('does nothing at all when there is no storage', () => {
    expect(rememberBoard('D1', board, { storage: null })).toBe(false);
    expect(recallBoard('D1', { storage: null })).toBeNull();
  });
});

describe('sweeping', () => {
  it('keeps the named draft and drops the rest', () => {
    const storage = new FakeStorage();
    rememberBoard('KEEP', { a: 1 }, { storage });
    rememberBoard('A', { a: 2 }, { storage });
    rememberBoard('B', { a: 3 }, { storage });
    expect(forgetOtherDrafts('KEEP', storage)).toBe(2);
    expect(recallBoard('KEEP', { storage })).not.toBeNull();
    expect(recallBoard('A', { storage })).toBeNull();
  });

  it('leaves keys belonging to anything else alone', () => {
    // The origin is shared with the theme and the install dismissal, and a
    // cache that clears its neighbours is a bug with a wide blast radius.
    const storage = new FakeStorage();
    storage.setItem('fa.theme', 'dark');
    rememberBoard('A', { a: 1 }, { storage });
    forgetOtherDrafts('KEEP', storage);
    expect(storage.getItem('fa.theme')).toBe('dark');
  });
});

describe('how old the board is, in words', () => {
  it('stays coarse, because precision here invites trust', () => {
    expect(describeAge(5_000)).toBe('moments ago');
    expect(describeAge(60_000)).toBe('1 minute ago');
    expect(describeAge(9 * 60_000)).toBe('9 minutes ago');
    expect(describeAge(65 * 60_000)).toBe('about an hour ago');
    expect(describeAge(3 * 3_600_000)).toBe('about 3 hours ago');
  });
});

describe('writing off the render path', () => {
  it('defers the write and still stores the board', async () => {
    /*
     * The screen calls this after every successful board load, which during a
     * live draft is every few seconds and always in the frame that has just
     * been rebuilt after a pick. Serialising four hundred rows and handing them
     * to a synchronous, disk-backed API in that frame is exactly the jank the
     * performance budgets exist to prevent.
     */
    const storage = new FakeStorage();
    let deferred: (() => void) | null = null;
    rememberBoardSoon('D1', board, { storage, defer: (write) => (deferred = write) });

    // Nothing yet: the whole point is that the current tick is left alone.
    expect(recallBoard('D1', { storage })).toBeNull();
    expect(deferred, 'the write was handed to the scheduler, not run').not.toBeNull();

    deferred!();
    expect(recallBoard<typeof board>('D1', { storage })?.value).toEqual(board);
  });

  it('writes immediately where there is no frame to protect', async () => {
    // A test, or a server render: nothing is waiting on the main thread, and a
    // write that never happens because nothing scheduled it would be worse.
    const storage = new FakeStorage();
    rememberBoardSoon('D1', board, { storage });
    expect(recallBoard<typeof board>('D1', { storage })?.value).toEqual(board);
  });

  it('swallows a failing write exactly as the synchronous form does', async () => {
    const storage = new FakeStorage();
    storage.setThrows = 'always';
    // Fire-and-forget: no throw, no rejection, nothing for a caller to await
    // back onto the hot path.
    expect(() => rememberBoardSoon('D1', board, { storage })).not.toThrow();
    expect(recallBoard('D1', { storage })).toBeNull();
  });
});
