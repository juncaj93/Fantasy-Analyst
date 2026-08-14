/**
 * Who picks before you do again, and whether they still need what you are
 * looking at.
 *
 * "Five receivers left in this tier" is a fact about the board. Whether that is
 * comfortable or alarming depends on something the board cannot say: how many
 * of the teams picking between now and your next selection are still short at
 * receiver. Four teams who all need one is a run; four teams who are all set is
 * five receivers that will mostly still be there.
 *
 * Every input is live draft state — the actual pick order, the actual players
 * those teams have taken, and the league's actual starting slots. Nothing here
 * reads ADP, the news ledger, My Guy or roster need, and nothing here scores
 * anybody. It is context attached to a line of text.
 */

import type { RosterShape } from '../sleeper/scoring.ts';

export interface DemandInput {
  /** Picks made so far, in any order. Only completed picks matter. */
  picks: { playerId: string | null; pickNo: number; draftSlot: number }[];
  /** Position lookup for drafted players. */
  positionOf: (playerId: string) => string | null;
  /** The pick on the clock. */
  currentPick: number;
  /** The user's next selection after this one. Null on their last pick. */
  horizonPick: number | null;
  /** The user's own draft slot, excluded from the scan. */
  mySlot: number | null;
  teams: number;
  /** `snake` unless the draft is linear. */
  type: string;
  shape: RosterShape;
}

export interface PositionDemand {
  /** Teams picking between now and your next selection, excluding you. */
  teamsAhead: number;
  /** How many of them are still short at this position. */
  needing: number;
  /**
   * How many of them have made enough picks to have covered it at all.
   *
   * The difference between "nobody ahead has a tight end" in round one and in
   * round nine. In round one that is true of every position and describes only
   * how early it is; the reader needs to know which of the two they are looking
   * at, and this is what tells them.
   */
  couldHaveCovered: number;
}

/**
 * Which draft slot owns a given overall pick.
 *
 * The inverse of `pickNumbersForSlot`, and the reason this is not derived from
 * league size alone: a snake reverses on even rounds, so pick 25 in a 12-team
 * draft belongs to slot 1 and pick 24 to slot 1 as well. Getting that wrong
 * would attribute a roster to the wrong manager and quietly invent demand.
 */
export function slotAtPick(pickNo: number, teams: number, type: string): number {
  if (teams < 1 || pickNo < 1) return 0;
  const round = Math.ceil(pickNo / teams);
  const indexInRound = ((pickNo - 1) % teams) + 1;
  const isSnake = type !== 'linear';
  return isSnake && round % 2 === 0 ? teams - indexInRound + 1 : indexInRound;
}

/**
 * How short each position is among the teams picking before your next turn.
 *
 * The coverage bar differs by position, and deliberately:
 *
 *   - **QB, TE, K, DEF** — one is enough. These are single-slot positions, and
 *     a team with a tight end has solved tight end for the purposes of "will
 *     somebody take one before I pick again".
 *   - **RB and WR** — the league's own starting requirement. A team with one
 *     back in a league that starts two is still shopping for backs, and
 *     counting it as covered is how a board tells you a run is not coming while
 *     it is happening.
 *
 * FLEX and bench are deliberately not modelled. Every team wants depth
 * eventually, so folding that in makes every team need everything and the
 * answer stops distinguishing anything.
 */
export function demandBetweenPicks(input: DemandInput): Map<string, PositionDemand> {
  const out = new Map<string, PositionDemand>();
  const { currentPick, horizonPick, teams, type, mySlot, shape } = input;
  if (horizonPick == null || teams < 1) return out;

  /*
   * The picks strictly between now and your next one.
   *
   * When you are on the clock the pick on the clock is yours, so the scan opens
   * at the one after it; when you are not, the pick on the clock belongs to
   * somebody else and counts. Your own slot is filtered out either way — your
   * roster is not competition for you.
   */
  const from = slotAtPick(currentPick, teams, type) === mySlot ? currentPick + 1 : currentPick;
  const slotsAhead = new Set<number>();
  for (let pick = from; pick < horizonPick; pick++) {
    const slot = slotAtPick(pick, teams, type);
    if (slot !== mySlot) slotsAhead.add(slot);
  }
  if (slotsAhead.size === 0) return out;

  // What each of those teams already holds, from the pick stream — which is the
  // only roster that exists mid-draft.
  const heldBySlot = new Map<number, Map<string, number>>();
  const pickedBySlot = new Map<number, number>();
  for (const slot of slotsAhead) {
    heldBySlot.set(slot, new Map());
    pickedBySlot.set(slot, 0);
  }
  for (const pick of input.picks) {
    if (!pick.playerId) continue;
    const held = heldBySlot.get(pick.draftSlot);
    if (!held) continue;
    pickedBySlot.set(pick.draftSlot, (pickedBySlot.get(pick.draftSlot) ?? 0) + 1);
    const position = input.positionOf(pick.playerId);
    if (!position) continue;
    held.set(position, (held.get(position) ?? 0) + 1);
  }

  const positions = new Set<string>([...Object.keys(shape.starters)]);
  for (const position of positions) {
    const required = requiredFor(position, shape);
    let needing = 0;
    let couldHaveCovered = 0;
    for (const [slot, held] of heldBySlot) {
      if ((held.get(position) ?? 0) < required) needing++;
      if ((pickedBySlot.get(slot) ?? 0) >= required) couldHaveCovered++;
    }
    out.set(position, { teamsAhead: slotsAhead.size, needing, couldHaveCovered });
  }
  return out;
}

/** One for the single-slot positions; the league's own requirement for RB/WR. */
function requiredFor(position: string, shape: RosterShape): number {
  if (position === 'RB' || position === 'WR') return Math.max(1, shape.starters[position] ?? 1);
  return 1;
}
