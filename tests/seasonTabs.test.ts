/**
 * The bar's seasonal slots while the overview is slow, failed or answered.
 * See `src/web/seasonTabs.ts` for the 28 September 2026 failure this is for.
 */

import { describe, expect, it } from 'vitest';
import {
  fromOverview,
  recallSeasonTabs,
  rememberSeasonTabs,
  resolveSeasonTabs,
  type StorageLike,
} from '../src/web/seasonTabs.ts';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const IN_SEASON = { season: { draftVisible: false }, lifecycle: { matchupVisible: true } };

describe('resolveSeasonTabs', () => {
  it('never reads a pending answer as pre-season', () => {
    const tabs = resolveSeasonTabs({ overview: null, failed: false, remembered: null });
    expect(tabs).toEqual({ draftVisible: false, matchupVisible: false, source: 'pending' });
  });

  it('keeps the last answer while a new one is in flight', () => {
    const tabs = resolveSeasonTabs({
      overview: null,
      failed: false,
      remembered: { draftVisible: false, matchupVisible: true },
    });
    expect(tabs).toEqual({ draftVisible: false, matchupVisible: true, source: 'remembered' });
  });

  it('lets a server answer override what was remembered', () => {
    const tabs = resolveSeasonTabs({
      overview: { season: { draftVisible: true }, lifecycle: { matchupVisible: false } },
      failed: false,
      remembered: { draftVisible: false, matchupVisible: true },
    });
    expect(tabs).toEqual({ draftVisible: true, matchupVisible: false, source: 'server' });
  });

  it('keeps the board on a failed read with nothing remembered', () => {
    const tabs = resolveSeasonTabs({ overview: null, failed: true, remembered: null });
    expect(tabs).toEqual({ draftVisible: true, matchupVisible: false, source: 'failed' });
  });

  it('prefers a remembered answer to the failure default', () => {
    const tabs = resolveSeasonTabs({
      overview: null,
      failed: true,
      remembered: { draftVisible: false, matchupVisible: true },
    });
    expect(tabs.source).toBe('remembered');
    expect(tabs.draftVisible).toBe(false);
  });
});

describe('fromOverview', () => {
  it('reads absent fields the way older deployments always have', () => {
    expect(fromOverview({})).toEqual({ draftVisible: true, matchupVisible: false });
    expect(fromOverview(IN_SEASON)).toEqual({ draftVisible: false, matchupVisible: true });
  });
});

describe('remembering', () => {
  it('round-trips per world, and a demo never teaches the live bar', () => {
    const storage = memoryStorage();
    rememberSeasonTabs('live', fromOverview(IN_SEASON), storage);
    rememberSeasonTabs('demo-preseason', { draftVisible: true, matchupVisible: false }, storage);
    expect(recallSeasonTabs('live', storage)).toEqual({ draftVisible: false, matchupVisible: true });
    expect(recallSeasonTabs('demo-preseason', storage)).toEqual({ draftVisible: true, matchupVisible: false });
    expect(recallSeasonTabs('demo-other', storage)).toBeNull();
  });

  it('treats garbage, missing storage and a throwing store as nothing remembered', () => {
    const storage = memoryStorage();
    storage.data.set('fa.seasonTabs.live', '{not json');
    expect(recallSeasonTabs('live', storage)).toBeNull();
    storage.data.set('fa.seasonTabs.live', JSON.stringify({ draftVisible: 'no' }));
    expect(recallSeasonTabs('live', storage)).toBeNull();
    expect(recallSeasonTabs('live', null)).toBeNull();

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(recallSeasonTabs('live', throwing)).toBeNull();
    expect(() => rememberSeasonTabs('live', fromOverview(IN_SEASON), throwing)).not.toThrow();
  });
});
