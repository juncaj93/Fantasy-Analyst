/**
 * What passing on a player costs, and the two halves of the answer.
 *
 * These are behaviour tests rather than weight tests: they ask whether a thin
 * position beats a deep one at the same market value, whether the replacement
 * gap is measured against the player who will actually still be there, and —
 * most importantly — whether the two halves and the separation component that
 * predates them can all be paid for the same distance. The numbers in
 * `opportunity.ts` can be retuned without touching this file.
 */

import { describe, expect, it } from 'vitest';
import { OPPORTUNITY, evaluateOpportunity, expectedBestAvailable } from '../src/core/draft/opportunity.ts';
import { rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

function ctx(overrides: Partial<Parameters<typeof rankAvailablePlayers>[1]> = {}) {
  return {
    currentPick: 25,
    nextPick: 40,
    shape: SHAPE,
    profile: HALF_PPR,
    rosterCounts: { QB: 0, RB: 0, WR: 0, TE: 0 },
    totalPicks: 180,
    ...overrides,
  };
}

function entry(id: string, position: string, adp: number, team = 'FA'): AvailablePlayerInput {
  return {
    player: player({ id, fullName: `${position} ${id}`, position, team }),
    adp,
    adpRank: Math.round(adp),
    signal: null,
  };
}

const byId = <T extends { playerId: string }>(recs: T[], id: string): T => recs.find((r) => r.playerId === id)!;
const contributionOf = (rec: { components: { key: string; contribution: number }[] }, key: string) =>
  rec.components.find((c) => c.key === key)?.contribution ?? 0;

describe('expected best available at the next pick', () => {
  it('is the best alternative when he is certain to last', () => {
    expect(expectedBestAvailable([{ base: 1, survival: 1 }, { base: 0.5, survival: 1 }])).toBe(1);
  });

  it('falls toward the next man when the best one will not last', () => {
    const value = expectedBestAvailable([
      { base: 1, survival: 0 },
      { base: 0.4, survival: 1 },
    ]);
    expect(value).toBe(0.4);
  });

  it('is a probability-weighted blend in between', () => {
    // 1×0.5 + 0.4×0.5 = 0.7.
    expect(expectedBestAvailable([{ base: 1, survival: 0.5 }, { base: 0.4, survival: 1 }])).toBeCloseTo(0.7, 3);
  });

  it('is unknown when nothing at the position can be priced', () => {
    expect(expectedBestAvailable([{ base: 1, survival: null }])).toBeNull();
  });

  it('never reports a replacement better than the best alternative', () => {
    const value = expectedBestAvailable([
      { base: 0.9, survival: 0.3 },
      { base: 0.8, survival: 0.3 },
      { base: 0.2, survival: 0.9 },
    ])!;
    expect(value).toBeLessThanOrEqual(0.9);
    expect(value).toBeGreaterThanOrEqual(0.2);
  });
});

describe('opportunity cost: the count half', () => {
  const thin = evaluateOpportunity({
    base: 1,
    alternatives: [
      { base: 0.9, survival: 0.1 },
      { base: 0.85, survival: 0.1 },
    ],
    separationGap: 0,
    needScore: 0.6,
    nextPick: 40,
  });

  const deep = evaluateOpportunity({
    base: 1,
    alternatives: Array.from({ length: 9 }, () => ({ base: 0.9, survival: 0.8 })),
    separationGap: 0,
    needScore: 0.6,
    nextPick: 40,
  });

  it('scores a thin tier above a deep one', () => {
    expect(thin.opportunityScore).toBeGreaterThan(deep.opportunityScore);
  });

  it('says nothing at all when nine comparable players will still be there', () => {
    expect(deep.opportunityScore).toBe(0);
    expect(deep.driver).toBeNull();
  });

  it('counts only comparable players, not everybody at the position', () => {
    // Twelve alternatives, all far worse than him: the position is deep and the
    // decision is still "him or nobody".
    const isolated = evaluateOpportunity({
      base: 1,
      alternatives: Array.from({ length: 12 }, () => ({ base: 0.2, survival: 1 })),
      separationGap: 0,
      needScore: 0.6,
      nextPick: 40,
    });
    expect(isolated.expectedComparableSurvivors).toBe(0);
    expect(isolated.opportunityScore).toBe(1);
  });

  it('is silent when there is no later pick to wait for', () => {
    const last = evaluateOpportunity({
      base: 1,
      alternatives: [{ base: 0.2, survival: 0.1 }],
      separationGap: 0,
      needScore: 1,
      nextPick: null,
    });
    expect(last.score).toBe(0);
    expect(last.reason).toContain('no later pick');
  });
});

describe('replacement value: the size half', () => {
  it('is positive when the likely replacement is much worse', () => {
    const result = evaluateOpportunity({
      base: 1,
      alternatives: [
        { base: 0.95, survival: 0 },
        { base: 0.1, survival: 1 },
      ],
      separationGap: 0,
      needScore: 0.6,
      nextPick: 40,
    });
    expect(result.replacementValueRaw).toBeCloseTo(0.9, 2);
    expect(result.replacementScore).toBeGreaterThan(0.5);
  });

  it('is small when a comparable player is likely to survive', () => {
    const result = evaluateOpportunity({
      base: 1,
      alternatives: [{ base: 0.95, survival: 1 }],
      separationGap: 0,
      needScore: 0.6,
      nextPick: 40,
    });
    expect(result.replacementValueRaw).toBeCloseTo(0.05, 2);
    expect(result.replacementScore).toBeLessThan(0.1);
  });

  it('nets out the gap separation was already paid for', () => {
    const alternatives = [
      { base: 0.6, survival: 0.2 },
      { base: 0.5, survival: 0.2 },
    ];
    const unpaid = evaluateOpportunity({ base: 1, alternatives, separationGap: 0, needScore: 0.6, nextPick: 40 });
    const paid = evaluateOpportunity({ base: 1, alternatives, separationGap: 0.45, needScore: 0.6, nextPick: 40 });

    expect(unpaid.replacementValueRaw).toBe(paid.replacementValueRaw);
    expect(paid.replacementValueNet).toBeLessThan(unpaid.replacementValueNet!);
    expect(paid.replacementValueNet).toBeCloseTo(unpaid.replacementValueNet! - 0.45, 3);
  });

  it('never goes negative, however much separation has already been paid', () => {
    const result = evaluateOpportunity({
      base: 1,
      alternatives: [{ base: 0.99, survival: 1 }],
      separationGap: 5,
      needScore: 0.6,
      nextPick: 40,
    });
    expect(result.replacementValueNet).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('bounds and roster context', () => {
  it('can never contribute more than its weight', () => {
    const extreme = evaluateOpportunity({
      base: 10,
      alternatives: [{ base: -10, survival: 0.01 }],
      separationGap: 0,
      needScore: 1,
      nextPick: 40,
    });
    expect(extreme.score).toBeLessThanOrEqual(1);
    expect(extreme.score * OPPORTUNITY.weight).toBeLessThanOrEqual(OPPORTUNITY.weight);
  });

  it('is discounted when the roster has no use for the position', () => {
    const alternatives = [{ base: 0.1, survival: 0.1 }];
    const needed = evaluateOpportunity({ base: 1, alternatives, separationGap: 0, needScore: 1, nextPick: 40 });
    const satisfied = evaluateOpportunity({ base: 1, alternatives, separationGap: 0, needScore: 0, nextPick: 40 });
    expect(satisfied.score).toBeLessThan(needed.score);
    expect(satisfied.score).toBeCloseTo(needed.score * OPPORTUNITY.satisfiedDamping, 2);
  });
});

describe('on a real board', () => {
  /**
   * The brief's own example: a receiver rated a shade higher, with nine
   * comparable receivers behind him, against a back with two comparable backs
   * and a cliff underneath. The back should gain ground and must not leapfrog a
   * player the market rates far higher.
   */
  const board = rankAvailablePlayers(
    [
      entry('wr-top', 'WR', 24),
      ...Array.from({ length: 9 }, (_, i) => entry(`wr-${i}`, 'WR', 26 + i)),
      entry('rb-top', 'RB', 25),
      entry('rb-2', 'RB', 27),
      entry('rb-3', 'RB', 28),
      ...Array.from({ length: 6 }, (_, i) => entry(`rb-deep-${i}`, 'RB', 120 + i * 6)),
    ],
    ctx(),
  );

  it('pays the thin position more for the cost of waiting than the deep one', () => {
    const rb = contributionOf(byId(board, 'rb-top'), 'opportunity');
    const wr = contributionOf(byId(board, 'wr-top'), 'opportunity');
    expect(rb).toBeGreaterThan(wr);
  });

  it('keeps the whole effect inside its cap', () => {
    for (const rec of board) {
      expect(contributionOf(rec, 'opportunity')).toBeLessThanOrEqual(OPPORTUNITY.weight + 1e-9);
      expect(contributionOf(rec, 'opportunity')).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not let a thin position beat a clearly better player', () => {
    // A back forty picks past the receiver's ADP is worse by any reading, and
    // the thinness of his position must not rescue him.
    const withGap = rankAvailablePlayers(
      [
        entry('wr-top', 'WR', 24),
        ...Array.from({ length: 9 }, (_, i) => entry(`wr-${i}`, 'WR', 26 + i)),
        entry('rb-late', 'RB', 95),
      ],
      ctx(),
    );
    expect(withGap[0]!.playerId).toBe('wr-top');
  });

  it('reports both halves on the recommendation, for the card and the audit', () => {
    const rb = byId(board, 'rb-top');
    expect(rb.opportunity.expectedReplacement).not.toBeNull();
    expect(rb.opportunity.replacementValueRaw).not.toBeNull();
    expect(['high', 'medium', 'low']).toContain(rb.opportunity.confidence);
  });

  it('is unknown, not zero, on the final pick of the draft', () => {
    const last = rankAvailablePlayers([entry('wr-top', 'WR', 24), entry('wr-2', 'WR', 30)], ctx({ nextPick: null }));
    for (const rec of last) {
      expect(rec.opportunity.score).toBe(0);
      expect(contributionOf(rec, 'opportunity')).toBe(0);
    }
  });
});
