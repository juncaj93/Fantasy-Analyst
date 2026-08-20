/**
 * The market delta, as arithmetic.
 *
 * The compact draft row's whole claim is that `ADP +6` and `DOG -19` are worth
 * more than `ADP 170` and `DOG 145.1`, and that claim only holds if the
 * subtraction and its sign are right every time. The numbers below are the
 * worked examples from the brief, kept as the brief wrote them.
 */

import { describe, expect, it } from 'vitest';
import { marketDelta, marketDeltaTitle } from '../src/web/marketDelta.ts';

const PICK = 164;

describe('marketDelta', () => {
  it('subtracts the current pick from the market, to whole picks', () => {
    expect(marketDelta(170.0, PICK)?.picks).toBe(6);
    expect(marketDelta(145.1, PICK)?.picks).toBe(-19);
    expect(marketDelta(164.0, PICK)?.picks).toBe(0);
    expect(marketDelta(180.0, PICK)?.picks).toBe(16);
    expect(marketDelta(139.0, PICK)?.picks).toBe(-25);
  });

  it('prints the sign, always', () => {
    expect(marketDelta(170.0, PICK)?.label).toBe('+6');
    expect(marketDelta(145.1, PICK)?.label).toBe('-19');
    expect(marketDelta(180.0, PICK)?.label).toBe('+16');
  });

  /**
   * The convention is inverted here on purpose, and this is the test that says
   * so: a positive delta is a *reach*, which the row paints as a cost, and a
   * negative one is value. Asserted as the tone rather than as a colour,
   * because the tone is the thing the design is allowed to change its mind
   * about painting.
   */
  it('calls a positive delta a reach and a negative one value', () => {
    expect(marketDelta(170.0, PICK)?.tone).toBe('reach');
    expect(marketDelta(180.0, PICK)?.tone).toBe('reach');
    expect(marketDelta(145.1, PICK)?.tone).toBe('value');
    expect(marketDelta(139.0, PICK)?.tone).toBe('value');
    expect(marketDelta(164.0, PICK)?.tone).toBe('even');
  });

  it('rounds a fraction of a pick to nothing rather than to a direction', () => {
    expect(marketDelta(164.4, PICK)).toMatchObject({ picks: 0, tone: 'even', label: '0' });
    expect(marketDelta(163.6, PICK)).toMatchObject({ picks: 0, tone: 'even', label: '0' });
  });

  /**
   * `Math.round(-0.4)` is `-0`, and `-0` prints as `"-0"`. A row reading
   * `ADP -0` would be claiming a direction the arithmetic did not find.
   */
  it('never prints a negative zero', () => {
    for (const adp of [163.7, 163.8, 163.9, 164, 164.1, 164.4]) {
      const delta = marketDelta(adp, PICK)!;
      expect(delta.label, `${adp} produced ${delta.label}`).toBe('0');
      expect(Object.is(delta.picks, -0), `${adp} produced -0`).toBe(false);
    }
  });

  it('is null when either side is unknown, rather than zero', () => {
    expect(marketDelta(null, PICK)).toBeNull();
    expect(marketDelta(undefined, PICK)).toBeNull();
    expect(marketDelta(170, null)).toBeNull();
    expect(marketDelta(170, undefined)).toBeNull();
    expect(marketDelta(Number.NaN, PICK)).toBeNull();
    expect(marketDelta(170, Number.NaN)).toBeNull();
  });

  it('is symmetric about the pick', () => {
    expect(marketDelta(PICK + 12, PICK)?.picks).toBe(12);
    expect(marketDelta(PICK - 12, PICK)?.picks).toBe(-12);
  });
});

describe('marketDeltaTitle', () => {
  it('names both numbers and which way the difference runs', () => {
    const reach = marketDelta(170, PICK)!;
    expect(marketDeltaTitle('Sleeper', 170, PICK, reach)).toBe(
      'Sleeper ADP 170 against pick 164: taking him here is 6 picks ahead of this market',
    );

    const value = marketDelta(145.1, PICK)!;
    expect(marketDeltaTitle('Underdog', 145.1, PICK, value)).toBe(
      'Underdog ADP 145.1 against pick 164: he has lasted 19 picks past this market',
    );

    const even = marketDelta(164, PICK)!;
    expect(marketDeltaTitle('Sleeper', 164, PICK, even)).toBe(
      'Sleeper ADP 164 against pick 164: he is going at about this market',
    );
  });

  it('says pick rather than picks when there is one of them', () => {
    const one = marketDelta(165, PICK)!;
    expect(marketDeltaTitle('Sleeper', 165, PICK, one)).toContain('1 pick ahead');
  });
});
