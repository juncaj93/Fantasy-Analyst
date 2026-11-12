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

let current: Features = { tradesScreens: 'old', preview: null, playersInSeason: false, known: false };
const listeners = new Set<() => void>();

/** Record the switches. Null (no answer, or an older server): today's screens, and known. */
export function setFeatures(next: Partial<Features> | null | undefined): void {
  const merged: Features = {
    tradesScreens: next?.tradesScreens === 'new' ? 'new' : 'old',
    preview: next?.preview === 'trades' ? 'trades' : next?.preview === 'players' ? 'players' : null,
    playersInSeason: next?.playersInSeason === true,
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
