/**
 * The role-specific month, and what a player is worth over it.
 *
 * The two properties worth protecting: a bye reduces how many weeks you get him
 * rather than how good he is, and an unknown week is never quietly counted as
 * an average one. Both are ways of refusing to average a fact with an absence.
 */

import { describe, expect, it } from 'vitest';
import { buildDefenseTendencies, type DefenseGame } from '../src/core/startsit/defense.ts';
import { ROLE_SCHEDULE, roleScheduleOutlook } from '../src/core/schedule/roleStrength.ts';
import { MULTI_WEEK, RELIABLE_FORECAST_DAYS, valueOverWeeks } from '../src/core/value/multiWeek.ts';
import type { RoleAssessment } from '../src/core/startsit/decisions.ts';
import type { UsageAssessment } from '../src/core/startsit/usageTrend.ts';
import type { XfpAssessment } from '../src/core/xfp/model.ts';

/** A defence that has been shredded by deep receivers, over enough weeks. */
function soft(defense: string): DefenseGame[] {
  return Array.from({ length: 6 }, (_, i) => ({
    defense,
    week: i + 1,
    position: 'WR',
    bucket: 'deep_receiver' as const,
    points: 20,
    baseline: 12,
  }));
}

/** ...and one nobody has beaten. */
function tough(defense: string): DefenseGame[] {
  return Array.from({ length: 6 }, (_, i) => ({
    defense,
    week: i + 1,
    position: 'WR',
    bucket: 'deep_receiver' as const,
    points: 6,
    baseline: 13,
  }));
}

const TENDENCIES = buildDefenseTendencies([...soft('MIA'), ...tough('BAL'), ...soft('NYJ')]);

describe('role-specific schedule outlook', () => {
  it('rates the weeks ahead for the role, not for the position at large', () => {
    const outlook = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [
        { week: 5, opponent: 'MIA' },
        { week: 6, opponent: 'NYJ' },
        { week: 7, opponent: 'MIA' },
      ],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    expect(outlook.rated).toBe(3);
    expect(outlook.verdict).toBe('favourable');
    expect(outlook.averagePoints!).toBeGreaterThan(ROLE_SCHEDULE.favourable);
    expect(outlook.driver).toMatch(/Schedule opens up/);
  });

  it('is difficult when the run of opponents is', () => {
    const outlook = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [
        { week: 5, opponent: 'BAL' },
        { week: 6, opponent: 'BAL' },
      ],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    expect(outlook.verdict).toBe('difficult');
  });

  it('counts a bye separately and keeps it out of the average', () => {
    const withBye = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [
        { week: 5, opponent: 'MIA' },
        { week: 6, opponent: null },
        { week: 7, opponent: 'NYJ' },
      ],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    const withoutBye = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [
        { week: 5, opponent: 'MIA' },
        { week: 7, opponent: 'NYJ' },
      ],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    expect(withBye.byes).toBe(1);
    expect(withBye.rated).toBe(2);
    expect(withBye.averagePoints).toBe(withoutBye.averagePoints);
    expect(withBye.notes.join(' ')).toMatch(/bye/);
  });

  it('says unknown rather than neutral when no opponent can be described', () => {
    const outlook = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [{ week: 5, opponent: 'SEA' }, { week: 6, opponent: 'DEN' }],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    expect(outlook.verdict).toBe('unknown');
    expect(outlook.averagePoints).toBeNull();
    expect(outlook.notes.join(' ')).toMatch(/cannot be described/);
  });

  it('never rates the week that is already on the card', () => {
    const outlook = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [{ week: 4, opponent: 'MIA' }, { week: 5, opponent: 'MIA' }],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    expect(outlook.weeks.map((w) => w.week)).toEqual([5]);
  });
});

const RISING: RoleAssessment = {
  trend: 'rising_high',
  label: 'Role rising — high confidence',
  detail: 'targets up sharply',
  metrics: [],
  games: 8,
} as RoleAssessment;

const STABLE: RoleAssessment = { ...RISING, trend: 'stable', label: 'Role stable' };

const BIG_ROLE: UsageAssessment = {
  perGame: 9,
  unit: 'targets',
  score: 0.6,
  points: 1.2,
  games: 6,
  display: '9.0 targets a game',
  driver: null,
  unknown: false,
} as UsageAssessment;

function xfp(interpretation: XfpAssessment['interpretation']): XfpAssessment {
  return {
    games: 6,
    xfpPerGame: 9,
    actualPerGame: 13,
    fpoePerGame: 4,
    tdOverExpectationPerGame: 0.5,
    interpretation,
    label: interpretation,
    display: '',
    driver: null,
    confidence: 'high',
    depthMeasured: true,
    perGame: [],
    points: 0,
  };
}

