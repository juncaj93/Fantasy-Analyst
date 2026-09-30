/**
 * Bench adds are priced, and the price is a band from this league's own bids.
 *
 * On 30 September 2026 every Waivers card showed a blank `Est. cost`: the
 * pricing pass priced starter upgrades only, and every card that week was a
 * bench add. The league had 17 paid winning bids in weeks 1–3; these are they.
 */

import { describe, expect, it } from 'vitest';
import { expectedMarketPrice } from '../src/core/faab/strategy.ts';
import { summarisePrices, type BidHistory } from '../src/core/faab/bids.ts';
import { buildBudgetState } from '../src/core/faab/budget.ts';
import { priceWaiverUpgrades } from '../src/core/waivers/pricing.ts';
import type { WaiverValueAdd } from '../src/core/startsit/waivers.ts';

const TONYS_2026 = [1, 2, 10, 1, 15, 4, 1, 1, 8, 11, 5, 6, 11, 1, 2, 16, 1];

function history(amounts: number[]): BidHistory {
  const won = amounts.map((amount, i) => ({
    transactionId: `t${i}`,
    week: 1,
    rosterId: 2,
    playerId: `p${i}`,
    amount,
    outcome: 'won' as const,
  }));
  return { observations: won, won, lost: [], losingBidsComplete: false, weeksRead: [1, 2, 3] };
}

describe('the price band', () => {
  const prices = summarisePrices(history(TONYS_2026));

  it('is drawn from where the player sits in the league\'s own bids, not the whole spread', () => {
    expect(prices.sample).toBe(17);
    expect([prices.low, prices.high]).toEqual([1, 10]);
    const quiet = expectedMarketPrice(prices, { total: 100 }, 0.2);
    const contested = expectedMarketPrice(prices, { total: 100 }, 0.7);
    expect(quiet).toEqual({ low: 1, high: 4, basis: 'league_history' });
    expect(contested).toEqual({ low: 2, high: 10, basis: 'league_history' });
  });

  it('keeps the old quartile band for a summary with no amounts', () => {
    const { amounts: _amounts, ...old } = prices;
    expect(expectedMarketPrice(old, { total: 100 }, 0.5).basis).toBe('league_history');
  });
});

describe('bench adds', () => {
  it('get a bid, from the same pass as starter upgrades', () => {
    const budget = buildBudgetState({
      leagueSettings: { waiver_type: 2, waiver_budget: 100 },
      rosters: [
        { rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 22 } },
        { rosterId: 2, ownerName: 'Rival', isMine: false, settings: { waiver_budget_used: 40 } },
      ],
    });
    const add: WaiverValueAdd = {
      playerId: 'keenan',
      name: 'Keenan Allen',
      position: 'WR',
      team: 'IND',
      score: 5,
      gain: 4.5,
      reasons: [],
      statusFlag: null,
      role: { trend: 'stable', games: 4 },
      overPlayerId: 'jw',
      overName: 'Jaylen Wright',
      priority: 5,
      basis: {
        comparedTo: 'bench',
        bar: 1,
        projection: 6.98,
        overProjection: 3.47,
        projectionGap: 3.51,
        depth: { position: 'WR', held: 4, cap: null },
        attention: null,
        lean: 0,
      },
    };
    const bids = priceWaiverUpgrades({
      advice: { upgrades: [], valueAdds: [add] },
      strategy: {
        week: 4,
        finalWeek: 14,
        budget,
        prices: summarisePrices(history(TONYS_2026)),
        trending: new Map(),
      },
      rosteredIds: new Set(),
    });
    expect(bids).toHaveLength(1);
    expect(bids[0]!.playerId).toBe('keenan');
    expect(bids[0]!.expected).not.toBeNull();
    expect(bids[0]!.recommended).toBeGreaterThan(0);
    expect(bids[0]!.recommended!).toBeLessThanOrEqual(78);
  });
});
