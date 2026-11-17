/**
 * Round 35: the UI revamp's switch and its faster loading.
 *
 * - UI_REVAMP reaches the phone on the status read, and is off unless set.
 * - With it on, a launch shows the last good answer for a screen's first read
 *   at once (kept for twelve hours, live league only, the screens' reads only)
 *   and the server's answer replaces it through the same `onFresh` a revisit
 *   uses. With it off, nothing is kept and nothing changes.
 * - A tab touched before it is opened starts its read once; the screen joins
 *   it instead of asking again, and still gets the newer answer.
 *
 * Every test here fails on the code before Round 35 (the modules, the switch
 * and the status field did not exist).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server/app.ts';
import { createTestDb } from './helpers/db.ts';
import { envFor, forbiddenSleeper } from './helpers/tradeLeague.ts';
import { MAX_AGE_MS, clearPersisted, isKept, readPersisted, setPersistence, writePersisted } from '../src/web/persistCache.ts';
import { cached, clearSessionCache, isKnownOrPending } from '../src/web/sessionCache.ts';
import { applyRevamp, bootRevamp, revampOn } from '../src/web/revamp.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A phone's storage, in memory. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: memoryStorage() });
  clearSessionCache();
});
afterEach(() => {
  setPersistence(false);
  vi.unstubAllGlobals();
});

describe('the UI_REVAMP switch', () => {
  it('is off in wrangler.toml and read as "on" only', () => {
    expect(read('wrangler.toml')).toMatch(/^UI_REVAMP = "off"$/m);
    expect(read('src/worker/index.ts')).toContain("uiRevamp: env.UI_REVAMP === 'on'");
  });

  it('reaches the phone on the status read, off unless set', async () => {
    const db = await createTestDb();
    const off = await createApp()(new Request('http://x/api/auth/status'), envFor(db, forbiddenSleeper().client));
    expect(((await off.json()) as { features: { uiRevamp: boolean } }).features.uiRevamp).toBe(false);
    const on = await createApp()(new Request('http://x/api/auth/status'), { ...envFor(db, forbiddenSleeper().client), uiRevamp: true });
    expect(((await on.json()) as { features: { uiRevamp: boolean } }).features.uiRevamp).toBe(true);
  });

  it('is remembered on the phone, so the next launch starts in the right look', () => {
    expect(bootRevamp()).toBe(false);
    applyRevamp(true);
    expect(revampOn()).toBe(true);
    expect(window.localStorage.getItem('fa.ui')).toBe('revamp');
    expect(bootRevamp()).toBe(true);
    applyRevamp(false);
    expect(revampOn()).toBe(false);
    expect(window.localStorage.getItem('fa.ui')).toBeNull();
  });
});

describe('the last good answer, kept across launches', () => {
  const PATH = '/api/leagues/L1/lineup';

  it('keeps only the screens\' first reads', () => {
    for (const path of [
      '/api/overview',
      '/api/leagues',
      '/api/auth/status',
      '/api/leagues/L1/roster',
      PATH,
      '/api/leagues/L1/matchup',
      '/api/leagues/L1/waivers',
      '/api/trades/screens/offers',
      '/api/players/season?leagueId=L1',
    ]) {
      expect(isKept(path), path).toBe(true);
    }
    for (const path of ['/api/players/1001/detail', '/api/leagues/L1/compare-pool?tab=mine', '/api/support/snapshot', '/api/data-health']) {
      expect(isKept(path), path).toBe(false);
    }
  });

  it('is not kept or shown with the switch off', () => {
    writePersisted(PATH, 'live', '{"n":1}');
    expect(readPersisted(PATH, 'live')).toBeNull();
  });

  it('is shown for twelve hours, for the live league only', () => {
    setPersistence(true);
    const now = 1_800_000_000_000;
    writePersisted(PATH, 'live', '{"n":1}', now);
    expect(readPersisted(PATH, 'live', now + 1000)?.value).toEqual({ n: 1 });
    expect(readPersisted(PATH, 'live', now + MAX_AGE_MS + 1)).toBeNull();
    expect(readPersisted(PATH, 'demo-sunday', now + 1000)).toBeNull();
    writePersisted(PATH, 'demo-sunday', '{"n":2}', now);
    expect(readPersisted(PATH, 'live', now + 1000)?.value).toEqual({ n: 1 });
  });

  it('is cleared when the switch goes off', () => {
    setPersistence(true);
    writePersisted(PATH, 'live', '{"n":1}');
    setPersistence(false);
    setPersistence(true);
    expect(readPersisted(PATH, 'live')).toBeNull();
  });

  it('paints at once on a launch and is replaced by the server\'s answer', async () => {
    setPersistence(true);
    /* Kept by an earlier launch, a minute ago. */
    writePersisted(PATH, 'live', JSON.stringify({ n: 1 }), Date.now() - 60_000);
    let release: (v: unknown) => void = () => {};
    let calls = 0;
    const fetcher = () => {
      calls++;
      return new Promise((resolve) => (release = resolve));
    };
    const fresh = vi.fn();
    /* Resolves before the server has answered anything. */
    expect(await cached(PATH, 'live', fetcher, { onFresh: fresh })).toEqual({ n: 1 });
    expect(calls).toBe(1);
    release({ n: 2 });
    await settle();
    expect(fresh).toHaveBeenCalledWith({ n: 2 });
    /* And the newer answer is what the next launch shows. */
    expect(readPersisted(PATH, 'live')?.value).toEqual({ n: 2 });
  });

  it('is not shown to a caller that cannot take a newer answer', async () => {
    setPersistence(true);
    writePersisted(PATH, 'live', JSON.stringify({ n: 1 }));
    expect(await cached(PATH, 'live', () => Promise.resolve({ n: 2 }))).toEqual({ n: 2 });
  });

  it('changes nothing with the switch off: a launch waits for the server', async () => {
    window.localStorage.setItem(`fa.swr:${PATH}`, JSON.stringify({ at: Date.now(), body: '{"n":1}' }));
    expect(await cached(PATH, 'live', () => Promise.resolve({ n: 2 }), { onFresh: () => {} })).toEqual({ n: 2 });
  });
});

