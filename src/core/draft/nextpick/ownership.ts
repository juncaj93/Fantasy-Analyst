/**
 * Who owns each pick, and which of them are yours.
 *
 * The snake is arithmetic and the simulator could do it inline, except for two
 * things it must not get wrong.
 *
 * **Traded picks.** If Sleeper publishes that roster 4 holds roster 9's
 * third-rounder, then the manager on the clock at that pick is roster 4 and the
 * roster the model should be reading for need is roster 4's. Inferring it from
 * the snake slot would attribute the pick to a manager who is not making it,
 * and quietly invent demand for a position that team filled two rounds ago.
 * Ownership is therefore resolved through here, once, and the simulator only
 * ever asks "whose pick is this".
 *
 * **Which pick `Next` is about.** The target is the user's next *future* owned
 * selection — strictly after the pick on the clock, never the pick on the clock.
 * On the clock those differ, and that is the one moment the number is being used
 * to decide something: asking whether a player available now is available now
 * returns 100% for everybody on the board.
 *
 * Back-to-back picks fall out of the same rule without a special case. Own 53
 * and 54, standing on 53: the target is 54, nobody picks in between, and the
 * honest answer is that anybody you pass on is still there — which is exactly
 * what the simulator produces from an empty interval.
 */

import { pickNumbersForSlot } from '../../sleeper/transform.ts';

/** One traded pick as Sleeper reports it: a round, its original owner, its new one. */
export interface TradedPick {
  round: number;
  /** The roster whose slot the pick sits in. */
  rosterId: number;
  /** The roster that will actually make it. */
  ownerRosterId: number;
}

export interface OwnershipInput {
  teams: number;
  rounds: number;
  /** `snake` unless the draft is linear. */
  type: string;
  /** Sleeper's `slot_to_roster_id`, when published. */
  slotToRosterId?: Record<string, number>;
  tradedPicks?: TradedPick[];
}

export interface PickOwnership {
  teams: number;
  rounds: number;
  /** The draft slot whose *seat* a pick sits in — pure snake arithmetic. */
  slotAt(pickNo: number): number;
  /**
   * The manager who will actually make a pick, keyed by draft slot.
   *
   * Equal to `slotAt` unless the pick was traded and Sleeper said so. Null when
   * the pick number is outside the draft.
   */
  ownerAt(pickNo: number): number | null;
  /** Every pick a slot will make, in order, after trades. */
  picksOwnedBy(slot: number): number[];
  /**
   * The slot's next selection strictly after `currentPick`.
   *
   * Null on their final pick of the draft: there is no later selection, so
   * "will he last until then" has no answer and must not be given one.
   */
  nextOwnedPickAfter(slot: number, currentPick: number): number | null;
  /** True when any pick in this draft has a published owner other than its seat. */
  hasTrades: boolean;
}

/** Which draft slot sits at a given overall pick, before any trade. */
export function slotAtPick(pickNo: number, teams: number, type: string): number {
  if (teams < 1 || pickNo < 1) return 0;
  const round = Math.ceil(pickNo / teams);
  const indexInRound = ((pickNo - 1) % teams) + 1;
  const isSnake = type !== 'linear';
  return isSnake && round % 2 === 0 ? teams - indexInRound + 1 : indexInRound;
}

export function buildPickOwnership(input: OwnershipInput): PickOwnership {
  const teams = Math.max(1, input.teams);
  const rounds = Math.max(1, input.rounds);
  const type = input.type;
  const total = teams * rounds;

  const slotOfRoster = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(input.slotToRosterId ?? {})) {
    slotOfRoster.set(Number(rosterId), Number(slot));
  }

  /*
   * Trades are indexed by (round, seat), because that is what a traded pick is:
   * one specific selection, not a manager's whole draft. A roster that trades
   * away its second-rounder still makes its first and its third.
   */
  const tradedOwner = new Map<string, number>();
  for (const trade of input.tradedPicks ?? []) {
    const seat = slotOfRoster.get(trade.rosterId);
    const owner = slotOfRoster.get(trade.ownerRosterId);
    // Both ends must resolve to a seat in this draft. A trade naming a roster
    // the draft does not know about is not information, it is noise.
    if (seat == null || owner == null) continue;
    if (trade.round < 1 || trade.round > rounds) continue;
    if (seat === owner) continue;
    tradedOwner.set(`${trade.round}:${seat}`, owner);
  }

  const slotAt = (pickNo: number) => slotAtPick(pickNo, teams, type);
  const ownerAt = (pickNo: number): number | null => {
    if (pickNo < 1 || pickNo > total) return null;
    const seat = slotAt(pickNo);
    const round = Math.ceil(pickNo / teams);
    return tradedOwner.get(`${round}:${seat}`) ?? seat;
  };

  const owned = new Map<number, number[]>();
  const picksOwnedBy = (slot: number): number[] => {
    const cached = owned.get(slot);
    if (cached) return cached;
    // No trades in this draft: the snake answers it directly, which is both
    // faster and the overwhelmingly common case.
    const list = tradedOwner.size === 0
      ? pickNumbersForSlot(slot, teams, rounds, type)
      : Array.from({ length: total }, (_, i) => i + 1).filter((pickNo) => ownerAt(pickNo) === slot);
    owned.set(slot, list);
    return list;
  };

  return {
    teams,
    rounds,
    slotAt,
    ownerAt,
    picksOwnedBy,
    nextOwnedPickAfter(slot, currentPick) {
      for (const pickNo of picksOwnedBy(slot)) if (pickNo > currentPick) return pickNo;
      return null;
    },
    hasTrades: tradedOwner.size > 0,
  };
}
