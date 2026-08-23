/**
 * The one line of ranking context the expanded card keeps.
 *
 * `WR board thinning · 5 left in this tier · 4 teams ahead still need WR`
 *
 * It replaces a section of bullets, a second section of counterpoints and a
 * disclosure full of component arithmetic — all of which explained a ranking the
 * user can already see, at the cost of most of a phone screen. What survives is
 * the part that is a fact about the draft rather than about the model: where
 * this position breaks, how many are left before it does, and whether the teams
 * picking before you still want one.
 *
 * Market-derived and demand-derived only. Roster need, My Guy, the news tally,
 * AVOID and Vegas all move the ranking elsewhere and none of them may appear
 * here — this line describes the board, not the recommendation.
 */

import type { PositionDemand } from './demandAhead.ts';
import type { TierCliff } from './tiers.ts';

/**
 * Below this many left, the group is about to be gone rather than shrinking.
 *
 * The same number the collapsed board uses for its `Tier · N left` chip, shared
 * so the row and the card it opens can never disagree about whether a position
 * is cliffing.
 */
export const CLIFF_IS_NEAR = 2;

/**
 * How big a group can be before "thinning" stops being true, when there is no
 * demand scan to measure it against.
 *
 * Only a fallback. The real test is below and is measured.
 */
const QUIET_ABOVE = 4;

/**
 * The line, or `null` when there is nothing worth a line.
 *
 * Shown for the player's whole tier, not only for whoever happens to sit at its
 * edge — "five left in this group" is the same useful fact to all five of them,
 * and showing it only to the last one would answer the question for the player
 * it no longer helps.
 *
 * Silence is still the answer for the last tier at a position. Nothing follows
 * it, so there is no drop to be ahead of, and "twenty-two left" is not context
 * for anything.
 */
export function tierContextLine(
  position: string,
  tier: TierCliff,
  demand: PositionDemand | null,
): string | null {
  if (!tier.tierEndsAtCliff) return null;
  const left = tier.tierSize > 0 ? tier.tierSize : tier.remainingInTier;
  if (left <= 0) return null;
  if (!worthSaying(left, demand)) return null;

  /*
   * Two words for two situations, and the difference is how close the drop is.
   * Every tier here ends at a cliff by construction, so calling all of them a
   * cliff would make the word meaningless — it is reserved for the point where
   * the group is nearly gone.
   */
  const state = left <= CLIFF_IS_NEAR ? `${position} tier cliff` : `${position} board thinning`;
  const parts = [state, left === 1 ? '1 left' : `${left} left in this tier`];

  const pressure = demandPhrase(position, demand);
  if (pressure) parts.push(pressure);

  return parts.join(' · ');
}

/**
 * Is this group small enough that running out is a real prospect?
 *
 * Every tier but the last ends at a cliff by construction, so "ends at a cliff"
 * on its own would put a line on four cards in five — and "WR board thinning ·
 * 12 left in this tier" is not a warning, it is a large comfortable group with
 * an alarming word in front of it. Production said so plainly: 158 of 195.
 *
 * The measured test is whether the teams picking before your next turn could
 * plausibly take the whole group. Twelve receivers with eleven teams ahead is
 * not thinning; five with eleven ahead is. A cliff is always worth saying
 * whatever the arithmetic, and with no scan to measure against — your last pick
 * of the draft, or a slot Sleeper has not published — a small fixed number
 * stands in.
 */
function worthSaying(left: number, demand: PositionDemand | null): boolean {
  if (left <= CLIFF_IS_NEAR) return true;
  if (!demand || demand.teamsAhead === 0) return left <= QUIET_ABOVE;
  return left <= demand.teamsAhead;
}

/**
 * How the teams ahead are fixed, in four words — when that is worth saying.
 *
 * Two ways it is not. The obvious one is the ordinary middle of the
 * distribution: "two of four still need one" is neither reassuring nor
 * alarming, so it is left off rather than padded onto the line.
 *
 * The less obvious one, and the one that made this clause useless on a real
 * board: early in a draft nobody has covered anything, so *every* position
 * comes back "all eleven teams ahead need one". That is true, and it
 * distinguishes nothing — the clause only carries information once the teams
 * ahead have made enough picks to have covered the slot if they wanted to.
 */
function demandPhrase(position: string, demand: PositionDemand | null): string | null {
  if (!demand || demand.teamsAhead === 0) return null;
  const { teamsAhead, needing, couldHaveCovered } = demand;

  // Everybody is set: the useful end of the scale, and always worth saying.
  if (needing === 0) return `teams ahead already have ${position}`;
  /*
   * Most of the teams ahead have to have had the chance before "they still
   * need one" is about demand rather than about the clock. Two teams having
   * passed on a quarterback in round one does not make the other nine short of
   * one — they have not picked at all.
   */
  if (couldHaveCovered * 2 < teamsAhead) return null;

  const share = needing / teamsAhead;
  if (share >= 0.6) {
    return needing === teamsAhead && teamsAhead > 1
      ? `all ${teamsAhead} teams ahead need ${position}`
      : `${needing} teams ahead still need ${position}`;
  }
  if (share <= 0.34) return `few teams ahead need ${position}`;
  return null;
}
