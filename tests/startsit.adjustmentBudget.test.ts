/**
 * Everything but the market is a nudge: a tenth of the Vegas number, at most.
 *
 * Written from the 6 October 2026 Compare sheet where Rhamondre Stevenson's
 * 8.55 Vegas points carried -2.2 of other reads, two news lines being -2.45 of
 * it. These tests lock the rule that produced the fix, not the single player:
 * the clamp at both ends, the smaller caps, news that cannot dominate, a
 * near-tie that can still flip, a clear gap that cannot, availability left
 * alone, and what happens with no market.
 */

import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_BUDGET,
  BUDGETED_KEYS,
  budgetAdjustments,
  totalBudget,
} from '../src/core/startsit/adjustmentBudget.ts';
import { compareStartSit, evaluatePlayer, type StartSitEvaluation } from '../src/core/startsit/engine.ts';
import { decisionPoints } from '../src/core/startsit/decisionPoints.ts';
import { START_SIT_MODES } from '../src/core/startsit/mode.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

const entries = (values: Record<string, number>) => Object.entries(values).map(([key, value]) => ({ key, value }));
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, v) => a + v, 0);

/** Everything inside the budget, summed from a finished evaluation. */
function secondaryOf(e: StartSitEvaluation): number {
  return e.components.filter((c) => !c.unknown && BUDGETED_KEYS.includes(c.key)).reduce((a, c) => a + c.value, 0);
}
const component = (e: StartSitEvaluation, key: string) => e.components.find((c) => c.key === key)!;

describe('the budget on its own', () => {
  it('leaves small nudges exactly as they were', () => {
    const out = budgetAdjustments(entries({ matchup_role: 0.1, usage_level: -0.1 }), 10);
    expect(out.get('matchup_role')).toBe(0.1);
    expect(out.get('usage_level')).toBe(-0.1);
  });

  it('holds the group to a tenth of the base at the top end', () => {
    const out = budgetAdjustments(
      entries({ matchup_role: 0.3, usage_level: 0.3, game_script: 0.3, weather: 0.3, td_dependency: 0.3, explosiveness: 0.3 }),
      10,
    );
    expect(sum(out)).toBeLessThanOrEqual(totalBudget(10) + 1e-9);
    expect(sum(out)).toBeGreaterThan(totalBudget(10) - 0.1);
  });

  it('holds the group to a tenth of the base at the bottom end', () => {
    const out = budgetAdjustments(
      entries({ matchup_role: -0.3, usage_level: -0.3, game_script: -0.3, weather: -0.3, td_dependency: -0.3, explosiveness: -0.3 }),
      10,
    );
    expect(sum(out)).toBeGreaterThanOrEqual(-totalBudget(10) - 1e-9);
    expect(sum(out)).toBeLessThan(-totalBudget(10) + 0.1);
  });

  it('never flips a sign, only shrinks', () => {
    const out = budgetAdjustments(entries({ news_recent: -5, usage_level: 4, matchup_role: -3 }), 8);
    expect(out.get('news_recent')!).toBeLessThanOrEqual(0);
    expect(out.get('usage_level')!).toBeGreaterThanOrEqual(0);
    expect(out.get('matchup_role')!).toBeLessThanOrEqual(0);
  });

  it('caps any one factor at 3% of the base', () => {
    const out = budgetAdjustments(entries({ matchup_role: 9 }), 10);
    expect(out.get('matchup_role')).toBe(ADJUSTMENT_BUDGET.single * 10);
  });

  it('caps lifetime news alone at 1%', () => {
    const out = budgetAdjustments(entries({ news_raw: -9 }), 10);
    expect(out.get('news_raw')).toBe(-ADJUSTMENT_BUDGET.lifetimeNews * 10);
  });

  it('caps recent and lifetime news together at 3%', () => {
    const out = budgetAdjustments(entries({ news_recent: -9, news_raw: -9 }), 10);
    expect(out.get('news_recent')! + out.get('news_raw')!).toBeGreaterThanOrEqual(-ADJUSTMENT_BUDGET.news * 10 - 1e-9);
    // And the shorter, fresher tally keeps the bigger share.
    expect(Math.abs(out.get('news_recent')!)).toBeGreaterThan(Math.abs(out.get('news_raw')!));
  });

  it('measures against the base it is given', () => {
    const small = budgetAdjustments(entries({ matchup_role: 1 }), 5);
    const big = budgetAdjustments(entries({ matchup_role: 1 }), 20);
    expect(small.get('matchup_role')).toBe(0.15);
    expect(big.get('matchup_role')).toBe(0.6);
  });

  it('leaves nothing to nudge when there is no base', () => {
    const out = budgetAdjustments(entries({ matchup_role: 1, news_recent: -1 }), 0);
    expect(sum(out)).toBe(0);
  });

  it('does not return availability, the market, or the cover charge', () => {
    const out = budgetAdjustments(entries({ status: -6, vegas: 9, replacement_risk: -1, matchup_role: 0.1 }), 10);
    expect([...out.keys()]).toEqual(['matchup_role']);
  });

  it('recomputes the 6 October Stevenson sheet', () => {
    const out = budgetAdjustments(
      entries({ news_recent: -1.75, news_raw: -0.7, uncertainty: -0.5, usage_level: 0.55, matchup_role: 0.19 }),
      8.55,
    );
    // Was -2.21 on an 8.55 base (26%). Each piece is now inside its own cap.
    expect(out.get('news_recent')).toBe(-0.19);
    expect(out.get('news_raw')).toBe(-0.06);
    expect(out.get('uncertainty')).toBe(-0.25);
    expect(out.get('usage_level')).toBe(0.25);
    expect(out.get('matchup_role')).toBe(0.19);
    expect(Math.abs(sum(out))).toBeLessThanOrEqual(totalBudget(8.55));
  });
});

