/**
 * The market baseline, pinned.
 *
 * These are the fifteen behaviours the brief asks to be proved rather than
 * asserted, and they are worth permanent tests for the same reason: every one
 * of them is a thing that would keep working, keep returning plausible numbers,
 * and be silently wrong. A DOG column filled from Sleeper looks exactly like a
 * DOG column. A 60/40 blend that has drifted to 50/50 reorders a board by a
 * couple of places and nothing on screen changes colour.
 *
 * The tests are written against behaviour, not against constants: where a
 * number matters it is asserted from `MARKET_BLEND` rather than typed again, so
 * a deliberate reweighting updates one place and an accidental one fails here.
 */

import { describe, expect, it } from 'vitest';
import {
  MARKET_BLEND,
  blendMarketBaseline,
  blendWeights,
  marketDisagreement,
} from '../src/core/draft/marketBaseline.ts';
import { detectBestBall, marketFormatOf } from '../src/core/sleeper/bestBall.ts';
import { DEFAULT_WEIGHTS, marketValueComponent } from '../src/core/draft/engine.ts';

describe('the blend is 60/40, and 75/25 in best ball', () => {
  it('weights a non-best-ball baseline 60% DOG / 40% Sleeper', () => {
    expect(MARKET_BLEND.standard).toEqual({ dog: 0.6, sleeper: 0.4 });
    const blend = blendMarketBaseline({ dogAdp: 20, sleeperAdp: 40, format: 'standard' });
    // 0.6 x 20 + 0.4 x 40 = 28.
    expect(blend.adp).toBe(28);
    expect(blend.weights).toEqual({ dog: 0.6, sleeper: 0.4 });
  });

  it('weights a best-ball baseline 75% DOG / 25% Sleeper', () => {
    expect(MARKET_BLEND.bestBall).toEqual({ dog: 0.75, sleeper: 0.25 });
    const blend = blendMarketBaseline({ dogAdp: 20, sleeperAdp: 40, format: 'best_ball' });
    // 0.75 x 20 + 0.25 x 40 = 25.
    expect(blend.adp).toBe(25);
    expect(blend.weights).toEqual({ dog: 0.75, sleeper: 0.25 });
  });

  it('gives DOG more influence than Sleeper in both formats', () => {
    for (const format of ['standard', 'best_ball'] as const) {
      const weights = blendWeights(format);
      expect(weights.dog).toBeGreaterThan(weights.sleeper);
    }
  });

  it('moves DOG from 60% to 75% when the league is best ball', () => {
    expect(blendWeights('best_ball').dog).toBeGreaterThan(blendWeights('standard').dog);
    expect(blendWeights('best_ball').dog - blendWeights('standard').dog).toBeCloseTo(0.15, 10);
  });

  /**
   * The directional statement behind the percentages, checked as a movement
   * rather than as arithmetic: shifting DOG by a fixed amount has to move the
   * baseline further in best ball than in an ordinary league.
   */
  it('responds more to a DOG move in best ball than outside it', () => {
    const at = (dog: number, format: 'standard' | 'best_ball') =>
      blendMarketBaseline({ dogAdp: dog, sleeperAdp: 50, format }).adp!;
    const standardSwing = Math.abs(at(20, 'standard') - at(40, 'standard'));
    const bestBallSwing = Math.abs(at(20, 'best_ball') - at(40, 'best_ball'));
    expect(bestBallSwing).toBeGreaterThan(standardSwing);
  });
});

