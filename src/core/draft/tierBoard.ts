/**
 * Turning the tier ladder into the two things a board can draw.
 *
 * `tiers.ts` owns what a tier *is* — market spacing, gap ratios, where the
 * position genuinely breaks. Nothing here decides any of that. This is the
 * layer above: given the model's answer, where does a line go on a list, and
 * which players are worth marking.
 *
 * It lives here rather than in the screen because both questions are pure
 * arithmetic over the model's output, and arithmetic that decides what the user
 * sees during a live draft should be testable without a browser.
 */

import type { TierCliff } from './tiers.ts';

/**
 * `Tier cliff · N away`, or nothing at all.
 *
 * Answers one question: is this player among the last one or two of the tier
 * that is actually in play at his position? Three conditions, each earning its
 * place:
 *
 *   - **his tier is the current one.** Tier 0 is the best group still on the
 *     board. A player in the tier below is not about to run out of anything —
 *     the group above him has to go first, and when it does his becomes tier 0
 *     and the question is asked again.
 *   - **a real cliff closes it.** The last tier at a position ends because the
 *     board ended, not because the position did, and "last group left" is not a
 *     warning about scarcity.
 *   - **one or two left.** Not "somewhere in a tier that eventually has a
 *     cliff" — that describes every player in it, which is how a board comes to
 *     stamp the same warning on every tight end on it.
 *
 * The count is of the position's tier, not of anything about the list this is
 * rendered into, so it falls the moment one of them is drafted, whoever drafts
 * them and wherever they sat on screen.
 */
export function tierCliffProximity(tier: TierCliff): number | null {
  if (tier.tierIndex !== 0) return null;
  if (!tier.tierEndsAtCliff) return null;
  return tier.tierSize === 1 || tier.tierSize === 2 ? tier.tierSize : null;
}

/**
 * Which rows in a position-filtered board have a tier boundary above them.
 *
 * Takes the tier index of each row in the order they are drawn and returns one
 * flag per row.
 *
 * The subtlety is that a board is ordered by the *ranking*, not by draft order:
 * the news ledger and My Guy can lift a player above somebody with a better
 * ADP, so tier indices arrive in mostly-ascending but not strictly ascending
 * order. Drawing a line wherever two neighbours differ would then draw the same
 * boundary several times, and draw it backwards wherever the ranking crossed
 * over.
 *
 * So the rule is "the first time the list reaches a tier". At most one line per
 * tier, always in reading order, and never above the first row — there is
 * nothing above it to separate it from.
 */
export function tierDividerFlags(tierIndices: (number | null)[]): boolean[] {
  let deepestSoFar = -1;
  return tierIndices.map((tier) => {
    const first = deepestSoFar < 0;
    const opens = tier != null && tier > deepestSoFar;
    if (opens) deepestSoFar = tier;
    return opens && !first;
  });
}
