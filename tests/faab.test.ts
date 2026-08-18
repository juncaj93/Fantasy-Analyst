/**
 * The pins the brief asks for, in the order it asks for them.
 *
 * Three of these are behavioural invariants rather than examples — market price
 * is not the recommended bid, budget is conserved, and no history degrades
 * gracefully — so each is written as a property that a plausible refactor would
 * actually break, not as a snapshot of today's arithmetic.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBudgetState,
  readBudgetRule,
  readSpend,
  spendFromTransactions,
  standingAfterSpend,
} from '../src/core/faab/budget.ts';
import { collectBids, losingBidNote, summarisePrices } from '../src/core/faab/bids.ts';
import {
  demandLevel,
  expectedMarketPrice,
  recommendBid,
  simulateOpportunityCost,
  spendableNow,
  worthShare,
  type BidInputs,
} from '../src/core/faab/strategy.ts';
import type { SleeperTransaction } from '../src/core/sleeper/types.ts';

const SEASON = { week: 5, finalWeek: 14 };

function inputs(over: Partial<BidInputs> = {}): BidInputs {
  return {
    playerId: 'p1',
    name: 'Test Back',
    position: 'RB',
    weeklyGain: 4,
    gainOverReplacement: 3,
    roleStability: 'stable',
    shelfLife: 'season',
    futureOpportunity: 'normal',
    marketHeat: 0.5,
    rivalsWithNeed: 3,
    ...over,
  };
}

function budgetState(over: { total?: number | null; mine?: number; others?: number[] } = {}) {
  const total = over.total === undefined ? 100 : over.total;
  const others = over.others ?? [80, 70, 60, 50, 40, 30, 20, 10, 5];
  return buildBudgetState({
    leagueSettings: total == null ? { waiver_type: 2 } : { waiver_type: 2, waiver_budget: total },
    rosters: [
      { rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: total ? total - (over.mine ?? 65) : 0 } },
      ...others.map((remaining, i) => ({
        rosterId: i + 2,
        ownerName: `M${i + 2}`,
        isMine: false,
        settings: { waiver_budget_used: (total ?? 100) - remaining },
      })),
    ],
  });
}

function waiver(over: Partial<SleeperTransaction> = {}): SleeperTransaction {
  return {
    transaction_id: 't1',
    type: 'waiver',
    status: 'complete',
    leg: 3,
    roster_ids: [2],
    adds: { '999': 2 },
    settings: { waiver_bid: 12 },
    ...over,
  };
}

describe('budget truth (§3)', () => {
  it('reads the league budget from settings rather than assuming $100', () => {
    expect(readBudgetRule({ waiver_type: 2, waiver_budget: 250 }).total).toBe(250);
    expect(readBudgetRule({ waiver_type: 2, waiver_budget: 50 }).total).toBe(50);
  });

  it('refuses to guess a budget the league does not publish', () => {
    const rule = readBudgetRule({ waiver_type: 2 });
    expect(rule.total).toBeNull();
    expect(rule.usesFaab).toBe(true);
    expect(rule.provenance).toContain('no budget');
  });

  it('knows a priority league is not a FAAB league', () => {
    const rule = readBudgetRule({ waiver_type: 0, waiver_budget: 100 });
    expect(rule.usesFaab).toBe(false);
    expect(rule.total).toBeNull();
  });

  it('treats a missing waiver_budget_used as unknown, never as unspent', () => {
    expect(readSpend({ settings: {} } as never)).toBeNull();
    expect(readSpend({ settings: { waiver_budget_used: 0 } } as never)).toBe(0);
    const state = buildBudgetState({
      leagueSettings: { waiver_type: 2, waiver_budget: 100 },
      rosters: [{ rosterId: 1, ownerName: 'Me', isMine: true, settings: null }],
    });
    expect(state.rosters[0]?.remaining).toBeNull();
    expect(state.notes.join(' ')).toContain('unknown');
  });

  it('uses Sleeper’s counter and only reports a disagreement', () => {
    const txns = [waiver({ roster_ids: [1], settings: { waiver_bid: 90 } })];
    const state = buildBudgetState({
      leagueSettings: { waiver_type: 2, waiver_budget: 100 },
      rosters: [{ rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 20 } }],
      transactions: txns,
    });
    expect(state.rosters[0]?.remaining).toBe(80);
    expect(state.notes.join(' ')).toContain('Sleeper’s figure is used');
  });

  it('counts only completed claims toward reconstructed spend', () => {
    const txns = [waiver({ settings: { waiver_bid: 10 } }), waiver({ transaction_id: 't2', status: 'failed', settings: { waiver_bid: 40 } })];
    expect(spendFromTransactions(txns, 2)).toBe(10);
  });
});

describe('bid research (§4)', () => {
  it('separates winning bids from losing bids', () => {
    const history = collectBids(
      [
        waiver({ transaction_id: 'w1', settings: { waiver_bid: 20 } }),
        waiver({ transaction_id: 'l1', status: 'failed', settings: { waiver_bid: 15 } }),
      ],
      [3],
    );
    expect(history.won.map((o) => o.amount)).toEqual([20]);
    expect(history.lost.map((o) => o.amount)).toEqual([15]);
  });

  it('says unknown when no losing bid can be reconstructed', () => {
    const history = collectBids([waiver({ settings: { waiver_bid: 20 } })], [3]);
    const summary = summarisePrices(history);
    expect(summary.highestLosing).toBeNull();
    expect(losingBidNote(summary)).toContain('unknown');
  });

  it('never claims the losing side is complete once any bid was seen', () => {
    const history = collectBids([waiver({ status: 'failed', settings: { waiver_bid: 8 } })], [3]);
    expect(history.losingBidsComplete).toBe(false);
    expect(losingBidNote(summarisePrices(history))).toContain('not all published');
  });

  it('ignores a pending claim rather than guessing its outcome', () => {
    const history = collectBids([waiver({ status: 'pending', settings: { waiver_bid: 30 } })], [3]);
    expect(history.observations).toHaveLength(0);
  });

  it('summarises winning prices by percentile, not by mean', () => {
    const txns = [1, 2, 3, 4, 71].map((amount, i) =>
      waiver({ transaction_id: `w${i}`, settings: { waiver_bid: amount } }),
    );
    const summary = summarisePrices(collectBids(txns, [3]));
    expect(summary.median).toBe(3);
    // A mean would be 16 — a price nobody in this league has ever paid.
    expect(summary.high).toBeLessThan(16);
    expect(summary.max).toBe(71);
  });
});

describe('bid strategy (§1)', () => {
  it('market price is not the recommended bid', () => {
    /*
     * The pin the brief names first. A player the room wants badly and this
     * roster barely needs must produce a recommendation below the market band.
     */
    const prices = summarisePrices(
      collectBids(
        [30, 35, 40, 45].map((amount, i) => waiver({ transaction_id: `w${i}`, settings: { waiver_bid: amount } })),
        [3],
      ),
    );
    const rec = recommendBid({
      inputs: inputs({ weeklyGain: 1, gainOverReplacement: 0.4, marketHeat: 0.95, rivalsWithNeed: 9 }),
      budgetState: budgetState(),
      prices,
      season: SEASON,
    });
    expect(rec.expected).not.toBeNull();
    expect(rec.recommended).toBeLessThan(rec.expected!.low);
    expect(rec.headline).toContain('Expected $');
    expect(rec.headline).toContain('Recommended max $');
    expect(rec.reasons.join(' ')).toContain('Losing him at that price is fine');
  });

  it('orders recommended ≤ do-not-exceed and never exceeds the money left', () => {
    for (const gain of [0.5, 2, 4, 6, 12]) {
      for (const mine of [1, 8, 65, 100]) {
        const rec = recommendBid({
          inputs: inputs({ weeklyGain: gain }),
          budgetState: budgetState({ mine }),
          prices: summarisePrices(collectBids([], [])),
          season: SEASON,
        });
        expect(rec.recommended!).toBeLessThanOrEqual(rec.doNotExceed!);
        expect(rec.doNotExceed!).toBeLessThanOrEqual(mine);
      }
    }
  });

  it('conserves budget: a bid can never be recommended above what remains', () => {
    const rec = recommendBid({
      inputs: inputs({ weeklyGain: 20, shelfLife: 'season' }),
      budgetState: budgetState({ mine: 7 }),
      prices: summarisePrices(collectBids([], [])),
      season: SEASON,
    });
    expect(rec.recommended).toBeLessThanOrEqual(7);
    expect(rec.doNotExceed).toBeLessThanOrEqual(7);
  });

  it('withholds dollar advice when the budget is unknown', () => {
    const rec = recommendBid({
      inputs: inputs(),
      budgetState: budgetState({ total: null }),
      prices: summarisePrices(collectBids([], [])),
      season: SEASON,
    });
    expect(rec.recommended).toBeNull();
    expect(rec.expected).toBeNull();
    expect(rec.withheld).toContain('does not publish');
  });

  it('withholds dollar advice in a waiver-priority league', () => {
    const state = buildBudgetState({
      leagueSettings: { waiver_type: 0 },
      rosters: [{ rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 0 } }],
    });
    const rec = recommendBid({
      inputs: inputs(),
      budgetState: state,
      prices: summarisePrices(collectBids([], [])),
      season: SEASON,
    });
    expect(rec.withheld).toContain('does not bid');
  });

  it('degrades gracefully with no bid history at all', () => {
    const rec = recommendBid({
      inputs: inputs(),
      budgetState: budgetState(),
      prices: summarisePrices(collectBids([], [])),
      season: SEASON,
    });
    expect(rec.expected).not.toBeNull();
    expect(rec.confidence).toBe('low');
    expect(rec.reasons.join(' ')).toContain('estimate rather than an observation');
  });

  it('pays less for a rental than for the same upgrade all season', () => {
    const season = worthShare(inputs({ shelfLife: 'season' }), SEASON).share;
    const rental = worthShare(inputs({ shelfLife: 'one_week' }), SEASON).share;
    expect(rental).toBeLessThan(season);
    expect(rental).toBeGreaterThan(0);
  });

  it('collapses the bid when the same points are free on the wire', () => {
    const exclusive = worthShare(inputs({ weeklyGain: 4, gainOverReplacement: 4 }), SEASON).share;
    const streamable = worthShare(inputs({ weeklyGain: 4, gainOverReplacement: 0.2 }), SEASON).share;
    expect(streamable).toBeLessThan(exclusive * 0.6);
  });

  it('names what the budget is being preserved for, and only when it is', () => {
    /*
     * The brief's own headline. It appears only when the recommendation is
     * genuinely held below the player's value — otherwise nothing is being
     * preserved and the phrase would be decoration.
     */
    // A depleted wallet early in the season is when discipline actually binds:
    // with a full budget, a player worth 45% of it is exactly what to spend on.
    const held = recommendBid({
      inputs: inputs({ weeklyGain: 12, gainOverReplacement: 12, shelfLife: 'season' }),
      budgetState: budgetState({ mine: 40 }),
      prices: summarisePrices(collectBids([], [])),
      season: { week: 1, finalWeek: 14 },
      reserveFor: 'RB depth',
    });
    expect(held.headline).toContain('Preserve budget for RB depth');
    expect(held.recommended!).toBeLessThan(held.worth!);

    const unheld = recommendBid({
      inputs: inputs({ weeklyGain: 0.5 }),
      budgetState: budgetState({ mine: 100 }),
      prices: summarisePrices(collectBids([], [])),
      season: { week: 13, finalWeek: 14 },
      reserveFor: 'RB depth',
    });
    expect(unheld.headline).not.toContain('Preserve budget');
  });

  it('loosens the purse as the season runs out', () => {
    expect(spendableNow(100, { week: 1, finalWeek: 14 })).toBeLessThan(spendableNow(100, { week: 13, finalWeek: 14 }));
    expect(spendableNow(100, { week: 14, finalWeek: 14 })).toBe(100);
  });

  it('reads demand from local money as well as global heat', () => {
    const contested = demandLevel(inputs({ rivalsWithNeed: 9, marketHeat: 0.9 }), budgetState());
    const quiet = demandLevel(inputs({ rivalsWithNeed: 0, marketHeat: 0.05 }), budgetState());
    expect(contested).toBeGreaterThan(quiet);
    expect(demandLevel(inputs({ rivalsWithNeed: null, marketHeat: null }), budgetState())).toBe(0.4);
  });

  it('prices off the league’s own history when there is enough of it', () => {
    const prices = summarisePrices(
      collectBids(
        [10, 12, 14, 16].map((amount, i) => waiver({ transaction_id: `w${i}`, settings: { waiver_bid: amount } })),
        [3],
      ),
    );
    expect(expectedMarketPrice(prices, { total: 100 }, 0.5).basis).toBe('league_history');
    expect(expectedMarketPrice(summarisePrices(collectBids([], [])), { total: 100 }, 0.5).basis).toBe('estimate');
  });
});

