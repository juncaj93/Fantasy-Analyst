/**
 * Whether a rival who *can* bid actually does.
 *
 * The case that prompted this: a manager who has placed one bid in the league's
 * history, or who is sitting on the whole $100 he started with, was counted as
 * a full competing bidder the moment he had a hole at the position — the same
 * weight as the manager who claims every week. These are the tests that say he
 * is not, and the tests that say the app must not go too far the other way and
 * write off a manager nobody has watched yet.
 */

import { describe, expect, it } from 'vitest';
import {
  BID_LIKELIHOOD,
  bidLikelihoodByRoster,
  bidParticipation,
  neutralBidLikelihood,
} from '../src/core/waivers/bidLikelihood.ts';
import { assessCompetition, type TeamNeed } from '../src/core/league/competition.ts';
import type { RosterBudget } from '../src/core/faab/budget.ts';
import type {
  LeagueTransactionBaseline,
  ManagerTransactionProfile,
} from '../src/core/managers/transactionProfile.ts';

const BASELINE: LeagueTransactionBaseline = {
  seasons: ['2024', '2025'],
  managers: 12,
  weeksRead: 28,
  claimsPerWeek: 0.5,
  addsPerWeek: 0.3,
  churnPerWeek: 1.2,
  usesFaab: true,
  medianBidShare: 0.08,
  bidSample: 140,
  positionShare: [{ position: 'RB', share: 0.4 }],
  sample: 400,
};

function profile(over: Partial<ManagerTransactionProfile> = {}): ManagerTransactionProfile {
  return {
    userId: 'u1',
    displayName: 'Rival',
    seasons: ['2024', '2025'],
    activeWeeks: 28,
    sample: 30,
    usable: true,
    claimsPerWeek: 0.5,
    addsPerWeek: 0.3,
    churnPerWeek: 1.2,
    activityRelative: 1,
    bidSample: 14,
    medianBidShare: 0.08,
    upperBidShare: 0.12,
    spendRelative: 1,
    bigBidRate: 0.1,
    earlySpendShare: 0.4,
    byPosition: [],
    timing: [],
    confidence: 0.8,
    spendConfidence: 0.8,
    notes: [],
    ...over,
  };
}

function wallet(over: Partial<RosterBudget> = {}): RosterBudget {
  return { rosterId: 2, ownerName: 'Rival', isMine: false, remaining: 50, spent: 50, share: 0.5, ...over };
}

const MIDSEASON = { week: 8, finalWeek: 14 };

describe('a manager who does not claim is not a full bidder', () => {
  it('discounts the manager who has bid once across two seasons', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 1 }),
      budget: wallet(),
      baseline: BASELINE,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result.participation).toBeLessThan(0.5);
    expect(result.participation).toBeGreaterThanOrEqual(BID_LIKELIHOOD.floor);
    expect(result.note).toContain('1 bid(s) in 28 active week(s)');
  });

  it('leaves the manager who claims at the room’s rate alone', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 14 }),
      budget: wallet(),
      baseline: BASELINE,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result.participation).toBe(1);
    expect(result.note).toBeNull();
  });

  /*
   * The upward direction is deliberately closed. A busy manager raising the
   * rival count would be a second path from tendency to price, which is what
   * `bidders.ts` calls the double-counting rule; the cost of his aggression is
   * `managerPressure.ts`'s job and it expresses it as cost context.
   */
  it('never counts a busy manager as more than one bidder', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 60 }),
      budget: wallet({ spent: 95, remaining: 5 }),
      baseline: BASELINE,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result.participation).toBe(1);
  });

  /*
   * The dormant end of the scale, at a realistic observation window. Two
   * seasons of never claiming and an untouched budget in week 13 is the most
   * damning record this league can actually produce, and it lands near — not
   * at — the floor, because the confidence term is still short of 1.
   */
  it('takes a manager who has never claimed close to the floor', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 0, activeWeeks: 28 }),
      budget: wallet({ spent: 0, remaining: 100, share: 1 }),
      baseline: BASELINE,
      budgetTotal: 100,
      week: 13,
      finalWeek: 14,
    });

    expect(result.participation).toBeLessThan(0.35);
    expect(result.participation).toBeGreaterThan(BID_LIKELIHOOD.floor);
  });

  /*
   * And the clamp itself, which no realistic league reaches but which is the
   * only thing standing between a long enough history and a $1 recommendation
   * on a player somebody was always going to bid for.
   */
  it('never writes anybody off entirely, however long the record', () => {
    for (const activeWeeks of [28, 60, 200, 1000]) {
      const result = bidParticipation(2, {
        profile: profile({ bidSample: 0, activeWeeks }),
        budget: wallet({ spent: 0, remaining: 100, share: 1 }),
        baseline: BASELINE,
        budgetTotal: 100,
        week: 13,
        finalWeek: 14,
      });
      expect(result.participation).toBeGreaterThanOrEqual(BID_LIKELIHOOD.floor);
    }
  });
});

