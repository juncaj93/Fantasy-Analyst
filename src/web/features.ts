/**
 * The site's feature switches, as `/api/auth/status` reports them (Round 19).
 *
 * `tradesScreens` picks today's Trades screens or the rebuilt ones; `preview`
 * is `trades` only on the preview upload. Read once at start, with today's
 * screens until the answer lands, so nothing waits on it.
 */

import { useSyncExternalStore } from 'react';

export interface Features {
  tradesScreens: 'old' | 'new';
  preview: 'trades' | null;
}

let current: Features = { tradesScreens: 'old', preview: null };
const listeners = new Set<() => void>();

export function setFeatures(next: Partial<Features> | null | undefined): void {
  if (!next) return;
  const merged: Features = {
    tradesScreens: next.tradesScreens === 'new' ? 'new' : 'old',
    preview: next.preview === 'trades' ? 'trades' : null,
  };
  if (merged.tradesScreens === current.tradesScreens && merged.preview === current.preview) return;
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