describe('a missing source renormalises rather than penalising', () => {
  it('gives DOG the whole baseline when Sleeper has not priced him', () => {
    const blend = blendMarketBaseline({ dogAdp: 33, sleeperAdp: null, format: 'standard' });
    expect(blend.adp).toBe(33);
    expect(blend.weights).toEqual({ dog: 1, sleeper: 0 });
    expect(blend.singleSource).toBe(true);
    expect(blend.sources).toEqual(['dog']);
  });

  it('gives Sleeper the whole baseline when DOG is unavailable', () => {
    const blend = blendMarketBaseline({ dogAdp: null, sleeperAdp: 33, format: 'best_ball' });
    expect(blend.adp).toBe(33);
    expect(blend.weights).toEqual({ dog: 0, sleeper: 1 });
    expect(blend.singleSource).toBe(true);
    expect(blend.sources).toEqual(['sleeper']);
  });

  it('never fabricates the absent source', () => {
    // The surviving source's own number, exactly — not a nudge toward where the
    // missing one "probably" was.
    expect(blendMarketBaseline({ dogAdp: 12.5, sleeperAdp: null, format: 'standard' }).adp).toBe(12.5);
    expect(blendMarketBaseline({ dogAdp: null, sleeperAdp: 12.5, format: 'standard' }).adp).toBe(12.5);
  });

  it('does not cost a player anything for being priced by one market only', () => {
    // Same underlying price, one source or two: the component must be identical.
    const both = marketValueComponent(
      30,
      50,
      12,
      blendMarketBaseline({ dogAdp: 30, sleeperAdp: 30, format: 'standard' }),
    );
    const dogOnly = marketValueComponent(
      null,
      50,
      12,
      blendMarketBaseline({ dogAdp: 30, sleeperAdp: null, format: 'standard' }),
    );
    expect(dogOnly.score).toBe(both.score);
    expect(dogOnly.unknown).toBe(false);
  });

  it('is unknown, not zero, when neither market has priced him', () => {
    const blend = blendMarketBaseline({ dogAdp: null, sleeperAdp: null, format: 'standard' });
    expect(blend.adp).toBeNull();
    expect(blend.unknown).toBe(true);
    expect(marketValueComponent(null, 50, 12, blend).unknown).toBe(true);
    expect(marketValueComponent(null, 50, 12, blend).contribution).toBe(0);
  });
});

describe('the weights are the market component, not the Score', () => {
  /**
   * The claim the brief most wants proved, and the one most easily lost: DOG at
   * 60% is 60% of *one component*. Measured against the engine's own weight
   * table rather than argued.
   */
  it('leaves DOG far short of 60% of the total weight in play', () => {
    const totalWeight = Object.values(DEFAULT_WEIGHTS).reduce((a, w) => a + w, 0);
    const dogShare = (DEFAULT_WEIGHTS.marketValue * MARKET_BLEND.standard.dog) / totalWeight;
    // About 18% at the shipped weights — nowhere near the 60% the percentage
    // would imply if it were a share of the Score.
    expect(dogShare).toBeLessThan(0.25);
    expect(dogShare).toBeGreaterThan(0.1);
  });

  it('leaves best-ball DOG short of 75% of the total weight in play', () => {
    const totalWeight = Object.values(DEFAULT_WEIGHTS).reduce((a, w) => a + w, 0);
    const dogShare = (DEFAULT_WEIGHTS.marketValue * MARKET_BLEND.bestBall.dog) / totalWeight;
    expect(dogShare).toBeLessThan(0.3);
  });

  it('lets the other components outvote a market disagreement', () => {
    // Two players at the same blended price; one carries the tally, the ★ and
    // the research the other does not. The market cannot be the whole answer.
    const nonMarketWeight = Object.entries(DEFAULT_WEIGHTS)
      .filter(([key]) => key !== 'marketValue')
      .reduce((a, [, w]) => a + w, 0);
    expect(nonMarketWeight).toBeGreaterThan(DEFAULT_WEIGHTS.marketValue);
  });
});

