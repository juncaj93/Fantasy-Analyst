/**
 * One availability rule, Team's, on every screen (Alex's decision, 23 October 2026).
 *
 * Before it, the same Questionable player read four ways: full value on Team,
 * 0.616 of his number on Matchup, 0.8 of a game in the trade and waiver rates,
 * and half a point down on the waiver yardstick. Each case below fails on the
 * code before that date.
 */

import { describe, expect, it } from 'vitest';
import { availableWeekPoints, weekAvailability, weekShare } from '../src/core/injury/weekAvailability.ts';
import { AVAILABILITY, availabilityPenalty } from '../src/core/injury/startsit.ts';
import { NO_INJURY_INFORMATION, type Designation } from '../src/core/injury/model.ts';
import { weeklyAvailability } from '../src/core/tradeValue/availability.ts';
import { readYardstick } from '../src/core/waivers/yardstick.ts';
import { buildDistribution, effectiveRemaining, resolveGameClock } from '../src/core/matchup/distribution.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const KICKOFF = '2026-10-25T17:00:00Z';
const BEFORE = new Date('2026-10-25T12:00:00Z');

function matchupPlayer(over: Partial<MatchupPlayerInput>): MatchupPlayerInput {
  return {
    playerId: 'p',
    name: 'Player',
    position: 'QB',
    team: 'GB',
    opponent: 'PIT',
    slot: 'QB',
    starting: true,
    side: 'mine',
    projection: 21.01,
    actual: 0,
    kickoff: KICKOFF,
    roleBucket: 'unclassified',
    availability: 'high_confidence_active',
    ruledOut: false,
    ...over,
  };
}

describe('the rule', () => {
  it('is full value for Questionable, six points off for Doubtful, nothing for ruled out', () => {
    expect(weekAvailability('questionable')).toEqual({ charge: 0, out: false, warn: true });
    expect(weekAvailability('doubtful')).toEqual({ charge: -6, out: false, warn: true });
    for (const d of ['out', 'ir', 'pup', 'suspended'] as const) expect(weekAvailability(d).out, d).toBe(true);
    expect(weekAvailability('healthy')).toEqual({ charge: 0, out: false, warn: false });
    expect(weekAvailability('unknown')).toEqual({ charge: 0, out: false, warn: false });
  });

  it('never takes a week below zero', () => {
    expect(availableWeekPoints(21.01, 'questionable')).toBe(21.01);
    expect(availableWeekPoints(8.5, 'doubtful')).toBe(2.5);
    expect(availableWeekPoints(4, 'doubtful')).toBe(0);
    expect(availableWeekPoints(15, 'out')).toBe(0);
  });

  it('is the rule Team scores with', () => {
    const designations: Designation[] = ['healthy', 'questionable', 'doubtful', 'out', 'ir', 'pup', 'suspended'];
    for (const designation of designations) {
      const team = availabilityPenalty({ ...NO_INJURY_INFORMATION, designation });
      const rule = weekAvailability(designation);
      expect(team.points, designation).toBe(rule.charge);
      expect(team.gate, designation).toBe(rule.out);
    }
    expect(AVAILABILITY.questionable).toBe(0);
  });
});

describe('Matchup', () => {
  it('simulates a Questionable starter at full value (Jordan Love read 12.94 here and 21.01 on Team)', () => {
    const clock = resolveGameClock(KICKOFF, BEFORE);
    const questionable = buildDistribution(
      matchupPlayer({ availability: 'uncertain', designation: 'questionable' }),
      clock,
    );
    expect(effectiveRemaining(questionable)).toBe(21.01);
  });
});

describe('Trades and the waiver tiers', () => {
  const weeks = [7, 8, 9];

  it('count a Questionable player as a whole game this week', () => {
    expect(weeklyAvailability({ designation: 'questionable', weeks, byeWeek: null, rate: 7.74 }).weekly).toEqual([1, 1, 1]);
  });

  it('count a Doubtful player at his rate less six points this week, and whole after', () => {
    const a = weeklyAvailability({ designation: 'doubtful', weeks, byeWeek: null, rate: 10 });
    expect(a.weekly[0]).toBeCloseTo(0.4, 10);
    expect(a.weekly.slice(1)).toEqual([1, 1]);
    expect(10 * a.weekly[0]!).toBeCloseTo(availableWeekPoints(10, 'doubtful'), 10);
    expect(weekShare('doubtful', 5)).toBe(0);
  });

  it('keep the multi-week assumption for a ruled-out player', () => {
    expect(weeklyAvailability({ designation: 'out', weeks, byeWeek: null, rate: 12 }).weekly).toEqual([0, 0.5, 1]);
  });
});

describe('the waiver yardstick', () => {
  const questionable = {
    playerId: 'kc',
    name: 'KC Concepcion Jr.',
    position: 'WR',
    team: 'CLE',
    expectation: null,
    injury: { designation: 'questionable', bodyPart: 'knee', practice: { latest: 'limited' } },
  };

  it('charges a Questionable player nothing and still names the status', () => {
    const r = readYardstick(questionable, [], 7.69);
    expect(r.availability).toBe(0);
    expect(r.availabilityNote).toBe('Questionable');
  });

  it('charges a Doubtful player six points', () => {
    const r = readYardstick({ ...questionable, injury: { ...questionable.injury, designation: 'doubtful' } }, [], 7.69);
    expect(r.availability).toBe(-6);
  });
});
