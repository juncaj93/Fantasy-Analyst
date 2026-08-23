/**
 * The smoke probe's own claims, pointed at a violation.
 *
 * A gate nobody has ever seen fail is a gate nobody knows the shape of. These
 * checks had been asserting `r.adp == null` long after the board's sort moved
 * to the blended market price, and asserting an integer Score after `score`
 * became `number | null` by design — and they passed for months, because
 * production was the only board they were ever pointed at and production never
 * happened to violate the thing they were accidentally asking.
 *
 * So each invariant is exercised twice here: once on a board that satisfies it,
 * once on a board that breaks it in the specific way the product would break it.
 * A check that cannot fail is not a check.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs probe helper, deliberately not part of the app build
import { isPriced, orderInvariants, scoreInvariants } from '../scripts/lib/boardInvariants.mjs';

interface Rec {
  playerId: string;
  adp: number | null;
  marketBlend: { adp: number | null };
  total: number;
  score: number | null;
}

/** One row: `adp` is Sleeper's alone, `blend` is what the board sorts on. */
function rec(
  playerId: string,
  { adp = null, blend = null, total = 0, score = null }: Partial<{
    adp: number | null;
    blend: number | null;
    total: number;
    score: number | null;
  }> = {},
): Rec {
  return { playerId, adp, marketBlend: { adp: blend }, total, score };
}

/** A well-formed board: four priced in descending order, then an unpriced tail. */
const GOOD: Rec[] = [
  rec('a', { adp: 1, blend: 1, total: 0.9, score: 91 }),
  rec('b', { adp: 2, blend: 2, total: 0.6, score: 84 }),
  rec('c', { adp: 3, blend: 3, total: 0.3, score: 77 }),
  rec('d', { adp: 4, blend: 4, total: 0.1, score: 70 }),
  rec('tail1', { total: 0.05, score: null }),
  rec('tail2', { total: 0.02, score: null }),
];

const results = (list: { label: string; ok: boolean }[]) =>
  Object.fromEntries(list.map((r) => [r.label, r.ok]));

const ORDER = {
  descending: 'the board is still ordered by score, not by health',
  tail: 'and players no market can price are ranked after the ones it can',
};
const SCORE = {
  whole: 'every priced player carries a whole-number Score in range',
  blank: 'and an unpriced player carries no Score at all, rather than an invented one',
  agrees: 'Score never contradicts board order',
  spread: 'it separates the players actually being chosen between',
};

describe('"priced" means the market the board actually sorts on', () => {
  it('counts a player only Underdog has priced as priced', () => {
    // The exact case the old `r.adp == null` form got wrong, and the reason
    // production reported a legal board as broken.
    expect(isPriced(rec('dogOnly', { adp: null, blend: 12 }))).toBe(true);
  });

  it('counts a player no market has priced as unpriced', () => {
    expect(isPriced(rec('nobody'))).toBe(false);
  });

  it('does not mistake a Sleeper price for the blend', () => {
    // Belt and braces: the blend is the authority, so a row with a Sleeper ADP
    // and no blended price is unpriced however odd that combination looks.
    expect(isPriced(rec('odd', { adp: 5, blend: null }))).toBe(false);
  });
});

describe('the ordering invariants', () => {
  it('pass on a well-formed board', () => {
    const r = results(orderInvariants(GOOD));
    expect(r[ORDER.descending]).toBe(true);
    expect(r[ORDER.tail]).toBe(true);
  });

  it('fail when a priced player is out of order', () => {
    const broken = [...GOOD];
    broken[1] = rec('b', { adp: 2, blend: 2, total: 0.95, score: 84 });
    expect(results(orderInvariants(broken))[ORDER.descending]).toBe(false);
  });

  it('fail when an unpriced player is ranked above a priced one', () => {
    // The failure the probe reported against production. Here it is real.
    const broken = [rec('ghost', { total: 0.99, score: null }), ...GOOD];
    expect(results(orderInvariants(broken))[ORDER.tail]).toBe(false);
  });

  it('pass when every player is priced, rather than vacuously reporting a gap', () => {
    const allPriced = GOOD.filter(isPriced);
    const r = results(orderInvariants(allPriced));
    expect(r[ORDER.tail]).toBe(true);
  });

  it('tolerate an Underdog-only player at the top, which is not a violation', () => {
    // The regression this repair exists to prevent: correct board, and the
    // probe must not call it broken.
    const withDogOnly = [rec('dogOnly', { adp: null, blend: 1, total: 0.95, score: 93 }), ...GOOD];
    const r = results(orderInvariants(withDogOnly));
    expect(r[ORDER.descending]).toBe(true);
    expect(r[ORDER.tail]).toBe(true);
  });
});