describe('disagreement is context, never a second bonus', () => {
  it('reports the gap and which market is higher on him', () => {
    const gap = marketDisagreement(52, 70);
    expect(gap.picks).toBe(18);
    expect(gap.leader).toBe('dog');
    expect(gap.note).toContain('18 picks earlier');
  });

  it('says nothing when only one market has an opinion', () => {
    expect(marketDisagreement(52, null).picks).toBeNull();
    expect(marketDisagreement(null, 70).note).toBeNull();
  });

  /**
   * The double-count guard. A disagreeing pair and an agreeing pair with the
   * same blended baseline must produce exactly the same component — the blend
   * has already paid for the eighteen picks.
   */
  it('does not pay for the same picks twice', () => {
    // 0.6 x 52 + 0.4 x 70 = 59.2. An agreeing pair at 59.2 blends to 59.2.
    const disagreeing = blendMarketBaseline({ dogAdp: 52, sleeperAdp: 70, format: 'standard' });
    const agreeing = blendMarketBaseline({ dogAdp: 59.2, sleeperAdp: 59.2, format: 'standard' });
    expect(disagreeing.adp).toBeCloseTo(agreeing.adp!, 6);
    expect(marketValueComponent(70, 60, 12, disagreeing).contribution).toBe(
      marketValueComponent(59.2, 60, 12, agreeing).contribution,
    );
  });

  it('moves the baseline smoothly as the markets diverge', () => {
    // No cliff, no threshold: a monotone walk from agreement to a wide split.
    const baselines = [70, 66, 62, 58, 54, 50].map(
      (dog) => blendMarketBaseline({ dogAdp: dog, sleeperAdp: 70, format: 'standard' }).adp!,
    );
    for (let i = 1; i < baselines.length; i++) {
      expect(baselines[i]!).toBeLessThan(baselines[i - 1]!);
      // Each equal step of DOG moves the baseline by the same 60% of it.
      expect(baselines[i - 1]! - baselines[i]!).toBeCloseTo(4 * MARKET_BLEND.standard.dog, 6);
    }
  });
});

describe('best-ball detection is deterministic and refuses to guess', () => {
  it('reads the flag from the league settings', () => {
    const detection = detectBestBall({ leagueSettings: { best_ball: 1 } });
    expect(detection.bestBall).toBe(true);
    expect(detection.confident).toBe(true);
    expect(marketFormatOf(detection)).toBe('best_ball');
  });

  it('reads an explicit zero as not best ball', () => {
    const detection = detectBestBall({ leagueSettings: { best_ball: 0 } });
    expect(detection.bestBall).toBe(false);
    expect(detection.confident).toBe(true);
  });

  it('falls back to the draft settings when the league does not say', () => {
    const detection = detectBestBall({ leagueSettings: {}, draftSettings: { best_ball: '1' } });
    expect(detection.bestBall).toBe(true);
    expect(detection.basis).toBe('draft_settings');
  });

  it('prefers the league over the draft when both state it', () => {
    const detection = detectBestBall({ leagueSettings: { best_ball: 0 }, draftSettings: { best_ball: 1 } });
    expect(detection.bestBall).toBe(false);
    expect(detection.basis).toBe('league_settings');
  });

  it('never infers best ball from the league name', () => {
    const detection = detectBestBall({ leagueSettings: { name: 'Motown Best Ball Classic' } });
    expect(detection.bestBall).toBe(false);
    expect(detection.confident).toBe(false);
  });

  it('uses the 60/40 blend and says so when Sleeper has not published the flag', () => {
    const detection = detectBestBall({ leagueSettings: {} });
    expect(detection.confident).toBe(false);
    expect(marketFormatOf(detection)).toBe('standard');
    expect(blendWeights(marketFormatOf(detection))).toEqual(MARKET_BLEND.standard);
    expect(detection.reason).toContain('60/40');
  });

  it('gives the same answer every time for the same settings', () => {
    const settings = { leagueSettings: { best_ball: 1 }, draftSettings: { best_ball: 0 } };
    const answers = Array.from({ length: 20 }, () => JSON.stringify(detectBestBall(settings)));
    expect(new Set(answers).size).toBe(1);
  });
});
