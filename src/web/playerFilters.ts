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
 * The defence, which goes last.
 *
 * The same string `orderPositions` emits and the same one the API filters on;
 * this module only decides where it sits in the row.
 */
export const DEF_FILTER = 'DEF';

/**
 * `ALL · QB · RB · WR · TE · FLX · DEF`, from what the league actually starts.
 *
 * Two chips are moved to the end of the positions, for two different reasons.
 *
 * **FLX** is a view spanning three positions rather than a fourth one, and a
 * chip that reads like a position among the real ones invites exactly the
 * confusion this filter must not cause.
 *
 * **DEF** then follows it. A defence is not a player anybody browses a player
 * database for — it is a streaming decision made once a week against a
 * schedule — and it sat between the tight ends and the flex view, in the middle
 * of the run of chips a reader actually moves between, where it was something
 * to skip past on the way to FLX rather than something to reach. Last is where
 * a chip nobody is looking for belongs, and it is still one tap away for the
 * week somebody is.
 *
 * `K` is deliberately left among the positions: a kicker is a roster slot a
 * reader browses like any other, so a league with one reads
 * `ALL · QB · RB · WR · TE · K · FLX · DEF`.
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
    ...positions.filter((p) => p !== DEF_FILTER),
    ...(offersFlexFilter(positions) ? [FLX_FILTER] : []),
    ...(positions.includes(DEF_FILTER) ? [DEF_FILTER] : []),
  ];
}
