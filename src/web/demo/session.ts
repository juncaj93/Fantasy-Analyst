/**
 * Whether this browser is in Demo Mode, and which scenario.
 *
 * One module owns that fact. The API client asks it before every request, the
 * indicator reads it to draw itself, and Settings changes it — so there is
 * exactly one answer to "is this a demo", which is the difference between a
 * DEMO badge that is always right and one that is usually right.
 *
 * What is stored, and what is not:
 *
 *   - **stored**: the chosen scenario id, in `localStorage`, so a reload during
 *     a demo does not silently drop back into live mode with a demo-looking
 *     screen still on it. §3 allows exactly this and nothing more.
 *   - **not stored**: every byte of fixture data, every board, every score.
 *     Those live in memory for as long as the scenario is selected and are
 *     dropped on exit.
 *
 * The one exception is the offline scenario's cached board, which is written
 * through the production offline cache because the production offline path is
 * the thing being demonstrated. It is keyed by the demo's own draft id, which
 * no real Sleeper draft can collide with, and it is deleted on exit.
 */

import type { DemoScenario } from '../../core/demo/types.ts';
/*
 * Type-only, so the engines stay out of the initial bundle.
 *
 * `api.ts` imports this module on every page load — it has to, because it asks
 * whether a demo is running before every request — and a static import of the
 * runtime here would drag the draft board, the start/sit engine, the waiver
 * pricing and the trade ranker into the download every reader pays for. §17
 * asks that Demo Mode cost the initial bundle as little as possible; the type
 * import is erased at build time and the value arrives through the dynamic
 * import in `enterDemo` below.
 */
import type { DemoRuntime } from '../../core/demo/runtime/index.ts';
import { clearScenarioCache } from '../../core/demo/fixtures/index.ts';
import { forgetBoard, rememberBoard } from '../offlineCache.ts';

const STORAGE_KEY = 'fa.demo.scenario';
/**
 * The audit hook.
 *
 * §14 asks that a test be able to select a named scenario deterministically. A
 * query parameter is the mechanism, and it is safe to leave ungated because of
 * what entering Demo Mode *is*: a read-only view of fixtures. There is no state
 * it can reach and nothing it can change, so the worst a stray link can do is
 * show somebody a clearly-labelled demo with an exit button on it.
 */
const QUERY_PARAM = 'demo';

export interface DemoSession {
  scenario: DemoScenario;
  runtime: DemoRuntime;
}

let current: DemoSession | null = null;
const listeners = new Set<() => void>();

export function demoSession(): DemoSession | null {
  return current;
}

export function subscribeToDemo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string | null): void {
  try {
    if (id == null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* Private mode, or a full quota. The demo still works for this page. */
  }
}

/**
 * Which scenario this page load should open in, if any.
 *
 * The query parameter wins over the stored choice, because it is the
 * deliberate, explicit act — a link somebody followed or a test that asked for
 * a named state.
 */
export function requestedScenarioId(search = window.location.search): string | null {
  const fromQuery = new URLSearchParams(search).get(QUERY_PARAM);
  if (fromQuery === '0' || fromQuery === 'off') return null;
  if (fromQuery) return fromQuery;
  return readStored();
}

/**
 * Tell the server this browser is in Demo Mode.
 *
 * Best effort, and deliberately not awaited into a failure. The refusal that
 * matters is the client-side one in `api.ts`, which cannot be skipped; this
 * adds the second one, below the UI, for requests the app did not make. An
 * older deployment that has no such route simply does not get the marker, and
 * the demo is no less read-only for it.
 */
async function markServer(entering: boolean): Promise<void> {
  try {
    await fetch(entering ? '/api/demo/enter' : '/api/demo/exit', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    /* No network, or an older worker. The client-side refusal still stands. */
  }
}

/**
 * Enter a scenario, or move to a different one.
 *
 * Throws when the scenario is unknown or is one that is declared but waiting
 * for its production surface. Nothing is stored and nothing is marked until the
 * runtime has actually built, so a failure leaves the app in live mode rather
 * than in a half-entered demo.
 */
export async function enterDemo(scenarioId: string): Promise<DemoSession> {
  /*
   * The registry arrives with the runtime, not with the app.
   *
   * Twenty-five scenarios with a sentence of description each is a few
   * kilobytes nobody who never opens Demo Mode should download, and this module
   * is loaded on every page load because `api.ts` has to ask it whether a
   * scenario is running before every request. `'on'` and `'1'` are accepted as
   * a shorthand for "whichever one is the default", which is what a hand-typed
   * `?demo=1` means.
   */
  const { DEFAULT_SCENARIO_ID, findScenario } = await import('../../core/demo/registry.ts');
  const wanted = scenarioId === '1' || scenarioId === 'on' ? DEFAULT_SCENARIO_ID : scenarioId;
  const scenario = findScenario(wanted);
  if (!scenario) throw new Error(`There is no demo scenario called "${wanted}".`);

  const { DemoRuntime } = await import('../../core/demo/runtime/index.ts');
  const runtime = await DemoRuntime.forScenario(scenario);
  const wasActive = current != null;
  current = { scenario, runtime };
  writeStored(scenario.id);
  if (!wasActive) await markServer(true);

  await seedOfflineCapture(runtime);
  announce();
  return current;
}

/**
 * The one thing a scenario is allowed to write to the browser.
 *
 * The offline scenario demonstrates a production behaviour — the draft screen
 * falling back to the board it captured before the signal went — and that
 * behaviour needs a real capture in the real cache to be demonstrated at all.
 * So the runtime builds one, it goes through the same `rememberBoard` the live
 * app uses, and the board request then fails exactly as it would in a tunnel.
 */
async function seedOfflineCapture(runtime: DemoRuntime): Promise<void> {
  const capture = await runtime.offlineCapture();
  if (!capture) return;
  rememberBoard(capture.draftId, capture.board, {
    // Captured twenty minutes before the scenario's clock, so the screen has an
    // honest age to print rather than "just now".
    now: Date.now() - 20 * 60_000,
  });
}

/**
 * Leave, and restore live mode completely.
 *
 * Everything the demo touched is undone here: the stored selection, the
 * in-memory fixtures, the offline capture, and the server's marker. What is
 * deliberately *not* touched is anything that was already the reader's — their
 * theme, their session, their real cached board for a real draft.
 */
export async function exitDemo(): Promise<void> {
  const leaving = current;
  current = null;
  writeStored(null);
  clearScenarioCache();
  if (leaving) {
    const capture = await leaving.runtime.offlineCapture().catch(() => null);
    if (capture) forgetBoard(capture.draftId);
    await markServer(false);
  }
  announce();
}

/**
 * Restore the demo on a page load, if one was running.
 *
 * Called once before the app renders, so the first request the app makes
 * already goes to the runtime rather than to the live server — which is what
 * stops a reload flashing live data for a frame.
 */
export async function restoreDemo(): Promise<DemoSession | null> {
  const id = requestedScenarioId();
  if (!id) return null;
  try {
    return await enterDemo(id);
  } catch {
    /*
     * An unknown or unwired id — a stale stored value, or a link written
     * against a scenario that has since been renamed. Fall back to live mode
     * rather than to an error page, and forget the value so it does not fail
     * again on the next load.
     */
    writeStored(null);
    return null;
  }
}
