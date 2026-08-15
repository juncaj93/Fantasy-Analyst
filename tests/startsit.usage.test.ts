/**
 * Opportunity, role and touchdown dependency — the three reads off one file.
 *
 * The property that matters most in this file is the one the brief puts first:
 * **usage outranks recent fantasy points**. It is asserted as behaviour rather
 * than as a weight — a low-volume player with a pile of touchdowns must score
 * below a high-volume player with none — so the constants can be retuned
 * without rewriting the test that protects the idea.
 */

import { describe, expect, it } from 'vitest';
import { assessUsage, OPPORTUNITY_BASELINE, USAGE_POINTS } from '../src/core/startsit/usageTrend.ts';
import { assessTdDependency, TD_DEPENDENCY } from '../src/core/startsit/tdDependency.ts';
import { classifyRole, ROLE_THRESHOLDS } from '../src/core/startsit/roleProfile.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

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

/** A run of identical weeks, which is the simplest shape a series can have. */
function run(count: number, template: Omit<Partial<UsageWeek>, 'week'>): UsageWeek[] {
  return Array.from({ length: count }, (_, i) => week({ week: i + 1, ...template }));
}

describe('opportunity level', () => {
  it('scores a full workload above a streaming one', () => {
    const starter = assessUsage('WR', run(6, { targets: 10 }));
    const streamer = assessUsage('WR', run(6, { targets: 3 }));
    expect(starter.score).toBeGreaterThan(streamer.score);
    expect(starter.points).toBeGreaterThan(0);
    expect(streamer.points).toBeLessThan(0);
  });

  it('is bounded whatever the volume', () => {
    const absurd = assessUsage('WR', run(6, { targets: 40 }));
    expect(Math.abs(absurd.points)).toBeLessThanOrEqual(USAGE_POINTS);
  });

  it('weights the most recent games more heavily', () => {
    const rising = assessUsage('WR', [
      ...run(4, { targets: 3 }),
      week({ week: 5, targets: 11 }),
      week({ week: 6, targets: 12 }),
    ]);
    const falling = assessUsage('WR', [
      ...run(4, { targets: 12 }),
      week({ week: 5, targets: 3 }),
      week({ week: 6, targets: 3 }),
    ]);
    expect(rising.perGame).toBeGreaterThan(falling.perGame!);
  });

  it('does not let one game redefine a player', () => {
    const steady = assessUsage('WR', run(6, { targets: 7 }));
    const oneBigGame = assessUsage('WR', [...run(5, { targets: 7 }), week({ week: 6, targets: 18 })]);
    // Moved, but nowhere near all the way to eighteen.
    expect(oneBigGame.perGame).toBeGreaterThan(steady.perGame!);
    expect(oneBigGame.perGame).toBeLessThan(12);
  });

  it('adds a back’s carries and targets, and ignores a receiver’s carries', () => {
    const back = assessUsage('RB', run(6, { carries: 12, targets: 4 }));
    expect(back.perGame).toBe(16);
    const receiver = assessUsage('WR', run(6, { carries: 12, targets: 4 }));
    expect(receiver.perGame).toBe(4);
  });

  it('is unknown, not zero, with no usage at all', () => {
    expect(assessUsage('WR', []).unknown).toBe(true);
    expect(assessUsage('WR', []).points).toBe(0);
  });

  it('drops playoff weeks from a fantasy season’s series', () => {
    const withPost = assessUsage('WR', [
      ...run(5, { targets: 4 }),
      week({ week: 20, targets: 20, seasonType: 'POST' }),
    ]);
    expect(withPost.perGame).toBe(4);
  });

  it('has a baseline for every position it carries', () => {
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      expect(OPPORTUNITY_BASELINE[position]).toBeDefined();
    }
  });
});

describe('usage outranks recent fantasy points', () => {
  /**
   * The brief's own pair, run through the real engine.
   *
   * Player A: four targets and forty yards a game, four touchdowns in four
   * weeks — the higher recent fantasy total by a distance. Player B: ten
   * targets, ninety yards, no scores. The engine must prefer B.
   */
  const volume = run(6, { targets: 10, receptions: 7, recYards: 90, recTds: 0 });
  const scores = [
    week({ week: 1, targets: 4, receptions: 3, recYards: 40, recTds: 1 }),
    week({ week: 2, targets: 4, receptions: 3, recYards: 40, recTds: 1 }),
    week({ week: 3, targets: 4, receptions: 2, recYards: 35, recTds: 1 }),
    week({ week: 4, targets: 4, receptions: 3, recYards: 45, recTds: 1 }),
    week({ week: 5, targets: 4, receptions: 2, recYards: 40, recTds: 0 }),
    week({ week: 6, targets: 4, receptions: 3, recYards: 40, recTds: 0 }),
  ];

  it('prefers the high-volume player with no touchdowns', () => {
    // Identical market expectation, so the only difference is the usage read.
    const b = evaluatePlayer({ ...candidate('b', 'Volume', 'WR', 12), usageWeeks: volume }, HALF_PPR);
    const a = evaluatePlayer({ ...candidate('a', 'Scores', 'WR', 12), usageWeeks: scores }, HALF_PPR);
    expect(b.score!).toBeGreaterThan(a.score!);
  });

  it('says why, in the drivers rather than only in the number', () => {
    const a = evaluatePlayer({ ...candidate('a', 'Scores', 'WR', 12), usageWeeks: scores }, HALF_PPR);
    expect(a.drivers.join(' ')).toMatch(/TD-dependent/i);
  });
});

