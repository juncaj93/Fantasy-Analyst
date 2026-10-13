/**
 * From a prop line to an average (October 2026).
 *
 * The line sits near the median; a fantasy score is an average. These pin the
 * three steps (take the margin out of the prices, move from median to mean,
 * read a touchdown price as a rate) and the caps around them.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPS,
  LINE_AS_MEDIAN,
  convertLine,
  inverseNormal,
  lineForMean,
  overChance,
  poissonOver,
  rateFor,
  touchdownRate,
} from '../src/core/startsit/propConversion.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { LEGACY_RULES, SCORING_RULES } from '../src/core/startsit/scoringRules.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const ALL = { devig: true, skew: true, tdRate: true };
const EVEN = { overPrice: -110, underPrice: -110 };
/* Tony's Pizza Fantasy: half PPR, six per passing TD. */
const LEAGUE = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

function prop(market: PlayerProp['market'], line: number | null, extra: Partial<PlayerProp> = {}): PlayerProp {
  return {
    playerId: 'x',
    sourcePlayerName: 'x',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: null,
    ...extra,
  };
}

describe('taking the margin out', () => {
  it('splits -110/-110 evenly and leans toward the favoured side', () => {
    expect(overChance(-110, -110)).toBeCloseTo(0.5, 6);
    // -125 / +105: 55.6% and 48.8% raw, 53.2% and 46.8% without the margin.
    expect(overChance(-125, 105)).toBeCloseTo(0.532, 3);
  });

  it('refuses to guess with one side missing', () => {
    expect(overChance(-110, null)).toBeNull();
    expect(overChance(null, null)).toBeNull();
  });

  it('holds an extreme price inside the band', () => {
    expect(overChance(-2000, 900)).toBe(CAPS.maxOver);
  });
});

describe('yardage: median to mean', () => {
  it('returns the line untouched with every step off', () => {
    expect(convertLine('receiving_yards', 62.5, EVEN, LINE_AS_MEDIAN)!.mean).toBe(62.5);
  });

  it('adds the skew at even prices, more for receivers than for passers', () => {
    const rec = convertLine('receiving_yards', 60, EVEN, ALL)!.mean / 60;
    const rush = convertLine('rush_yards', 60, EVEN, ALL)!.mean / 60;
    const pass = convertLine('pass_yards', 250, EVEN, ALL)!.mean / 250;
    expect(rec).toBeCloseTo(1.071, 3);
    expect(rush).toBeCloseTo(1.049, 3);
    expect(pass).toBeCloseTo(1.02, 3);
    expect(rec).toBeGreaterThan(rush);
    expect(rush).toBeGreaterThan(pass);
  });

  it('moves the median up when the over is the favoured side, and down when it is not', () => {
    const juicedOver = convertLine('receiving_yards', 60, { overPrice: -140, underPrice: 115 }, { ...ALL, skew: false })!;
    const juicedUnder = convertLine('receiving_yards', 60, { overPrice: 115, underPrice: -140 }, { ...ALL, skew: false })!;
    expect(juicedOver.mean).toBeGreaterThan(60);
    expect(juicedUnder.mean).toBeLessThan(60);
    expect(juicedOver.steps).toEqual(['devig']);
  });

  it('never moves a line further than the cap', () => {
    const wild = convertLine('receiving_yards', 60, { overPrice: -5000, underPrice: 2000 }, ALL)!;
    expect(wild.mean / 60).toBeLessThanOrEqual(CAPS.maxRatio + 1e-9);
  });

  it('inverts exactly for a fixture', () => {
    const line = lineForMean('receiving_yards', 70, ALL);
    expect(convertLine('receiving_yards', line, EVEN, ALL)!.mean).toBeCloseTo(70, 9);
  });
});

