/**
 * Who the market says to hold, and which condition qualified each of them.
 *
 * One protection with two conditions. A claim cuts one of these players only
 * when nobody else on the roster can go (see `cutFor` in `yardstick.ts`):
 *
 *  - **Draft capital.** The room drafted him inside the league's starter pool
 *    and the season is young enough for that to still be the better evidence.
 *    On 16 September 2026 two well-drafted players were offered as cuts after
 *    one bad afternoon; this is what stops that.
 *  - **Trending.** He is near the top of Sleeper's adds list this week, so a
 *    rival claims him the moment he clears waivers. On 25 September 2026 the
 *    plan said `Drop Emanuel Wilson` while he was the #1 add in all of Sleeper.
 *
 * Attention is not quality, and neither condition says what he is worth. They
 * say that cutting him now is the kind of mistake that cannot be taken back.
 */

/**
 * How early a player had to be drafted before a September waiver run may not cut him.
 *
 * The top eight rounds of a ten-team league — the players a room spent real
 * draft capital on. The caller passes the league's own starter pool (teams ×
 * starting slots) where it knows it; this is the fallback.
 */
export const EARLY_PICK_RANK = 80;

/**
 * The week the draft stops being the best thing known about a player.
 *
 * Six: by then a sixth of a season of real production says more than an
 * August ranking does, and a player who is genuinely finished should be
 * cuttable.
 */
export const EARLY_PICK_WEEKS = 6;

export type MarketHoldCondition = 'draft_capital' | 'trending';

export function marketHoldFor(input: {
  /** Where this room's draft took each player. Smaller is earlier. */
  draftRankOf?: ReadonlyMap<string, number>;
  /** The ADP inside which a player counts as draft capital. Defaults to {@link EARLY_PICK_RANK}. */
  draftCapitalRank?: number;
  /** Rostered players near the top of Sleeper's adds list, by rank. */
  roomIsAdding?: ReadonlyMap<string, number>;
  /** 1-based. */
  week?: number;
}): Map<string, { condition: MarketHoldCondition; rank: number }> {
  const marketHold = new Map<string, { condition: MarketHoldCondition; rank: number }>();
  const capital = input.draftCapitalRank ?? EARLY_PICK_RANK;
  if (input.draftRankOf && (input.week ?? 1) <= EARLY_PICK_WEEKS) {
    for (const [playerId, rank] of input.draftRankOf) {
      if (Number.isFinite(rank) && rank <= capital) marketHold.set(playerId, { condition: 'draft_capital', rank });
    }
  }
  for (const [playerId, rank] of input.roomIsAdding ?? []) {
    if (!marketHold.has(playerId)) marketHold.set(playerId, { condition: 'trending', rank });
  }
  return marketHold;
}
