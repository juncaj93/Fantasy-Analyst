/**
 * The Players list's own chip row, which is the shared row plus an `ALL`.
 *
 * This module used to own the ordering rule as well — the kicker and the
 * defence following FLX rather than sitting among the positions — on the
 * argument that it was a presentation decision belonging to one screen, and
 * that "a rule about one screen that lived in core is a rule the next screen
 * adopts by accident".
 *
 * That argument was right about the danger and wrong about this rule, and the
 * draft board is what settled it: the same reordering was asked for there, on
 * the compare picker, and on the roster strip at the top of Draft — which reads
 * `0/1 QB · … · 0/2 FLX · 0/1 DEF · 0/6 BN` and has to agree with the chips
 * drawn immediately beneath it. Four places wanting one answer is not one
 * screen's presentation decision; it is the shared rule the comment beside
 * `orderPositions` already says must not exist twice. So the rule is
 * `orderFilterChips` in core now, and this is the Players screen's name for it.
 *
 * What stays here is what is genuinely local: the `ALL` chip, which is not a
 * position, which not every caller draws — the draft board leads with `★` and
 * `ALL` of its own — and the decision to draw no row at all rather than a lone
 * `ALL` for a league whose slots say nothing.
 *
 * It stays a module rather than folding back into the component for the reason
 * it was extracted: the demo league starts neither a kicker nor a defence, so a
 * browser test cannot exercise the rule this exists for — the chips it moves
 * would not be drawn — and asserting an ordering through a screen that cannot
 * show it is how a rule ends up untested while looking tested.
 */

import { TRAILING_FILTER_POSITIONS, orderFilterChips, orderPositions } from '../core/sleeper/eligibility.ts';

/** Everything, the chip the list opens on. */
export const ALL_FILTER = 'ALL';

/**
 * The two chips that follow the flex view, in the order they follow it.
 *
 * Re-exported rather than redeclared: the draft board, the compare picker and
 * the draft screen's roster strip all read the same constant, and a second copy
 * of it here is exactly how two rows end up disagreeing about where a defence
 * goes. See `TRAILING_FILTER_POSITIONS` for why these two and why the kicker
 * entry is inert today.
 */
export const TRAILING_FILTERS = TRAILING_FILTER_POSITIONS;

/**
 * `ALL · QB · RB · WR · TE · FLX · K · DEF`, from what the league actually
 * starts.
 *
 * The row is in three parts, and the split is about how a reader uses it rather
 * than about what a position is.
 *
 * **The skimmed positions** come first, in the order every fantasy site, draft
 * board and roster page has used for decades. These are the chips somebody
 * comparing players moves between, and they keep the front of the row.
 *
 * **FLX** follows them, because it is a view spanning three positions rather
 * than a fourth one, and a chip that reads like a position among the real ones
 * invites exactly the confusion this filter must not cause.
 *
 * **The kicker and the defence** come last, in that order. Neither is a player
 * anybody browses a player database for: each is one slot filled once a week,
 * usually against a schedule rather than against the rest of the pool. Sitting
 * among the skimmed positions they were something to move past on the way to
 * FLX rather than something to reach. The end of the row is where a chip nobody
 * is hunting for belongs, and both are still one tap away for the week somebody
 * is.
 *
 * A chip is only offered when the league starts that position. A filter that
 * can only ever return nothing is worse than no filter, which is why a defence
 * chip stopped appearing in a league with no defence slot — and why an empty
 * `startable` yields no row at all rather than a lone `ALL`.
 */
export function playerFilterChips(startable: Iterable<string>): string[] {
  const positions = orderPositions(startable);
  if (positions.length === 0) return [];
  return [ALL_FILTER, ...orderFilterChips(positions)];
}
