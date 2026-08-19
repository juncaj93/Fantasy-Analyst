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

/** One drawn row, and whether a tier boundary is drawn above it. */
export interface AnnotatedRow<T> {
  row: T;
  /** Rank as drawn, 1-based. Follows the sequence, never the tiers. */
  rank: number;
  divider: boolean;
}

/**
 * Annotate a board with tier boundaries **without reordering it**.
 *
 * The one rule, and the reason this function exists rather than a pair of calls
 * at the call site: the sequence handed in is the sequence handed back. Whatever
 * sort the reader chose — Score, ADP, DOG — decides who appears where, and a
 * tier is punctuation on that sequence.
 *
 * ## What this replaced
 *
 * The board used to be re-sorted into tier bands first, so that a divider's
 * claim — everything above this line is one tier — came out literally true. It
 * did, and the board was wrong. On the reported tight-end board a Score of 68
 * was drawn above two Scores of 83 because the market clustered him higher; on
 * the running-back board the best-scoring player was pushed below four worse
 * ones. The Score tab exists to answer one question, and it was answering it
 * with the ranking in one column and the opposite claim in the layout.
 *
 * A reader comparing two numbers on screen cannot be expected to know that the
 * layout silently outranked one of them. So the divider now says something
 * weaker and true — *the market's next tier starts here* — and the rows above it
 * are the rows the reader's own sort put above it.
 *
 * Returning flags rather than an order is deliberate: this shape has no way to
 * express "move this row", which is what makes the invariant structural instead
 * of a rule somebody has to remember.
 */
export function annotateTiers<T>(rows: readonly T[], tierOf: (row: T) => number | null): AnnotatedRow<T>[] {
  const flags = tierDividerFlags(rows.map(tierOf));
  return rows.map((row, i) => ({ row, rank: i + 1, divider: flags[i] === true }));
}
