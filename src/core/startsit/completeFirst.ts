/**
 * Incomplete information can no longer win a comparison (16 October 2026).
 *
 * Alex's rule for Compare: when some of the players have a complete Vegas
 * market (`decisionPoints` basis `market`) and others are ranked on Sleeper's
 * projection or less, only a complete player can be recommended. The best
 * complete player wins; the best Sleeper-only player, when he projects higher,
 * is named as a marked second choice and is never the pick.
 *
 * Nothing changes when every player is complete, or when none is: two
 * Sleeper-only players compared with each other still rank on Sleeper's
 * number. A ruled-out player never counts as complete, so an Out player with a
 * full market cannot beat a healthy one ranked on Sleeper.
 *
 * Compare only. The Team screen's lineup has its own rule (a published figure
 * ranks there with a discount, `lineup.ts`) and does not call this.
 */

export interface CompleteFirstCandidate {
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

/** Complete, healthy information: a full market and able to play. */
export function isComplete(e: CompleteFirstCandidate): boolean {
  return e.decision?.basis === 'market' && e.ruledOut !== true;
}

/**
 * Reorder an already-ranked list (best first) so a complete player leads when
 * there is one, and say which Sleeper-only player, if any, projected higher.
 */
export function completeFirst<T extends CompleteFirstCandidate>(
  ranked: readonly T[],
): { order: T[]; sleeperOnly: SleeperOnlyNote | null } {
  const complete = ranked.filter(isComplete);
  const rest = ranked.filter((e) => !isComplete(e));
  if (complete.length === 0 || rest.length === 0) return { order: [...ranked], sleeperOnly: null };

  const pick = complete[0]!;
  const pickPoints = pick.decision!.points;
  /* The best player shown on Sleeper's week, and only if he is actually ahead. */
  const fallback = rest.find((e) => e.ruledOut !== true && e.decision?.basis === 'published' && e.decision.points > pickPoints);
  return {
    order: [...complete, ...rest],
    sleeperOnly: fallback
      ? { playerId: fallback.playerId, name: fallback.name, aheadBy: Math.round((fallback.decision!.points - pickPoints) * 100) / 100 }
      : null,
  };
}