describe('touchdown dependency', () => {
  it('flags a low-volume, high-scoring profile as fragile', () => {
    const fragile = assessTdDependency('WR', [
      week({ week: 1, targets: 4, recYards: 40, recTds: 1 }),
      week({ week: 2, targets: 4, recYards: 30, recTds: 1 }),
      week({ week: 3, targets: 3, recYards: 35, recTds: 1 }),
      week({ week: 4, targets: 4, recYards: 40, recTds: 1 }),
      week({ week: 5, targets: 4, recYards: 40, recTds: 0 }),
      week({ week: 6, targets: 3, recYards: 30, recTds: 0 }),
    ]);
    expect(fragile.profile).toBe('td_dependent_weak_opportunity');
    expect(fragile.points).toBeLessThan(0);
  });

  it('does not punish a goal-line role that scores most weeks', () => {
    const goalLine = assessTdDependency('RB', [
      week({ week: 1, carries: 12, rushYards: 40, rushTds: 1 }),
      week({ week: 2, carries: 11, rushYards: 35, rushTds: 1 }),
      week({ week: 3, carries: 13, rushYards: 45, rushTds: 1 }),
      week({ week: 4, carries: 10, rushYards: 30, rushTds: 1 }),
      week({ week: 5, carries: 12, rushYards: 40, rushTds: 1 }),
      week({ week: 6, carries: 11, rushYards: 38, rushTds: 0 }),
    ]);
    expect(goalLine.profile).toBe('td_driven_with_role');
    expect(goalLine.points).toBe(0);
  });

  it('credits a high-volume, low-scoring profile', () => {
    const volume = assessTdDependency('WR', run(6, { targets: 10, recYards: 90, recTds: 0 }));
    expect(volume.profile).toBe('volume_driven');
    expect(volume.points).toBeGreaterThan(0);
  });

  it('refuses to judge a short sample', () => {
    const thin = assessTdDependency('WR', run(TD_DEPENDENCY.minGames - 1, { targets: 6, recYards: 40, recTds: 2 }));
    expect(thin.profile).toBe('insufficient_data');
    expect(thin.points).toBe(0);
  });

  it('does not call a quarterback dependent for throwing touchdowns', () => {
    const passer = assessTdDependency('QB', run(6, { passAttempts: 34, passYards: 265, passTds: 2 }));
    expect(passer.profile).not.toBe('td_dependent_weak_opportunity');
  });
});

describe('role classification', () => {
  it('separates a downfield receiver from an underneath one', () => {
    const deep = classifyRole('WR', run(6, { targets: 6, receivingAirYards: 96, airYardsShare: 0.35 }));
    const underneath = classifyRole('WR', run(6, { targets: 8, receivingAirYards: 40, airYardsShare: 0.15 }));
    expect(deep.bucket).toBe('deep_receiver');
    expect(underneath.bucket).toBe('underneath_receiver');
    expect(deep.adot).toBeGreaterThan(ROLE_THRESHOLDS.receiver.deep);
  });

  it('uses a shallower scale for tight ends', () => {
    const te = classifyRole('TE', run(6, { targets: 6, receivingAirYards: 66 }));
    const wr = classifyRole('WR', run(6, { targets: 6, receivingAirYards: 66 }));
    expect(te.bucket).toBe('deep_receiver');
    expect(wr.bucket).toBe('intermediate_receiver');
  });

  it('separates a receiving back from a ground back', () => {
    expect(classifyRole('RB', run(6, { carries: 6, targets: 6 })).bucket).toBe('receiving_back');
    expect(classifyRole('RB', run(6, { carries: 16, targets: 1 })).bucket).toBe('rushing_back');
    expect(classifyRole('RB', run(6, { carries: 14, targets: 4 })).bucket).toBe('dual_threat_back');
  });

  it('separates a rushing quarterback from a pocket one', () => {
    expect(classifyRole('QB', run(6, { passAttempts: 32, carries: 8 })).bucket).toBe('rushing_quarterback');
    expect(classifyRole('QB', run(6, { passAttempts: 38, carries: 1 })).bucket).toBe('pocket_quarterback');
  });

  it('never invents a slot or outside label', () => {
    const profiles = [
      classifyRole('WR', run(6, { targets: 8, receivingAirYards: 80 })),
      classifyRole('TE', run(6, { targets: 6, receivingAirYards: 30 })),
    ];
    for (const profile of profiles) {
      expect(profile.bucket).not.toContain('slot');
      expect(profile.bucket).not.toContain('outside');
    }
  });

  it('declines to classify without enough targets to read depth', () => {
    const thin = classifyRole('WR', run(4, { targets: 2, receivingAirYards: 30 }));
    expect(thin.bucket).toBe('unclassified');
  });

  it('declines to classify with no air-yard data at all', () => {
    expect(classifyRole('WR', run(6, { targets: 9 })).bucket).toBe('unclassified');
  });
});
