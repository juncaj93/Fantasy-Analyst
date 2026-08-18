/**
 * Expected points, and the gap.
 *
 * The properties defended here are the ones the brief names: opportunity is
 * separated from efficiency, a fluky touchdown week reads as regression risk
 * rather than as a good player, tiny samples say nothing at all — and, the one
 * that guards the whole design, none of it reaches the lineup score. Constants
 * can be retuned without rewriting a test, because every assertion is about a
 * comparison rather than about a number.
 */

import { describe, expect, it } from 'vitest';
import { assessXfp, expectedPoints, actualPoints, XFP, STARTABLE_XFP } from '../src/core/xfp/model.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const PPR = buildScoringProfile({ rec: 1, pass_td: 4 }, []);

function week(over: Partial<UsageWeek> & { week: number }): UsageWeek {
  return {
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: null,
    receptions: null,
    targetShare: null,
    wopr: null,
    ...over,
  };
}

function run(count: number, template: Omit<Partial<UsageWeek>, 'week'>): UsageWeek[] {
  return Array.from({ length: count }, (_, i) => week({ week: i + 1, ...template }));
}

describe('expected points from opportunity', () => {
  it('pays for volume, not for what came of it', () => {
    const busy = expectedPoints('WR', week({ week: 1, targets: 11, receptions: 2, recYards: 12 }), HALF_PPR);
    const quiet = expectedPoints('WR', week({ week: 1, targets: 3, receptions: 3, recYards: 95, recTds: 2 }), HALF_PPR);
    expect(busy!.points).toBeGreaterThan(quiet!.points);
  });

  it('is worth more in a league that pays more per reception', () => {
    const half = expectedPoints('WR', week({ week: 1, targets: 9 }), HALF_PPR)!;
    const full = expectedPoints('WR', week({ week: 1, targets: 9 }), PPR)!;
    expect(full.points).toBeGreaterThan(half.points);
  });

  it('reads target depth when air yards are stored', () => {
    const deep = expectedPoints('WR', week({ week: 1, targets: 8, receivingAirYards: 128 }), HALF_PPR)!;
    const shallow = expectedPoints('WR', week({ week: 1, targets: 8, receivingAirYards: 16 }), HALF_PPR)!;
    // Deep targets are caught less often and are worth more when they are.
    expect(deep.points).toBeGreaterThan(shallow.points);
    expect(deep.touchdowns).toBeGreaterThan(shallow.touchdowns);
  });

  it('returns null for a week with no opportunity of any kind', () => {
    expect(expectedPoints('WR', week({ week: 1 }), HALF_PPR)).toBeNull();
  });

  it('never invents production: a week with no stored box score has no actual', () => {
    expect(actualPoints('WR', week({ week: 1, targets: 9 }), HALF_PPR)).toBeNull();
  });
});

describe('interpretation', () => {
  it('says nothing at all below the minimum sample', () => {
    const thin = assessXfp('WR', run(XFP.minGames - 1, { targets: 9, receptions: 6, recYards: 80 }), HALF_PPR);
    expect(thin.interpretation).toBe('insufficient_data');
    expect(thin.fpoePerGame).toBeNull();
    expect(thin.driver).toBeNull();
  });

  it('calls a run of touchdowns on ordinary volume a regression risk', () => {
    const lucky = assessXfp(
      'WR',
      run(6, { targets: 6, receptions: 4, recYards: 55, recTds: 1.5 }),
      HALF_PPR,
    );
    expect(lucky.interpretation).toBe('td_regression_risk');
    expect(lucky.fpoePerGame!).toBeGreaterThan(0);
    expect(lucky.tdOverExpectationPerGame!).toBeGreaterThan(XFP.materialTdOverExpectation);
    expect(lucky.driver).toMatch(/over expectation/);
  });

  it('separates a healthy role with a bad box score from a thin role with a bad box score', () => {
    const starter = assessXfp('WR', run(6, { targets: 11, receptions: 5, recYards: 35 }), HALF_PPR);
    const streamer = assessXfp('WR', run(6, { targets: 3, receptions: 1, recYards: 4 }), HALF_PPR);
    expect(starter.xfpPerGame!).toBeGreaterThanOrEqual(STARTABLE_XFP.WR!);
    expect(starter.interpretation).toBe('role_healthy_despite_box_score');
    expect(streamer.interpretation).toBe('usage_stronger_than_results');
  });

  it('calls a player whose results track his opportunity matched', () => {
    const weeks = run(6, { targets: 8, receivingAirYards: 76 });
    const expected = expectedPoints('WR', weeks[0]!, HALF_PPR)!;
    // Give him exactly the points the model expects, in yards, with no scores.
    const honest = weeks.map((w) => ({ ...w, receptions: 5, recYards: yardsFor(expected.points, 5, HALF_PPR) }));
    const read = assessXfp('WR', honest, HALF_PPR);
    expect(Math.abs(read.fpoePerGame!)).toBeLessThan(XFP.material);
    expect(read.interpretation).toBe('matched');
  });

  it('reports honestly when target depth was assumed rather than measured', () => {
    const measured = assessXfp('WR', run(6, { targets: 8, receivingAirYards: 70, receptions: 5, recYards: 60 }), HALF_PPR);
    const assumed = assessXfp('WR', run(6, { targets: 8, receptions: 5, recYards: 60 }), HALF_PPR);
    expect(measured.depthMeasured).toBe(true);
    expect(assumed.depthMeasured).toBe(false);
    expect(assumed.confidence).not.toBe('high');
  });

  it('ignores playoff weeks, like every other read off this file', () => {
    const weeks = [...run(5, { targets: 9, receptions: 6, recYards: 70 }), week({ week: 19, seasonType: 'POST', targets: 20, receptions: 15, recYards: 250 })];
    const read = assessXfp('WR', weeks, HALF_PPR);
    expect(read.games).toBe(5);
    expect(read.perGame.every((g) => g.week < 19)).toBe(true);
  });

  it('works for a quarterback off attempts and carries', () => {
    const read = assessXfp(
      'QB',
      run(6, { passAttempts: 34, carries: 6, passYards: 250, passTds: 1.5, rushYards: 30 }),
      HALF_PPR,
    );
    expect(read.xfpPerGame!).toBeGreaterThan(0);
    expect(read.interpretation).not.toBe('insufficient_data');
  });
});

describe('no triple counting', () => {
  it('contributes exactly zero, and the engine does not read it', () => {
    const weeks = run(6, { targets: 6, receptions: 4, recYards: 55, recTds: 1.5 });
    const read = assessXfp('WR', weeks, HALF_PPR);
    expect(read.points).toBe(0);

    const withUsage = evaluatePlayer({ ...candidate('p1', 'A Receiver', 'WR', 12), usageWeeks: weeks }, HALF_PPR);
    // Nothing in the breakdown is expected points, and the score is the sum of
    // the components that were already there.
    expect(withUsage.components.some((c) => c.key.includes('xfp'))).toBe(false);
    const sum = withUsage.components.filter((c) => !c.unknown).reduce((a, c) => a + c.value, 0);
    expect(withUsage.score).toBeCloseTo(Math.round(sum * 100) / 100, 2);
  });
});

/** The receiving yards that, with `receptions` catches, produce `points`. */
function yardsFor(points: number, receptions: number, profile: { ppr: number; pointsPerRecYard: number }): number {
  return (points - receptions * profile.ppr) / profile.pointsPerRecYard;
}