describe('counts: a Poisson rate', () => {
  it('reads a half-point line at even prices as a little above the line', () => {
    // P(X >= 5) = 0.5 at a rate of about 4.67.
    expect(rateFor(4.5, 0.5)).toBeCloseTo(4.67, 2);
    expect(convertLine('receptions', 4.5, EVEN, ALL)!.mean).toBeCloseTo(4.67, 2);
  });

  it('turns 1.5 passing TDs at -150 into close to two', () => {
    const tds = convertLine('pass_tds', 1.5, { overPrice: -150, underPrice: 125 }, ALL)!.mean;
    expect(tds).toBeGreaterThan(1.8);
    expect(tds).toBeLessThan(2.1);
  });

  it('treats a whole-number line as able to push', () => {
    // At a rate of 4 a line of 4 pushes about 20% of the time.
    expect(poissonOver(4, 4)).toBeGreaterThan(poissonOver(4.5, 4));
  });
});

describe('touchdowns as a rate', () => {
  it('reads 40% as 0.51 touchdowns', () => {
    const td = touchdownRate(null, 0.4, true, ALL)!;
    expect(td.probability).toBeCloseTo(0.4, 6);
    expect(td.expected).toBeCloseTo(-Math.log(0.6), 6);
  });

  it('takes the margin out of a one-sided price', () => {
    const td = touchdownRate(null, 0.428, false, ALL)!;
    expect(td.probability).toBeCloseTo(0.4, 3);
  });

  it('keeps the chance as it was with the step off', () => {
    expect(touchdownRate(null, 0.4, true, LINE_AS_MEDIAN)!.expected).toBe(0.4);
  });

  it('caps the rate', () => {
    expect(touchdownRate(null, 0.99, true, ALL)!.expected).toBe(CAPS.maxTdRate);
  });
});

describe('the whole conversion on real-shaped boards', () => {
  it('lifts a receiver by a few percent, and records the bare-line figure beside it', () => {
    const board = [prop('receiving_yards', 62.5), prop('receptions', 5.5), prop('anytime_td', null, { impliedProbability: 0.38 })];
    const before = buildExpectation('WR', board, LEAGUE, LINE_AS_MEDIAN);
    const after = buildExpectation('WR', board, LEAGUE, ALL);
    expect(after.points!).toBeGreaterThan(before.points!);
    expect(after.points! / before.points!).toBeLessThan(1.15);
    expect(after.lineTotal).toBeCloseTo(before.points!, 2);
    const yards = after.contributions.find((c) => c.market === 'receiving_yards')!;
    expect(yards.detail).toMatch(/62.5 rec yds \(avg 6\d\.\d\) x 0.1/);
    expect(yards.linePoints).toBeCloseTo(6.25, 2);
  });

  it('applies this league’s six-point passing TD to the converted rate', () => {
    const qb = buildExpectation('QB', [prop('pass_yards', 245.5), prop('pass_tds', 1.5), prop('rush_yards', 12.5)], LEAGUE, ALL);
    const td = qb.contributions.find((c) => c.market === 'pass_tds')!;
    expect(td.points).toBeCloseTo((td.mean ?? 0) * 6, 1);
  });

  it('scores the old way under the old rules, so the backtest has both', () => {
    const input = {
      player: player({ id: 'p', fullName: 'P', position: 'WR', team: 'NE' }),
      props: [prop('receiving_yards', 70), prop('receptions', 5), prop('anytime_td', null, { impliedProbability: 0.4 })],
      signal: null,
    };
    const legacy = evaluatePlayer(input, LEAGUE, LEGACY_RULES);
    const converted = evaluatePlayer(input, LEAGUE, { ...SCORING_RULES, conversion: ALL });
    expect(legacy.expectation.points).toBeCloseTo(7 + 2.5 + 2.4, 2);
    expect(converted.expectation.points!).toBeGreaterThan(legacy.expectation.points!);
  });

  /*
   * Off in production since the 13 October 2026 backtest: it lowered the bias
   * and raised the average miss (see `scoringRules.ts`). This holds it off.
   */
  it('ships off: the live rules read every line as quoted', () => {
    expect(SCORING_RULES.conversion).toEqual(LINE_AS_MEDIAN);
    const board = [prop('receiving_yards', 62.5), prop('receptions', 5.5)];
    expect(buildExpectation('WR', board, LEAGUE).points).toBeCloseTo(6.25 + 2.75, 2);
  });
});

describe('the normal quantile', () => {
  it('matches known values', () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormal(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormal(0.01)).toBeCloseTo(-2.326348, 5);
  });
});
