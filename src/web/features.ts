/**
 * The site's feature switches, as `/api/auth/status` reports them (Round 19).
 *
 * `tradesScreens` picks today's Trades screens or the rebuilt ones; `preview`
 * is `trades` only on the preview upload. Read once at start; Trades shows a
 * skeleton until the answer lands, so it never draws (and reads for) the
 * wrong screen first.
 */

import { useSyncExternalStore } from 'react';

export interface Features {
  tradesScreens: 'old' | 'new';
  preview: 'trades' | null;
  /** False until `/api/auth/status` has answered (or failed), so no screen picks before it knows. */
  known: boolean;
}

let current: Features = { tradesScreens: 'old', preview: null, known: false };
const listeners = new Set<() => void>();

/** Record the switches. Null (no answer, or an older server): today's screens, and known. */
export function setFeatures(next: Partial<Features> | null | undefined): void {
  const merged: Features = {
    tradesScreens: next?.tradesScreens === 'new' ? 'new' : 'old',
    preview: next?.preview === 'trades' ? 'trades' : null,
    known: true,
  };
  if (merged.tradesScreens === current.tradesScreens && merged.preview === current.preview && current.known) return;
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
