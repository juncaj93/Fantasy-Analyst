/**
 * What a market is called, and nothing about what it is worth.
 *
 * Split out of `season.ts`, and the reason is measured rather than aesthetic —
 * the same reason `core/sleeper/rosterShape.ts` and `core/dst/weeks.ts` exist.
 * The Draft screen names the components behind a summed market number, so it
 * needs the vocabulary. It has no use for the arithmetic that produced the sum.
 * But a module reachable from the entry belongs to the entry, so `season.ts`
 * sat in the render path for this one function, and took `types.ts` with it for
 * `SEASON_MARKET_KEYS`. 1.7kB gzipped on every page load, to print the words
 * "receiving yards" under a card.
 *
 * Worth being exact about what that 1.7kB was, because it is smaller than the
 * file it came from: rollup had already shaken the identity ladder out, since
 * `seasonMarketLabel` does not reach `resolvePlayer`. What shipped was whatever
 * of `season.ts` tree-shaking could not prove unused, plus `types.ts` behind
 * it. The whole of `core/identity` was never in there, and a comment claiming
 * it was would be the kind of number nobody re-measures.
 *
 * So the words the screen reads are separate from the model the engines read.
 * This module's only import is a type, which erases — that is the property that
 * matters, and the reason the label rather than the caller had to move. It also
 * takes `types.ts` off the render path, which a value import would not have.
 *
 * The table is exported because `season.ts` writes its own coverage notes from
 * it and there is no version of this worth having two of: one spelling of
 * "receiving yards" in this repository, in one place, read by both.
 */

import type { SeasonMarketKey } from './types.ts';

/**
 * One market's name in words, shared by everything that prints one.
 *
 * Exported so a screen naming the components behind a summed number uses the
 * same vocabulary the baseline's own note does. Two spellings of "receiving
 * yards" in one card is how a reader starts wondering whether they are two
 * different things.
 */
export function seasonMarketLabel(market: string): string {
  return MARKET_LABEL[market as SeasonMarketKey] ?? market;
}

export const MARKET_LABEL: Record<SeasonMarketKey, string> = {
  season_pass_yards: 'passing yards',
  season_pass_tds: 'passing TDs',
  season_rush_yards: 'rushing yards',
  season_rush_tds: 'rushing TDs',
  season_receptions: 'receptions',
  season_receiving_yards: 'receiving yards',
  season_receiving_tds: 'receiving TDs',
};
