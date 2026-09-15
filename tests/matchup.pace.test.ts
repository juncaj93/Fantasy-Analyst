/**
 * What a few minutes of football is allowed to say about the rest of a game.
 *
 * The live blend reads a player's scoring rate off the wall clock and leans on
 * it more as the afternoon runs down. That is the right shape, and it had a
 * hole in it that only showed up in one direction: `settled / elapsed` grows
 * without limit as `elapsed` goes to zero, and {@link PACE_TRUST} bounds the
 * weight on that rate rather than the rate itself. A scoreless player was never
 * affected — his implied rate is zero — so the failure was invisible on every
 * fixture built around a quiet first half, and arrived on screen only when
 * somebody's quarterback scored twice in the first quarter.
 *
 * These are the two properties the cap exists to hold, written as the model's
 * own arithmetic rather than as a number somebody measured once: an early
 * reading may not project a number nobody would defend, and it may not be worth
 * *more* the less of it there is.
 */

import { describe, expect, it } from 'vitest';
import {
  GAME_MINUTES,
  PACE_CEILING,
  PACE_FLOOR_ALLOWANCE,
  buildDistribution,
  projectedFinal,
  resolveGameClock,
} from '../src/core/matchup/distribution.ts';
import { player } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const KICKOFF = '2026-12-20T18:00:00Z';
const KICKOFF_MS = Date.parse(KICKOFF);

/** The moment a given share of the game has elapsed, on this module's clock. */
function minutesIn(minutes: number): Date {
  return new Date(KICKOFF_MS + minutes * 60_000);
}

function at(minutes: number, over: Partial<MatchupPlayerInput> = {}) {
  const input = player({ playerId: 'p1', side: 'mine', kickoff: KICKOFF, ...over });
  return buildDistribution(input, resolveGameClock(KICKOFF, minutesIn(minutes)));
}

describe('an early scoring burst cannot imply an impossible afternoon', () => {
  /**
   * The case that was actually wrong, in the numbers it was wrong by.
   *
   * A quarterback projected 20 with 24 points eight minutes in read 56.4
   * before the cap — a full-game total nobody would write down, produced from
   * a rate of 555 points a game held with a weight of 0.026.
   */
  it('keeps a quarterback who scored 24 in eight minutes under a defensible total', () => {
    const early = at(8, { position: 'QB', projection: 20, actual: 24 });
    const total = projectedFinal(early);

    expect(total, 'the pre-cap answer here was 56.4').toBeLessThan(48);
    // And not so tight that it argues with the points he has already banked.
    expect(total).toBeGreaterThan(24);
  });

  it('never projects more than the banked points plus the capped rate', () => {
    const projection = 20;
    const cap = projection * PACE_CEILING + PACE_FLOOR_ALLOWANCE;
    for (const minutes of [1, 4, 8, 20, 45, 90, 150]) {
      const distribution = at(minutes, { position: 'QB', projection, actual: 24 });
      expect(projectedFinal(distribution), `at ${minutes} minutes`).toBeLessThanOrEqual(24 + cap);
    }
  });

  /**
   * The property the number itself does not state.
   *
   * Eight minutes of football is less evidence than thirty, so the same banked
   * total may not be worth more at eight. Before the cap it was: the projected
   * final peaked at four minutes and fell from there, which is the blend
   * arguing against its own premise.
   */
  it('does not read the same points as worth more the earlier they arrived', () => {
    const totals = [4, 8, 12, 20, 30, 45].map((minutes) =>
      projectedFinal(at(minutes, { position: 'QB', projection: 20, actual: 24 })),
    );
    const earliest = totals[0]!;
    const peak = Math.max(...totals);

    // The four-minute reading may not be the high point of the afternoon by any
    // margin that would move a win probability.
    expect(peak - earliest).toBeGreaterThanOrEqual(0);
    expect(earliest).toBeLessThanOrEqual(peak);
    expect(peak - Math.min(...totals), 'the whole early window should be flat, not a spike').toBeLessThan(5);
  });

  /**
   * The guard this replaced was a step, and a step in a live number is a jump
   * on somebody's screen. Below 2% elapsed the pace used to be ignored
   * entirely, so the third minute and the fourth answered seven points apart
   * on identical facts.
   */
  it('crosses the old 2%-elapsed threshold without a step', () => {
    const before = projectedFinal(at(0.02 * GAME_MINUTES - 0.5, { actual: 12 }));
    const after = projectedFinal(at(0.02 * GAME_MINUTES + 0.5, { actual: 12 }));

    expect(Math.abs(after - before), 'a minute of wall clock moved this by 6.5 points').toBeLessThan(0.5);
  });
});

describe('the cap binds in one direction only', () => {
  it('leaves a scoreless player exactly where the blend put him', () => {
    // His implied rate is zero, which is inside any cap. This is the half of
    // the model that was always right and must stay byte-identical.
    for (const minutes of [10, 45, 90, 150]) {
      const quiet = at(minutes, { actual: 0, projection: 12 });
      // Recomputed from the clock rather than read off the distribution, whose
      // own `remainingShare` is rounded for display.
      const share = 1 - minutes / GAME_MINUTES;
      const weight = Math.min((minutes / GAME_MINUTES) * 0.6, 0.6);
      expect(quiet.remainingMean).toBeCloseTo(Math.max(0, (1 - weight) * 12 * share), 1);
    }
  });

  it('leaves a player scoring at his projected rate on his projection', () => {
    for (const minutes of [20, 60, 120]) {
      const share = minutes / GAME_MINUTES;
      const onPace = at(minutes, { projection: 12, actual: Math.round(12 * share * 10) / 10 });
      expect(projectedFinal(onPace), `at ${minutes} minutes`).toBeCloseTo(12, 0);
    }
  });
});

describe('a player projected at almost nothing can still be seen scoring', () => {
  /**
   * The degenerate end of a purely multiplicative cap: three times 0.4 is 1.2,
   * so the deep-bench starter who has just caught a touchdown would be told his
   * afternoon means nothing. {@link PACE_FLOOR_ALLOWANCE} is why he is not.
   */
  it('lets a touchdown move a player nobody projected', () => {
    const surprise = at(45, { projection: 0.4, actual: 6.4 });
    expect(projectedFinal(surprise)).toBeGreaterThan(6.4);
  });

  it('does not let the allowance matter for a player who was projected properly', () => {
    // At 12 projected the cap is 42 a game either way; the allowance is noise.
    const withAllowance = projectedFinal(at(30, { projection: 12, actual: 14 }));
    expect(withAllowance).toBeGreaterThan(14);
    expect(withAllowance).toBeLessThan(14 + 12 * PACE_CEILING + PACE_FLOOR_ALLOWANCE);
  });
});
