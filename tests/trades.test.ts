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
  explainScore,
  groupByVerdict,
  rankTrades,
  urgencyOf,
  type Ownership,
  type TradeVerdict,
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
    carriedOverItems: 0,
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

  /**
   * The correction this file exists for.
   *
   * "Emerging" used to mean `items30 < 2` — a statement about how many rows the
   * ledger held, not about the player. It put the strongest 30-day signal on
   * the board into the emerging bucket whenever the backfill importer had
   * carried a run of issues across as one row, which is exactly what that
   * importer is supposed to do.
   */
  it('does not call a thinly sourced player emerging when the signal is not new', () => {
    // One item, +13, and none of it from this week: sustained, not emerging.
    expect(of({ last30: 13, last7: 0, items30: 1, lifetime: 13, itemsLifetime: 1 }, 'other')).toBe('trade_target');
  });

  it('calls a player emerging when the week carries the case and the weeks before it did not', () => {
    expect(of({ last30: 3, last7: 3, items30: 1 }, 'other')).toBe('emerging_target');
  });

  it('keeps a player with a sustained base out of emerging even when this week adds to it', () => {
    // +10 over the month with +4 this week is a strengthening established case,
    // not a new one: the 23 days before this week already cleared the bar.
    expect(of({ last30: 10, last7: 4, items30: 3 }, 'other')).toBe('trade_target');
  });

  it('does not let the week alone promote a decelerating player', () => {
    expect(of({ last30: 12, last7: 2, items30: 4 }, 'other')).toBe('trade_target');
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

  it('drops when this week points against the month it sits in', () => {
    expect(confidenceOf(w({ items30: 4, last30: 5, last7: -1 }), 0)).toBe('low');
  });

  /** Two agreeing observations is the bar; the second is allowed to be older. */
  it('lets an older agreeing record carry a single recent item to medium', () => {
    expect(confidenceOf(w({ items30: 1, last30: 4, lifetime: 9, itemsLifetime: 4 }), 0)).toBe('medium');
  });

  it('will not let the lifetime record carry a single item all the way to high', () => {
    expect(confidenceOf(w({ items30: 1, last30: 4, lifetime: 40, itemsLifetime: 30 }), 0)).toBe('medium');
  });

  it('does not accept a lifetime record that disagrees as corroboration', () => {
    // Conflicted, so low regardless — asserted because the corroboration branch
    // must never be reachable by a record pointing the other way.
    expect(confidenceOf(w({ items30: 1, last30: 4, lifetime: -9, itemsLifetime: 4 }), 0)).toBe('low');
  });

  /**
   * The separation the whole correction rests on.
   *
   * A single backfilled row carrying a season's tally is the most attractive
   * thing on the board and the least evidenced. Both readings are correct and
   * the engine has to be able to hold them at once.
   */
  it('keeps how attractive a player is independent of how well evidenced he is', () => {
    const thinButStrong = w({ last30: 13, last7: 0, items30: 1, lifetime: 13, itemsLifetime: 1 });
    const broadButModest = w({ last30: 4, last7: 1, items30: 4, lifetime: 4, itemsLifetime: 4 });

    expect(confidenceOf(thinButStrong, 0)).toBe('low');
    expect(confidenceOf(broadButModest, 0)).toBe('high');
    expect(urgencyOf(thinButStrong)).toBeGreaterThan(urgencyOf(broadButModest));
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

  /**
   * The 7-day term used to be `|last7|`, so a week pointing the other way made
   * a player look *more* urgent. It has to cost him instead.
   */
  it('charges a week that points against the month rather than paying for it', () => {
    expect(urgencyOf(w({ last30: 5, last7: -1 }))).toBeLessThan(urgencyOf(w({ last30: 5 })));
  });

  it('will not let one loud week outweigh the month it sits in', () => {
    // A +4 month with a +40 week is not a bigger case than a +8 month.
    expect(urgencyOf(w({ last30: 4, last7: 40 }))).toBeLessThan(urgencyOf(w({ last30: 8 })));
  });

  /** Otherwise the trade list is just a list of good players. */
  it('does not let the lifetime record drive discovery', () => {
    expect(urgencyOf(w({ last30: 3, lifetime: 40 }))).toBe(urgencyOf(w({ last30: 3, lifetime: 40, itemsLifetime: 99 })));
  });

  it('pays lifetime only as a bounded tie-break, never as the signal', () => {
    const supported = urgencyOf(w({ last30: 3, lifetime: 40 }));
    const bare = urgencyOf(w({ last30: 3 }));
    expect(supported).toBeGreaterThan(bare);
    expect(supported - bare).toBeLessThanOrEqual(0.5);
    // And a huge career cannot lift a quiet player above one who is moving.
    expect(urgencyOf(w({ last30: 3, lifetime: 400 }))).toBeLessThan(urgencyOf(w({ last30: 4 })));
  });

  it('ranks the emerging group on acceleration rather than the 30-day total', () => {
    // The bigger 30-day number, but none of it from this week.
    const stale = w({ last30: 9, last7: 2, items30: 3 });
    const surging = w({ last30: 4, last7: 4, items30: 2 });
    expect(urgencyOf(surging, 'emerging_target')).toBeGreaterThan(urgencyOf(stale, 'emerging_target'));
  });

  it('reports every term behind the number it produced', () => {
    const b = explainScore(w({ last30: 10, last7: 3, items30: 2, lifetime: 12, itemsLifetime: 6 }), 'trade_target');
    expect(b.basis).toBe('sustained');
    expect(b.prior23).toBe(7);
    expect(b.lifetimeSupport).toBe(0.5);
    expect(b.total).toBe(urgencyOf(w({ last30: 10, last7: 3, items30: 2, lifetime: 12, itemsLifetime: 6 })));
  });
});

/**
 * The two rows that started this, as the board actually held them.
 *
 * Both players' whole record sits inside the 30-day window. Gibbs arrived as
 * two weekly rows; Puka arrived as one backfilled row carrying a run of issues,
 * which the old classifier read as a thin sample and demoted for.
 */
describe('the Gibbs and Puka rows', () => {
  const gibbs = w({ last30: 10, last7: 0, items30: 2, lifetime: 10, itemsLifetime: 2 });
  const puka = w({ last30: 13, last7: 0, items30: 1, lifetime: 13, itemsLifetime: 1 });

  it('files both as trade targets, because neither case is new this week', () => {
    expect(classify(gibbs, 'other')).toBe('trade_target');
    expect(classify(puka, 'other')).toBe('trade_target');
  });

  it('ranks the stronger 30-day signal above the weaker one', () => {
    expect(urgencyOf(puka, 'trade_target')).toBeGreaterThan(urgencyOf(gibbs, 'trade_target'));
  });

  /**
   * The confidence reading was never the bug. One row really is one row, and
   * saying so is correct — what was wrong is that saying so also cost Puka his
   * bucket and his place in the order.
   */
  it('still reports the single-row player as the less well evidenced of the two', () => {
    expect(confidenceOf(puka, 0)).toBe('low');
    expect(confidenceOf(gibbs, 0)).toBe('medium');
  });
});

/** The cases the handoff names, kept as a table so the semantics stay legible. */
describe('the semantics, case by case', () => {
  const cases: { name: string; windows: TradeWindows; verdict: TradeVerdict; confidence: string }[] = [
    {
      name: 'established strong target',
      windows: w({ last30: 13, last7: 2, items30: 4, lifetime: 13, itemsLifetime: 4 }),
      verdict: 'trade_target',
      confidence: 'high',
    },
    {
      name: 'strong emerging',
      windows: w({ last30: 3, last7: 3, items30: 2, lifetime: 3, itemsLifetime: 2 }),
      verdict: 'emerging_target',
      confidence: 'medium',
    },
    {
      name: 'recent one-off',
      windows: w({ last30: 2, last7: 2, items30: 1, lifetime: 2, itemsLifetime: 1 }),
      verdict: 'emerging_target',
      confidence: 'low',
    },
    {
      name: 'sustained multi-source support',
      windows: w({ last30: 8, last7: 2, items30: 4, lifetime: 8, itemsLifetime: 4 }),
      verdict: 'trade_target',
      confidence: 'high',
    },
    {
      name: 'contradictory recent evidence',
      windows: w({ last30: 5, last7: -1, items30: 3, lifetime: 5, itemsLifetime: 3 }),
      verdict: 'trade_target',
      confidence: 'low',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.verdict}, ${c.confidence} confidence`, () => {
      expect(classify(c.windows, 'other')).toBe(c.verdict);
      expect(confidenceOf(c.windows, 0)).toBe(c.confidence);
    });
  }

  it('rates contradicted recent evidence below the same month running clean', () => {
    const contradicted = w({ last30: 5, last7: -1, items30: 3, lifetime: 5, itemsLifetime: 3 });
    const clean = w({ last30: 5, last7: 0, items30: 3, lifetime: 5, itemsLifetime: 3 });
    expect(urgencyOf(contradicted)).toBeLessThan(urgencyOf(clean));
    expect(confidenceOf(contradicted, 0)).toBe('low');
    expect(confidenceOf(clean, 0)).toBe('high');
  });

  /** Lifetime alone must not manufacture a current trade idea. */
  it('does not surface an old positive with nothing recent behind it', () => {
    const stale = w({ last30: 0, last7: 0, lifetime: 10, itemsLifetime: 6 });
    expect(classify(stale, 'other')).toBe('hold_mixed');
    expect(
      rankTrades([
        { player: player({ id: 'stale', fullName: 'Stale Sam', position: 'WR' }), ownership: 'other', signal: signal({ lifetime: 10, itemsLifetime: 6 }) },
      ]),
    ).toEqual([]);
  });

  /** The sell side reads the same windows the same way. */
  it('treats a deteriorating player on your roster symmetrically', () => {
    const sinking = w({ last30: -6, last7: -2, items30: 3, lifetime: 8, itemsLifetime: 9 });
    expect(classify(sinking, 'mine')).toBe('sell_high');
    expect(urgencyOf(sinking)).toBeGreaterThan(urgencyOf(w({ last30: -3, last7: -1, items30: 3, lifetime: 8, itemsLifetime: 9 })));
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