describe('inside the engine', () => {
  it('lets news move a player by no more than 3% of his market number', () => {
    const quiet = evaluatePlayer(candidate('a', 'A', 'WR', 14), HALF_PPR);
    const loud = evaluatePlayer(candidate('a', 'A', 'WR', 14, { signal: signalWithNet(-20) }), HALF_PPR);
    const news = component(loud, 'news_recent').value + component(loud, 'news_raw').value;
    expect(Math.abs(news)).toBeLessThanOrEqual(0.03 * 14 + 1e-9);
    expect(quiet.score! - loud.score!).toBeLessThanOrEqual(0.03 * 14 + 1e-9);
    expect(component(loud, 'news_raw').value).toBeGreaterThanOrEqual(-0.01 * 14 - 1e-9);
  });

  it('keeps the breakdown adding up to the score', () => {
    const e = evaluatePlayer(candidate('a', 'A', 'WR', 14, { signal: signalWithNet(-20) }), HALF_PPR);
    const total = e.components.filter((c) => !c.unknown).reduce((a, c) => a + c.value, 0);
    expect(e.score).toBeCloseTo(total, 2);
  });

  it('remembers what a shrunk component was', () => {
    const e = evaluatePlayer(candidate('a', 'A', 'WR', 14, { signal: signalWithNet(-20) }), HALF_PPR);
    expect(component(e, 'news_recent').preBudgetValue).toBe(-2.1);
  });

  it('still lets a nudge break a near-tie', () => {
    const result = compareStartSit(
      [
        candidate('a', 'Better News', 'WR', 14, { signal: signalWithNet(6) }),
        candidate('b', 'Slightly Higher Line', 'WR', 14.2),
      ],
      HALF_PPR,
    );
    expect(result.recommendedPlayerId).toBe('a');
  });

  it('cannot flip a clear gap', () => {
    const result = compareStartSit(
      [
        candidate('a', 'Better News', 'WR', 12, { signal: signalWithNet(20) }),
        candidate('b', 'Clearly Better Line', 'WR', 14),
      ],
      HALF_PPR,
    );
    expect(result.recommendedPlayerId).toBe('b');
  });

  it('leaves availability as the gate it was', () => {
    const healthy = evaluatePlayer(candidate('a', 'A', 'WR', 10), HALF_PPR);
    const doubtful = evaluatePlayer(candidate('a', 'A', 'WR', 10, { status: 'Doubtful' }), HALF_PPR);
    const out = evaluatePlayer(candidate('a', 'A', 'WR', 10, { status: 'Out' }), HALF_PPR);
    // A -6 on a 10-point player is 60%: far past the budget, and untouched.
    expect(component(doubtful, 'status').value).toBe(-6);
    expect(component(doubtful, 'status').preBudgetValue).toBeUndefined();
    expect(doubtful.score!).toBeCloseTo(healthy.score! - 6, 1);
    expect(out.ruledOut).toBe(true);
    expect(out.score!).toBeLessThan(-80);
  });

  it('leaves everything alone when there is no market to be a tenth of', () => {
    const e = evaluatePlayer(candidate('a', 'A', 'WR', null, { signal: signalWithNet(9) }), HALF_PPR);
    expect(e.expectation.points).toBeNull();
    expect(component(e, 'news_recent').preBudgetValue).toBeUndefined();
    expect(component(e, 'news_recent').value).toBe(2.1);
    // Not a projection, and `decisionPoints` calls it what it is.
    expect(decisionPoints(e)?.basis).toBe('unpriced');
  });

  it('measures a published week against the published week', () => {
    const e = evaluatePlayer(candidate('a', 'A', 'WR', null, { signal: signalWithNet(9) }), HALF_PPR);
    const d = decisionPoints(e, new Map([['a', 10]]));
    expect(d?.basis).toBe('published');
    expect(Math.abs(d!.adjustments)).toBeLessThanOrEqual(totalBudget(10) + 1e-9);
  });

  it('holds on every mode with every signal at full strength', () => {
    for (const mode of START_SIT_MODES) {
      for (const net of [-30, -3, 0, 3, 30]) {
        for (const status of [null, 'Questionable']) {
          const input = candidate('a', 'A', 'WR', 13, { signal: signalWithNet(net), status });
          const e = evaluatePlayer({ ...input, mode }, HALF_PPR);
          const base = component(e, 'vegas').value;
          expect(Math.abs(secondaryOf(e))).toBeLessThanOrEqual(totalBudget(base) + 1e-9);
          expect(base / (base + secondaryOf(e))).toBeGreaterThanOrEqual(1 / 1.1 - 1e-9);
        }
      }
    }
  });
});
