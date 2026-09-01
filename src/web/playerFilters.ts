/**
 * The Players list's own filters: its position chips, and who holds a player.
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
 *
 * The second half of the file is the *ownership* control — anyone, available,
 * or one manager's team — which is this screen's alone and is one exclusive
 * choice rather than the two filters it reads as. The rule it enforces is in
 * `core/roster/ownership.ts`, where both handlers can reach it; what is here is
 * its vocabulary: what each option is called, what the button says while it is
 * shut, and what an empty list is allowed to say once three things are
 * narrowing it.
 */

import { TRAILING_FILTER_POSITIONS, orderFilterChips, orderPositions } from '../core/sleeper/eligibility.ts';
import {
  ANYONE_OWNER,
  AVAILABLE_OWNER,
  type OwnerFilter,
  type OwnerTeam,
} from '../core/roster/ownership.ts';

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

/* ------------------------------------------------------------- ownership */

/**
 * `Anyone · Available · <each team>`, from the teams the list came back with.
 *
 * One list for what the brief describes as two filters, because they are two
 * readings of one fact and cannot both hold: a player nobody rosters is not on
 * Joe's team, and a player on Joe's team is not available. Two controls would
 * have needed a rule about which one wins, a disabled state on the loser, and a
 * reader working out why the list went empty. One exclusive choice makes the
 * contradiction unrepresentable instead of handling it. See
 * `core/roster/ownership.ts`.
 *
 * It is orthogonal to the position chips beside it, which is the combination
 * that is actually wanted: available running backs, or every quarterback on
 * Joe's team.
 *
 * **Why this is a picker and not a second chip row.** It was a chip row, and
 * the row cost the Players list its tenth player on a 360px phone — the density
 * the screen is measured against and the reason the cards became rows in the
 * first place (`e2e/density.spec.ts`). It would also have been the wrong shape
 * for the league it is for: `Anyone · Available` plus twelve managers is
 * fourteen chips in a track a thumb has to drag through to reach the name it
 * wants. A button that names the current answer and opens a list of the rest
 * costs no vertical space at all, and reads the same at two teams as at twelve.
 *
 * No teams means no control, on the same rule the position chips follow: with
 * no league selected there is nothing to derive one from, and "available" in no
 * league at all is not a question anybody can answer.
 */
export function ownerFilterOptions(teams: readonly OwnerTeam[]): { id: string; label: string }[] {
  if (teams.length === 0) return [];
  return [
    { id: ANYONE_OWNER, label: 'Anyone' },
    { id: AVAILABLE_OWNER, label: 'Available' },
    ...teams.map((team) => ({ id: String(team.rosterId), label: teamLabel(team) })),
  ];
}

/**
 * What the button itself says.
 *
 * The current answer once there is one — `Available`, `Rival` — because a
 * filter control's first job is to say what it is doing, and a chip row's whole
 * advantage was that the active chip is visible without opening anything.
 *
 * `Owner` while nothing is filtered, rather than `Anyone`: a button alone on a
 * row saying "Anyone" names its answer without ever naming its question, and
 * this is the one state in which the answer is not worth saying. The label
 * changing from the noun to a name is also the only signal that the filter is
 * on, which is why it is the label that carries it rather than a tint.
 */
export function ownerButtonLabel(owner: OwnerFilter, ownerLabel: string | null): string {
  if (owner.kind === 'available') return 'Available';
  if (owner.kind === 'roster') return ownerLabel ?? `Team ${owner.rosterId}`;
  return 'Owner';
}

/**
 * What to call a seat.
 *
 * Sleeper's own name for the manager, and a positional stand-in only where it
 * has never published one — `Team 4` says which roster without claiming to know
 * whose it is, which is the honest answer and is still enough to tell two
 * options apart.
 */
export function teamLabel(team: OwnerTeam): string {
  return (team.ownerName ?? '').trim() || `Team ${team.rosterId}`;
}

/**
 * The one line an empty list is allowed to say, given everything narrowing it.
 *
 * Here rather than in the screen because it is the only place the three
 * narrowings meet, and an empty list that names the wrong one is how a reader
 * concludes the data is missing when in fact they are looking at one manager's
 * bench. The sentences are built so that no possessive is ever needed — a
 * manager is the *subject* of his own empty roster — because `Chris's` and
 * `Chris'` is an argument nobody should have to have with a fixture.
 *
 * "Run a Sleeper player sync" appears in exactly one case and deliberately: the
 * unfiltered list. With any filter on, an empty list is a fact about the filter,
 * and sending the reader to Setup would be advice about the wrong problem.
 */
export function playersEmptyLine(opts: {
  query: string;
  position: string;
  owner: OwnerFilter;
  /** The chip's own label for the roster being filtered to; null otherwise. */
  ownerLabel: string | null;
}): string {
  const { query, position, owner } = opts;
  const under = position === ALL_FILTER ? '' : ` under ${position}`;
  const players = position === ALL_FILTER ? 'players' : `${position} players`;

  if (owner.kind === 'roster') {
    const who = opts.ownerLabel ?? `Team ${owner.rosterId}`;
    return query ? `${who} has nobody matching “${query}”${under}.` : `${who} has no ${players}.`;
  }

  if (owner.kind === 'available') {
    return query ? `Nobody available matching “${query}”${under}.` : `No ${players} are available.`;
  }

  if (query) return `Nobody matching “${query}”${under}.`;
  return position === ALL_FILTER
    ? 'No players found. Run a Sleeper player sync from the Team screen.'
    : `No ${position} players found.`;
}
