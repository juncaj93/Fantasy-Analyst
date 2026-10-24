/**
 * When Sleeper and the injury report disagree, the worse status stands
 * (24 October 2026).
 *
 * Sleeper's player list is downloaded once a day and the injury report is
 * checked every five minutes. Until this round Sleeper always won, so a player
 * ruled out after the morning download kept a stale Questionable, counted at
 * full value, and could be started. Time is the check on severity: an old bad
 * record never beats a newer clean one.
 */

import { describe, expect, it } from 'vitest';
import { resolveInjury, type InjuryObservation } from '../src/core/injury/model.ts';
import { weekAvailability } from '../src/core/injury/weekAvailability.ts';

/* Sunday 25 October 2026, 11:00 AM Eastern. */
const NOW = new Date('2026-10-25T15:00:00Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function sleeper(raw: string, asOf: string | null = hoursAgo(6)): InjuryObservation {
  const designation = ({ Questionable: 'questionable', Out: 'out', Active: 'healthy', Doubtful: 'doubtful' } as const)[
    raw as 'Questionable'
  ];
  return { source: 'sleeper', designation, raw, observedAt: null, asOf };
}

function report(raw: string, observedAt: string): InjuryObservation {
  const designation = ({ Questionable: 'questionable', Out: 'out', Doubtful: 'doubtful' } as const)[raw as 'Out'];
  return { source: 'nflverse', designation, raw, observedAt, practice: ['dnp'], bodyPart: 'Knee' };
}

describe('the more severe status wins', () => {
  it('Sleeper Questionable and the report Out reads Out, and he is benched', () => {
    const state = resolveInjury([sleeper('Questionable'), report('Out', hoursAgo(2))], NOW);
    expect(state.designation).toBe('out');
    expect(state.designationSource).toBe('nflverse');
    expect(weekAvailability(state.designation).out).toBe(true);
    // Still a disagreement, and still said.
    expect(state.conflict).toBe(true);
  });

  it('Sleeper Out and the report Questionable reads Out', () => {
    const state = resolveInjury([sleeper('Out'), report('Questionable', hoursAgo(2))], NOW);
    expect(state.designation).toBe('out');
    expect(state.designationSource).toBe('sleeper');
    expect(weekAvailability(state.designation).out).toBe(true);
  });

  it('Sleeper with no designation and the report Questionable reads Questionable', () => {
    const state = resolveInjury([sleeper('Active'), report('Questionable', hoursAgo(20))], NOW);
    expect(state.designation).toBe('questionable');
  });

  it('agreeing sources change nothing: Sleeper keeps the word', () => {
    const state = resolveInjury([sleeper('Questionable'), report('Questionable', hoursAgo(2))], NOW);
    expect(state.designation).toBe('questionable');
    expect(state.designationSource).toBe('sleeper');
    expect(state.conflict).toBe(false);
  });
});

describe('time is the check on severity', () => {
  it('a Wednesday Out does not beat a Sunday Active', () => {
    const wednesday = '2026-10-21T20:00:00Z';
    const state = resolveInjury([sleeper('Active', hoursAgo(1)), report('Out', wednesday)], NOW);
    expect(state.designation).toBe('healthy');
    expect(state.designationSource).toBe('sleeper');
  });

  it('an old Sleeper Out does not beat a newer report Questionable', () => {
    const state = resolveInjury([sleeper('Out', hoursAgo(60)), report('Questionable', hoursAgo(3))], NOW);
    expect(state.designation).toBe('questionable');
  });

  it('records within a day of each other are the same news: the worse stands', () => {
    const state = resolveInjury([sleeper('Questionable', hoursAgo(2)), report('Out', hoursAgo(20))], NOW);
    expect(state.designation).toBe('out');
  });

  it('with no download time, an earlier week\'s report cannot outrank Sleeper', () => {
    const lastWeek = '2026-10-16T20:00:00Z';
    const state = resolveInjury([sleeper('Questionable', null), report('Out', lastWeek)], NOW);
    expect(state.designation).toBe('questionable');
  });

  it('with no download time, this week\'s report still can', () => {
    const friday = '2026-10-23T20:00:00Z';
    const state = resolveInjury([sleeper('Questionable', null), report('Out', friday)], NOW);
    expect(state.designation).toBe('out');
  });
});
