/**
 * What a tally point is worth, pinned to the two transfer functions that exist.
 *
 * The audit that produced this found that the two observations behind it were
 * both correct and were about different screens — see `tallyInfluence.ts`. The
 * tests below record that finding as behaviour, so the next person to ask "why
 * did my +13 barely move him" gets an answer from a test run rather than from
 * reading the engine.
 *
 * Deliberately NOT asserting linearity on the board. The saturation is the
 * design: a player the newsletters have been positive about ten net times is a
 * player they like, and the eleventh mention is the same information again.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPOSITE_PER_PICK,
  draftBoardTallyInfluence,
  lifetimeSaturationPoint,
  playersListTallyInfluence,
} from '../src/core/draft/tallyInfluence.ts';
import { DEFAULT_WEIGHTS, NEWS_SATURATION } from '../src/core/draft/engine.ts';
import { TALLY_WEIGHT, adjustedRank } from '../src/core/draft/playerOrder.ts';

const only = (lifetime: number) => draftBoardTallyInfluence({ lifetime, last30: 0, last7: 0 });

describe('the Players list is linear: half a pick per point', () => {
  /** The original observation, reproduced exactly. */
  it('turns +5 into 2.5 picks of movement', () => {
    expect(playersListTallyInfluence(5).picks).toBe(2.5);
    expect(adjustedRank(60, 5)).toBe(60 - 2.5);
  });

  it('stays linear at +13 — 6.5 picks, no cap', () => {
    expect(playersListTallyInfluence(13).picks).toBe(6.5);
    expect(playersListTallyInfluence(13).picks / playersListTallyInfluence(5).picks).toBeCloseTo(13 / 5, 6);
  });

  it('is exactly TALLY_WEIGHT per point in both directions', () => {
    for (const net of [-20, -7, -1, 1, 7, 20]) {
      expect(playersListTallyInfluence(net).picks).toBeCloseTo(TALLY_WEIGHT * net, 6);
    }
  });
});

describe('the draft board saturates, and that is the intended shape', () => {
  it('is linear below saturation', () => {
    // 5 and 8 are both under the lifetime saturation of 10.
    const ratio = only(8).contribution / only(5).contribution;
    expect(ratio).toBeCloseTo(8 / 5, 3);
  });

  it('stops responding at the saturation point', () => {
    expect(lifetimeSaturationPoint()).toBe(NEWS_SATURATION.lifetime);
    expect(only(10).contribution).toBe(only(13).contribution);
    expect(only(13).contribution).toBe(only(40).contribution);
  });

  /** The second observation, reproduced and explained: sublinear, not broken. */
  it('makes +13 worth 2x what +5 is worth rather than 2.6x', () => {
    const ratio = only(13).contribution / only(5).contribution;
    expect(ratio).toBeCloseTo(2, 3);
    expect(ratio).toBeLessThan(13 / 5);
    expect(only(13).note).toContain('saturated');
  });

  it('says which windows have saturated and which are still responding', () => {
    expect(only(4).note).toContain('still responding');
    expect(draftBoardTallyInfluence({ lifetime: 12, last30: 1, last7: 0 }).note).toContain('lifetime');
  });

  it('is symmetric: a negative tally saturates the same way', () => {
    expect(only(-13).contribution).toBe(-only(13).contribution);
  });

  it('caps the whole tally at the sum of the three window weights', () => {
    const maxed = draftBoardTallyInfluence({ lifetime: 99, last30: 99, last7: 99 });
    expect(maxed.contribution).toBeCloseTo(
      DEFAULT_WEIGHTS.newsLifetime + DEFAULT_WEIGHTS.news30 + DEFAULT_WEIGHTS.news7,
      6,
    );
    expect(maxed.contribution).toBeCloseTo(maxed.ceiling, 6);
  });

  it('keeps the tally a secondary input, not a trump card', () => {
    // Even fully maxed, the tally cannot outweigh the market on its own.
    const maxed = draftBoardTallyInfluence({ lifetime: 99, last30: 99, last7: 99 });
    expect(maxed.contribution).toBeLessThan(DEFAULT_WEIGHTS.marketValue);
  });

  it('saturates the shorter windows sooner, as their sample deserves', () => {
    expect(NEWS_SATURATION.last7).toBeLessThan(NEWS_SATURATION.last30);
    expect(NEWS_SATURATION.last30).toBeLessThan(NEWS_SATURATION.lifetime);
    const week = draftBoardTallyInfluence({ lifetime: 0, last30: 0, last7: 3 });
    expect(week.windows.find((w) => w.window === 'last7')!.saturated).toBe(true);
  });
});

describe('the windows disagreeing is damped rather than resolved', () => {
  it('halves the recent windows when they contradict lifetime', () => {
    const agreeing = draftBoardTallyInfluence({ lifetime: 6, last30: 3, last7: 0 });
    const conflicting = draftBoardTallyInfluence({ lifetime: 6, last30: -3, last7: 0 });
    expect(conflicting.damped).toBe(true);
    expect(agreeing.damped).toBe(false);
    const dampedThirty = conflicting.windows.find((w) => w.window === 'last30')!;
    const plainThirty = agreeing.windows.find((w) => w.window === 'last30')!;
    expect(Math.abs(dampedThirty.contribution)).toBeCloseTo(Math.abs(plainThirty.contribution) / 2, 6);
  });

  it('never damps the lifetime window itself', () => {
    const conflicting = draftBoardTallyInfluence({ lifetime: 6, last30: -3, last7: 0 });
    expect(conflicting.windows.find((w) => w.window === 'lifetime')!.contribution).toBe(
      only(6).windows.find((w) => w.window === 'lifetime')!.contribution,
    );
  });

  it('does not call a zero a disagreement', () => {
    expect(draftBoardTallyInfluence({ lifetime: 6, last30: 0, last7: 0 }).damped).toBe(false);
  });
});

describe('the effect is reported in the unit the card uses', () => {
  it('translates a contribution into approximate board places', () => {
    const influence = only(5);
    expect(influence.approximateSpots).toBe(Math.round(influence.contribution / COMPOSITE_PER_PICK));
    // +5 lifetime is 0.175 of composite, about three or four places.
    expect(influence.approximateSpots).toBeGreaterThanOrEqual(3);
    expect(influence.approximateSpots).toBeLessThanOrEqual(4);
  });

  it('is deterministic', () => {
    const windows = { lifetime: 7, last30: -2, last7: 1 };
    const answers = Array.from({ length: 10 }, () => JSON.stringify(draftBoardTallyInfluence(windows)));
    expect(new Set(answers).size).toBe(1);
  });
});
