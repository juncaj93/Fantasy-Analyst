/**
 * Who a free agent is compared with when Compare opens from his row (Round 33).
 *
 * The roster player he would most likely replace: the weakest starter at his
 * position, or, with no starter there, the best of the bench at it. Everybody
 * else at the position is offered as a one-tap swap, best first. Players who
 * cannot play (Out, Doubtful, IR) are neither picked nor offered.
 *
 * Read off the Compare list's own My team rows, so the number that chooses him
 * is the one the sheet prints.
 */

export interface PairCandidate {
  id: string;
  name: string;
  starter: boolean | null;
  ruledOut: boolean;
  week: { points: number | null };
}

/** How many swaps fit beside the strip on a 360px phone. */
export const PAIR_SWAPS = 3;

export function pairFor<T extends PairCandidate>(mine: readonly T[]): { pick: T | null; swaps: T[] } {
  const playable = mine.filter((r) => !r.ruledOut);
  const points = (r: T) => r.week.points ?? -Infinity;
  const best = [...playable].sort((a, b) => points(b) - points(a));
  const starters = best.filter((r) => r.starter === true);
  const pick = starters.length > 0 ? starters[starters.length - 1]! : (best[0] ?? null);
  return { pick, swaps: best.filter((r) => r !== pick).slice(0, PAIR_SWAPS) };
}

/** The swaps on offer now: everybody playable at the position not already compared, best first. */
export function swapOptions<T extends PairCandidate>(mine: readonly T[], chosen: readonly string[]): T[] {
  const points = (r: T) => r.week.points ?? -Infinity;
  return mine
    .filter((r) => !r.ruledOut && !chosen.includes(r.id))
    .sort((a, b) => points(b) - points(a))
    .slice(0, PAIR_SWAPS);
}
