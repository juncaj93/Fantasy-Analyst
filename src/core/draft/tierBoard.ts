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

/** What the chip says, and how many players it is counting. */
export interface TierCliffWarning {
  /** Available players left in the active tier. Only ever 1 or 2. */
  remaining: 1 | 2;
  /** `Tier cliff · last 1` / `Tier cliff · 2 left`. */
  label: string;
  /** `Cliff · 1` / `Cliff · 2`, for phones too narrow for the sentence. */
  short: string;
}

/**
 * `Tier cliff · last 1`, `Tier cliff · 2 left`, or nothing at all.
 *
 * One question, and the wording is the question: **if I want a player from the
 * best tier still available at this position, how many are left before I drop
 * into the next one?** Not how many picks away a hole is, not how far off some
 * other tier is — a count of players in one specific group.
 *
 * Three conditions.
 *
 *   - **his tier is the active one.** Tier 0 is the best group still available:
 *     the ladder is rebuilt from the players who are actually left, so the
 *     moment the group above is drafted his becomes tier 0 and the question is
 *     asked again. A group two tiers down is not endangered by anything yet —
 *     everything above it has to go first — and warning about it is the bug this
 *     rule exists to stop.
 *   - **a lower tier exists.** The last tier at a position ends because the
 *     board ended rather than because the position did, and "last one left" is
 *     not a cliff when there is nothing to fall to.
 *   - **one or two left.** Three is a group you can still choose from.
 *
 * The middle test asks the *boundary*, not the alarm. That is the second half of
 * this repair and it is deliberate: `tierEndsAtCliff` additionally demands an
 * absolute hole in picks — twelve at quarterback — which is the right bar for
 * "interrupt the reader about a hole" and the wrong one for "this group is down
 * to its last player". On the reported board the best quarterback left was alone
 * above an 8-pick step: a real break, drawn as a real divider, three and a half
 * times the spacing around it, and under the alarm floor. He was the one card on
 * the board that needed marking and the one card that said nothing.
 *
 * Every boundary the model draws has already cleared a ratio bar, a noise floor
 * scaled to the region of the draft, and a per-position fragmentation cap. "A
 * lower tier exists" is not a weak test — it is the model's own answer to
 * whether the board steps down here.
 *
 * Restraint comes from the active-tier rule instead, and it is much stronger
 * than the bar it replaces: at most one tier per position may warn, and only
 * when it is down to one or two players. A whole board can carry at most two
 * chips per position, and usually carries none, because a healthy top tier has
 * three or more in it.
 */
export function tierCliffWarning(tier: TierCliff): TierCliffWarning | null {
  if (tier.tierIndex !== 0) return null;
  if (!tier.tierEndsAtBoundary) return null;
  if (tier.tierSize === 1) return { remaining: 1, label: 'Tier cliff · last 1', short: 'Cliff · 1' };
  if (tier.tierSize === 2) return { remaining: 2, label: 'Tier cliff · 2 left', short: 'Cliff · 2' };
  return null;
}

/** A player as this layer needs him: who he is, where he plays, what the model said. */
export interface WarnablePlayer {
  playerId: string;
  position: string;
  tier: TierCliff;
}

/**
 * Every warning a board should draw, keyed by player.
 *
 * A fold over `tierCliffWarning` rather than a second rule — the per-player
 * predicate is the primitive and the screen calls it directly, one row at a
 * time, because building a map on every render of a live draft would be work
 * for nothing. This exists for the things that want the whole answer at once:
 * the read-only probe, and the tests that assert the two invariants a
 * per-player function cannot state about itself.
 *
 *   - no player in a worse tier warns while a better tier at his position still
 *     has anybody in it;
 *   - at most one tier per position warns at a time.
 *
 * Both fall out of "tier 0 only", but they are the properties that matter and a
 * regression in either is silent, so they are checked over a whole board.
 *
 * Positions are independent. A board may show one quarterback warning, two
 * tight end warnings and nothing at running back in the same breath, because
 * each position runs out of its own best group on its own schedule.
 */
export function activeTierCliffWarnings(players: WarnablePlayer[]): Map<string, TierCliffWarning> {
  const out = new Map<string, TierCliffWarning>();
  for (const player of players) {
    const warning = tierCliffWarning(player.tier);
    if (warning) out.set(player.playerId, warning);
  }
  return out;
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
