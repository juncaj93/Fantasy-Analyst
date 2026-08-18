/**
 * The board survives the tunnel.
 *
 * Draft night is the one time this app is used somewhere with bad signal — a
 * friend's basement, a bar, a phone that has been on hotspot for two hours —
 * and it is also the one time being without it costs something. The refresh
 * controller already handles *losing* the network mid-session: it stops
 * polling, marks the board stale, and keeps the last good board on screen. What
 * it cannot survive is a reload. Close the tab in a dead zone, reopen it, and
 * every request fails; the screen has nothing, because everything it knows
 * lived in a React state that is now gone.
 *
 * So the last good board goes to `localStorage`, and the screen reads it when
 * the network does not answer.
 *
 * ## The three rules this is built around
 *
 * **Never pretend stale is live.** A cached board is always rendered as cached,
 * with the time it was captured, and the caller is handed `stale: true` rather
 * than being left to work it out. The failure this prevents is the expensive
 * one: a board that silently shows the pre-tunnel state while three picks
 * happen, and the user takes a player who is gone.
 *
 * **Never invent Sleeper picks.** Nothing is written here that did not come
 * from Sleeper. There is no offline queue of picks, no optimistic "you drafted
 * him" state, no local mutation of the board. The user's own UI preferences —
 * which chip is selected, what is in the queue — are a different matter and are
 * already local; draft state is read-only, offline as well as online.
 *
 * **Bounded, and disposable.** One entry per draft, capped, and any parse
 * failure throws the entry away rather than propagating. A cache that can break
 * the screen it exists to protect is worse than no cache. Every read is
 * wrapped: a browser in private mode with `localStorage` throwing on write, a
 * quota that is full, a payload from a previous deploy with a different shape —
 * all of them come back as "no cache", which is the state the app was in before
 * this module existed and is still a working one.
 */

/** Bumped when the cached shape changes. An older entry is dropped, not migrated. */
const SCHEMA = 3;

const PREFIX = 'fa.draft.board.';

/**
 * How old a cached board may be and still be worth showing.
 *
 * Twelve hours covers a draft that started last night and a phone that has been
 * asleep since; past that, a board is likelier to mislead than to help, and the
 * honest screen is the empty one that says it could not reach the server.
 * Deliberately not days: a board from last week is not a degraded board, it is
 * a different draft.
 */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * The most characters one cached board may occupy.
 *
 * `localStorage` is typically 5MB per origin and shared with the theme, the
 * install dismissal and anything else. A 400-row board with its explanations is
 * comfortably under this; something that is not is a payload shape nobody
 * anticipated, and dropping it is better than filling the origin's quota and
 * breaking the settings that share it.
 */
export const MAX_ENTRY_CHARS = 2_000_000;

export interface CachedBoard<T> {
  value: T;
  /** When this was captured, as epoch ms. */
  capturedAt: number;
  /** How old it is right now, in ms. */
  ageMs: number;
  /**
   * Always true for anything this returns.
   *
   * Present as a field rather than left implicit so a caller physically cannot
   * render a cached board without having had the word `stale` in front of them.
   */
  stale: true;
}

/** The bits of `window` this needs, so tests need no browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

interface Envelope<T> {
  schema: number;
  capturedAt: number;
  /** The draft this belongs to. Checked on read; a mismatch is a miss. */
  draftId: string;
  value: T;
}

