/**
 * The posture and the waiver tie line. The tie band that lived here (0.6
 * points, 23 October 2026) is gone: every start/sit call now uses the toss-up
 * bar in `tossup.ts` (4 November 2026).
 *
 * The posture is still read and recorded with each support snapshot; it
 * decides nothing.
 */

export type Posture = 'underdog' | 'favourite';

/** Underdog below zero, favourite above, nothing when unknown or dead level. */
export function postureFrom(margin: number | null | undefined): Posture | null {
  if (margin == null || !Number.isFinite(margin) || margin === 0) return null;
  return margin < 0 ? 'underdog' : 'favourite';
}

/** The tie line, in the words the waiver tiers use (`startNowReason`). */
export function tieLine(name: string): string {
  return `Ties ${name} this week`;
}