describe('multi-week value', () => {
  const base = {
    playerId: 'p1',
    name: 'A Receiver',
    position: 'WR',
    currentWeek: 4,
    thisWeekScore: 12,
  };

  it('keeps this week exactly as the lineup screen has it', () => {
    const value = valueOverWeeks({ ...base, role: RISING, usage: BIG_ROLE });
    expect(value.thisWeek).toBe(12);
  });

  it('pays for a rising role and a soft month', () => {
    const outlook = roleScheduleOutlook({
      position: 'WR',
      bucket: 'deep_receiver',
      schedule: [
        { week: 5, opponent: 'MIA' },
        { week: 6, opponent: 'NYJ' },
      ],
      tendencies: TENDENCIES,
      fromWeek: 4,
    });
    const value = valueOverWeeks({ ...base, role: RISING, usage: BIG_ROLE, schedule: outlook });
    expect(value.nextFourPerWeek!).toBeGreaterThan(value.thisWeek!);
    expect(value.verdict).toBe('rising_asset');
  });

  it('marks a touchdown-fuelled hot streak as a sell', () => {
    const value = valueOverWeeks({ ...base, role: STABLE, usage: BIG_ROLE, xfp: xfp('td_regression_risk') });
    expect(value.nextFourPerWeek!).toBeLessThan(value.thisWeek!);
    expect(value.verdict).toBe('sell_high');
  });

  it('prices the starter coming back, and the week he comes back in', () => {
    const soon = valueOverWeeks({
      ...base,
      role: STABLE,
      usage: BIG_ROLE,
      returningStarter: { name: 'The Starter', expectedWeek: 5, confidence: 'high' },
    });
    const later = valueOverWeeks({
      ...base,
      role: STABLE,
      usage: BIG_ROLE,
      returningStarter: { name: 'The Starter', expectedWeek: 7, confidence: 'high' },
    });
    expect(soon.nextFourPerWeek!).toBeLessThan(later.nextFourPerWeek!);
    expect(soon.verdict).toBe('one_week_rental');
  });

  it('discounts an unknown return date without treating it as never', () => {
    const undated = valueOverWeeks({
      ...base,
      role: STABLE,
      usage: BIG_ROLE,
      returningStarter: { name: 'The Starter', expectedWeek: null, confidence: 'low' },
    });
    const nobody = valueOverWeeks({ ...base, role: STABLE, usage: BIG_ROLE });
    const dated = valueOverWeeks({
      ...base,
      role: STABLE,
      usage: BIG_ROLE,
      returningStarter: { name: 'The Starter', expectedWeek: 5, confidence: 'high' },
    });
    expect(undated.nextFourPerWeek!).toBeLessThan(nobody.nextFourPerWeek!);
    expect(undated.nextFourPerWeek!).toBeGreaterThan(dated.nextFourPerWeek!);
  });

  it('treats a bye as a week you do not get him, not as a worse player', () => {
    const onBye = valueOverWeeks({ ...base, role: STABLE, usage: BIG_ROLE, byeWeek: 6 });
    const noBye = valueOverWeeks({ ...base, role: STABLE, usage: BIG_ROLE, byeWeek: 15 });
    expect(onBye.nextFourPerWeek).toBe(noBye.nextFourPerWeek);
    expect(onBye.weeksAvailable).toBe(MULTI_WEEK.horizon - 1);
    expect(onBye.nextFourTotal!).toBeLessThan(noBye.nextFourTotal!);
  });

  it('says out loud that weather is not in a four-week number', () => {
    const value = valueOverWeeks({ ...base, role: STABLE, usage: BIG_ROLE });
    expect(value.notes.join(' ')).toMatch(new RegExp(`${RELIABLE_FORECAST_DAYS} days`));
  });

  it('withholds a value when there is no score to carry forward', () => {
    const value = valueOverWeeks({ ...base, thisWeekScore: null, role: RISING, usage: BIG_ROLE });
    expect(value.nextFourPerWeek).toBeNull();
    expect(value.nextFourTotal).toBeNull();
    expect(value.verdict).toBe('unknown');
    expect(value.confidence).toBe('low');
  });

  it('does not buy a one-game spike as a rising role', () => {
    const spike = valueOverWeeks({
      ...base,
      role: { ...RISING, trend: 'spike', label: 'One-game spike; broader role stable' },
      usage: BIG_ROLE,
    });
    const rising = valueOverWeeks({ ...base, role: RISING, usage: BIG_ROLE });
    expect(spike.nextFourPerWeek!).toBeLessThan(rising.nextFourPerWeek!);
  });
});