function storageOf(explicit?: StorageLike | null): StorageLike | null {
  if (explicit) return explicit;
  try {
    // Safari in private mode has thrown on access to this in the past, and a
    // draft screen that white-screens because of a cache is the opposite of
    // what this module is for.
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const keyFor = (draftId: string) => `${PREFIX}${draftId}`;

/**
 * Remember a board, off the path the user is waiting on.
 *
 * `rememberBoard` writes synchronously and is what the tests drive. This is
 * what the *screen* calls, and the difference matters during a live draft:
 * serialising a four-hundred-row board and handing it to `localStorage` is
 * main-thread work — `JSON.stringify` plus a synchronous, disk-backed write —
 * and it was happening inside the same tick that had just rebuilt the board
 * after a pick. That is precisely the frame the user is watching, several times
 * a minute, on a phone.
 *
 * Nothing depends on the write having finished. The cache is only ever read on
 * a fresh mount, so deferring it costs nothing and removes the work from the
 * frame entirely. `requestIdleCallback` where it exists — Safari still does not
 * have it — and a macrotask everywhere else, which is enough to let the browser
 * paint first.
 *
 * Fire-and-forget on purpose: there is no outcome a caller could act on, and a
 * promise here would only invite somebody to await it back onto the hot path.
 */
export function rememberBoardSoon<T>(
  draftId: string,
  value: T,
  opts: { storage?: StorageLike | null; defer?: (write: () => void) => void } = {},
): void {
  const write = () => {
    rememberBoard(draftId, value, opts);
  };
  (opts.defer ?? defaultDefer)(write);
}

/**
 * How the write gets off the current tick.
 *
 * Injectable for the same reason the refresh controller's timers are: a
 * deferral that can only be observed by waiting is a deferral no test can
 * assert the *absence* of, and "it did not happen in this tick" is the whole
 * property. Outside a browser — a test, a server render — there is nothing to
 * keep responsive and the write happens immediately.
 */
function defaultDefer(write: () => void): void {
  const win =
    typeof window === 'undefined'
      ? null
      : (window as unknown as {
          requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
          setTimeout: (cb: () => void, ms: number) => number;
        });
  if (!win) {
    write();
    return;
  }
  // The timeout matters: an idle callback with no deadline can be postponed
  // indefinitely on a busy tab, and a draft tab polling every five seconds is a
  // busy tab. Two seconds is far longer than the write needs and far shorter
  // than a user could reload within.
  if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(write, { timeout: 2_000 });
  else win.setTimeout(write, 0);
}

/**
 * Remember a board that came from the server.
 *
 * Synchronous. Prefer `rememberBoardSoon` from anything on a render path.
 *
 * Silent on every failure. A full quota, a private-mode browser, a payload too
 * large to be sane — none of them are worth a word to somebody mid-draft, and
 * the consequence of not caching is only that a reload in a dead zone shows
 * nothing, which is where the app was before.
 */
export function rememberBoard<T>(
  draftId: string,
  value: T,
  opts: { storage?: StorageLike | null; now?: number } = {},
): boolean {
  const storage = storageOf(opts.storage);
  if (!storage || !draftId) return false;
  const envelope: Envelope<T> = {
    schema: SCHEMA,
    capturedAt: opts.now ?? Date.now(),
    draftId,
    value,
  };
  let text: string;
  try {
    text = JSON.stringify(envelope);
  } catch {
    return false;
  }
  if (text.length > MAX_ENTRY_CHARS) return false;
  try {
    storage.setItem(keyFor(draftId), text);
    return true;
  } catch {
    /*
     * Almost certainly a full quota, and the fix is almost certainly a board
     * for a draft that finished last August. Sweep and retry exactly once —
     * twice would be a loop, and a second failure means the quota is being
     * spent by something that is not ours to reclaim.
     */
    forgetOtherDrafts(draftId, storage);
    try {
      storage.setItem(keyFor(draftId), text);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The last board for this draft, if there is a usable one.
 *
 * Null means "nothing to show", and it means it for every reason: no entry, a
 * different draft, a shape from a previous deploy, an entry older than
 * `MAX_AGE_MS`, or a storage that will not answer. The caller does not need to
 * tell those apart — all of them lead to the same screen.
 */
export function recallBoard<T>(
  draftId: string,
  opts: { storage?: StorageLike | null; now?: number; maxAgeMs?: number } = {},
): CachedBoard<T> | null {
  const storage = storageOf(opts.storage);
  if (!storage || !draftId) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(keyFor(draftId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(raw) as Envelope<T>;
  } catch {
    drop(draftId, storage);
    return null;
  }

  if (
    !envelope ||
    envelope.schema !== SCHEMA ||
    envelope.draftId !== draftId ||
    typeof envelope.capturedAt !== 'number' ||
    envelope.value == null
  ) {
    drop(draftId, storage);
    return null;
  }

  const now = opts.now ?? Date.now();
  const ageMs = now - envelope.capturedAt;
  /*
   * A negative age means the clock moved backwards between writing and reading
   * — a timezone change, a manual clock set, an NTP correction. Treated as
   * fresh-but-unknown rather than discarded: the board is still the last thing
   * Sleeper said, and throwing it away over a clock adjustment would cost the
   * user their board for no reason.
   */
  if (ageMs > (opts.maxAgeMs ?? MAX_AGE_MS)) {
    drop(draftId, storage);
    return null;
  }

  return { value: envelope.value, capturedAt: envelope.capturedAt, ageMs: Math.max(0, ageMs), stale: true };
}

/** Forget one draft's board. Used when a fresh one lands, and on a bad parse. */
export function forgetBoard(draftId: string, storage?: StorageLike | null): void {
  const store = storageOf(storage);
  if (store) drop(draftId, store);
}

/**
 * Drop every cached board except this one.
 *
 * Called on a quota failure, and worth calling nowhere else: a user with two
 * leagues drafting on the same night wants both boards, and this is not a
 * cleanup that needs doing on a schedule.
 */
export function forgetOtherDrafts(keepDraftId: string, storage?: StorageLike | null): number {
  const store = storageOf(storage);
  if (!store) return 0;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(PREFIX) && key !== keyFor(keepDraftId)) doomed.push(key);
    }
  } catch {
    return 0;
  }
  for (const key of doomed) {
    try {
      store.removeItem(key);
    } catch {
      /* nothing to do about it, and nothing worth saying */
    }
  }
  return doomed.length;
}

function drop(draftId: string, storage: StorageLike): void {
  try {
    storage.removeItem(keyFor(draftId));
  } catch {
    /* see above */
  }
}

/**
 * How old a cached board is, in the words the header uses.
 *
 * Deliberately coarse. A cached board's age is the one number on the screen
 * that must not look precise: "captured 4 minutes ago" invites the reader to
 * trust it to the minute, and the whole point is that they should not trust it
 * at all.
 */
export function describeAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'moments ago';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
}
