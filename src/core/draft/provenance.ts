/**
 * Where a player came from, said the way drafters say it.
 *
 * `#40` is a pick number and nobody thinks in pick numbers. `1.04` is the same
 * fact in the unit the room actually used — fourth pick of the first round —
 * and it is what every drafter, every board and every recap writes. The
 * conversion is one line of arithmetic and it lives here rather than in three
 * screens, because the moment two files do it independently they disagree about
 * whether the count is zero-based.
 *
 * ## The same row means two things at two times
 *
 * During the draft, "which pick was he" is the interesting fact about a player
 * on your roster: it is how you remember what you spent and it is what the
 * board next to you is showing. Once the draft is over it stops being
 * interesting — everybody has fifteen of them — and the number that identifies
 * a player on a team sheet is the one on his shirt.
 *
 * So a Team row shows `1.04` while the draft is running and `#8` afterwards,
 * and the draft position is not lost when it stops being the headline: it moves
 * into the player's detail, where "what did I spend on him" is still a question
 * worth answering in week nine.
 *
 * Nothing here invents a value. A player with no jersey number stored shows no
 * jersey number, and a player acquired off waivers has no draft position
 * because he was not drafted — an empty string, not a `0.00`.
 */

import { pickLabel } from './boardGrid.ts';

export { pickLabel };

/**
 * `1.04`, from an overall pick number.
 *
 * Re-exported from the board grid rather than reimplemented: the number under a
 * cell on the draft board and the number on a Team row are the same fact, and
 * two implementations of "which round is pick 40" is two chances to be off by
 * one.
 */
export function draftPickLabel(pickNo: number | null | undefined, teams: number): string | null {
  if (pickNo == null || !Number.isFinite(pickNo) || pickNo < 1) return null;
  return pickLabel(pickNo, teams) || null;
}

/** `#8`, or null for a player whose number this app does not know. */
export function jerseyLabel(jerseyNumber: number | null | undefined): string | null {
  if (jerseyNumber == null || !Number.isFinite(jerseyNumber) || jerseyNumber < 0) return null;
  return `#${Math.trunc(jerseyNumber)}`;
}

/**
 * What a Team row prints in its right-hand column, given how far along the
 * season is.
 *
 * The draft is the authority on which of the two is wanted, so it is an
 * argument rather than a guess from the date. `held` is the honest answer for a
 * player who is on the roster with no pick behind him and no number known —
 * the state a mid-draft roster is in for a player Sleeper has listed but not
 * yet attributed to a pick.
 */
export function rosterRowLabel(input: {
  drafting: boolean;
  pickNo: number | null | undefined;
  jerseyNumber: number | null | undefined;
  teams: number;
}): string {
  const pick = draftPickLabel(input.pickNo, input.teams);
  const jersey = jerseyLabel(input.jerseyNumber);

  if (input.drafting) {
    // Mid-draft the pick is the point. A jersey number is a reasonable second
    // choice for a player who arrived without one — a keeper, say — but it is
    // never preferred while the draft is the thing happening.
    return pick ?? jersey ?? 'held';
  }
  // Afterwards the shirt number identifies him, and the pick moves into detail.
  return jersey ?? pick ?? '';
}

/**
 * `Drafted 1.02 by Joe` — the whole provenance, in one sentence.
 *
 * Shown on a player's detail and in Trades, where "who spent what on him" is
 * real context for what a manager will want back. Built from Sleeper's own
 * draft history and nothing else: a manager name this app inferred would be a
 * sentence about a person, which is the worst possible thing to get wrong.
 *
 * Degrades a piece at a time rather than all at once — a pick with no known
 * manager still says which pick, which is most of the value.
 */
export function draftProvenanceLine(input: {
  pickNo: number | null | undefined;
  teams: number;
  managerName?: string | null;
  season?: string | null;
}): string | null {
  const pick = draftPickLabel(input.pickNo, input.teams);
  if (!pick) return null;
  const manager = (input.managerName ?? '').trim();
  const season = (input.season ?? '').trim();
  return [`Drafted ${pick}`, manager ? `by ${manager}` : '', season ? `· ${season}` : '']
    .filter(Boolean)
    .join(' ');
}
