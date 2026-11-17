/**
 * Round 36: the UI revamp, part 2 (Waivers, Trades, Players, Setup), behind
 * UI_REVAMP.
 *
 * - Draft mode keeps today's look: while a draft is ahead the switch is not
 *   in force, whatever the server says.
 * - The stash, cover and block lines become cards: the same reason and the
 *   same bid band, the bid on the right as "Waivers $N", a tap for Compare.
 * - Setup's read and the Trades rosters join the kept first reads.
 * - The explanatory sentences are marked, and the one rule hides them only
 *   with the switch on.
 *
 * Every test here fails on the code before Round 36 (`setDraftSeason`,
 * `extraCard` and `extraSheet` did not exist, and neither read was kept).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyRevamp, bootRevamp, revampOn, setDraftSeason } from '../src/web/revamp.ts';
import { isKept, persistenceOn, setPersistence } from '../src/web/persistCache.ts';
import { extraCard, extraLine, extraSheet } from '../src/web/waiverCard.ts';
import type { UpsideStashLine } from '../src/core/waivers/upsideStash.ts';
import type { BlockLine } from '../src/core/waivers/block.ts';
import type { CoverLine } from '../src/core/waivers/lookAhead.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

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

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: memoryStorage() });
});
afterEach(() => {
  setDraftSeason(false);
  applyRevamp(false);
  setPersistence(false);
  vi.unstubAllGlobals();
});

describe('draft mode keeps today\'s look', () => {
  it('the switch is not in force while a draft is ahead, and returns once it is done', () => {
    bootRevamp();
    applyRevamp(true);
    expect(revampOn()).toBe(true);
    setDraftSeason(true);
    expect(revampOn()).toBe(false);
    expect(persistenceOn()).toBe(false);
    /* The server's answer is still remembered for after the draft. */
    expect(window.localStorage.getItem('fa.ui')).toBe('revamp');
    setDraftSeason(false);
    expect(revampOn()).toBe(true);
  });

  it('the shell tells the switch which season it is, before the first paint', () => {
    const app = read('src/web/App.tsx');
    expect(app).toContain('useLayoutEffect(() => setDraftSeason(draftVisible), [draftVisible]);');
  });
});

const STASH: UpsideStashLine = {
  playerId: 's1',
  name: 'Hollis Marchetti',
  position: 'RB',
  team: 'NYJ',
  path: { kind: 'next_man_up', starterId: 'x', starterName: 'Breece Hall', starterRate: 14 },
  reason: 'next up behind Breece Hall, hurt',
  value: 14,
  bid: { kind: 'claim', low: 0, high: 1 },
  room: { kind: 'drop', playerId: 'd1', name: 'Jonah Priestley' },
};
const COVER: CoverLine = {
  playerId: 'c1',
  name: 'Casey Lindqvist',
  position: 'QB',
  team: 'DEN',
  week: 14,
  reason: 'covers your Week 14 bye at QB',
  gain: 14.2,
  bid: { kind: 'free' },
  room: { kind: 'open' },
};
const BLOCK: BlockLine = {
  playerId: 'b1',
  name: 'Tennessee',
  position: 'DEF',
  team: 'TEN',
  reason: 'opponent needs a DEF',
  detail: 'his DEF is on bye',
  gain: 5.1,
  bid: { kind: 'claim', low: 2, high: 2 },
  room: { kind: 'open' },
};

describe('stash, cover and block as cards', () => {
  it('keep the line\'s reason and bid band; the bid reads "Waivers $N" like every pick', () => {
    const stash = extraCard('stash', STASH);
    expect(stash.gain).toBe('Stash');
    expect(stash.reason).toBe(STASH.reason);
    expect(stash.chips).toEqual([
      { key: 'waivers', label: 'Waivers $0–1' },
      { key: 'drop', label: 'Drop: Priestley' },
    ]);
    /* The same band the old line printed. */
    expect(extraLine('stash', STASH)).toContain('bid $0 to $1');

    const cover = extraCard('cover', COVER);
    expect(cover.gain).toBe('Cover');
    expect(cover.chips).toEqual([
      { key: 'free', label: 'Free agent' },
      { key: 'open', label: 'Open spot' },
    ]);

    const block = extraCard('block', BLOCK);
    expect(block.gain).toBe('Block');
    expect(block.chips).toEqual([
      { key: 'waivers', label: 'Waivers $2' },
      { key: 'open', label: 'Open spot' },
    ]);
    expect(extraCard('stash', { ...STASH, room: { kind: 'reserve' } }).chips[1]).toEqual({ key: 'ir', label: 'IR slot' });
  });

  it('a tap compares him with the player he would replace, or opens the list when the spot is open', () => {
    expect(extraSheet(STASH).partner).toEqual({ playerId: 'd1', name: 'Jonah Priestley' });
    expect(extraSheet(COVER).partner).toBeNull();
    expect(extraSheet(BLOCK).partner).toBeNull();
    expect(extraSheet(STASH).playerId).toBe('s1');
  });
});

describe('speed: the new reads kept for the next launch', () => {
  it('Setup\'s read and the Trades rosters are kept; their neighbours are not', () => {
    expect(isKept('/api/setup/status')).toBe(true);
    expect(isKept('/api/trades/screens/teams')).toBe(true);
    expect(isKept('/api/setup/newsletter')).toBe(false);
    expect(isKept('/api/trades/screens/verdict?b=2&give=a&get=b')).toBe(false);
  });

  it('the gear starts Setup\'s read and the idle moment fetches Setup\'s code', () => {
    expect(read('src/web/components/native.tsx')).toContain('onPointerDown={() => prefetch(SETUP_READ)}');
    expect(read('src/web/App.tsx')).toMatch(/warm = \(\) => \{[\s\S]*?loadSetupScreen\(\)/);
  });
});

describe('the explanatory sentences', () => {
  it('one rule hides them, and only with the switch on', () => {
    const css = read('src/web/styles.css');
    expect(css).toContain("[data-ui='revamp'] :is(.blurb, .draft-only) {\n  display: none;\n}");
    expect(css).not.toMatch(/^\.blurb\b/m);
  });

  it('are marked on Setup, its pages and the decision screens', () => {
    const setup = read('src/web/screens/SetupScreen.tsx');
    expect(setup.match(/className="faint blurb"/g)?.length ?? 0).toBeGreaterThanOrEqual(24);
    expect(setup).toContain('<div className="draft-only">');
    expect(read('src/web/components/weekly.tsx')).toContain('weekly-changes blurb');
    expect(read('src/web/components/playerPage.tsx').match(/className="blurb"/g)).toHaveLength(3);
  });
});
