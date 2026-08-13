/**
 * Trade intelligence.
 *
 * The distinctions that matter here are the ones a person would argue about:
 * "sell high" versus "trade away" (both have bad news; only one still has
 * value), and "trade target" versus "add" (only one costs you something).
 * Getting those wrong is worse than saying nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  classify,
  confidenceOf,
  conflicted,
  groupByVerdict,
  rankTrades,
  urgencyOf,
  type Ownership,
  type TradeWindows,
} from '../src/core/trades/engine.ts';
import { player } from './helpers/players.ts';

const w = (over: Partial<TradeWindows> = {}): TradeWindows => ({
  lifetime: 0,
  season: 0,
  last30: 0,
  last7: 0,
  items30: 0,
  itemsLifetime: 0,
  ...over,
});

const signal = (over: Partial<TradeWindows> = {}) => {
  const win = w(over);
  const window = (net: number, items: number) => ({ positive: 0, negative: 0, net, items });
  return {
    playerId: 'x',
    raw: window(win.lifetime, win.itemsLifetime),
    last7: window(win.last7, win.last7 === 0 ? 0 : 1),
    last30: window(win.last30, win.items30),
    seasonToDate: window(win.season, win.itemsLifetime),
    categoryBreakdown: {},
    pendingCount: 0,
    mixedCount: 0,
    lastEvidenceAt: null,
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
};

describe('classifying a player', () => {
  const of = (windows: Partial<TradeWindows>, ownership: Ownership) => classify(w(windows), ownership);

  it('calls a rising player somebody else holds a trade target', () => {
    expect(of({ last30: 4, items30: 3 }, 'other')).toBe('trade_target');
  });

  /** Nobody trades for a free agent. */
  it('calls the same player an add when nobody rosters them', () => {
    expect(of({ last30: 4, items30: 3 }, 'free')).toBe('add_waiver');
  });

  it('calls a rising player with a thin sample emerging, not a target', () => {
    expect(of({ last30: 3, items30: 1 }, 'other')).toBe('emerging_target');
  });

  it('ignores movement too small to mean anything', () => {
    expect(of({ last30: 1, items30: 4 }, 'other')).toBe('hold_mixed');
  });

  /**
   * The distinction the brief cares most about: falling news on a player who
   * was well regarded is something to sell; on a player who never was, it is
   * something to be rid of.
   */
  it('separates selling high from cutting losses by the lifetime record', () => {
    expect(of({ last30: -4, lifetime: 8, items30: 3 }, 'mine')).toBe('sell_high');
    expect(of({ last30: -4, lifetime: -6, items30: 3 }, 'mine')).toBe('trade_away');
  });

  it('holds a player of yours whose news is not getting worse', () => {
    expect(of({ last30: 5, lifetime: 5, items30: 3 }, 'mine')).toBe('hold_mixed');
  });
});

describe('how much to trust it', () => {
  it('rises with the amount of recent evidence', () => {
    expect(confidenceOf(w({ items30: 3, last30: 3 }), 0)).toBe('high');
    expect(confidenceOf(w({ items30: 2, last30: 2 }), 0)).toBe('medium');
    expect(confidenceOf(w({ items30: 1, last30: 2 }), 0)).toBe('low');
  });

  it('drops when the trend contradicts the lifetime record', () => {
    expect(confidenceOf(w({ items30: 4, last30: 4, lifetime: -6 }), 0)).toBe('low');
  });

  it('drops when most of the evidence has not been reviewed', () => {
    expect(confidenceOf(w({ items30: 3, last30: 3 }), 3)).toBe('low');
  });

  it('sees a contradiction only when both windows actually say something', () => {
    expect(conflicted(w({ lifetime: 5, last30: -3 }))).toBe(true);
    expect(conflicted(w({ lifetime: 5, last30: 0 }))).toBe(false);
    expect(conflicted(w({ lifetime: 0, last30: -3 }))).toBe(false);
  });
});

describe('what gets looked at first', () => {
  it('ranks a bigger 30-day move above a smaller one', () => {
    expect(urgencyOf(w({ last30: 6 }))).toBeGreaterThan(urgencyOf(w({ last30: 3 })));
  });

  it('prefers the one still moving this week', () => {
    expect(urgencyOf(w({ last30: 4, last7: 3 }))).toBeGreaterThan(urgencyOf(w({ last30: 4 })));
  });

  it('pushes a contradicted signal down', () => {
    expect(urgencyOf(w({ last30: 4, lifetime: -5 }))).toBeLessThan(urgencyOf(w({ last30: 4, lifetime: 5 })));
  });

  /** Otherwise the trade list is just a list of good players. */
  it('does not let the lifetime record drive discovery', () => {
    expect(urgencyOf(w({ last30: 3, lifetime: 40 }))).toBe(urgencyOf(w({ last30: 3, lifetime: 40, itemsLifetime: 99 })));
  });
});

describe('the list as a whole', () => {
  const candidates = [
    { player: player({ id: 'rise', fullName: 'Rising Rob', position: 'WR' }), ownership: 'other' as const, signal: signal({ last30: 5, last7: 2, items30: 3, lifetime: 6, itemsLifetime: 8 }) },
    { player: player({ id: 'fall', fullName: 'Falling Fran', position: 'RB' }), ownership: 'mine' as const, signal: signal({ last30: -5, last7: -2, items30: 3, lifetime: 9, itemsLifetime: 12 }) },
    { player: player({ id: 'free', fullName: 'Free Fred', position: 'TE' }), ownership: 'free' as const, signal: signal({ last30: 4, items30: 2, lifetime: 4, itemsLifetime: 4 }) },
    { player: player({ id: 'quiet', fullName: 'Quiet Quinn', position: 'WR' }), ownership: 'other' as const, signal: signal({ lifetime: 10, itemsLifetime: 10 }) },
    { player: player({ id: 'nothing', fullName: 'Unknown Ulysses', position: 'WR' }), ownership: 'other' as const, signal: null },
  ];

  it('drops players with nothing to say rather than listing them as holds', () => {
    const ids = rankTrades(candidates).map((s) => s.playerId);
    expect(ids).not.toContain('nothing');
    expect(ids).not.toContain('quiet');
  });

  it('keeps a well-regarded player out of the trade list when the news has gone quiet', () => {
    // Quiet Quinn has a lifetime +10 and no recent evidence. That is a good
    // player, not a trade idea.
    expect(rankTrades(candidates).some((s) => s.playerId === 'quiet')).toBe(false);
  });

  it('explains each call in words, with counterpoints', () => {
    const rob = rankTrades(candidates).find((s) => s.playerId === 'rise')!;
    expect(rob.reasons.join(' ')).toContain('improving over 30 days');
    expect(rob.reasons.join(' ')).toContain('still moving this week');
  });

  it('admits it cannot see a market price when it says sell high', () => {
    const fran = rankTrades(candidates).find((s) => s.playerId === 'fall')!;
    expect(fran.verdict).toBe('sell_high');
    expect(fran.counterpoints.join(' ')).toContain('no market price');
  });

  it('groups into sections in a fixed order and omits empty ones', () => {
    const sections = groupByVerdict(rankTrades(candidates));
    expect(sections.map((s) => s.verdict)).toEqual(['trade_target', 'add_waiver', 'sell_high']);
    expect(sections.every((s) => s.players.length > 0)).toBe(true);
  });

  it('works with no Vegas or usage data at all', () => {
    // Everything above ran on the evidence ledger alone; this is the assertion
    // that says so on purpose.
    expect(rankTrades(candidates).length).toBeGreaterThan(0);
  });
});
