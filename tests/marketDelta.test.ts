/**
 * The market delta, as arithmetic.
 *
 * The compact draft row's whole claim is that `ADP +6` and `DOG -19` are worth
 * more than `ADP 170` and `DOG 145.1`, and that claim only holds if the
 * subtraction and its sign are right every time. The numbers below are the
 * worked examples from the brief, kept as the brief wrote them.
 */

import { describe, expect, it } from 'vitest';
import {
  DELTA_FAIR_CEILING,
  DELTA_STEEP_CEILING,
  marketDelta,
  marketDeltaBand,
  marketDeltaTitle,
} from '../src/web/marketDelta.ts';

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

/**
 * What the row's ADP and DOG columns actually print, before anything is painted.
 *
 * The thresholds below are stated against "the displayed value", so the first
 * thing that has to be true is that everybody agrees what the displayed value
 * *is*. It is `round(marketADP − currentPick)`, printed with its sign, and it
 * is positive when the player is being taken earlier than the market has him.
 * Worked here on representative rendered values rather than asserted in prose,
 * because misreading this sign would invert every colour on the board.
 */
describe('the number the row displays', () => {
  const at = (pick: number, adp: number) => marketDelta(adp, pick)!;

  it('is the cost in picks of taking him here, signed, and positive is the cost', () => {
    // On the clock at 30, a market that has him at 45: he is going fifteen
    // picks early, which costs you fifteen picks against that market.
    expect(at(30, 45)).toMatchObject({ label: '+15', picks: 15, tone: 'reach' });
    // The same pick, a market that has him at 20: he lasted ten picks past it.
    expect(at(30, 20)).toMatchObject({ label: '-10', picks: -10, tone: 'value' });
    // And a market that agrees with the clock.
    expect(at(30, 30)).toMatchObject({ label: '0', picks: 0, tone: 'even' });
  });

  /**
   * DOG is the same arithmetic against a different market — the row builds both
   * columns from this one function — so the sign and the bands cannot diverge
   * between them. Underdog prices to a decimal; the column still prints picks.
   */
  it('means the same thing in the DOG column as in the ADP column', () => {
    expect(at(88, 99.4)).toMatchObject({ label: '+11', band: 'steep' });
    expect(at(88, 99.4).picks).toBe(marketDelta(99.4, 88)!.picks);
  });
});

/**
 * The three colours, as thresholds on that displayed value.
 *
 * `+10` or lower is fair, `+11` through `+15` steep, anything above `+15`
 * costly. Walked across the boundaries rather than sampled, because a colour
 * that is right at `+12` and wrong at `+15` is the kind of thing three
 * hand-picked examples miss.
 */
describe('the band the row paints', () => {
  it('is fair at and below +10, steep to +15, costly above it', () => {
    expect(marketDeltaBand(9)).toBe('fair');
    expect(marketDeltaBand(10)).toBe('fair');
    expect(marketDeltaBand(11)).toBe('steep');
    expect(marketDeltaBand(15)).toBe('steep');
    expect(marketDeltaBand(16)).toBe('costly');
  });

  it('reads value and an even pick as fair, because neither costs anything', () => {
    expect(marketDeltaBand(0)).toBe('fair');
    expect(marketDeltaBand(-1)).toBe('fair');
    expect(marketDeltaBand(-40)).toBe('fair');
  });

  /** Total and monotone: no integer is unbanded, and the bands never go back. */
  it('never softens as the reach grows', () => {
    const rank = { fair: 0, steep: 1, costly: 2 } as const;
    let previous = rank[marketDeltaBand(-60)];
    for (let picks = -60; picks <= 60; picks++) {
      const current = rank[marketDeltaBand(picks)];
      expect(current, `band went backwards at ${picks}`).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('names its own boundaries, so the thresholds are one place', () => {
    expect(DELTA_FAIR_CEILING).toBe(10);
    expect(DELTA_STEEP_CEILING).toBe(15);
  });

  /**
   * The band travels on the delta the row renders, so the column cannot paint
   * one number and compute the colour from another.
   */
  it('rides along with the delta the row prints', () => {
    expect(marketDelta(174, PICK)).toMatchObject({ label: '+10', band: 'fair' });
    expect(marketDelta(175, PICK)).toMatchObject({ label: '+11', band: 'steep' });
    expect(marketDelta(179, PICK)).toMatchObject({ label: '+15', band: 'steep' });
    expect(marketDelta(180, PICK)).toMatchObject({ label: '+16', band: 'costly' });
  });

  /**
   * The tone is the semantics and the band is the paint. A `+11` is still a
   * reach whatever colour it is given, and this is the row that says so — the
   * two must be able to move apart without either quietly following the other.
   */
  it('leaves the tone alone: a small reach is still a reach', () => {
    expect(marketDelta(170, PICK)).toMatchObject({ tone: 'reach', band: 'fair' });
    expect(marketDelta(180, PICK)).toMatchObject({ tone: 'reach', band: 'costly' });
    expect(marketDelta(145.1, PICK)).toMatchObject({ tone: 'value', band: 'fair' });
    expect(marketDelta(164, PICK)).toMatchObject({ tone: 'even', band: 'fair' });
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
