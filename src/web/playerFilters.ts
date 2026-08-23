/**
 * The order the Players list draws its position chips in.
 *
 * A presentation decision belonging to one screen, which is why it is here
 * rather than beside `orderPositions` in `core/sleeper/eligibility.ts`. That
 * helper answers "what order are positions read in", and its answer is shared
 * by the draft board, Team and this screen — deliberately, so the same chips
 * cannot appear in two different orders on two screens. What follows is only
 * about which chips this particular row ends with, and a rule about one screen
 * that lived in core is a rule the next screen adopts by accident.
 *
 * Extracted from the component so it can be asserted directly. The demo league
 * has no defence slot, so a browser test cannot exercise the rule this module
 * exists for — the chip it moves would not be drawn at all — and asserting an
 * ordering through a screen that cannot show it is how a rule ends up untested
 * while looking tested.
 */

import { FLX_FILTER, offersFlexFilter, orderPositions } from '../core/sleeper/eligibility.ts';

/** Everything, the chip the list opens on. */
export const ALL_FILTER = 'ALL';

/**
 * The two chips that follow the flex view, in the order they follow it.
 *
 * Both are positions a reader browses *occasionally* rather than compares: a
 * kicker and a defence are each one slot filled once, usually against a
 * schedule rather than against the rest of the pool. They are the same strings
 * `orderPositions` emits and the same ones the API filters on; this module only
 * decides where they sit in the row.
 *
 * The order between them is the roster's own — kicker, then defence — which is
 * how every lineup page in the sport ends.
 */
export const TRAILING_FILTERS = ['K', 'DEF'];

/**
 * `ALL · QB · RB · WR · TE · FLX · K · DEF`, from what the league actually
 * starts.
 *
 * The row is in three parts, and the split is about how a reader uses it rather
 * than about what a position is.
 *
 * **The skimmed positions** come first, in the order every fantasy site, draft
 * board and roster page has used for decades — `orderPositions`, shared with
 * the draft board and Team so the same chips cannot appear in two different
 * orders on two screens. These are the chips somebody comparing players moves
 * between, and they keep the front of the row.
 *
 * **FLX** follows them, because it is a view spanning three positions rather
 * than a fourth one, and a chip that reads like a position among the real ones
 * invites exactly the confusion this filter must not cause.
 *
 * **The kicker and the defence** come last, in that order — see
 * {@link TRAILING_FILTERS}. Neither is a player anybody browses a player
 * database for: each is one slot filled once a week, usually against a schedule
 * rather than against the rest of the pool. Sitting among the skimmed positions
 * they were something to move past on the way to FLX rather than something to
 * reach. The end of the row is where a chip nobody is hunting for belongs, and
 * both are still one tap away for the week somebody is.
 *
 * A chip is only offered when the league starts that position. A filter that
 * can only ever return nothing is worse than no filter, which is why a defence
 * chip stopped appearing in a league with no defence slot — and why an empty
 * `startable` yields no row at all rather than a lone `ALL`.
 */
export function playerFilterChips(startable: Iterable<string>): string[] {
  const positions = orderPositions(startable);
  if (positions.length === 0) return [];
  return [
    ALL_FILTER,
    ...positions.filter((p) => !TRAILING_FILTERS.includes(p)),
    ...(offersFlexFilter(positions) ? [FLX_FILTER] : []),
    // Read from the constant rather than from `positions`, so the order between
    // them is this module's and not the shared helper's.
    ...TRAILING_FILTERS.filter((p) => positions.includes(p)),
  ];
}
