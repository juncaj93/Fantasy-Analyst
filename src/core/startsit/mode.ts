/**
 * Floor, Balanced, Ceiling: which way a toss-up leans (Alex's decision,
 * 5 November 2026; review S3).
 *
 * The mode comes from his 10-point rule (`modeSuggest.ts`): a projected
 * underdog by 10 or more plays Ceiling, a favorite by 10 or more plays Floor,
 * anything closer is Balanced.
 *
 * **The mode changes no number.** Every screen shows the same Balanced number
 * for a player in every mode. Until this date Floor multiplied the Vegas part
 * of a number by 0.9 (Ceiling by 1.2) and reweighted the small nudges, which
 * made Team's numbers differ from every other screen and could never reorder
 * two Vegas-priced players anyway.
 *
 * **The mode only picks the lean inside a toss-up** (a gap under two points,
 * `tossup.ts`): Floor leans to the safer player, Ceiling to the one with more
 * upside, Balanced to the higher expected points. Outside a toss-up expected
 * points decide, whatever the mode. Safe and upside are measured by one shared
 * function, `spread.ts`.
 */

export type StartSitMode = 'balanced' | 'floor' | 'ceiling';

export const START_SIT_MODES: StartSitMode[] = ['balanced', 'floor', 'ceiling'];

/** Parse whatever arrived on the wire. Anything unrecognised is Balanced. */
export function normalizeMode(raw: string | null | undefined): StartSitMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (START_SIT_MODES as string[]).includes(value) ? (value as StartSitMode) : 'balanced';
}
