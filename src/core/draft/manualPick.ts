/**
 * A pick entered by hand, because the room is not on Sleeper.
 *
 * An in-person draft has no pick stream. Twelve people sit around a table, a
 * name is called, and Sleeper hears about it that evening if it hears about it
 * at all — the draft object stays `pre_draft` the whole afternoon and
 * `/draft/:id/picks` stays empty. Every model in this app is built over that
 * stream: who is gone, what the run at a position looks like, what survives to
 * your next turn, what you already hold. With nothing arriving, the board ranks
 * a pool in which nobody has been taken, which is a board for a draft that has
 * not started, four rounds in.
 *
 * So the reader enters the picks themselves, and they go into the same
 * `draft_picks` table Sleeper's would have. That is the whole design: there is
 * no parallel store, no second read path and no flag anywhere downstream. The
 * board, the tiers, `Next%`, the survival model, roster need and the Team
 * screen all read `listPicks(draftId)` and cannot tell the difference, because
 * there is none to tell.
 *
 * **Sleeper still wins if it ever speaks.** `upsertPicks` conflicts on
 * `(draft_id, pick_no)` and overwrites, so a commissioner who types the room's
 * picks into Sleeper afterwards replaces the hand-entered rows with the
 * official ones, pick for pick, and nothing has to be undone first. A row this
 * module wrote is marked as its own in `raw_json` — see `MANUAL_PICK_SOURCE` —
 * which is what lets an undo refuse to delete a pick that came from Sleeper.
 *
 * Nothing here talks to a database or a clock. It answers one question — given
 * the picks already in, what is the next one — and the arithmetic is the snake
 * the rest of the app already uses.
 */

import type { DraftPickRecord } from '../sleeper/types.ts';

/** The marker a hand-entered pick carries in `raw_json`. */
export const MANUAL_PICK_SOURCE = 'manual';

/** Was this row entered by hand rather than read from Sleeper? */
export function isManualPick(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { source?: unknown };
    return parsed?.source === MANUAL_PICK_SOURCE;
  } catch {
    return false;
  }
}

/**
 * Which seat is on the clock at a given pick.
 *
 * The inverse of `pickNumbersForSlot`, and it must stay the inverse: a linear
 * draft advances in fixed slot order and a snake reverses every even round, and
 * the two functions disagreeing would put a pick on the wrong team's sheet
 * while the header counted down to the right turn.
 */
export function slotForPick(pickNo: number, teams: number, type: string): number {
  if (pickNo < 1 || teams < 1) return 0;
  const round = Math.ceil(pickNo / teams);
  const positionInRound = pickNo - (round - 1) * teams;
  const isSnake = type !== 'linear';
  return isSnake && round % 2 === 0 ? teams - positionInRound + 1 : positionInRound;
}

export interface ManualPickInput {
  draftId: string;
  /** Seats in the room. Never 0 by the time this is called — see `nextManualPick`. */
  teams: number;
  /** `snake`, `linear`, `auction`; anything but `linear` snakes. */
  type: string;
  /** Rounds the draft has, so a pick past the end can be refused. */
  rounds: number;
  /** Every pick already stored for this draft, hand-entered and Sleeper's alike. */
  existing: { pickNo: number; playerId: string | null }[];
  /** Whom the reader says this pick belongs to. */
  playerId: string;
  /**
   * Which roster owns the seat on the clock, where that is known.
   *
   * Sleeper publishes `slot_to_roster_id` once a commissioner seats the room,
   * and leaves it empty otherwise — which is the common case for a draft nobody
   * has opened. An unknown owner is stored as one rather than guessed at.
   */
  slotToRosterId: Record<string, number>;
  /**
   * The reader's own roster id, and whether this pick was theirs.
   *
   * `mine` is what the screen's toggle says. It is needed because a room with
   * no published seating has no other way to attribute a pick: without it the
   * app would know twenty-three players are gone and not that six of them are
   * on the reader's team.
   */
  myRosterId: number | null;
  mine: boolean;
}

export class ManualPickRefused extends Error {}

/**
 * The next pick, ready to store.
 *
 * Refuses rather than guesses in the two cases where guessing would corrupt the
 * board: a draft with no seat count (the snake is undefined, so every
 * attribution would be wrong) and a draft already full (a pick past the final
 * round is not a pick).
 */
export function nextManualPick(input: ManualPickInput): DraftPickRecord {
  const teams = Math.trunc(input.teams);
  if (teams < 1) {
    throw new ManualPickRefused('this draft has no seat count, so a pick cannot be placed in the order');
  }

  /*
   * The next pick is one past the highest already stored, not one past the
   * count.
   *
   * They differ exactly when Sleeper has published a partial stream with a gap
   * in it, and counting would then write over a pick that already exists.
   */
  const highest = input.existing.reduce((max, p) => (p.pickNo > max ? p.pickNo : max), 0);
  const pickNo = highest + 1;

  const rounds = Math.trunc(input.rounds);
  if (rounds > 0 && pickNo > rounds * teams) {
    throw new ManualPickRefused(`this draft is ${rounds} rounds and every one of its ${rounds * teams} picks is in`);
  }

  if (input.existing.some((p) => p.playerId === input.playerId)) {
    throw new ManualPickRefused('that player has already been taken in this draft');
  }

  const round = Math.ceil(pickNo / teams);
  const pickInRound = pickNo - (round - 1) * teams;
  const draftSlot = slotForPick(pickNo, teams, input.type);
  /*
   * Who this pick belongs to.
   *
   * The reader's own answer first, because in a room with no published seating
   * it is the only one there is. Otherwise the seat map, which is Sleeper's own
   * and right whenever it exists. Neither available means the pick is stored
   * with no owner — the player is off the board, which is the fact that matters
   * most, and no team is told it holds somebody it does not.
   */
  const rosterId = input.mine && input.myRosterId != null ? input.myRosterId : (input.slotToRosterId[String(draftSlot)] ?? null);

  return {
    draftId: input.draftId,
    pickNo,
    round,
    pickInRound,
    draftSlot,
    sleeperPlayerId: input.playerId,
    playerId: input.playerId,
    rosterId: rosterId == null ? null : Number(rosterId),
    pickedBy: null,
    raw: JSON.stringify({ source: MANUAL_PICK_SOURCE, pick_no: pickNo, round, draft_slot: draftSlot }),
  };
}
