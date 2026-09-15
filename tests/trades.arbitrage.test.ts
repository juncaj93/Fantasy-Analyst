/**
 * Buy low, sell high: the read, and the gate it is allowed to walk past.
 *
 * Two things are being tested and they are separable on purpose. The first is
 * the reading itself — does a player running four points a game under his draft
 * price come back as a buy, does a receiver whose whole line is touchdowns come
 * back as a sell, and does an ordinary player come back as nothing. The second
 * is the reconciliation Alex asked for: an arbitrage offer must survive the
 * user-benefit gate that correctly suppresses a pointless upgrade, and every
 * *other* gate must still apply to it unchanged.
 *
 * The second half is where a feature like this goes wrong. A category that
 * bypasses one gate is one edit away from a category that bypasses all of them,
 * and "it surfaced something" is not evidence that it surfaced something sane.
 */

import { describe, expect, it } from 'vitest';
import {
  ARBITRAGE,
  productionOf,
  readArbitrage,
  regressionRisk,
  tallyFactorOf,
  type ArbitrageInput,
  type ArbitrageRead,
} from '../src/core/trades/arbitrage.ts';
import { assessTdDependency } from '../src/core/startsit/tdDependency.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';

/** A receiver's week: targets, yards and scores, with nothing else claimed. */
function week(n: number, over: Partial<UsageWeek> = {}): UsageWeek {
  return {
    week: n,
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: 7,
    receptions: 4,
    targetShare: 0.2,
    wopr: 0.3,
    recYards: 50,
    recTds: 0,
    ...over,
  };
}

function signalWithNet(net: number, items = 3): PlayerSignal {
  const s = emptySignal('x');
  s.last30 = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.raw = { ...s.last30 };
  return s;
}

function read(over: Partial<ArbitrageInput> = {}): ArbitrageRead | null {
  return readArbitrage({
    playerId: 'p1',
    name: 'Test Player',
    position: 'WR',
    preseasonPoints: 16 * 12, // twelve a game
    weeks: [1, 2, 3, 4, 5].map((n) => week(n)),
    signal: null,
    ...over,
  });
}

describe('what the reading is measured against', () => {
  it('reconstructs a week the way the touchdown model does', () => {
    // 100 receiving yards and a score, at the conventional rates. Receptions
    // are deliberately absent — PPR is a league setting, and a residual that
    // moved with it would be measuring the rulebook.
    expect(productionOf(week(1, { recYards: 100, recTds: 1, receptions: 9 }))).toBe(16);
    expect(productionOf(week(1, { recYards: 100, recTds: 1, receptions: 2 }))).toBe(16);
  });

  it('says nothing at all without a preseason expectation', () => {
    expect(read({ preseasonPoints: null })).toBeNull();
    expect(read({ preseasonPoints: 0 })).toBeNull();
  });

  it('says nothing on a sample too thin to mean anything', () => {
    const twoGames = [1, 2].map((n) => week(n, { recYards: 10, recTds: 0 }));
    expect(twoGames.length).toBeLessThan(ARBITRAGE.minGames);
    expect(read({ weeks: twoGames })).toBeNull();
  });

  it('does not count a week he did not play as a week he did nothing', () => {
    /*
     * The failure this guards is specific and would look like a feature: an
     * injured star has four blank weeks, every one of them reads as a zero, and
     * the board recommends buying him *because* he is hurt. Blank is dropped;
     * a week he played and did nothing is kept, because that one is real.
     */
    const blank: UsageWeek = {
      week: 6,
      seasonType: 'REG',
      passAttempts: null,
      carries: null,
      targets: null,
      receptions: null,
      targetShare: null,
      wopr: null,
      recYards: null,
      recTds: null,
    };
    const played = [1, 2, 3, 4].map((n) => week(n));
    const withBlanks = [...played, blank, { ...blank, week: 7 }];

    expect(read({ weeks: withBlanks })?.residualPerGame).toBe(read({ weeks: played })?.residualPerGame);
  });
});

describe('a buy-low read', () => {
  const quiet = [1, 2, 3, 4, 5].map((n) => week(n, { recYards: 22, recTds: 0, targets: 3 }));

  it('finds a player running well under what he was drafted to be', () => {
    const buy = read({ weeks: quiet });
    expect(buy?.kind).toBe('buy_low');
    expect(buy!.residualPerGame).toBeLessThan(0);
    expect(buy!.expectedPerGame).toBe(12);
  });

  it('weights the recent weeks more heavily than the old ones', () => {
    /*
     * Alex's instruction, as arithmetic: a bad week 6 weeks ago matters less
     * than a bad week 2 weeks ago. The same five weeks, reordered, must not
     * produce the same answer — and the version whose bad weeks are recent must
     * read as the stronger buy.
     */
    const badLate = [
      week(1, { recYards: 110 }),
      week(2, { recYards: 110 }),
      week(3, { recYards: 20 }),
      week(4, { recYards: 20 }),
      week(5, { recYards: 20 }),
    ];
    const badEarly = [
      week(1, { recYards: 20 }),
      week(2, { recYards: 20 }),
      week(3, { recYards: 20 }),
      week(4, { recYards: 110 }),
      week(5, { recYards: 110 }),
    ];

    const late = read({ weeks: badLate })!;
    const early = read({ weeks: badEarly });

    expect(late.kind).toBe('buy_low');
    expect(late.observedPerGame).toBeLessThan(early?.observedPerGame ?? Infinity);
  });

  it('never asks whether the shortfall was touchdowns', () => {
    // A player under his expectation is cheap however the shortfall is
    // composed, and the touchdown question has no content for a player who has
    // not scored any.
    const noScores = read({ weeks: quiet })!;
    const someScores = read({
      weeks: [1, 2, 3, 4, 5].map((n) => week(n, { recYards: 10, recTds: n <= 2 ? 1 : 0, targets: 3 })),
    })!;
    expect(noScores.kind).toBe('buy_low');
    expect(someScores.kind).toBe('buy_low');
  });
});

