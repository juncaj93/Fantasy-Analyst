/**
 * Fair to both sides, in the ranking (review T3, November 2026).
 *
 * Until November the composite ranked a deal 10-25% the user's way above an
 * even one, on Alex's 15 September "lean my way" instruction, and broke ties
 * toward the bigger surplus. Alex replaced that rule: a good trade is fair to
 * both sides, his edge at most 10%. These tests pin the new order: past 10%
 * his way is outside the range, even ranks first, and ties go to the deal
 * closer to even.
 */

import { describe, expect, it } from 'vitest';
import {
  FAIRNESS_BANDS,
  RANK_WEIGHTS,
  compareOffers,
  fairnessOf,
  scoreOf,
  type Fairness,
  type OfferEvaluation,
  type SideOutcome,
} from '../src/core/trades/bilateral.ts';
import { MANAGER_FIT_CAP, type ManagerFit } from '../src/core/trades/managerFit.ts';

const NEUTRAL_FIT: ManagerFit = {
  userId: null,
  displayName: null,
  activity: 'unknown',
  activityLabel: 'Limited history',
  contribution: 0,
  evidence: {
    sample: 0,
    seasonsObserved: 0,
    historyComplete: false,
    ratePerSeason: null,
    leagueRate: null,
    confidence: 0,
  },
  shapeNotes: [],
  notes: [],
} as unknown as ManagerFit;

function side(starterGain: number, rationaleCount = 1): SideOutcome {
  return {
    starterGain,
    rationales: Array.from({ length: rationaleCount }, () => 'upgrades_starter' as const),
    entersLineup: [],
    leavesLineup: [],
  } as unknown as SideOutcome;
}

function fairnessAt(gap: number): Fairness {
  // Build a real one through the module's own reader, so the band and the gap
  // can never drift apart in a fixture the way they could if written by hand.
  return fairnessOf([{ playerId: 'a', name: 'A', position: 'RB', value: 100 }], [
    { playerId: 'b', name: 'B', position: 'RB', value: 100 / (1 - gap) },
  ]);
}

function scoreWith(fairness: Fairness, userGain = 2): number {
  return scoreOf({
    user: side(userGain),
    fairness,
    counterparty: side(1),
    managerFit: NEUTRAL_FIT,
    size: 2,
  }).total;
}

describe('even ranks first, and the user’s edge stops at 10%', () => {
  it('puts a deal more than 10% the user’s way outside the range', () => {
    expect(fairnessAt(0.18).band).toBe('outside_range');
    expect(fairnessAt(0.12).band).toBe('outside_range');
    expect(fairnessAt(0.09).band).toBe('even');
  });

  it('ranks even above leaning their way', () => {
    const even = fairnessAt(0);
    const edgeOpponent = fairnessAt(-0.18);
    expect(even.band).toBe('even');
    expect(edgeOpponent.band).toBe('edge_opponent');
    expect(scoreWith(even)).toBeGreaterThan(scoreWith(edgeOpponent));
  });

  it('never outranks a materially better deal for the user', () => {
    const evenButBetter = scoreWith(fairnessAt(0), 4);
    const leaningButWorse = scoreWith(fairnessAt(-0.18), 2);
    expect(evenButBetter).toBeGreaterThan(leaningButWorse);
  });

  it('cannot reach past the band on their side either', () => {
    expect(fairnessAt(-(FAIRNESS_BANDS.edge + 0.15)).band).toBe('outside_range');
  });
});

describe('a level match goes to the deal closer to even', () => {
  function offer(over: { id: string; gap: number; userGain: number; partnerGain: number }): OfferEvaluation {
    const fairness = fairnessAt(over.gap);
    return {
      id: over.id,
      fairness,
      user: side(over.userGain),
      counterparty: side(over.partnerGain),
      give: [{ playerId: 'g', name: 'G', position: 'RB', value: 10 }],
      get: [{ playerId: 'r', name: 'R', position: 'RB', value: 10 }],
      score: scoreOf({
        user: side(over.userGain),
        fairness,
        counterparty: side(over.partnerGain),
        managerFit: NEUTRAL_FIT,
        size: 2,
      }).total,
    } as unknown as OfferEvaluation;
  }

  it('breaks a level match toward the fairer offer, not the bigger surplus', () => {
    const fairer = offer({ id: 'zzz', gap: 0.02, userGain: 3, partnerGain: 1 });
    const surplus = offer({ id: 'aaa', gap: 0.09, userGain: 3, partnerGain: 1 });

    expect(fairer.fairness.band).toBe(surplus.fairness.band);
    expect(fairer.score).toBe(surplus.score);
    expect([surplus, fairer].sort(compareOffers)[0]!.id).toBe('zzz');
  });

  it('still prefers the deal they are likelier to take when the price is level', () => {
    const theirsBetter = offer({ id: 'zzz', gap: 0.05, userGain: 3, partnerGain: 3 });
    const theirsWorse = offer({ id: 'aaa', gap: 0.05, userGain: 3, partnerGain: 1 });

    expect([theirsWorse, theirsBetter].sort(compareOffers)[0]!.id).toBe('zzz');
  });

  it('leaves the user’s own lineup gain ahead of the balance', () => {
    const bigGain = offer({ id: 'zzz', gap: 0.09, userGain: 5, partnerGain: 1 });
    const even = offer({ id: 'aaa', gap: 0, userGain: 3, partnerGain: 1 });

    expect([even, bigGain].sort(compareOffers)[0]!.id).toBe('zzz');
  });
});

describe('the weights are still the weights', () => {
  it('leaves the fairness term inside its own share of the composite', () => {
    const best = scoreWith(fairnessAt(0));
    const worst = scoreWith(fairnessAt(-0.18));
    expect(best - worst).toBeLessThanOrEqual(RANK_WEIGHTS.fairness + 1e-9);
    expect(best - worst).toBeLessThan(MANAGER_FIT_CAP);
  });
});
