/**
 * Round 20: waiver bids from what this league actually pays.
 *
 * Alex: the app often told him to spend more than he should. The bid is now
 * the league's own price for a starter at the position (`leagueBidHistory.ts`,
 * three seasons of claims), $0 when nobody else is likely to bid, never above
 * his worth to the roster, never into the $20 playoff reserve. One number and
 * one short reason, wherever a bid is shown.
 */

import { describe, expect, it } from 'vitest';
import { priceRowFor, smartBid, SMART_BID } from '../src/core/faab/smartBid.ts';
import { LEAGUE_BID_HISTORY, type BidHistorySummary } from '../src/core/faab/leagueBidHistory.ts';
import { bidLabel, bidNote } from '../src/web/waiverCard.ts';
import type { TierBid } from '../src/core/waivers/tierPlan.ts';

/** A small league record with known numbers, so the rule is read and not the data. */
const HISTORY: BidHistorySummary = {
  generated: '2026-11-11',
  seasons: ['2024', '2025', '2026'],
  weeks: { '2024': 17, '2025': 17, '2026': 9 },
  claims: 600,
  playersWon: 300,
  contested: 90,
  wonAtZeroOrOne: 0.5,
  pricePerPoint: 0.5,
  minContested: 8,
  starter: {
    RB: { claims: 13, contested: 9, p50: 7, p75: 11, paidMedian: 16, won: [[1, 0.1], [2, 0.16], [3, 0.27], [7, 0.54], [9, 0.71], [11, 0.77], [12, 0.94], [26, 1]] },
    WR: { claims: 27, contested: 10, p50: 6, p75: 10, paidMedian: 13, won: [[2, 0.34], [4, 0.49], [6, 0.72], [10, 0.86], [12, 0.91], [19, 1]] },
    TE: { claims: 12, contested: 4, p50: 1, p75: 2, paidMedian: 11, won: [[1, 0.5], [2, 0.81], [16, 1]] },
    ALL: { claims: 105, contested: 38, p50: 3, p75: 7, paidMedian: 11, won: [[1, 0.27], [3, 0.53], [6, 0.73], [7, 0.8], [12, 0.95], [26, 1]] },
  },
  depth: {
    RB: { claims: 63, contested: 19, p50: 2, p75: 4, paidMedian: 6, won: [[1, 0.48], [4, 0.81], [31, 1]] },
    QB: { claims: 24, contested: 9, p50: 1, p75: 1, paidMedian: 2, won: [[1, 1]] },
    ALL: { claims: 193, contested: 54, p50: 2, p75: 4, paidMedian: 4, won: [[1, 0.48], [4, 0.81], [53, 1]] },
  },
};

/* Somebody else is sure to bid unless a test says otherwise. */
const base = { position: 'WR', gain: 40, expectedRivals: 1.2, noRival: 0, spendable: 28, reserveHeld: 20, history: HISTORY } as const;