describe('opportunity cost (§2)', () => {
  it('reports leverage, not just dollars', () => {
    const sim = simulateOpportunityCost(budgetState({ mine: 65 }), 24);
    expect(sim).not.toBeNull();
    expect(sim!.remainingAfter).toBe(41);
    expect(sim!.line).toContain('Bid $24 → $41 remaining');
    expect(sim!.line).toContain('still above');
  });

  it('names the managers a bid drops you below, while the list is short', () => {
    // Was ahead of M7/M8/M9; $24 puts him behind all three and into the bottom half.
    const sim = simulateOpportunityCost(budgetState({ mine: 30, others: [90, 85, 80, 70, 60, 28, 25, 20, 5] }), 24);
    expect(sim!.line).toContain('falls below');
    expect(sim!.droppedBelow).toEqual(['M7', 'M8', 'M9']);
  });

  it('does not blame the bid for managers you were already behind', () => {
    // Ends up behind four richer managers, but was behind two of them already.
    const sim = simulateOpportunityCost(budgetState({ mine: 65 }), 24);
    expect(sim!.droppedBelow).toEqual(['M4', 'M5']);
    expect(sim!.line).toContain('still above');
  });

  it('returns nothing rather than a fabricated comparison', () => {
    expect(simulateOpportunityCost(budgetState({ total: null }), 10)).toBeNull();
  });

  it('counts only rosters whose budget is actually known', () => {
    const state = buildBudgetState({
      leagueSettings: { waiver_type: 2, waiver_budget: 100 },
      rosters: [
        { rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 50 } },
        { rosterId: 2, ownerName: 'Known', isMine: false, settings: { waiver_budget_used: 90 } },
        { rosterId: 3, ownerName: 'Unknown', isMine: false, settings: null },
      ],
    });
    expect(standingAfterSpend(state, 0)).toEqual({ above: 1, comparable: 1, below: [] });
  });
});