describe('the Score invariants', () => {
  it('pass on a well-formed board', () => {
    const r = results(scoreInvariants(GOOD));
    expect(r[SCORE.whole]).toBe(true);
    expect(r[SCORE.blank]).toBe(true);
    expect(r[SCORE.agrees]).toBe(true);
    expect(r[SCORE.spread]).toBe(true);
  });

  it('accept a null Score on an unpriced player, which is the contract', () => {
    // The stale form failed here. It must not any more — and must still be
    // checking something, which the next case proves.
    expect(results(scoreInvariants(GOOD))[SCORE.blank]).toBe(true);
  });

  it('fail when an unpriced player is given an invented Score', () => {
    // The direction that actually matters: a fabricated 83 beside a dash for
    // ADP, Val and Next is exactly what the null contract exists to prevent.
    const broken = [...GOOD];
    broken[4] = rec('tail1', { total: 0.05, score: 83 });
    expect(results(scoreInvariants(broken))[SCORE.blank]).toBe(false);
  });

  it('fail when a priced player has no Score', () => {
    const broken = [...GOOD];
    broken[2] = rec('c', { adp: 3, blend: 3, total: 0.3, score: null });
    expect(results(scoreInvariants(broken))[SCORE.whole]).toBe(false);
  });

  it('fail on a fractional or out-of-range Score', () => {
    const fractional = [...GOOD];
    fractional[1] = rec('b', { adp: 2, blend: 2, total: 0.6, score: 84.5 });
    expect(results(scoreInvariants(fractional))[SCORE.whole]).toBe(false);

    const tooBig = [...GOOD];
    tooBig[0] = rec('a', { adp: 1, blend: 1, total: 0.9, score: 140 });
    expect(results(scoreInvariants(tooBig))[SCORE.whole]).toBe(false);
  });

  it('fail when Score contradicts the order it is a transform of', () => {
    const broken = [...GOOD];
    broken[1] = rec('b', { adp: 2, blend: 2, total: 0.6, score: 95 });
    expect(results(scoreInvariants(broken))[SCORE.agrees]).toBe(false);
  });

  it('fail when the priced top of the board is squashed flat', () => {
    // A calibration that renders the players actually being chosen between as
    // indistinguishable is the failure this one is for.
    const flat = [
      rec('a', { adp: 1, blend: 1, total: 0.9, score: 85 }),
      rec('b', { adp: 2, blend: 2, total: 0.6, score: 85 }),
      rec('c', { adp: 3, blend: 3, total: 0.3, score: 84 }),
      rec('d', { adp: 4, blend: 4, total: 0.1, score: 84 }),
    ];
    expect(results(scoreInvariants(flat))[SCORE.spread]).toBe(false);
  });

  it('measure the spread over priced players only, not over nulls', () => {
    /*
     * The stale form read the top 20 of the whole board, and `Math.min` over a
     * list containing null returns 0 — so an unpriced tail reported a 0–91
     * spread and passed a flatness check for entirely the wrong reason. A board
     * that is genuinely flat at the top must fail even with a long null tail
     * dragging the apparent minimum down.
     */
    const flatWithTail = [
      rec('a', { adp: 1, blend: 1, total: 0.9, score: 85 }),
      rec('b', { adp: 2, blend: 2, total: 0.6, score: 85 }),
      rec('c', { adp: 3, blend: 3, total: 0.3, score: 84 }),
      rec('d', { adp: 4, blend: 4, total: 0.1, score: 84 }),
      rec('tail', { total: 0.01, score: null }),
    ];
    expect(results(scoreInvariants(flatWithTail))[SCORE.spread]).toBe(false);
  });
});