describe('the bid is the lowest amount that likely wins in this league', () => {
  it('a "Do this" starter somebody else wants: the bid that beat every other bid 3 times in 4', () => {
    const b = smartBid({ ...base, kind: 'do_this' });
    expect(b).toMatchObject({ bid: 10, basis: 'history', clearing: 10, thin: false });
    expect(b.reason).toBe('Wins a starting WR in this league about 3 times in 4');
  });

  it('"Worth considering": half the time, so less', () => {
    const b = smartBid({ ...base, kind: 'consider' });
    expect(b.bid).toBe(6);
    expect(b.reason).toBe('Wins a starting WR in this league about half the time');
  });

  it('a rival who may not bid at all lowers the bid', () => {
    /* Even odds nobody else bids: $6 already wins 3 times in 4 (0.5 + 0.5 x 0.72 = 0.86, $4 gives 0.745). */
    expect(smartBid({ ...base, kind: 'do_this', noRival: 0.5 }).bid).toBe(6);
    /* Three in four that nobody bids: $0 does it. */
    expect(smartBid({ ...base, kind: 'do_this', noRival: 0.8 })).toMatchObject({ bid: 0, basis: 'nobody' });
  });

  it('$0 when nobody else is likely to bid', () => {
    const b = smartBid({ ...base, kind: 'do_this', expectedRivals: SMART_BID.nobody - 0.01 });
    expect(b).toMatchObject({ bid: 0, basis: 'nobody', reason: 'Nobody else is likely to bid' });
  });

  it('never more than he is worth to you: gain times the price per point', () => {
    /* 8 points over the drop at $0.50 a point is $4, under the $11 a starting RB takes. */
    const b = smartBid({ ...base, kind: 'do_this', position: 'RB', gain: 8 });
    expect(b).toMatchObject({ bid: 4, basis: 'value', valueCap: 4, clearing: 11 });
    expect(b.reason).toBe('Worth about $4 to you; a starting RB usually takes $11');
  });

  it('never into the $20 playoff reserve', () => {
    const b = smartBid({ ...base, kind: 'do_this', position: 'RB', spendable: 5 });
    expect(b).toMatchObject({ bid: 5, basis: 'reserve', reason: 'Keeps $20 for the playoffs' });
    expect(smartBid({ ...base, kind: 'do_this', spendable: 0 }).bid).toBe(0);
  });

  it('a position with too few contested claims uses every starter, and says so', () => {
    const b = smartBid({ ...base, kind: 'do_this', position: 'TE' });
    expect(b).toMatchObject({ bid: 7, thin: true });
    expect(b.reason).toBe('Few TE bids on record; wins a starter here about 3 times in 4');
    expect(priceRowFor('starter', 'K', HISTORY)).toMatchObject({ thin: true, row: HISTORY.starter.ALL });
  });

  it('a block stays one number from $1 to $3', () => {
    expect(smartBid({ ...base, kind: 'block', position: 'RB' })).toMatchObject({ bid: 3, basis: 'block' });
    expect(smartBid({ ...base, kind: 'block', position: 'QB' }).bid).toBe(1);
    expect(smartBid({ ...base, kind: 'block', position: 'RB', spendable: 2 }).bid).toBe(2);
  });

  it('a stash is $0 with nobody else after him, else $1, never more', () => {
    expect(smartBid({ ...base, kind: 'stash', expectedRivals: 0.1 }).bid).toBe(0);
    expect(smartBid({ ...base, kind: 'stash', expectedRivals: 2 }).bid).toBe(1);
    expect(smartBid({ ...base, kind: 'stash', expectedRivals: null }).bid).toBe(1);
  });

  it('no reason Alex reads is long, has an em-dash or names Sleeper', () => {
    for (const kind of ['do_this', 'consider', 'stash', 'block'] as const) {
      for (const position of ['QB', 'RB', 'WR', 'TE', 'DEF']) {
        for (const gain of [2, 40]) {
          const { reason } = smartBid({ ...base, kind, position, gain, history: LEAGUE_BID_HISTORY });
          expect(reason).not.toMatch(/—|Sleeper/);
          expect(reason.length).toBeLessThanOrEqual(70);
        }
      }
    }
  });
});

describe('the stored league record', () => {
  it('covers three seasons, and a starter goes for less than the winners paid', () => {
    expect(LEAGUE_BID_HISTORY.seasons).toEqual(['2024', '2025', '2026']);
    const all = LEAGUE_BID_HISTORY.starter.ALL!;
    expect(all.contested).toBeGreaterThanOrEqual(LEAGUE_BID_HISTORY.minContested);
    expect(all.p50).toBeLessThanOrEqual(all.p75);
    expect(all.p75).toBeLessThan(all.paidMedian);
  });

  it('prices every starter "Do this" under the $28 Alex can spend before the playoffs', () => {
    for (const position of ['QB', 'RB', 'WR', 'TE', 'DEF']) {
      const b = smartBid({ kind: 'do_this', position, gain: null, expectedRivals: 2, spendable: 28 });
      expect(b.bid).toBeGreaterThan(0);
      expect(b.bid).toBeLessThan(28);
    }
  });
});

describe('the screen shows one number', () => {
  const bid = (over: Partial<TierBid>): TierBid => ({
    kind: 'claim', recommended: 4, low: 3, high: 7, reason: 'In this league $4 wins a starting WR about half the time',
    ceiling: null, overCeiling: false, likely: [], thin: null, until: null, ...over,
  });

  it('the chip is the bid, never a band', () => {
    expect(bidLabel(bid({}))).toBe('$4');
    expect(bidLabel(bid({ kind: 'free', recommended: null }))).toBeNull();
  });

  it('the sheet carries the bid and its one reason', () => {
    expect(bidNote(bid({}))).toBe('Bid $4: In this league $4 wins a starting WR about half the time');
    expect(bidNote(bid({ kind: 'none', recommended: null }))).toBeNull();
  });
});
