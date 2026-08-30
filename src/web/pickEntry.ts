/**
 * Whether this browser is entering the draft's picks by hand, per draft.
 *
 * A league that drafts in a room tells Sleeper nothing until somebody types it
 * all in afterwards, so the reader records the picks themselves as names are
 * called. That is a mode, and it has to survive the phone locking, the browser
 * discarding a backgrounded tab, and the reader closing the app to look
 * something up — a draft runs three hours and none of that should cost them
 * their place.
 *
 * So it lives in `localStorage`, keyed by the Sleeper `draft_id` and nowhere
 * else. The key is the lesson `mock/session.ts` records: a preference stored by
 * feature alone is one global preference, and next season's draft would open
 * with last season's mode already on.
 *
 * The *picks* are not here. They go to the server, into the same table
 * Sleeper's picks go into — see `core/draft/manualPick.ts`. This module stores
 * one boolean per draft and has no opinion about anything else.
 */

const PREFIX = 'fa.pickentry.';

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    /* Private mode, or storage disabled. The mode simply does not persist. */
    return null;
  }
}

export function readPickEntry(draftId: string | null): boolean {
  if (!draftId) return false;
  try {
    return store()?.getItem(`${PREFIX}${draftId}`) === '1';
  } catch {
    return false;
  }
}

export function writePickEntry(draftId: string | null, on: boolean): void {
  if (!draftId) return;
  try {
    const s = store();
    if (!s) return;
    if (on) s.setItem(`${PREFIX}${draftId}`, '1');
    else s.removeItem(`${PREFIX}${draftId}`);
  } catch {
    /* Nothing to do and nothing worth saying: the mode is still on in memory. */
  }
}
