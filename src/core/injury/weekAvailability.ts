/**
 * What an injury designation does to a player's number this week, on every screen.
 *
 * Team's rule, owned here so no screen can carry a second one (Alex's decision,
 * 23 October 2026). Until then four screens answered the same question four
 * ways: Team charged Questionable nothing (`startsit@5`), Matchup multiplied
 * him by a play-chance mix (0.616 of his number), the trade and waiver rates
 * counted him as 0.8 of a game, and the waiver yardstick took half a point off.
 * Jordan Love read 21.01 on Team and 12.94 on Matchup on the same night.
 *
 *  - **Questionable**, and every status that is not Doubtful or ruled out:
 *    full value, shown as a warning chip.
 *  - **Doubtful**: counts as Out this week (Alex's decision, 5 November 2026;
 *    review S8). Zero points, benched and replaced. A Doubtful player almost
 *    never plays, and the six points this used to take off left an 18-point
 *    Doubtful star starting over a healthy 11. The chip still says Doubtful.
 *  - **Out, IR, PUP, suspended**: ruled out, nothing this week.
 *
 * Only this week. What a designation means for later weeks is the trade
 * model's own assumption (`tradeValue/availability.ts`) and is not a screen's
 * number: a Doubtful player misses this week and is back the week after.
 */

import { isRuledOut, type Designation } from './model.ts';

/** The anchors. `ruledOut` is a gate, not a penalty: large enough that nothing lifts him over somebody available. */
export const AVAILABILITY = {
  ruledOut: -99,
  /** Shown, not scored, since 13 October 2026. */
  questionable: 0,
} as const;

export interface WeekAvailability {
  /** Points added to his healthy week. Zero or negative; the gate value when ruled out. */
  charge: number;
  /** Out, IR, PUP, suspended or Doubtful: not a playable starter this week. */
  out: boolean;
  /** A designation the reader should see as a chip. True for everything but healthy and unknown. */
  warn: boolean;
}

export function weekAvailability(designation: Designation): WeekAvailability {
  if (designation === 'healthy' || designation === 'unknown') return { charge: 0, out: false, warn: false };
  if (isOutThisWeek(designation)) return { charge: AVAILABILITY.ruledOut, out: true, warn: true };
  return { charge: AVAILABILITY.questionable, out: false, warn: true };
}

/** Out, IR, PUP, suspended, or Doubtful: no game this week, on every screen. */
export function isOutThisWeek(designation: Designation): boolean {
  return isRuledOut(designation) || designation === 'doubtful';
}

/** His healthy week after the rule: zero when out this week, the charge taken off otherwise, never below zero. */
export function availableWeekPoints(healthy: number, designation: Designation): number {
  const rule = weekAvailability(designation);
  if (rule.out) return 0;
  return Math.max(0, Math.round((healthy + rule.charge) * 100) / 100);
}

/**
 * The same rule as a share of his healthy week, for the models that count
 * games rather than points (the trade and waiver rates). Questionable is a
 * whole game; Doubtful and ruled out are none.
 */
export function weekShare(designation: Designation, healthy: number | null): number {
  const rule = weekAvailability(designation);
  if (rule.out) return 0;
  if (rule.charge === 0) return 1;
  if (healthy == null || !(healthy > 0)) return 0;
  return Math.max(0, healthy + rule.charge) / healthy;
}
