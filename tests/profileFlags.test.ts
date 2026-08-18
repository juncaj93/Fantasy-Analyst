/**
 * Height, weight, age and experience — context only, and rarely even that.
 *
 * The two pins the brief names: a physical profile must be context rather than
 * a ranking penalty, and age alone must stay bounded. Both are written here as
 * "the flag does not fire" tests, because the failure mode is over-firing.
 */

import { describe, expect, it } from 'vitest';
import {
  ageFlags,
  parseHeight,
  parseWeight,
  physicalFlags,
  profileContext,
  type PlayerPhysical,
} from '../src/core/players/profileFlags.ts';

function player(over: Partial<PlayerPhysical> = {}): PlayerPhysical {
  return { playerId: 'p1', position: 'WR', heightInches: 72, weightPounds: 200, age: 25, yearsExp: 3, ...over };
}

describe('physical profile flags (§12)', () => {
  it('says nothing at all without a projected role', () => {
    expect(physicalFlags(player({ heightInches: 66, weightPounds: 160 }))).toEqual([]);
  });

  it('fires only where the measurement is in tension with the role', () => {
    const small = player({ weightPounds: 165 });
    expect(physicalFlags(small, { projectedRole: 'outside_receiver' })[0]?.text).toBe(
      'Small frame for projected outside role',
    );
    // The same body in the slot is unremarkable, and gets no flag.
    expect(physicalFlags(small, { projectedRole: 'slot_receiver' })).toEqual([]);
  });

  it('names the unusually large receiving back', () => {
    const flags = physicalFlags(player({ position: 'RB', weightPounds: 245 }), { projectedRole: 'receiving_back' });
    expect(flags[0]?.text).toBe('Unusually large receiving-back profile');
  });

  it('never shows measurements unless a physical flag fired', () => {
    expect(profileContext(player(), { projectedRole: 'outside_receiver' }).showMeasurements).toBe(false);
    expect(profileContext(player({ weightPounds: 165 }), { projectedRole: 'outside_receiver' }).showMeasurements).toBe(true);
  });

  it('is context, never a ranking penalty', () => {
    const context = profileContext(player({ weightPounds: 160, heightInches: 66 }), {
      projectedRole: 'outside_receiver',
    });
    expect(context.scoreDelta).toBe(0);
    for (const flag of context.flags) expect(flag.weight).toBe('context');
  });

  it('reads Sleeper’s two height formats and rejects nonsense', () => {
    expect(parseHeight('72')).toBe(72);
    expect(parseHeight("6'1\"")).toBe(73);
    expect(parseHeight('6’0”')).toBe(72);
    expect(parseHeight('')).toBeNull();
    expect(parseHeight(null)).toBeNull();
    expect(parseWeight('205')).toBe(205);
    expect(parseWeight('unknown')).toBeNull();
  });
});

describe('age and experience flags (§13)', () => {
  it('age alone produces no flag', () => {
    /*
     * The brief's explicit bound. A 30-year-old back whose usage is holding is
     * a 30-year-old back, and nothing more is claimed about him.
     */
    expect(ageFlags(player({ position: 'RB', age: 30, yearsExp: 8 }), { usageTrend: 'flat' })).toEqual([]);
    expect(ageFlags(player({ position: 'RB', age: 30, yearsExp: 8 }), { usageTrend: 'rising' })).toEqual([]);
    expect(ageFlags(player({ position: 'RB', age: 30, yearsExp: 8 }))).toEqual([]);
  });

  it('fires only when age and declining usage agree', () => {
    const flags = ageFlags(player({ position: 'RB', age: 30, yearsExp: 8 }), { usageTrend: 'falling' });
    expect(flags[0]?.key).toBe('age_with_declining_usage');
  });

  it('is position aware — the same age means different things', () => {
    expect(ageFlags(player({ position: 'RB', age: 29 }), { usageTrend: 'falling' })).toHaveLength(1);
    expect(ageFlags(player({ position: 'WR', age: 29 }), { usageTrend: 'falling' })).toHaveLength(0);
    expect(ageFlags(player({ position: 'QB', age: 29 }), { usageTrend: 'falling' })).toHaveLength(0);
  });

  it('names the year-2 receiver window and the rookie tight end', () => {
    expect(ageFlags(player({ position: 'WR', yearsExp: 2 }))[0]?.key).toBe('year_two_wr');
    expect(ageFlags(player({ position: 'TE', yearsExp: 0 }))[0]?.key).toBe('rookie_te');
    expect(ageFlags(player({ position: 'WR', yearsExp: 5 }))).toEqual([]);
  });

  it('changes no score', () => {
    const context = profileContext(player({ position: 'RB', age: 31 }), { usageTrend: 'falling' });
    expect(context.scoreDelta).toBe(0);
    expect(context.showMeasurements).toBe(false);
  });
});
