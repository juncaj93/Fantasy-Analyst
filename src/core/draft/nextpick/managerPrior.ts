/**
 * What the specific people picking before you have historically done.
 *
 * `room.ts` already reads a manager's lean *from this draft* — four picks in and
 * he has taken two receivers. That is a small, fast-moving signal about today.
 * This is the slow one: the same manager, across the league's previous seasons,
 * taking his quarterback in round fourteen every single year.
 *
 * ## Where this is allowed to reach
 *
 * Exactly one place: the per-slot, per-position demand multiplier the simulator
 * already assembles from runs, standing room bias and in-draft manager lean.
 * This module contributes a fourth factor to that same table and exports nothing
 * else. It therefore moves `Next%` — the estimate of whether somebody else takes
 * a player before your next pick — and it cannot move `Score`, `PTS`, `ADP`,
 * `DOG`, the tier ladders, the Players ranking or any trade number, because none
 * of those read this table.
 *
 * That boundary is the brief's, and it is worth stating why it is the right one
 * rather than merely the required one. A manager's habit is evidence about *who
 * will be drafted*. It is not evidence about *who is good*. A quarterback does
 * not become a better football player because the man three seats over likes
 * quarterbacks, and a model that let history leak into quality would be claiming
 * he does.
 *
 * ## Only the managers who actually pick
 *
 * The table is indexed by the slots picking between the clock and the user's
 * next selection, so a manager with no intervening pick contributes nothing by
 * construction rather than by filtering. A manager with three intervening picks
 * contributes three times, because his multiplier applies at each of them — which
 * is the correct weighting and needs no separate "how many picks does he own"
 * term.
 *
 * ## Today outranks history, always
 *
 * A manager who has taken quarterbacks early for three years and already has two
 * quarterbacks on his roster this afternoon is not a quarterback risk this
 * afternoon. Every tendency is therefore scaled by how much of the relevant
 * starting requirement he still has open, measured from the live pick stream
 * against the league's own roster rules. When the requirement is met the
 * historical signal is suppressed to nothing, in both directions: history about
 * *when he takes his first one* stops meaning anything once he has one.
 */

import { buildDemandPlan, type PositionCounts } from './demand.ts';
import type { ManagerTendencies } from '../../managers/managerTendencies.ts';
import type { RosterShape } from '../../sleeper/scoring.ts';

export const MANAGER_PRIOR = {
  /**
   * How much of a unit of `lift` becomes demand.
   *
   * `lift` is already bounded to ±0.35 by the tendency model, so a gain of 0.4
   * puts the largest possible single-manager effect at ±14% on that manager's
   * appetite for one position — the same order as the in-draft lean this sits
   * beside (`ROOM.managerBounds`, 0.9–1.15) and deliberately no larger. History
   * is the weaker evidence of the two: it describes a different draft.
   */
  gain: 0.4,
  /** The most any one manager's history may move his own demand for a position. */
  bounds: { min: 0.87, max: 1.15 },
  /**
   * Below this share of a starting requirement still open, history is silent.
   *
   * Not zero, because "he has his quarterback" and "he has two quarterbacks"
   * are the same as far as his first-quarterback habit goes, and both should
   * end it.
   */
  suppressAt: 0,
} as const;

export interface ManagerPriorInput {
  /** Historical tendencies, keyed by Sleeper user id. */
  tendencies: Map<string, ManagerTendencies>;
  /** Which user holds each draft slot in the *current* draft. */
  userBySlot: Map<number, string | null>;
  /** Slots picking between the clock and the user's next selection. */
  slotsAhead: readonly number[];
  /** What each slot already holds in this draft, by position. */
  rosters: Map<number, PositionCounts>;
  /** The league's roster rules, for reading "has he filled it". */
  shape: RosterShape;
  /** Positions in play, in the simulator's own order. */
  positions: string[];
  /** Display names, for the diagnostics only. */
  displayNames?: Map<number, string | null>;
}

export interface ManagerPriorEntry {
  slot: number;
  userId: string | null;
  displayName: string | null;
  /** Per position, a demand multiplier centred on 1. */
  multipliers: Map<string, number>;
  draftsObserved: number;
  picksObserved: number;
  /** Positions whose history was suppressed by what he already holds. */
  suppressed: string[];
}

