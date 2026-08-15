/**
 * Which players a lineup slot will accept — in one place.
 *
 * Three screens ask a version of this question. The draft board and the player
 * list ask it as a filter ("show me the flex-eligible players"); the comparison
 * tool asks it as a legality check ("can these four players be compared at
 * all?"); the lineup optimiser asks it per slot. They were always going to be
 * the same answer, and a second copy of it is exactly how a quarterback ends up
 * in a flex.
 *
 * **`FLX` is a view, not a position.** Nothing here relabels a player: a running
 * back filtered under FLX is still an RB in his row, his badge and his card
 * tint. The filter narrows what is drawn and changes nothing else.
 *
 * Superflex is deliberately not part of it. `SUPER_FLEX` accepts quarterbacks
 * and is a real Sleeper slot with its own eligibility, read from the league like
 * every other slot; `FLX` is the ordinary W/R/T view and never includes one.
 */

import { FLEX_ELIGIBILITY, type RosterShape } from './scoring.ts';

/**
 * Normal flex eligibility: running backs, receivers and tight ends.
 *
 * Not quarterbacks, not kickers, not defences.
 */
export const FLEX_POSITIONS = ['RB', 'WR', 'TE'] as const;

/** The filter's id and its visible label. It is not a position code. */
export const FLX_FILTER = 'FLX';

/** Every position the app understands as a real football position. */
export function normalizePosition(position: string | null | undefined): string {
  return (position ?? '').trim().toUpperCase();
}

/** True for RB, WR and TE. False for QB, K, DEF and anything unknown. */
export function isFlexEligible(position: string | null | undefined): boolean {
  return (FLEX_POSITIONS as readonly string[]).includes(normalizePosition(position));
}

/**
 * The positions a slot accepts, whether it is a flex slot or a plain one.
 *
 * `FLX` is included as a pseudo-slot so a caller that has a filter id and a
 * caller that has a Sleeper slot name can ask the same function.
 */
export function slotAccepts(slot: string | null | undefined): string[] {
  const key = normalizePosition(slot);
  if (!key) return [];
  if (key === FLX_FILTER) return [...FLEX_POSITIONS];
  const flex = FLEX_ELIGIBILITY[key];
  if (flex) return [...flex];
  // `QB2` is Sleeper's second-quarterback slot, spelled as a slot rather than a
  // position — the same normalisation `buildRosterShape` applies.
  if (key === 'QB2') return ['QB'];
  return [key];
}

/** Whether a slot (or the FLX view) would take this player. */
export function slotAcceptsPosition(slot: string | null | undefined, position: string | null | undefined): boolean {
  return slotAccepts(slot).includes(normalizePosition(position));
}

/**
 * Does this player belong under this filter chip?
 *
 * `ALL` and an empty filter match everybody; `FLX` matches W/R/T; anything else
 * is an exact position match, which is what every chip did before FLX existed.
 */
export function positionMatchesFilter(position: string | null | undefined, filter: string | null | undefined): boolean {
  const key = normalizePosition(filter);
  if (!key || key === 'ALL') return true;
  if (key === FLX_FILTER) return isFlexEligible(position);
  return normalizePosition(position) === key;
}

/**
 * Whether a league is worth offering the FLX view at all.
 *
 * A chip that can only ever return nothing is worse than no chip — the same
 * reason the board takes its position chips from the league rather than from a
 * list. A league that starts none of RB, WR or TE is not a league this filter
 * has anything to say about.
 */
export function offersFlexFilter(startable: Iterable<string>): boolean {
  for (const p of startable) if (isFlexEligible(p)) return true;
  return false;
}

export interface ComparisonSlot {
  /**
   * The slot the comparison is about: a league slot name, `FLX`, or null when
   * the selected players share no legal slot.
   */
  slot: string | null;
  /** Positions that slot accepts. Empty when there is no shared slot. */
  accepts: string[];
  /** False when these players cannot legally occupy the same lineup spot. */
  comparable: boolean;
  /** Plain-language explanation, shown as-is. */
  detail: string;
}

/**
 * Which lineup slot, if any, a set of players is actually competing for.
 *
 * Two quarterbacks are competing for the QB slot. A running back and a receiver
 * are competing for a flex, in a league that has one — and in a league that does
 * not, they are not competing for anything, and saying so is more use than
 * ranking them anyway. **A comparison with no legal slot is reported, never
 * forced**: the ranking would be arithmetically fine and practically meaningless,
 * because no lineup exists in which the answer could be acted on.
 *
 * When the caller launched from a specific slot that slot is honoured, so
 * "compare for my FLEX" stays about the flex even if every candidate happens to
 * be a running back.
 */
export function resolveComparisonSlot(
  positions: (string | null | undefined)[],
  shape: RosterShape | null,
  requestedSlot?: string | null,
): ComparisonSlot {
  const wanted = positions.map(normalizePosition).filter((p) => p.length > 0);
  if (wanted.length === 0) {
    return { slot: null, accepts: [], comparable: false, detail: 'No positions to compare.' };
  }

  const distinct = [...new Set(wanted)];

  if (requestedSlot) {
    const accepts = slotAccepts(requestedSlot);
    const rejected = distinct.filter((p) => !accepts.includes(p));
    return {
      slot: normalizePosition(requestedSlot),
      accepts,
      comparable: rejected.length === 0,
      detail:
        rejected.length === 0
          ? `Compared for the ${normalizePosition(requestedSlot)} slot.`
          : `${rejected.join(', ')} cannot fill a ${normalizePosition(requestedSlot)} slot.`,
    };
  }

  // Most specific first: two running backs in a league with an RB slot are
  // competing for RB, not for the flex that would also take them.
  const candidates = shape ? slotsOf(shape) : [];
  if (!shape) candidates.push({ slot: FLX_FILTER, accepts: [...FLEX_POSITIONS] });
  const fits = candidates
    .filter((c) => distinct.every((p) => c.accepts.includes(p)))
    .sort((a, b) => a.accepts.length - b.accepts.length);

  const best = fits[0];
  if (best) {
    return {
      slot: best.slot,
      accepts: best.accepts,
      comparable: true,
      detail: `These players are competing for the ${best.slot} slot.`,
    };
  }

  /*
   * No league slot takes all of them.
   *
   * The W/R/T case still gets a name, because "these three could share a flex if
   * you had one" is a different sentence from "a quarterback and a kicker are
   * not the same decision", and the reader deserves the more specific one.
   */
  if (distinct.every((p) => isFlexEligible(p))) {
    return {
      slot: null,
      accepts: [...FLEX_POSITIONS],
      comparable: false,
      detail: `${distinct.join(', ')} are flex-eligible, but this league has no flex slot that starts them together.`,
    };
  }

  return {
    slot: null,
    accepts: [],
    comparable: false,
    detail: `${distinct.join(', ')} do not share a lineup slot in this league, so ranking them against each other would not answer a lineup question.`,
  };
}

/** Every distinct slot this league starts, with what each accepts. */
export function slotsOf(shape: RosterShape): { slot: string; accepts: string[] }[] {
  const out: { slot: string; accepts: string[] }[] = [];
  const seen = new Set<string>();
  for (const position of Object.keys(shape.starters)) {
    if (seen.has(position)) continue;
    seen.add(position);
    out.push({ slot: position, accepts: [position] });
  }
  for (const f of shape.flex) {
    if (seen.has(f.slot)) continue;
    seen.add(f.slot);
    out.push({ slot: f.slot, accepts: [...f.positions] });
  }
  return out;
}
