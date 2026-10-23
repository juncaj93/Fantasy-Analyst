/**
 * A close call is a tie, said as one, and never a pick (Alex's decision, 23 October 2026).
 *
 * When two players are within {@link TIE_BAND} points, Compare shows the
 * line Waivers already uses ("Ties B. Allen this week") where the Start pick
 * would be, and nothing claims a winner.
 *
 * This replaced the pill tie-break of 16 October 2026, which broke the same
 * close calls by the week's posture (underdog: the Explosive player;
 * favourite: the Steady one) and printed "Close call. You're the underdog, so
 * the higher ceiling gets the nod." It never fired on production: it needed
 * the posture, which is empty whenever Team has not yet seen this week's
 * opponent (the pairing is written when the Matchup screen is opened) or fewer
 * than 60% of either side's starting slots carry a number, and even then it
 * needed the bench player to carry the wanted pill and the starter not to.
 * The posture is still read and recorded with each support snapshot; it no
 * longer decides anything.
 */

/**
 * Points inside which two players tie. The band the old tie-break and the
 * lineup's Floor/Ceiling preference already used (`LINEUP_PREFERENCE_TOLERANCE`).
 */
export const TIE_BAND = 0.6;

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

/** Whether a lead is a tie: both numbers known and the gap inside {@link TIE_BAND}. */
export function isTie(leader: number | null | undefined, runnerUp: number | null | undefined): boolean {
  if (leader == null || runnerUp == null) return false;
  const gap = leader - runnerUp;
  return gap >= 0 && gap <= TIE_BAND + 1e-9;
}
