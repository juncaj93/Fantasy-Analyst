/**
 * Which reasoning produced a trade offer, and the word a screen prints for it.
 *
 * A leaf, and it is a leaf for one reason: the Trades screen needs the label
 * and nothing else, and importing it from `bilateral.ts` reaches the whole
 * trade engine — which reaches the lineup optimiser, which reaches the start/sit
 * engine, the injury model, the defence tendencies and the touchdown model. A
 * module reachable from the entry is placed in the entry chunk whatever else
 * also reaches it, so one import of one string table put twenty-two modules
 * into the shell every page load fetches and cost 25KB gzipped.
 *
 * `core/dst/weeks.ts` and `core/sleeper/rosterShape.ts` were split out of
 * larger modules for exactly this, and the perf budget names both of them when
 * it fails. This is the third.
 *
 * Nothing may be added here that imports anything. That is the whole contract.
 */

/**
 * The three kinds of idea the board can produce.
 *
 * `upgrade` is every offer it has ever made: the lineup is short somewhere and
 * this fills it. The other two are value arbitrage — a player and his price
 * have come apart — and they are labelled separately because they are judged by
 * a different test. An upgrade's case is the points it adds this Sunday; a
 * buy-low's case is that those points are close to zero on purpose.
 */
export type OfferCategory = 'upgrade' | 'buy_low' | 'sell_high';

export const CATEGORY_LABELS: Record<OfferCategory, string> = {
  upgrade: 'Lineup upgrade',
  buy_low: 'Buy low',
  sell_high: 'Sell high',
};
