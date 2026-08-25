/**
 * Money, which this module reads and never computes.
 *
 * The FAAB layer already exists — `core/faab/strategy.ts` prices a bid against
 * this league's observed history, the roster's remaining budget and the demand
 * for the player, and it withholds a figure when there is not an honest one.
 * The planner's job is to decide *structure*, and a second opinion about what a
 * player is worth would be exactly the sort of quiet disagreement that ends up
 * on a screen next to the first one.
 *
 * So the tests here are mostly about what the planner does *not* do.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { recommendBid } from '../src/core/faab/strategy.ts';
import { buildBudgetState } from '../src/core/faab/budget.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';
import { HALF_PPR, NOW, SHAPE, roster, targets, wire } from './helpers/waiverPlanner.ts';

const NO_PRICES: PriceSummary = {
  sample: 0,
  median: null,
  low: null,
  high: null,
  max: null,
  highestLosing: null,
  losingBidsComplete: false,
  confidence: 'none',
};

function plan(overrides: Partial<Parameters<typeof planWaiverClaims>[0]> = {}) {
  return planWaiverClaims({
    roster: roster(),
    targets: targets(wire(), {
      wireRb: { recommended: 24, doNotExceed: 29, headline: 'Expected $18–24 · Recommended max $24' },
      wireWr: { recommended: 18, doNotExceed: 21 },
      wireTe: { recommended: 6, doNotExceed: 8 },
    }),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    generatedAt: '2025-10-05T14:00:00.000Z',
    ...overrides,
  });
}

describe('bids and budget', () => {
  it('carries the pricing pass’s numbers through unchanged', () => {
    const claims = plan({ budget: { remaining: 100, usesFaab: true } }).claims;
    const forRb = claims.find((c) => c.addPlayerId === 'wireRb');

    expect(forRb?.bid).toBe(24);
    expect(forRb?.doNotExceed).toBe(29);
    expect(forRb?.bidHeadline).toBe('Expected $18–24 · Recommended max $24');
    expect(forRb?.reasons.map((r) => r.code)).toContain('bid_reused_from_pricing');
  });

  it('quotes one price per target, however many claims it appears in', () => {
    /*
     * The A/B/C/D structure claims the same player twice. Two different
     * recommended bids on those two rows would be two different opinions about
     * what he is worth, and the difference between them would be a fact about
     * claim ordering rather than about football.
     */
    const claims = plan({ budget: { remaining: 100, usesFaab: true } }).claims;
    const forWr = claims.filter((c) => c.addPlayerId === 'wireWr');

    expect(forWr.length).toBe(2);
    expect(new Set(forWr.map((c) => c.bid)).size).toBe(1);
    expect(new Set(forWr.map((c) => c.doNotExceed)).size).toBe(1);
  });

  it('reports the most any reachable branch could cost', () => {
    const result = plan({ budget: { remaining: 100, usesFaab: true } });
    const spends = result.outcomes.map((o) => o.spend).filter((s): s is number => s != null);

    expect(result.maxSimultaneousSpend).toBe(Math.max(...spends));
    expect(result.maxSimultaneousSpend as number).toBeLessThanOrEqual(100);
  });

  it('never plans a set of claims that could all win and overspend', () => {
    /*
     * §13, held to the one condition that is safe whatever Sleeper does with a
     * set of pending claims that together exceed the budget — a question
     * nothing in this repository establishes and this module refuses to guess.
     *
     * A wallet with $30 in it cannot pay $24 and $18, so the plan gives up the
     * cheaper acquisition and says which one and what it would have cost. The
     * primary claim is never the one dropped.
     */
    const result = plan({ budget: { remaining: 30, usesFaab: true } });
    const acquisitions = result.claims.filter((c) => c.relation !== 'fallback');
    const total = acquisitions.reduce((sum, claim) => sum + (claim.bid ?? 0), 0);

    expect(total).toBeLessThanOrEqual(30);
    expect(result.claims[0]?.addPlayerId).toBe('wireRb');
    expect(result.reasons.map((r) => r.code)).toContain('budget_caps_simultaneous_claims');
    for (const outcome of result.outcomes) {
      if (outcome.spend == null) continue;
      expect(outcome.spend).toBeLessThanOrEqual(30);
    }
  });

  it('lets a fallback ride for free, because it can never land beside its blocker', () => {
    const result = plan({ budget: { remaining: 30, usesFaab: true } });
    const fallbacks = result.claims.filter((c) => c.relation === 'fallback');

    for (const fallback of fallbacks) {
      /* Its blocker is still in the plan — a fallback with nothing to fall
       * back from is removed rather than left dangling. */
      for (const blocker of fallback.blockedBy) {
        expect(result.claims.some((c) => c.id === blocker)).toBe(true);
      }
      /* No outcome contains both. */
      for (const outcome of result.outcomes) {
        const both = outcome.claimIds.includes(fallback.id) && fallback.blockedBy.some((b) => outcome.claimIds.includes(b));
        expect(both).toBe(false);
      }
    }
  });

  it('plans without money at all in a priority league', () => {
    const result = plan({ budget: { remaining: null, usesFaab: false } });

    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.maxSimultaneousSpend).toBeNull();
    /* The structure survives; only the dollar figures are absent. */
    expect(result.claims.some((c) => c.relation === 'fallback')).toBe(true);
  });

  it('says so when the pricing pass withheld a figure', () => {
    const result = plan({ targets: targets(wire()), budget: { remaining: 40, usesFaab: true } });
    for (const claim of result.claims) {
      expect(claim.bid).toBeNull();
      expect(claim.reasons.map((r) => r.code)).toContain('bid_unavailable');
    }
    expect(result.maxSimultaneousSpend).toBeNull();
  });

  it('accepts a real BidRecommendation without adaptation', () => {
    /*
     * The integration contract, exercised rather than described: the object the
     * Waivers screen already has is passed straight in.
     */
    const budgetState = buildBudgetState({
      leagueSettings: { waiver_type: 2, waiver_budget: 100 },
      rosters: [
        { rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 20 } },
        { rosterId: 2, ownerName: 'Them', isMine: false, settings: { waiver_budget_used: 10 } },
      ],
    });
    const recommendation = recommendBid({
      inputs: {
        playerId: 'wireRb',
        name: 'Breakout Back',
        position: 'RB',
        weeklyGain: 7,
        gainOverReplacement: 5,
        roleStability: 'rising',
        shelfLife: 'season',
        futureOpportunity: 'normal',
        rivalsWithNeed: 3,
        marketHeat: null,
      },
      budgetState,
      prices: NO_PRICES,
      season: { week: 5, finalWeek: 14 },
    });

    const result = plan({
      targets: targets(wire()).map((t) => (t.input.player.id === 'wireRb' ? { ...t, bid: recommendation } : t)),
      budget: { remaining: 80, usesFaab: true },
    });
    const claim = result.claims.find((c) => c.addPlayerId === 'wireRb');

    expect(recommendation.recommended).not.toBeNull();
    expect(claim?.bid).toBe(recommendation.recommended);
    expect(claim?.doNotExceed).toBe(recommendation.doNotExceed);
    expect(claim?.bidHeadline).toBe(recommendation.headline);
  });
});
