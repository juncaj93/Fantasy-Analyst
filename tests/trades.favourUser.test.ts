/**
 * Fair, but favouring the user where it still is.
 *
 * The engine already refused lopsided trades and already refused trades the
 * partner would decline. What it did not do was *prefer* the deal that captured
 * surplus: `even` and `edge_user` scored identically, so between a dead-even
 * package and one worth a little more to the user the composite was indifferent
 * and the ordering fell through to an alphabetical tiebreak on the offer id.
 *
 * These tests pin the preference and, more importantly, pin its limits — the
 * bands it may not cross and the amount it may not outweigh.
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

describe('the composite prefers an edge to the user over a dead-even deal', () => {
  it('ranks a slight edge above even, and even above paying over the odds', () => {
    const edgeUser = fairnessAt(0.18);
    const even = fairnessAt(0);
    const edgeOpponent = fairnessAt(-0.18);

    expect(edgeUser.band).toBe('edge_user');
    expect(even.band).toBe('even');
    expect(edgeOpponent.band).toBe('edge_opponent');

    expect(scoreWith(edgeUser)).toBeGreaterThan(scoreWith(even));
    expect(scoreWith(even)).toBeGreaterThan(scoreWith(edgeOpponent));
  });

  /*
   * The bound that keeps this a tiebreak. If seeking an edge could outweigh a
   * manager's whole measured history, it would be an objective rather than a
   * preference — and §12's cap would stop meaning anything.
   */
  it('is worth less than the manager-history cap', () => {
    const advantage = scoreWith(fairnessAt(0.18)) - scoreWith(fairnessAt(0));
    expect(advantage).toBeGreaterThan(0);
    expect(advantage).toBeLessThan(MANAGER_FIT_CAP);
  });

  /*
   * And less than a point of lineup gain, which is the thing the board is
   * actually for. An even deal that helps the user more must still win.
   */
  it('never outranks a materially better deal for the user', () => {
    const evenButBetter = scoreWith(fairnessAt(0), 4);
    const edgeButWorse = scoreWith(fairnessAt(0.18), 2);
    expect(evenButBetter).toBeGreaterThan(edgeButWorse);
  });

  it('cannot reach past the fairness band that is still fair', () => {
    // Anything past `edge` is rejected at gate 1 and never scored at all.
    expect(fairnessAt(FAIRNESS_BANDS.edge + 0.05).band).toBe('outside_range');
  });
});

describe('the tiebreak spends a level match on the user', () => {
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

  /*
   * Two offers identical on score and on the user's lineup gain. Before the
   * value gap was a tiebreak these ordered by `id.localeCompare`, so which of
   * them a reader saw first was decided by a player id.
   */
  it('breaks a level match toward the offer worth more to the user', () => {
    const generous = offer({ id: 'zzz', gap: 0.02, userGain: 3, partnerGain: 1 });
    const surplus = offer({ id: 'aaa', gap: 0.09, userGain: 3, partnerGain: 1 });

    // Same band, so the composite cannot separate them; the tiebreak must.
    expect(generous.fairness.band).toBe(surplus.fairness.band);
    expect(generous.score).toBe(surplus.score);
    expect([generous, surplus].sort(compareOffers)[0]!.id).toBe('aaa');
  });

  it('still prefers the deal they are likelier to take when the price is level', () => {
    const theirsBetter = offer({ id: 'zzz', gap: 0.05, userGain: 3, partnerGain: 3 });
    const theirsWorse = offer({ id: 'aaa', gap: 0.05, userGain: 3, partnerGain: 1 });

    expect([theirsWorse, theirsBetter].sort(compareOffers)[0]!.id).toBe('zzz');
  });

  it('leaves the user’s own lineup gain ahead of the surplus', () => {
    const bigGain = offer({ id: 'zzz', gap: 0, userGain: 5, partnerGain: 1 });
    const bigEdge = offer({ id: 'aaa', gap: 0.09, userGain: 3, partnerGain: 1 });

    expect([bigEdge, bigGain].sort(compareOffers)[0]!.id).toBe('zzz');
  });
});

describe('the weights are still the weights', () => {
  it('leaves the fairness term inside its own share of the composite', () => {
    const best = scoreWith(fairnessAt(0.18));
    const worst = scoreWith(fairnessAt(-0.18));
    expect(best - worst).toBeLessThanOrEqual(RANK_WEIGHTS.fairness + 1e-9);
  });
});
