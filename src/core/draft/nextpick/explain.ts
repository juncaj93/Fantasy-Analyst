/**
 * Why the number is what it is, in words a drafter would use.
 *
 * The rule this file exists to enforce: **a driver is only printed when it
 * actually moved the model.** "3 teams ahead still need TE" is not a decoration
 * — it is a claim that the simulator counted three managers with an empty tight
 * end slot picking before you, and if it counted two the sentence must say two
 * or not appear. Explanations that drift from the model are worse than no
 * explanation, because they are checkable and they teach the reader to trust
 * something that is not true.
 *
 * Everything here is therefore derived from the simulation's own diagnostics,
 * and every driver has a threshold below which it is silent.
 */

import type { TierCliff } from '../tiers.ts';
import type { PlayerAvailability, SimulationResult } from './simulate.ts';

export interface ExplainInput {
  position: string;
  adp: number | null;
  currentPick: number;
  availability: PlayerAvailability;
  result: SimulationResult;
  cliff?: TierCliff | null;
  /** Comparable players still available at the position. */
  alternatives?: number;
}

export interface NextPickExplanation {
  /** Short, ordered, most important first. Empty when nothing stood out. */
  drivers: string[];
  /** How much to trust the number. */
  confidence: 'high' | 'medium' | 'low';
  /** Why confidence is not high. Empty when it is. */
  degraded: string[];
}

/** Where the headline verdict changes. Same bands the board's colour uses. */
const VERDICT = { unlikely: 0.3, likely: 0.66 } as const;

/** A position run has to be this far from the market before it is worth saying. */
const RUN_THRESHOLD = 1.06;
/** ADP picks past the clock before "he is falling" is a real observation. */
const FALL_THRESHOLD = 8;

export function explainNextPick(input: ExplainInput): NextPickExplanation {
  const { availability, result } = input;
  const degraded = [...result.degraded];

  if (availability.probability == null) {
    return {
      drivers: [],
      confidence: 'low',
      degraded: degraded.length > 0 ? degraded : ['no market ADP for this player'],
    };
  }

  const drivers: string[] = [];
  const probability = availability.probability;

  /*
   * The headline, and the only driver that always appears.
   *
   * It names the pick rather than saying "your next pick", because on the clock
   * those are different picks and the whole model turns on which one is meant.
   */
  drivers.push(
    probability <= VERDICT.unlikely
      ? `Unlikely to last to pick ${result.targetPick}`
      : probability >= VERDICT.likely
        ? `Likely to last to pick ${result.targetPick}`
        : `A coin flip to last to pick ${result.targetPick}`,
  );

  /*
   * When the market answered, only the market may speak.
   *
   * The teams ahead and their empty slots were measured from the real board and
   * are perfectly true — but they did not move this number, and a driver that
   * explains a calculation which did not happen is exactly the failure this
   * file exists to prevent. Everything below the headline is therefore skipped,
   * except the observation about his own price, which is the model that ran.
   */
  if (result.marketOnly) {
    if (input.adp != null && input.currentPick - input.adp >= FALL_THRESHOLD) {
      drivers.push(`already ${Math.round(input.currentPick - input.adp)} picks past his ADP`);
    }
    return { drivers, confidence: result.confidence, degraded };
  }

  // --- who is picking, and what they are short of ---------------------------
  const needing = result.needAhead.get(input.position) ?? 0;
  const ahead = result.slotsAhead.length;
  if (ahead > 0 && needing > 0) {
    drivers.push(
      `${needing} of the ${ahead} team${ahead === 1 ? '' : 's'} ahead still need${needing === 1 ? 's' : ''} ${input.position}`,
    );
  } else if (ahead > 0 && needing === 0 && result.needAhead.has(input.position)) {
    // The reason a quarterback in round nine survives, said plainly. Only when
    // the position has a dedicated slot at all — otherwise "nobody needs it" is
    // a statement about the league, not about the board.
    drivers.push(`every team ahead of you already has their ${input.position}`);
  }

  // --- how replaceable he is ------------------------------------------------
  const cliff = input.cliff;
  if (cliff && cliff.tierEndsAtCliff && cliff.remainingInTier > 0 && cliff.remainingInTier <= 3) {
    drivers.push(
      cliff.remainingInTier === 1
        ? `last ${input.position} in this tier`
        : `${cliff.remainingInTier} ${input.position}s left in this tier`,
    );
  } else if (input.alternatives != null && input.alternatives >= 6) {
    drivers.push(`${input.alternatives} comparable ${input.position}s still on the board`);
  }

  // --- what the room has been doing ----------------------------------------
  const run = result.room.runs.get(input.position);
  if (run != null && run >= RUN_THRESHOLD) {
    drivers.push(`${input.position}s are going faster than the market expects right now`);
  } else if (run != null && run <= 2 - RUN_THRESHOLD) {
    drivers.push(`this room has been fading ${input.position}`);
  }

  const bias = result.room.bias.get(input.position);
  if (bias != null && bias >= 1.05) {
    drivers.push(`this room takes ${input.position}s earlier than the market`);
  } else if (bias != null && bias <= 0.95) {
    drivers.push(`this room takes ${input.position}s later than the market`);
  }

  // --- where he sits against his own price ----------------------------------
  if (input.adp != null && input.currentPick - input.adp >= FALL_THRESHOLD) {
    drivers.push(`already ${Math.round(input.currentPick - input.adp)} picks past his ADP`);
  }

  return {
    drivers,
    // Decided by the simulation, which knows what it could and could not see.
    confidence: result.confidence,
    degraded,
  };
}

/**
 * The one line the existing card already has room for.
 *
 * Joined with the same separator the rest of the draft UI uses, so this can be
 * dropped into the survival component's `display` without touching a component.
 */
export function driverLine(explanation: NextPickExplanation): string {
  return explanation.drivers.join(' · ');
}
