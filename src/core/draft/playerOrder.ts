/**
 * Ordering for the Players list: Sleeper's draft rank, nudged by the tally.
 *
 * Sleeper says roughly where a player goes. The tally says what the newsletters
 * have been saying about them since. Neither alone is the answer — so the rank
 * moves by half a pick per point of tally, which is enough to lift a riser past
 * a neighbour without letting a run of good press leapfrog a genuinely better
 * player.
 *
 *     adjusted = draftRank - (TALLY_WEIGHT x net)
 *
 * A positive tally moves a player *up* (a smaller number is earlier).
 *
 * Unranked stays unranked: a player Sleeper does not rank has no position to
 * adjust, so they sort after everyone who does rather than being treated as
 * pick zero.
 */

/** Picks of movement per point of tally. */
export const TALLY_WEIGHT = 0.5;

export interface RankablePlayer {
  id: string;
  draftRank?: number | null;
  /** Net tally: positive is good news, negative is bad. */
  net: number;
  /** Tie-break for players with identical adjusted ranks. */
  name: string;
}

export interface RankedPlayer<T extends RankablePlayer> {
  player: T;
  draftRank: number | null;
  /** Null when the player is unranked — never a fabricated position. */
  adjustedRank: number | null;
  /** How many picks the tally moved them. Positive means earlier. */
  movement: number;
}

export function adjustedRank(draftRank: number | null | undefined, net: number): number | null {
  if (draftRank == null || !Number.isFinite(draftRank)) return null;
  // Never past the first pick: a huge tally should not invent a rank of -3.
  return Math.max(0.5, draftRank - TALLY_WEIGHT * net);
}

/**
 * Order players best-first.
 *
 * Ranked players come first by adjusted rank; unranked players follow, ordered
 * by tally so the list still says something useful about them.
 */
export function orderPlayers<T extends RankablePlayer>(players: T[]): RankedPlayer<T>[] {
  const ranked = players.map((player) => {
    const base = player.draftRank ?? null;
    const adjusted = adjustedRank(base, player.net);
    return {
      player,
      draftRank: base,
      adjustedRank: adjusted,
      movement: base == null || adjusted == null ? 0 : round1(base - adjusted),
    };
  });

  return ranked.sort((a, b) => {
    if (a.adjustedRank == null && b.adjustedRank == null) {
      return b.player.net - a.player.net || a.player.name.localeCompare(b.player.name);
    }
    if (a.adjustedRank == null) return 1;
    if (b.adjustedRank == null) return -1;
    return a.adjustedRank - b.adjustedRank || a.player.name.localeCompare(b.player.name);
  });
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
