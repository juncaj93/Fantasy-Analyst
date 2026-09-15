/**
 * How long a waiver claim is expected to be worth something.
 *
 * `shelfLifeOf` is the only input to `recommendBid` that answers "for how many
 * weeks", and `recommendBid` multiplies the whole bid by a duration factor
 * derived from it — so an answer of `unknown` is not a neutral answer. It is
 * priced at two weeks of the remaining schedule, deliberately, because unknown
 * is not supposed to read as optimism.
 *
 * That was right when nothing had a usage series. It stopped being right as the
 * weeks accumulated: `roleStabilityOf`, ten lines above it in the same file,
 * tells a **stable measured** role from an unmeasured one, and this function did
 * not — so a back with four settled weeks of work was priced for exactly as long
 * as a name nobody had ever seen carry the ball.
 */

import { describe, expect, it } from 'vitest';
import { SETTLED_ROLE_GAMES, roleStabilityOf, shelfLifeOf } from '../src/core/waivers/pricing.ts';
import type { WaiverCandidate } from '../src/core/startsit/waivers.ts';

function candidate(over: Partial<WaiverCandidate> = {}): WaiverCandidate {
  return {
    playerId: 'p1',
    name: 'Wire Guy',
    position: 'RB',
    team: 'KC',
    score: 11,
    gain: 2.4,
    reasons: [],
    statusFlag: null,
    role: { trend: 'stable', games: 6 },
    ...over,
  };
}

describe('a settled role is not the same answer as an unmeasured one', () => {
  it('reads four stable games as a multi-week hold', () => {
    expect(shelfLifeOf(candidate({ role: { trend: 'stable', games: SETTLED_ROLE_GAMES } }))).toBe('multi_week');
  });

  it('still says unknown below that, because three games is an accident', () => {
    expect(shelfLifeOf(candidate({ role: { trend: 'stable', games: SETTLED_ROLE_GAMES - 1 } }))).toBe('unknown');
  });

  it('says unknown for a player with no usage series at all', () => {
    // Week 1, and every deployment before the usage backfill. Unchanged.
    expect(shelfLifeOf(candidate({ role: { trend: 'insufficient_data', games: 0 } }))).toBe('unknown');
  });

  it('agrees with the stability read beside it, which is the point', () => {
    const settled = candidate({ role: { trend: 'stable', games: 6 } });
    const unmeasured = candidate({ role: { trend: 'insufficient_data', games: 0 } });

    expect(roleStabilityOf(settled)).toBe('stable');
    expect(roleStabilityOf(unmeasured)).toBe('unknown');
    // The two functions used to disagree about whether those were the same
    // player. They no longer do.
    expect(shelfLifeOf(settled)).not.toBe(shelfLifeOf(unmeasured));
  });
});

describe('what a settled role is still not worth', () => {
  it('keeps the rest of the season for a rising role only', () => {
    expect(shelfLifeOf(candidate({ role: { trend: 'rising_high', games: 6 } }))).toBe('season');
    expect(shelfLifeOf(candidate({ role: { trend: 'rising_moderate', games: 6 } }))).toBe('season');
    // Holding is not growing. The thing that ends a settled role has not
    // happened yet, which is not the same as knowing it will not.
    expect(shelfLifeOf(candidate({ role: { trend: 'stable', games: 12 } }))).toBe('multi_week');
  });

  it('promises nothing for a role that is moving the wrong way, or spiking', () => {
    for (const trend of ['falling_high', 'falling_moderate', 'spike'] as const) {
      expect(shelfLifeOf(candidate({ role: { trend, games: 8 } })), trend).toBe('unknown');
    }
  });
});

describe('a body for an empty slot is read off the slot', () => {
  it('takes the upgrade’s own need rather than the sentence describing it', () => {
    const thin = candidate({ role: { trend: 'insufficient_data', games: 0 }, reasons: [] });

    expect(shelfLifeOf(thin, 'unfilled')).toBe('multi_week');
    expect(shelfLifeOf(thin, 'upgrade')).toBe('unknown');
  });

  it('still reads the prose for a caller that has no upgrade to hand', () => {
    // The fallback, and the line to delete when nothing needs it. A caller that
    // passes a `need` never reaches it — which is what stops a reworded card
    // from silently repricing a bid.
    const phrased = candidate({ role: { trend: 'insufficient_data', games: 0 }, reasons: ['fills a slot nobody can start'] });

    expect(shelfLifeOf(phrased)).toBe('multi_week');
    expect(shelfLifeOf(phrased, 'upgrade'), 'the slot is filled; the sentence must not overrule it').toBe('unknown');
  });
});