export interface ManagerPriorResult {
  /** Per slot, per position. Only slots with usable history appear. */
  bySlot: Map<number, Map<string, number>>;
  /** The same thing with its workings attached, for diagnostics. */
  entries: ManagerPriorEntry[];
  /** Managers picking ahead who had no usable history. Neutral, not penalised. */
  unknownSlots: number[];
  /** Said plainly, for the board's `nextPickModel` diagnostics. */
  notes: string[];
}

export const NEUTRAL_MANAGER_PRIOR: ManagerPriorResult = {
  bySlot: new Map(),
  entries: [],
  unknownSlots: [],
  notes: [],
};

/**
 * Turn history into demand, for the managers who are actually about to pick.
 *
 * Pure and deterministic. Returns a neutral result — every multiplier absent,
 * which the simulator reads as 1 — whenever there is no history, no identity, or
 * nothing left to want.
 */
export function readManagerPrior(input: ManagerPriorInput): ManagerPriorResult {
  if (input.tendencies.size === 0 || input.slotsAhead.length === 0) return neutral();

  const plan = buildDemandPlan(input.shape, input.positions);
  const bySlot = new Map<number, Map<string, number>>();
  const entries: ManagerPriorEntry[] = [];
  const unknownSlots: number[] = [];
  const notes: string[] = [];

  for (const slot of input.slotsAhead) {
    const userId = input.userBySlot.get(slot) ?? null;
    const tendencies = userId ? input.tendencies.get(userId) : undefined;

    /*
     * A manager nobody can match to a history is not a manager with a bad
     * history. He gets exactly the model everyone got before this file existed.
     */
    if (!userId || !tendencies || !tendencies.usable) {
      unknownSlots.push(slot);
      continue;
    }

    const counts = input.rosters.get(slot) ?? {};
    const multipliers = new Map<string, number>();
    const suppressed: string[] = [];

    for (let pi = 0; pi < input.positions.length; pi++) {
      const position = input.positions[pi]!;
      const tendency = tendencies.byPosition.get(position);
      if (!tendency || tendency.lift === 0) continue;

      /*
       * How much of this position he still has to solve, in [0,1].
       *
       * From the same `required` the demand model uses — which folds a superflex
       * slot into the quarterback requirement — so the two cannot disagree about
       * what "filled" means in a given league.
       */
      const required = plan.required[pi] ?? 0;
      const held = counts[position] ?? 0;
      const open = required > 0 ? Math.max(0, required - held) / required : held > 0 ? 0 : 1;

      if (open <= MANAGER_PRIOR.suppressAt) {
        suppressed.push(position);
        continue;
      }

      const multiplier = round3(
        clamp(
          1 + MANAGER_PRIOR.gain * tendency.lift * open,
          MANAGER_PRIOR.bounds.min,
          MANAGER_PRIOR.bounds.max,
        ),
      );
      if (multiplier !== 1) multipliers.set(position, multiplier);
    }

    if (multipliers.size === 0 && suppressed.length === 0) {
      unknownSlots.push(slot);
      continue;
    }

    const displayName = input.displayNames?.get(slot) ?? tendencies.displayName ?? null;
    if (multipliers.size > 0) bySlot.set(slot, multipliers);
    entries.push({
      slot,
      userId,
      displayName,
      multipliers,
      draftsObserved: tendencies.draftsObserved,
      picksObserved: tendencies.picksObserved,
      suppressed,
    });

    for (const [position, multiplier] of multipliers) {
      notes.push(
        `slot ${slot}${displayName ? ` (${displayName})` : ''}: ${position} demand ×${multiplier} ` +
          `from ${tendencies.draftsObserved} historical draft(s), ${tendencies.picksObserved} pick(s)`,
      );
    }
    for (const position of suppressed) {
      notes.push(
        `slot ${slot}${displayName ? ` (${displayName})` : ''}: ${position} history ignored — ` +
          `he has already filled the position in this draft`,
      );
    }
  }

  return { bySlot, entries, unknownSlots, notes };
}

/**
 * The multiplier for one slot and one position. 1 whenever nothing is known,
 * which is the great majority of slots in the great majority of leagues.
 */
export function managerMultiplier(
  result: ManagerPriorResult,
  slot: number | null | undefined,
  position: string,
): number {
  if (slot == null) return 1;
  return result.bySlot.get(slot)?.get(position) ?? 1;
}

function neutral(): ManagerPriorResult {
  return { bySlot: new Map(), entries: [], unknownSlots: [], notes: [] };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
