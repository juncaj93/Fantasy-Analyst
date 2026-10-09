/**
 * Breaking a close call with the shape of each player's week.
 *
 * Pills (`pills.ts`) never change a score. They are allowed to decide between
 * two players only when the scores are inside {@link PILL_TIEBREAK_BAND}, the
 * same band inside which the lineup already lets Floor and Ceiling choose
 * (`LINEUP_PREFERENCE_TOLERANCE`), and only in one direction per week:
 *
 *  - **an underdog** in his matchup wants the higher ceiling: Explosive;
 *  - **a favourite** wants the safer floor: Steady.
 *
 * Which one he is comes from the projected margin of his matchup, the same
 * reading the lineup's posture is built from (`modeSuggest.ts`). Unknown means
 * no tie-break at all, never a guess.
 */

import type { Pill } from './pills.ts';

/** Points inside which two players are a close call. Equal to `LINEUP_PREFERENCE_TOLERANCE`. */
export const PILL_TIEBREAK_BAND = 0.6;

export type Posture = 'underdog' | 'favourite';

/** Underdog below zero, favourite above, nothing when unknown or dead level. */
export function postureFrom(margin: number | null | undefined): Posture | null {
  if (margin == null || !Number.isFinite(margin) || margin === 0) return null;
  return margin < 0 ? 'underdog' : 'favourite';
}

export function wantedPill(posture: Posture): Pill {
  return posture === 'underdog' ? 'explosive' : 'steady';
}

/** The one line the Best move card and the Compare verdict print. */
export function tiebreakSentence(posture: Posture): string {
  return posture === 'underdog'
    ? "Close call. You're the underdog, so the higher ceiling gets the nod."
    : "Close call. You're the favourite, so the safer floor gets the nod.";
}

export interface TiebreakNote {
  pill: Pill;
  posture: Posture;
  sentence: string;
}

/**
 * Whether `challenger` should take the spot from `holder` on the tie-break.
 *
 * Both need a number; the gap (holder minus challenger) must be inside the
 * band; the challenger must carry the pill this week wants and the holder
 * must not.
 */
export function tiebreakFavours(
  holder: { points: number | null; pill?: { pill: Pill } | null | undefined },
  challenger: { points: number | null; pill?: { pill: Pill } | null | undefined },
  posture: Posture | null,
): TiebreakNote | null {
  if (posture == null) return null;
  if (holder.points == null || challenger.points == null) return null;
  if (holder.points - challenger.points > PILL_TIEBREAK_BAND) return null;
  const wanted = wantedPill(posture);
  if (challenger.pill?.pill !== wanted || holder.pill?.pill === wanted) return null;
  return { pill: wanted, posture, sentence: tiebreakSentence(posture) };
}
