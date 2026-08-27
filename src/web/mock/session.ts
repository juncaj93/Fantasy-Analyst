/**
 * Whether this browser is rehearsing, and the state of the rehearsal.
 *
 * One module owns both facts, the way `demo/session.ts` owns them for Demo
 * Mode. The API client asks whether a mock is running before every request, the
 * Mock Draft screen reads and writes the state, and nothing else in the app
 * knows this file exists.
 *
 * ## Keyed by the draft, and only by the draft
 *
 * The storage key carries the Sleeper `draft_id`. That is the whole of §3's
 * scoping rule and it is the same lesson as migration `0029`: a shortlist keyed
 * by player alone turned out to be one global list, and a finished draft's
 * queue surfaced in the next league's board. So a mock for one league is
 * written at a key another league can never read, deleting one leaves the other
 * untouched, and there is deliberately no way to ask for "the mock" without
 * naming which draft it is for.
 *
 * ## What is stored, and what is not
 *
 *   - **stored**: the rehearsal's own state — a draft id, a seed, and a list of
 *     picks. A few kilobytes at most, in `localStorage`, so a reload during a
 *     mock does not throw the draft away.
 *   - **not stored**: every board, every score, every player. Those are built
 *     from the state on the server, on request, and are never written anywhere.
 *
 * ## Deleted the moment the real draft starts
 *
 * `forgetMock` is called from two places and both are the same rule: the Draft
 * screen deletes the state as soon as the real board reports a pick, and the
 * server refuses to build a mock board for a draft that is underway. Neither is
 * a backstop for the other — the first is what makes the state actually go
 * away, and the second is what makes a client that has not noticed unable to
 * carry on regardless.
 *
 * ## No world marker, deliberately
 *
 * Demo Mode moves `world.ts` because it substitutes the answer to every path.
 * A mock does not: while one is running, a GET returns exactly what it would
 * have returned anyway, because the only thing a rehearsal changes is served at
 * its own path and is a POST that is never cached. Marking a world here would
 * empty the session cache twice per rehearsal and correct nothing.
 */

import { assertAllowedInMock } from '../../core/draft/mockGuard.ts';
import { isUsableMockState, type MockDraftState } from '../../core/draft/mockDraft.ts';

/** `fa.mock.<draft id>`. The draft is in the key; see the note above. */
const STORAGE_PREFIX = 'fa.mock.';

const storageKey = (draftId: string) => `${STORAGE_PREFIX}${draftId}`;

/**
 * The draft currently being rehearsed, or null.
 *
 * "Running" means the Mock Draft screen is open. A stored state for a draft
 * nobody is looking at is a rehearsal that can be resumed, not one in progress
 * — and the read-only rule applies to the second, because that is the window in
 * which a stray write would be a write made *during* a rehearsal.
 */
let running: string | null = null;

const listeners = new Set<() => void>();

export function mockRunning(): string | null {
  return running;
}

export function subscribeToMock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * The browser's half of the refusal.
 *
 * Called at the one seam every request in this app goes through, so there is no
 * screen, no component and no future endpoint that can route around it. It
 * throws rather than returning a status, for the same reason the demo runtime
 * does: a caller can ignore a status code and cannot ignore a rejected promise.
 *
 * The server's half is a cookie and a middleware, and it is not a backstop for
 * this one — it catches the request that never came through here at all.
 */
export function assertMockAllows(method: string, path: string): void {
  if (running == null) return;
  assertAllowedInMock(method, path.split('?')[0] ?? path);
}

/**
 * Begin rehearsing, and tell the server so.
 *
 * The server marker is best effort and deliberately not awaited into a failure,
 * exactly as Demo Mode's is: the refusal that cannot be skipped is the one
 * above, and a deployment too old to have the route is no less read-only for
 * the request the app never makes.
 */
export async function enterMock(draftId: string): Promise<void> {
  if (running === draftId) return;
  running = draftId;
  announce();
  await markServer(true);
}

/** Stop rehearsing. The stored state survives — leaving is not resetting. */
export async function exitMock(): Promise<void> {
  if (running == null) return;
  running = null;
  announce();
  await markServer(false);
}

/** This draft's rehearsal, if there is one this build can read. */
export function readMock(draftId: string): MockDraftState | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(draftId));
  } catch {
    /* Private mode, or storage disabled. There is simply no stored mock. */
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUsableMockState(parsed, draftId) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keep this rehearsal. Filed under its own draft and no other. */
export function writeMock(state: MockDraftState): void {
  try {
    window.localStorage.setItem(storageKey(state.draftId), JSON.stringify(state));
  } catch {
    /*
     * A full quota, or private mode. The rehearsal still works for this page:
     * the state is held in the screen's own React state and posted with every
     * request, so what is lost is the reload, not the draft.
     */
  }
}

/**
 * Delete this draft's rehearsal outright.
 *
 * Not hidden, not flagged — the row is removed. Called when the real draft
 * makes its first pick, and when the reader asks for a reset before a new one
 * is written in its place.
 */
export function forgetMock(draftId: string): void {
  try {
    window.localStorage.removeItem(storageKey(draftId));
  } catch {
    /* Nothing was stored, so there is nothing to remove. */
  }
}

async function markServer(entering: boolean): Promise<void> {
  try {
    await fetch(entering ? '/api/mock/enter' : '/api/mock/exit', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    /* No network, or an older worker. The client-side refusal still stands. */
  }
}
