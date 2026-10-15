/**
 * The betting markets each position is priced on.
 *
 * A leaf of its own (15 October 2026) so the Compare table, which is on the
 * render path, can name a player's lines without pulling the expectation
 * model into the first page load (`perf-budgets.json`, chunk ownership).
 */

import type { MarketKey } from '../vegas/types.ts';

export const EXPECTED_MARKETS: Record<string, MarketKey[]> = {
  QB: ['pass_yards', 'pass_tds', 'rush_yards'],
  RB: ['rush_yards', 'receiving_yards', 'receptions', 'anytime_td'],
  WR: ['receiving_yards', 'receptions', 'anytime_td'],
  TE: ['receiving_yards', 'receptions', 'anytime_td'],
};
