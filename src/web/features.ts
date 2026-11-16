/**
 * The site's feature switches, as `/api/auth/status` reports them (Round 19).
 *
 * `tradesScreens` picks today's Trades screens or the rebuilt ones;
 * `playersInSeason` (Round 24) the in-season Players tab; `preview` is set
 * only on the preview upload. Read once at start; Trades shows a
 * skeleton until the answer lands, so it never draws (and reads for) the
 * wrong screen first.
 */

import { useSyncExternalStore } from 'react';

export interface Features {
  tradesScreens: 'old' | 'new';
  preview: 'trades' | 'players' | null;
  /** The in-season Players tab (Round 24, `PLAYERS_INSEASON`). False: today's tab. */
  playersInSeason: boolean;
  /** False until `/api/auth/status` has answered (or failed), so no screen picks before it knows. */
  known: boolean;
}

/**
 * The screens Alex uses today (both switches on since 12 and 13 November).
 *
 * Kept when `/api/auth/status` fails or answers with no switches at all
 * (Round 30, audit C2): one failed read used to put him back on the retired
 * Trades and Players screens for the whole session, with no message. A server
 * that answers sets them as it says: `tradesScreens: 'old'` and an absent
 * `playersInSeason` still mean off.
 */
const CURRENT_SCREENS = { tradesScreens: 'new', playersInSeason: true } as const;

let current: Features = { ...CURRENT_SCREENS, preview: null, known: false };
const listeners = new Set<() => void>();

/** Record the switches. Null (no answer, or no switches in it): the current screens, and known. */
export function setFeatures(next: Partial<Features> | null | undefined): void {
  const merged: Features =
    next == null
      ? { ...CURRENT_SCREENS, preview: null, known: true }
      : {
          tradesScreens: next.tradesScreens === 'new' ? 'new' : 'old',
          preview: next.preview === 'trades' ? 'trades' : next.preview === 'players' ? 'players' : null,
          playersInSeason: next.playersInSeason === true,
          known: true,
        };
  if (
    merged.tradesScreens === current.tradesScreens &&
    merged.preview === current.preview &&
    merged.playersInSeason === current.playersInSeason &&
    current.known
  )
    return;
  current = merged;
  for (const listener of listeners) listener();
}

export function useFeatures(): Features {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

/** What the screens read right now (for tests and non-React callers). */
export function currentFeatures(): Features {
  return current;
}
