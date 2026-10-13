/**
 * A touchdown over/under, read as the any-touchdown chance it implies.
 *
 * Finding F1 (October 2026), option B as Alex chose it: the provider's main
 * touchdown line became "over 1.5" for most players, and the app read that
 * two-or-more price as an any-touchdown chance. The market stays the base; the
 * price is converted with a Poisson rate.
 */

import { describe, expect, it } from 'vitest';
import { anytimeChance, MAX_CONVERTED_LINE } from '../src/core/startsit/touchdownLine.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, rush_td: 6, rec_td: 6, pass_td: 6 }, []);

function prop(market: PlayerProp['market'], line: number | null, p: number | null = null): PlayerProp {
  return {
    playerId: 'p',
    sourcePlayerName: 'P',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: p,
  };
}

describe('the conversion', () => {
  it('leaves an anytime price alone', () => {
    expect(anytimeChance(0.5, 0.42)).toBe(0.42);
    expect(anytimeChance(null, 0.42)).toBe(0.42);
  });

  it('turns a two-or-more price into a larger any-touchdown chance', () => {
    // Bijan Robinson's week-5 quote: 31% for over 1.5.
    const any = anytimeChance(1.5, 0.31)!;
    expect(any).toBeGreaterThan(0.31);
    expect(any).toBeCloseTo(0.675, 2);
  });

  it('is exact on the model it assumes', () => {
    // At a Poisson rate of 1, P(2 or more) = 1 - 2/e and P(1 or more) = 1 - 1/e.
    const p2 = 1 - 2 / Math.E;
    expect(anytimeChance(1.5, p2)!).toBeCloseTo(1 - 1 / Math.E, 6);
    // And for over 2.5: P(3 or more) = 1 - 2.5/e at the same rate.
    const p3 = 1 - 2.5 / Math.E;
    expect(anytimeChance(2.5, p3)!).toBeCloseTo(1 - 1 / Math.E, 6);
  });

  it('keeps the order of the prices it is given', () => {
    const lows = [0.01, 0.04, 0.06, 0.13, 0.31, 0.6].map((p) => anytimeChance(1.5, p)!);
    for (let i = 1; i < lows.length; i += 1) expect(lows[i]!).toBeGreaterThan(lows[i - 1]!);
  });

  it('never guesses past the tail it can pin, and never invents a price', () => {
    expect(anytimeChance(MAX_CONVERTED_LINE + 1, 0.1)).toBeNull();
    expect(anytimeChance(1.5, null)).toBeNull();
    expect(anytimeChance(1.5, 0)).toBe(0);
    expect(anytimeChance(1.5, 1)).toBe(1);
  });
});

describe('the market number', () => {
  const board = (tdLine: number | null, p: number) => [
    prop('rush_yards', 80),
    prop('receiving_yards', 25),
    prop('receptions', 3),
    prop('anytime_td', tdLine, p),
  ];

  it('scores the converted chance, and says what was quoted', () => {
    const e = buildExpectation('RB', board(1.5, 0.31), HALF_PPR);
    const td = e.contributions.find((c) => c.market === 'anytime_td')!;
    expect(td.probability).toBeCloseTo(0.675, 2);
    expect(td.points).toBeCloseTo(0.675 * 6, 1);
    expect(td.detail).toMatch(/31% for over 1.5 TDs/);
    expect(e.missingMarkets).toEqual([]);
  });

  it('is unchanged for an anytime quote', () => {
    const e = buildExpectation('RB', board(0.5, 0.42), HALF_PPR);
    const td = e.contributions.find((c) => c.market === 'anytime_td')!;
    expect(td.probability).toBe(0.42);
    expect(td.detail).not.toMatch(/for over/);
  });

  it('treats an unconvertible line as a missing market, not a zero', () => {
    const e = buildExpectation('RB', board(3.5, 0.05), HALF_PPR);
    expect(e.contributions.some((c) => c.market === 'anytime_td')).toBe(false);
    expect(e.missingMarkets).toContain('anytime_td');
  });
});
