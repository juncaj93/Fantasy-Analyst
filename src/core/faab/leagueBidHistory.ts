/**
 * This league's waiver bid history, reduced to what the bid rule reads
 * (`smartBid.ts`). Written by `scripts/bid-history-report.ts --write` from
 * Sleeper's documented endpoints; re-run it to refresh. No database rows: the
 * screen reads this file.
 *
 * - **p50 / p75**: of the players somebody else also bid on, the bid that would
 *   have beaten every other bid (the next-highest bid plus $1), half the time
 *   and three times in four. Seasons weigh 1, 0.6 and 0.36 from the newest.
 * - **Starter**: the winner started him in two or more weeks after the claim.
 *   Depth: fewer. Claims too recent to tell are left out of both.
 * - **won**: `[dollars, share]`: of those contested players, the share that
 *   many dollars would have won (weighted the same way). The bid rule reads it.
 * - **paidMedian**: what the winners actually paid for those contested players.
 * - **pricePerPoint**: the median dollars a paid pickup ($3 or more) cost per
 *   point he scored in the weeks he started, complete seasons only.
 * - A position with fewer than `minContested` contested claims uses ALL.
 */

export interface PriceRow {
  claims: number;
  contested: number;
  p50: number;
  p75: number;
  paidMedian: number;
  /** `[dollars, share]`, ascending: the share of contested players that many dollars would have won. */
  won: [number, number][];
}

export interface BidHistorySummary {
  generated: string;
  seasons: string[];
  /** Weeks of each season read. */
  weeks: Record<string, number>;
  /** Every waiver claim read, won, lost or voided. */
  claims: number;
  playersWon: number;
  /** Players won where somebody else also bid. */
  contested: number;
  /** Share of players won for $0 or $1. */
  wonAtZeroOrOne: number;
  pricePerPoint: number;
  minContested: number;
  starter: Record<string, PriceRow>;
  depth: Record<string, PriceRow>;
}

export const LEAGUE_BID_HISTORY: BidHistorySummary = {
  generated: '2026-11-11',
  seasons: ["2024","2025","2026"],
  weeks: {'2024': 17,'2025': 17,'2026': 9},
  claims: 622,
  playersWon: 303,
  contested: 94,
  wonAtZeroOrOne: 0.52,
  pricePerPoint: 0.5,
  minContested: 8,
  starter: {
    QB: { claims: 18, contested: 4, p50: 1, p75: 6, paidMedian: 6, won: [[1,0.66],[6,1]] },
    RB: { claims: 13, contested: 9, p50: 7, p75: 11, paidMedian: 16, won: [[1,0.1],[2,0.16],[3,0.27],[7,0.54],[9,0.71],[11,0.77],[12,0.94],[26,1]] },
    WR: { claims: 27, contested: 10, p50: 6, p75: 10, paidMedian: 13.5, won: [[2,0.34],[4,0.49],[6,0.72],[10,0.86],[12,0.91],[19,1]] },
    TE: { claims: 12, contested: 4, p50: 1, p75: 2, paidMedian: 11.5, won: [[1,0.5],[2,0.81],[16,1]] },
    DEF: { claims: 35, contested: 11, p50: 2, p75: 3, paidMedian: 2, won: [[1,0.44],[2,0.59],[3,0.82],[4,0.91],[5,1]] },
    ALL: { claims: 105, contested: 38, p50: 3, p75: 7, paidMedian: 11, won: [[1,0.27],[2,0.44],[3,0.53],[4,0.6],[5,0.62],[6,0.73],[7,0.8],[9,0.84],[10,0.88],[11,0.89],[12,0.95],[16,0.96],[19,0.99],[26,1]] },
  },
  depth: {
    QB: { claims: 14, contested: 5, p50: 1, p75: 1, paidMedian: 2, won: [[1,1]] },
    RB: { claims: 63, contested: 19, p50: 2, p75: 4, paidMedian: 6, won: [[1,0.48],[2,0.6],[3,0.72],[4,0.81],[5,0.84],[6,0.89],[7,0.95],[31,1]] },
    WR: { claims: 56, contested: 16, p50: 3, p75: 6, paidMedian: 8.5, won: [[1,0.32],[2,0.48],[3,0.57],[5,0.73],[6,0.8],[7,0.84],[12,0.89],[13,0.96],[53,1]] },
    TE: { claims: 20, contested: 6, p50: 1, p75: 4, paidMedian: 4, won: [[1,0.5],[4,0.91],[19,1]] },
    DEF: { claims: 40, contested: 8, p50: 2, p75: 3, paidMedian: 1, won: [[1,0.46],[2,0.71],[3,0.89],[4,1]] },
    ALL: { claims: 193, contested: 54, p50: 2, p75: 4, paidMedian: 4, won: [[1,0.48],[2,0.61],[3,0.71],[4,0.81],[5,0.86],[6,0.9],[7,0.93],[12,0.94],[13,0.96],[19,0.97],[31,0.99],[53,1]] },
  },
};