describe('a sell-high read, and the touchdowns it turns on', () => {
  /** Five weeks of thin volume and a lot of end zone. */
  const hotOnScores = [1, 2, 3, 4, 5].map((n) => week(n, { targets: 4, recYards: 35, recTds: 2 }));
  /** The same points, made of yardage. */
  const hotOnVolume = [1, 2, 3, 4, 5].map((n) => week(n, { targets: 12, recYards: 155, recTds: 0 }));

  it('sells a non-quarterback whose overperformance is made of scores', () => {
    const sell = read({ weeks: hotOnScores })!;
    expect(sell.kind).toBe('sell_high');
    expect(sell.residualPerGame).toBeGreaterThan(0);
    expect(sell.tdDependency.share).toBeGreaterThan(0.45);
  });

  it('does not sell the same overperformance when it is made of yardage', () => {
    /*
     * The mistake this prevents is the expensive one: a receiver whose targets
     * doubled is a player whose *role* grew, and selling him into that is the
     * opposite of arbitrage. `regressionRisk` is zero below the independence
     * threshold, which zeroes the whole read rather than weakening it.
     */
    const volume = read({ weeks: hotOnVolume });
    expect(volume).toBeNull();
    expect(regressionRisk('WR', assessTdDependency('WR', hotOnVolume))).toBe(0);
  });

  it('never treats a quarterback’s scoring as a sell signal', () => {
    // TD rate is his offence rather than his luck. The read survives on the
    // size of the overperformance alone.
    expect(regressionRisk('QB', assessTdDependency('WR', hotOnScores))).toBe(1);

    const passer = read({
      position: 'QB',
      preseasonPoints: 16 * 18,
      weeks: [1, 2, 3, 4, 5].map((n) => ({
        ...week(n),
        targets: null,
        receptions: null,
        recYards: null,
        recTds: null,
        passAttempts: 38,
        passYards: 330,
        passTds: 3,
      })),
    })!;
    expect(passer.kind).toBe('sell_high');
    expect(passer.reasons.join(' ')).toMatch(/offence rather than his luck/i);
  });

  it('scales with how much of the line is end zone, rather than switching at a line', () => {
    const risk = (share: number) => regressionRisk('WR', { ...assessTdDependency('WR', hotOnScores), share });
    expect(risk(0.25)).toBe(0);
    expect(risk(0.35)).toBeGreaterThan(0);
    expect(risk(0.35)).toBeLessThan(1);
    expect(risk(0.6)).toBe(1);
  });
});

describe('the newsletter tally reinforces and never originates', () => {
  it('leaves a read alone when the tally is positive or silent', () => {
    expect(tallyFactorOf(null).factor).toBe(1);
    expect(tallyFactorOf(signalWithNet(4)).factor).toBe(1);
    expect(tallyFactorOf(signalWithNet(0, 0)).factor).toBe(1);
  });

  it('strengthens a read when the story is moving against him', () => {
    expect(tallyFactorOf(signalWithNet(-3)).factor).toBeGreaterThan(1);
    expect(tallyFactorOf(signalWithNet(-3)).factor).toBeLessThanOrEqual(1 + ARBITRAGE.tallyInfluence);
  });

  it('does the same in both directions, which is Alex’s own reasoning', () => {
    // A story turning against an underperformer is what makes him cheap; the
    // same story turning against an overperformer is why now rather than later.
    // Deliberately mild on both sides: a shortfall or a surplus large enough to
    // saturate the 0–1 scale would clamp both readings to 1 and the test would
    // pass without the tally having done anything.
    const quiet = [1, 2, 3, 4, 5].map((n) => week(n, { recYards: 85, targets: 6 }));
    const hot = [1, 2, 3, 4, 5].map((n) => week(n, { targets: 4, recYards: 30, recTds: 2 }));
    const bad = signalWithNet(-3);

    const buy = read({ weeks: quiet })!;
    const sell = read({ weeks: hot })!;
    expect(buy.kind).toBe('buy_low');
    expect(sell.kind).toBe('sell_high');
    expect(buy.strength).toBeLessThan(1);
    expect(sell.strength).toBeLessThan(1);

    expect(read({ weeks: quiet, signal: bad })!.strength).toBeGreaterThan(buy.strength);
    expect(read({ weeks: hot, signal: bad })!.strength).toBeGreaterThan(sell.strength);
  });

  it('cannot create a read out of a player who is performing', () => {
    /*
     * The property that makes "reinforcement, never origin" arithmetic rather
     * than assertion: the tally is a multiplier on a residual, and a player at
     * his expectation has a residual of nothing to multiply.
     */
    const onExpectation = [1, 2, 3, 4, 5].map((n) => week(n, { recYards: 100, recTds: 0, targets: 8 }));
    expect(productionOf(onExpectation[0]!)).toBe(10);
    expect(read({ weeks: onExpectation, preseasonPoints: 16 * 10, signal: signalWithNet(-8) })).toBeNull();
  });
});
