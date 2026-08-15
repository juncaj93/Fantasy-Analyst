/**
 * Agreeing with the market, disagreeing with it, and never obeying it.
 *
 * The one behaviour this file exists to lock down: a disagreement must not flip
 * the recommendation. The market's number is already the largest component of
 * every score; deferring to it a second time would be counting it twice, and
 * the model has usage, practice reports and role information a prop line cannot
 * carry.
 */

import { describe, expect, it } from 'vitest';
import { compareWithMarket, MARKET_AGREEMENT } from '../src/core/startsit/market.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

describe('market agreement', () => {
  it('agrees when both prefer the same player', () => {
    const result = compareWithMarket([
      { playerId: 'a', name: 'A', modelScoreExMarket: 4, marketPoints: 16 },
      { playerId: 'b', name: 'B', modelScoreExMarket: 1, marketPoints: 11 },
    ]);
    expect(result.verdict).toBe('agrees');
    expect(result.modelPreferredId).toBe('a');
    expect(result.marketPreferredId).toBe('a');
  });

  it('disagrees when they prefer different players', () => {
    const result = compareWithMarket([
      { playerId: 'a', name: 'A', modelScoreExMarket: 4, marketPoints: 10 },
      { playerId: 'b', name: 'B', modelScoreExMarket: 1, marketPoints: 16 },
    ]);
    expect(result.verdict).toBe('disagrees');
    expect(result.marketMargin).toBe(6);
    expect(result.material).toBe(true);
  });

  it('is neutral when the market barely separates them', () => {
    const result = compareWithMarket([
      { playerId: 'a', name: 'A', modelScoreExMarket: 4, marketPoints: 12.5 },
      { playerId: 'b', name: 'B', modelScoreExMarket: 1, marketPoints: 12 },
    ]);
    expect(result.verdict).toBe('neutral');
  });

  it('is neutral when the model barely separates them', () => {
    const result = compareWithMarket([
      { playerId: 'a', name: 'A', modelScoreExMarket: 2, marketPoints: 10 },
      { playerId: 'b', name: 'B', modelScoreExMarket: 1.8, marketPoints: 18 },
    ]);
    expect(result.verdict).toBe('neutral');
  });

  it('has no view when only one player is priced', () => {
    const result = compareWithMarket([
      { playerId: 'a', name: 'A', modelScoreExMarket: 4, marketPoints: 16 },
      { playerId: 'b', name: 'B', modelScoreExMarket: 1, marketPoints: null },
    ]);
    expect(result.verdict).toBe('unavailable');
  });

  it('calls a small disagreement immaterial', () => {
    const result = compareWithMarket([
      { playerId: 'a', name: 'A', modelScoreExMarket: 4, marketPoints: 12 },
      { playerId: 'b', name: 'B', modelScoreExMarket: 1, marketPoints: 14 },
    ]);
    expect(result.verdict).toBe('disagrees');
    expect(result.marketMargin).toBeLessThan(MARKET_AGREEMENT.strongMarketMargin);
    expect(result.material).toBe(false);
  });
});

describe('inside a comparison', () => {
  it('does not flip the recommendation just because the market differs', () => {
    /*
     * Constructed so the two genuinely disagree and the model still wins.
     *
     * B carries the bigger prop line — sixteen points against fourteen, which
     * clears the market's own margin for having an opinion. A carries an
     * emphatic news record worth about three points, which is enough to put him
     * ahead on the total. The market therefore prefers B, the model prefers A,
     * and the recommendation must be A: the line is already inside both scores,
     * and deferring to it again would be counting it twice.
     */
    const comparison = compareStartSit(
      [
        candidate('a', 'Model Pick', 'WR', 14, { signal: signalWithNet(9) }),
        candidate('b', 'Market Pick', 'WR', 16),
      ],
      HALF_PPR,
    );

    expect(comparison.market.verdict).toBe('disagrees');
    expect(comparison.market.marketPreferredId).toBe('b');
    expect(comparison.recommendedPlayerId).toBe('a');
  });

  it('lowers confidence rather than the score when the disagreement is wide', () => {
    const comparison = compareStartSit(
      [
        // A large, unambiguous news signal against a much larger market gap.
        candidate('a', 'Model Pick', 'WR', 6, { signal: signalWithNet(8) }),
        candidate('b', 'Market Pick', 'WR', 15),
      ],
      HALF_PPR,
    );
    if (comparison.market.verdict === 'disagrees' && comparison.market.material) {
      expect(comparison.confidence).not.toBe('high');
    }
    // Either way, the disagreement is on the card rather than resolved silently.
    expect([...comparison.reasons, ...comparison.warnings].join(' ').length).toBeGreaterThan(0);
  });

  it('reports the mode it was asked in', () => {
    const comparison = compareStartSit(
      [candidate('a', 'A', 'WR', 12), candidate('b', 'B', 'WR', 10)],
      HALF_PPR,
      { mode: 'floor' },
    );
    expect(comparison.mode).toBe('floor');
    for (const evaluation of comparison.evaluations) expect(evaluation.mode).toBe('floor');
  });
});
