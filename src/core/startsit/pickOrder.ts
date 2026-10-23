/**
 * The order Compare picks from, on the shared ranking rule (23 October 2026).
 *
 * Every player ranks on `rankingNumber`: his decision number, two points lower
 * when it is Sleeper's week rather than a full set of Vegas lines. The same
 * rule as Team's lineup, Best move and Matchup (Alex's decision), so a
 * Sleeper-only player can be the pick when his number minus 2 is higher.
 *
 * It replaced "complete first" (16 October 2026), under which only a fully
 * priced player could be the pick. One thing from it stays: when a
 * Sleeper-only player shows the higher number and still loses on the two
 * points, he is named as the second choice so the card does not look wrong.
 */

import { rankingNumber } from './decisionPoints.ts';

export interface PickCandidate {
  playerId: string;
  name: string;
  ruledOut?: boolean | null;
  decision?: { points: number; basis: string } | null;
}

export interface SleeperOnlyNote {
  playerId: string;
  name: string;
  /** How far his Sleeper number is above the pick's, to the hundredth. */
  aheadBy: number;
}

const borrowed = (e: PickCandidate): boolean => e.decision?.basis === 'published';
const key = (e: PickCandidate): number => rankingNumber(e.decision?.points ?? 0, borrowed(e));

/**
 * Reorder an already-ranked list (best first, by the shown number) on the
 * ranking rule, keeping the given order among equals, and name the
 * Sleeper-only player the two points kept off the pick, if any.
 */
export function pickOrder<T extends PickCandidate>(ranked: readonly T[]): { order: T[]; sleeperOnly: SleeperOnlyNote | null } {
  const order = ranked
    .map((e, i) => ({ e, i }))
    .sort((a, b) => key(b.e) - key(a.e) || a.i - b.i)
    .map((x) => x.e);
  const pick = order[0];
  if (!pick || borrowed(pick)) return { order, sleeperOnly: null };
  const pickPoints = pick.decision?.points ?? 0;
  const ahead = order.find((e) => e !== pick && e.ruledOut !== true && borrowed(e) && (e.decision?.points ?? 0) > pickPoints);
  return {
    order,
    sleeperOnly: ahead
      ? { playerId: ahead.playerId, name: ahead.name, aheadBy: Math.round(((ahead.decision?.points ?? 0) - pickPoints) * 100) / 100 }
      : null,
  };
}