describe('an unwatched manager is unknown, not quiet', () => {
  it('claims nothing below the minimum observation window', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 0, activeWeeks: 4 }),
      budget: wallet({ spent: 0, remaining: 100 }),
      baseline: BASELINE,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result.participation).toBe(1);
    expect(result.note).toContain('below the 8 needed');
  });

  it('claims nothing without a profile at all', () => {
    const result = bidParticipation(2, {
      profile: undefined,
      budget: wallet(),
      baseline: BASELINE,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result).toEqual(neutralBidLikelihood(2));
  });

  it('claims nothing without a league baseline to compare against', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 0 }),
      budget: wallet(),
      baseline: null,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result.participation).toBe(1);
  });

  it('claims nothing in a room that does not bid either', () => {
    const result = bidParticipation(2, {
      profile: profile({ bidSample: 0 }),
      budget: wallet(),
      baseline: { ...BASELINE, claimsPerWeek: 0 },
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(result.participation).toBe(1);
    expect(result.note).toContain('no claim rate');
  });

  /*
   * Everybody holds their whole budget in week 2. Reading it there would mark
   * the entire league dormant in September, which is exactly when the advice
   * matters and exactly when it would be wrong.
   */
  it('does not read an untouched budget early in the season', () => {
    const early = bidParticipation(2, {
      profile: profile({ bidSample: 3 }),
      budget: wallet({ spent: 0, remaining: 100 }),
      baseline: BASELINE,
      budgetTotal: 100,
      week: 2,
      finalWeek: 14,
    });
    const late = bidParticipation(2, {
      profile: profile({ bidSample: 3 }),
      budget: wallet({ spent: 0, remaining: 100 }),
      baseline: BASELINE,
      budgetTotal: 100,
      week: 12,
      finalWeek: 14,
    });

    expect(late.participation).toBeLessThan(early.participation);
  });
});

describe('an unspent budget only ever confirms what the record already said', () => {
  /*
   * The manager `managerPressure.ts` calls a `fundedLateRival` — historically
   * saves his money and is a live threat in week 11. His full wallet must not
   * come back through this file as evidence that he is harmless.
   */
  it('moves an active manager with a full wallet by nothing at all', () => {
    const spent = bidParticipation(2, {
      profile: profile({ bidSample: 14 }),
      budget: wallet({ spent: 90, remaining: 10 }),
      baseline: BASELINE,
      budgetTotal: 100,
      week: 12,
      finalWeek: 14,
    });
    const unspent = bidParticipation(2, {
      profile: profile({ bidSample: 14 }),
      budget: wallet({ spent: 0, remaining: 100 }),
      baseline: BASELINE,
      budgetTotal: 100,
      week: 12,
      finalWeek: 14,
    });

    expect(spent.participation).toBe(1);
    expect(unspent.participation).toBe(1);
  });

  it('deepens the discount on a manager whose record was already quiet', () => {
    const args = {
      profile: profile({ bidSample: 1 }),
      baseline: BASELINE,
      budgetTotal: 100,
      week: 12,
      finalWeek: 14,
    };
    const spent = bidParticipation(2, { ...args, budget: wallet({ spent: 80, remaining: 20 }) });
    const unspent = bidParticipation(2, { ...args, budget: wallet({ spent: 0, remaining: 100 }) });

    expect(unspent.participation).toBeLessThan(spent.participation);
  });
});

describe('the competition count spends the reading', () => {
  const needs: TeamNeed[] = [2, 3, 4].map((rosterId) => ({
    rosterId,
    displayName: `Team ${rosterId}`,
    level: 'urgent' as const,
    healthy: 0,
    required: 1,
    flexEligible: false,
  }));
  const budgets = new Map<number, RosterBudget>(
    [2, 3, 4].map((rosterId) => [rosterId, wallet({ rosterId, remaining: 60, spent: 40 })]),
  );

  it('counts every rival whole when no participation is supplied', () => {
    const assessed = assessCompetition({ needs, budgets, expectedLow: 5, bidding: true, position: 'RB' });

    expect(assessed.bidders).toHaveLength(3);
    expect(assessed.effectiveBidders).toBe(3);
    expect(assessed.bidders.every((b) => b.participation === 1)).toBe(true);
  });

  it('prices a room of quiet managers as fewer bidders', () => {
    const assessed = assessCompetition({
      needs,
      budgets,
      expectedLow: 5,
      bidding: true,
      position: 'RB',
      participationOf: () => 0.25,
    });

    expect(assessed.bidders).toHaveLength(3);
    expect(assessed.effectiveBidders).toBe(1);
    expect(assessed.level).toBe('low');
  });

  /*
   * Never zero while anybody is in the list. "Nobody needs him" and "three
   * people need him and none of them usually bid" are different facts, and
   * `bidders.ts` reads a zero as the first one.
   */
  it('never rounds a real rival away entirely', () => {
    const assessed = assessCompetition({
      needs: [needs[0]!],
      budgets,
      expectedLow: 5,
      bidding: true,
      position: 'RB',
      participationOf: () => BID_LIKELIHOOD.floor,
    });

    expect(assessed.bidders).toHaveLength(1);
    expect(assessed.effectiveBidders).toBe(1);
  });

  it('still reports nobody when nobody has a hole', () => {
    const assessed = assessCompetition({
      needs: [],
      budgets,
      expectedLow: 5,
      bidding: true,
      position: 'RB',
      participationOf: () => 1,
    });

    expect(assessed.effectiveBidders).toBe(0);
  });
});

describe('the whole-board pass', () => {
  it('reads every rival once and defaults the unknown ones to whole', () => {
    const likelihood = bidLikelihoodByRoster({
      rosterIds: [2, 3],
      profiles: new Map([[2, profile({ bidSample: 1 })]]),
      budgets: new Map([[2, wallet()]]),
      baseline: BASELINE,
      budgetTotal: 100,
      ...MIDSEASON,
    });

    expect(likelihood.get(2)!.participation).toBeLessThan(0.6);
    expect(likelihood.get(3)!.participation).toBe(1);
  });
});
