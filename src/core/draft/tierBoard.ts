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
 * Answers one question: is this player among the last one or two of his group,
 * with a drop worth warning about immediately after it? Two conditions, each
 * earning its place:
 *
 *   - **a warning-grade cliff closes his tier.** Not merely a boundary — since
 *     tiers were recalibrated against local spacing, almost every tier is
 *     closed by one of those, and a warning true of almost every card is the
 *     wallpaper this label has already been rescued from once. `tierEndsAtCliff`
 *     is the strict test: an absolute hole in picks, twice the local spacing,
 *     confirmed against what follows, capped at a fifth of the position. It is
 *     also false for the last tier at a position, which ends because the board
 *     ended rather than because the position did.
 *   - **one or two left.** Not "somewhere in a tier that eventually has a
 *     cliff" — that describes every player in it, which is how a board comes to
 *     stamp the same warning on every tight end on it.
 *
 * There used to be a third: his tier had to be tier 0, the best group left. That
 * made sense when a position had four or five tiers and tier 0 was most of the
 * board — "the group above has to go first" was nearly always true, and the
 * group in play was nearly always the one about to run out. It stopped making
 * sense the moment tiers became granular. A real quarterback board now has a
 * dozen tiers and tier 0 is its top two players, so the test threw away every
 * useful warning on the board and kept only the rarest: on the live board it
 * suppressed a two-man group above a 14-pick hole, a one-man group above a
 * 21-pick hole, and four more like them, and fired for nothing at all.
 *
 * It was also never quite true. This is drawn on the mixed board, which is
 * ordered by the ranking and not by draft order, so a player in the tier below
 * routinely sits *above* tier 0 on screen. "The group above him goes first" is
 * an argument about draft order that the list he is being drawn into does not
 * make.
 *
 * The count is of the position's tier, not of anything about the list this is
 * rendered into, so it falls the moment one of them is drafted, whoever drafts
 * them and wherever they sat on screen.
 */
export function tierCliffProximity(tier: TierCliff): number | null {
  if (!tier.tierEndsAtCliff) return null;
  return tier.tierSize === 1 || tier.tierSize === 2 ? tier.tierSize : null;
}

/**
 * The rows of a position-filtered board, in tier order.
 *
 * A divider is a claim about everything above and below it, and that claim is
 * only true if a tier is contiguous. The board is ordered by the *ranking*,
 * which is market value plus the news ledger plus My Guy, so it interleaves
 * tiers routinely — and one interleaving is enough to make the line a lie.
 *
 * The reported case, four quarterbacks: ADP 53.2 and 55.3 are one tier, 63.4
 * and 65.8 are the next, and the second-tier 65.8 outranks the first-tier 55.3.
 * Drawn in ranking order that reads 53.2, 65.8, 55.3, 63.4 — and the single
 * divider, correctly placed at the first row that reaches tier 1, lands after
 * 53.2. The screen then says the top group is one player and the next is three.
 * Both are false, and the `Tier cliff · 2 away` tags on the two genuine members
 * of tier 1 sat right beside it saying so.
 *
 * So tiers are drawn as bands, and the ranking orders the players inside each
 * band. Nothing about the ranking is discarded — within a tier it is the whole
 * order, and a tier is by definition the players who are close enough in market
 * value to be one decision, which is exactly where a preference belongs. Across
 * tiers the market decides, because that is what the divider is describing.
 *
 * Players with no tier at all — no published ADP — keep to the tail, where the
 * board already puts them.
 */
export function groupByTier<T>(items: T[], tierOf: (item: T) => number | null): T[] {
  const tiered: { item: T; at: number; tier: number }[] = [];
  const untiered: T[] = [];
  items.forEach((item, at) => {
    const tier = tierOf(item);
    if (tier == null) untiered.push(item);
    else tiered.push({ item, at, tier });
  });
  // Ties broken by the incoming position, so the ranking survives inside a
  // band and the same board never draws itself two ways.
  tiered.sort((a, b) => a.tier - b.tier || a.at - b.at);
  return [...tiered.map((e) => e.item), ...untiered];
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
