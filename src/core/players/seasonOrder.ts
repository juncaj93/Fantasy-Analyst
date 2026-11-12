/**
 * The in-season Players list's orders (Round 24 review). No imports beyond
 * types, so the screen can sort without loading an engine.
 */

import type { Willingness } from './seasonWire.ts';

/**
 * The default order: rest-of-season points over a free agent at his position
 * (Trades' value), then points a week, then the name. Nulls last.
 */
export function byOverFreeAgent<T extends { overFreeAgent: number | null; value: number | null; name: string }>(a: T, b: T): number {
  return (b.overFreeAgent ?? -1) - (a.overFreeAgent ?? -1) || (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name);
}

/** Trade targets in the order Alex wants them: Likely, then Maybe, then Unlikely. */
export const WILLINGNESS_ORDER: Record<Willingness, number> = { Likely: 0, Maybe: 1, Unlikely: 2 };

/** Likely first, then Maybe, then Unlikely; players without a trade read last. */
export function byWillingness<T extends { trade: { willingness: Willingness } | null }>(a: T, b: T): number {
  const rank = (r: T) => (r.trade ? WILLINGNESS_ORDER[r.trade.willingness] : 9);
  return rank(a) - rank(b);
}
