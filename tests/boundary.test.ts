/**
 * The conditions that would change the answer.
 *
 * Two things are being defended. First, a boundary must be **true**: the test
 * applies the condition it printed and checks the recommendation actually
 * flips, which is the only assertion that cannot rot as the engine is retuned.
 * Second, a boundary must be **worth printing**: a comfortable call and an
 * unreachable threshold both produce nothing, said plainly.
 */

import { describe, expect, it } from 'vitest';
import { BOUNDARY, findBoundaries } from '../src/core/startsit/boundary.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { NO_INJURY_INFORMATION } from '../src/core/injury/model.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

/** Questionable, with a practice week the caller chooses. */
function questionable(input: StartSitInput, trend: 'stable_limited' | 'full_participant'): StartSitInput {
  return {
    ...input,
    injury: {
      ...NO_INJURY_INFORMATION,
      designation: 'questionable',
      designationSource: 'sleeper',
      practice: { trend, days: [], latest: 'limited', label: trend === 'full_participant' ? 'full participant' : 'limited all week' },
      freshness: 'fresh',
      confidence: 'high',
    },
  };
}

describe('when there is nothing to say', () => {
  it('says the call is not close rather than inventing a condition', () => {
    const report = findBoundaries(
      [candidate('a', 'Clear Starter', 'WR', 16), candidate('b', 'Bench Guy', 'WR', 6)],
      HALF_PPR,
    );
    expect(report.conditions).toEqual([]);
    expect(report.note).toMatch(/not a close call/);
    expect(report.margin!).toBeGreaterThan(BOUNDARY.closeCall);
  });

  it('says so when only one candidate can be scored at all', () => {
    const report = findBoundaries([candidate('a', 'Priced', 'WR', 12), candidate('b', 'No Market', 'WR', null)], HALF_PPR);
    expect(report.conditions).toEqual([]);
    expect(report.note).toMatch(/only one candidate/);
  });
});

describe('market line boundary', () => {
  const leader = candidate('a', 'A Starter', 'WR', 12);
  const challenger = candidate('b', 'B Challenger', 'WR', 11);

  it('names the line the challenger would have to reach', () => {
    const report = findBoundaries([leader, challenger], HALF_PPR);
    const line = report.conditions.find((c) => c.kind === 'market_line');
    expect(line).toBeDefined();
    expect(line!.switchToName).toBe('B Challenger');
    expect(line!.unit).toBe('yards');
    expect(line!.detail).toMatch(/receiving yards line reaches/);
  });

  it('is actually true: applying it flips the recommendation', () => {
    const report = findBoundaries([leader, challenger], HALF_PPR);
    const line = report.conditions.find((c) => c.kind === 'market_line')!;
    const moved: StartSitInput = {
      ...challenger,
      props: challenger.props.map((p) => ({ ...p, line: line.threshold! })),
    };
    const before = evaluatePlayer(leader, HALF_PPR).score!;
    const after = evaluatePlayer(moved, HALF_PPR).score!;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('rounds to something a person could read off a sportsbook', () => {
    const report = findBoundaries([leader, challenger], HALF_PPR);
    const line = report.conditions.find((c) => c.kind === 'market_line')!;
    expect(line.threshold! * 2).toBe(Math.round(line.threshold! * 2));
  });

  it('refuses a line move too large to be a condition', () => {
    // A two-point gap on a small line needs an implausible move to close.
    const report = findBoundaries(
      [candidate('a', 'A Starter', 'WR', 8.4), candidate('b', 'B Challenger', 'WR', 6)],
      HALF_PPR,
    );
    expect(report.conditions.some((c) => c.kind === 'market_line')).toBe(false);
  });
});

describe('practice-report boundary', () => {
  it('offers the leader getting worse', () => {
    const leader = questionable(candidate('a', 'A Starter', 'WR', 12.5), 'full_participant');
    const challenger = candidate('b', 'B Challenger', 'WR', 11.9);
    const report = findBoundaries([leader, challenger], HALF_PPR);
    const practice = report.conditions.find((c) => c.kind === 'practice_report');
    expect(practice).toBeDefined();
    expect(practice!.playerName).toBe('A Starter');
    expect(practice!.switchToName).toBe('B Challenger');
    expect(practice!.detail).toMatch(/limited again|held out of practice/);
  });

  it('offers the challenger getting better', () => {
    const leader = candidate('a', 'A Starter', 'WR', 12);
    const challenger = questionable(candidate('b', 'B Challenger', 'WR', 13.2), 'stable_limited');
    const report = findBoundaries([leader, challenger], HALF_PPR);
    const practice = report.conditions.find((c) => c.kind === 'practice_report' && c.playerName === 'B Challenger');
    expect(practice).toBeDefined();
    expect(practice!.switchToName).toBe('B Challenger');
    expect(practice!.detail).toMatch(/full participant|upgraded in practice/);
  });

  it('never proposes a change that is already true', () => {
    const leader = questionable(candidate('a', 'A Starter', 'WR', 12.5), 'stable_limited');
    const challenger = candidate('b', 'B Challenger', 'WR', 12);
    const report = findBoundaries([leader, challenger], HALF_PPR);
    for (const condition of report.conditions) {
      expect(condition.detail).not.toMatch(/A Starter is limited again/);
    }
  });

  it('says nothing about practice for a player with no designation', () => {
    const report = findBoundaries(
      [candidate('a', 'A Starter', 'WR', 12), candidate('b', 'B Challenger', 'WR', 11.6)],
      HALF_PPR,
    );
    expect(report.conditions.some((c) => c.kind === 'practice_report')).toBe(false);
  });
});

describe('wind boundary', () => {
  /** A downfield role, so the wind model has somebody to be sensitive about. */
  const downfield = Array.from({ length: 6 }, (_, i) => ({
    week: i + 1,
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: 8,
    receptions: 5,
    targetShare: 0.22,
    wopr: null,
    receivingAirYards: 120,
    recYards: 70,
  }));

  const inWeather = (input: StartSitInput, weather: StartSitInput['weather']): StartSitInput => ({
    ...input,
    weather,
    usageWeeks: downfield,
  });

  it('names the wind speed that would flip a deep receiver off the lineup', () => {
    const leader = inWeather(candidate('a', 'Deep Threat', 'WR', 12.2), {
      indoor: false,
      windMph: 6,
      gustMph: null,
      precipitationMmPerHour: 0,
      temperatureC: 8,
      snow: false,
    });
    const challenger = inWeather(candidate('b', 'Indoor Guy', 'WR', 11.7), { indoor: true });
    const report = findBoundaries([leader, challenger], HALF_PPR);
    const wind = report.conditions.find((c) => c.kind === 'wind');
    expect(wind).toBeDefined();
    expect(wind!.unit).toBe('mph');
    expect(wind!.threshold!).toBeGreaterThan(6);
    expect(wind!.threshold!).toBeLessThanOrEqual(BOUNDARY.maxWindMph);
    expect(Number.isInteger(wind!.threshold!)).toBe(true);
  });

  it('says nothing about wind for an indoor game', () => {
    const leader = inWeather(candidate('a', 'Dome Guy', 'WR', 12.2), { indoor: true });
    const challenger = inWeather(candidate('b', 'B Challenger', 'WR', 11.7), { indoor: true });
    const report = findBoundaries([leader, challenger], HALF_PPR);
    expect(report.conditions.some((c) => c.kind === 'wind')).toBe(false);
  });
});
