/**
 * Round 35: the UI revamp preview (`VITE_PREVIEW=ui`).
 *
 * The PIN, then the whole app with the UI_REVAMP switch on, opening on Team in
 * season. Every answer comes from `uiResponses.json`, captured from the local
 * made-up league (the same names the earlier previews used: Trey Halloran,
 * Marcus Vance, Devin Okafor ...) with every switch that is on for the live
 * site on (`npm run preview:capture`). Nothing here reads the real league or
 * the database, and nothing writes: a change answers "not in the preview".
 *
 * The screens are the real ones. Only the source of their answers differs.
 */

import { useState } from 'react';
import { App } from '../App.tsx';
import { answerFromPreview } from '../api.ts';
import { PinGate, wasUnlocked } from './pin.tsx';
import captured from './uiResponses.json';

interface Captured {
  /** `GET path` (with its query) to the server's answer. */
  get: Record<string, { status: number; body: unknown }>;
  /** Compare's verdicts, by slot and the sorted player ids. */
  compare: Record<string, unknown>;
}

const NOT_HERE = 'This is not in the preview.';

/** The key a Compare verdict was captured under. */
export function compareKey(body: { playerIds?: string[]; slot?: string | null } | null): string {
  return `${body?.slot ?? ''}|${[...(body?.playerIds ?? [])].sort().join(',')}`;
}

export function previewAnswer(data: Captured) {
  return async (method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    if (method === 'GET') {
      const hit = data.get[path] ?? data.get[path.split('?')[0]!];
      return hit ?? { status: 404, body: { error: NOT_HERE } };
    }
    if (path === '/api/startsit/compare') {
      const verdict = data.compare[compareKey(body as { playerIds?: string[]; slot?: string | null })];
      return verdict ? { status: 200, body: verdict } : { status: 404, body: { error: NOT_HERE } };
    }
    /* Pull to refresh: nothing to fetch, so it finishes at once. */
    if (path === '/api/refresh') {
      const now = new Date().toISOString();
      const kind = (body as { kind?: string } | null)?.kind ?? 'startsit';
      const job = { id: `preview-${now}`, kind, state: 'done', startedAt: now, finishedAt: now, ms: 0, sources: [], complete: true, cost: null };
      return { status: 200, body: { job, joined: false } };
    }
    return { status: 403, body: { error: NOT_HERE } };
  };
}

export function UiPreview() {
  const [unlocked, setUnlocked] = useState(wasUnlocked);
  if (!unlocked) return <PinGate title="New look preview" onUnlock={() => setUnlocked(true)} />;
  answerFromPreview(previewAnswer(captured as unknown as Captured));
  return <App />;
}