describe('a tab touched before it opens', () => {
  const PATH = '/api/leagues/L1/matchup';

  it('starts its read once, and the screen joins it', async () => {
    setPersistence(true);
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve({ n: 1 });
    };
    expect(isKnownOrPending(PATH)).toBe(false);
    const touched = cached(PATH, 'live', fetcher);
    expect(isKnownOrPending(PATH)).toBe(true);
    const opened = cached(PATH, 'live', fetcher, { onFresh: () => {} });
    expect(await opened).toEqual(await touched);
    /* Opened a moment after the answer landed: not asked again. */
    await cached(PATH, 'live', fetcher, { onFresh: () => {} });
    await settle();
    expect(calls).toBe(1);
  });

  it('still brings the screen a newer answer that was on its way', async () => {
    setPersistence(true);
    writePersisted(PATH, 'live', JSON.stringify({ n: 1 }), Date.now() - 60_000);
    let release: (v: unknown) => void = () => {};
    const touched = cached(PATH, 'live', () => new Promise((resolve) => (release = resolve)));
    const fresh = vi.fn();
    expect(await cached(PATH, 'live', () => Promise.resolve({ n: 9 }), { onFresh: fresh })).toEqual({ n: 1 });
    release({ n: 2 });
    await touched;
    await settle();
    expect(fresh).toHaveBeenCalledWith({ n: 2 });
  });
});

describe('the shell', () => {
  const app = read('src/web/App.tsx');

  it('draws without waiting for the status read when the switch is on', () => {
    expect(app).toContain('if (!ready && !revamp) return <Loading');
  });

  it('takes Setup out of the tab bar and puts it behind the gear, with the switch on', () => {
    expect(app).toMatch(/revamp && t\.id === 'setup'\s*\? false/);
    expect(read('src/web/components/native.tsx')).toContain('data-testid="nav-setup"');
  });
});

afterEach(() => clearPersisted());
