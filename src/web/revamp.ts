/**
 * Round 35: the UI revamp switch, as the phone holds it.
 *
 * The server says whether UI_REVAMP is on (`features.uiRevamp` on the status
 * read). The phone remembers the last answer, so the next launch draws the
 * right look on its first frame instead of after a round trip, and marks the
 * page with `data-ui="revamp"`, which is all the stylesheet keys on.
 *
 * Off by default, and off whenever nothing has been said: a phone that has
 * never heard the switch is on draws today's app. The preview build
 * (`VITE_PREVIEW=ui`) is the one place it is forced on.
 *
 * It decides how things look and how fast they arrive, never what they say:
 * no number, pick or verdict reads it.
 */

import { useSyncExternalStore } from 'react';
import { setPersistence } from './persistCache.ts';

const KEY = 'fa.ui';
const FORCED = import.meta.env.VITE_PREVIEW === 'ui';

function stored(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'revamp';
  } catch {
    return false;
  }
}

let on = false;
const listeners = new Set<() => void>();

function paint(): void {
  if (typeof document === 'undefined') return;
  if (on) document.documentElement.dataset.ui = 'revamp';
  else delete document.documentElement.dataset.ui;
}

/** Before the first render: the remembered answer, on the page and in force. */
export function bootRevamp(): boolean {
  on = FORCED || (typeof window !== 'undefined' && stored());
  setPersistence(on);
  paint();
  return on;
}

export function revampOn(): boolean {
  return on;
}

/** The server's answer. Remembered for the next launch; a change redraws. */
export function applyRevamp(next: boolean): void {
  const value = FORCED || next;
  try {
    if (value) window.localStorage.setItem(KEY, 'revamp');
    else window.localStorage.removeItem(KEY);
  } catch {
    /* remembered for this page only */
  }
  if (value === on) return;
  on = value;
  setPersistence(on);
  paint();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the new look is drawn. Re-renders when the server's answer changes it. */
export function useRevamp(): boolean {
  return useSyncExternalStore(subscribe, revampOn, revampOn);
}
