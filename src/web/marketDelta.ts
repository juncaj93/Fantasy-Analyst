/**
 * What a market thinks of taking this player *right now*.
 *
 * The draft board used to print two raw market positions and a value column —
 * `ADP 170  DOG 145.1  Val -6` — and every one of those asks the reader to do
 * the same subtraction in their head against the pick that is on the clock. The
 * subtraction is the decision, so the board does it: `ADP +6` says taking him
 * here is six picks ahead of where Sleeper's market has him, and `DOG -19` says
 * he has fallen nineteen picks past where Underdog's has.
 *
 * **This module computes nothing about football.** It subtracts one number the
 * board already published from another the board already published, rounds it,
 * and names the direction. No ranking, no weighting, no blend, no ordering: the
 * sort controls still sort on the raw market values, and this never touches
 * them — see `SORT_MODES` in the Draft screen.
 *
 * The sign convention is deliberately the opposite of the app's usual one, and
 * that is worth stating plainly because it looks like a bug until you read it:
 *
 *  - **positive is bad.** `+6` means the current pick is *earlier* than the
 *    market's, so taking him now costs six picks against that market — a reach.
 *  - **negative is good.** `-19` means he is still on the board nineteen picks
 *    later than that market expected — value.
 *
 * So a `+` is red and a `-` is green here, where everywhere else in this app a
 * `+` is green. The sign itself is always printed, so the meaning survives
 * greyscale, colour blindness and a screen reader without the colour.
 */

/** Which way a delta points, in the terms a drafter thinks in. */
export type MarketDeltaTone = 'reach' | 'value' | 'even';

export interface MarketDelta {
  /** Whole picks, signed. Positive is a reach; negative is value. */
  picks: number;
  tone: MarketDeltaTone;
  /** `+6`, `-19`, `0` — what the row prints. */
  label: string;
}

/**
 * The delta, or null when there is nothing honest to say.
 *
 * Null whenever either side is unknown: a market that has not priced him, a
 * board with no live pick. The caller renders its own unknown mark for that —
 * never a zero, which would read as "he is going at market" and is a different
 * claim entirely.
 */
export function marketDelta(
  marketAdp: number | null | undefined,
  currentPick: number | null | undefined,
): MarketDelta | null {
  if (marketAdp == null || currentPick == null) return null;
  if (!Number.isFinite(marketAdp) || !Number.isFinite(currentPick)) return null;

  /*
   * Rounded to whole picks, and `|| 0` is load-bearing rather than defensive.
   *
   * `Math.round(-0.4)` is `-0` in JavaScript, and `-0` formats as `"-0"` — a
   * row reading `ADP -0` would be claiming a direction the arithmetic did not
   * find. `|| 0` maps both zeroes onto the one the reader means.
   */
  const picks = Math.round(marketAdp - currentPick) || 0;
  const tone: MarketDeltaTone = picks > 0 ? 'reach' : picks < 0 ? 'value' : 'even';
  return { picks, tone, label: picks > 0 ? `+${picks}` : `${picks}` };
}

/**
 * The sentence behind the number, for the control's own tooltip.
 *
 * Explainability at the point of the claim: the row shows the answer, and
 * hovering or long-pressing it says which two numbers produced it. The full
 * provenance — both raw markets, side by side, with their source — stays on the
 * expanded card, which is where the reader goes when the answer is not enough.
 */
export function marketDeltaTitle(
  label: string,
  marketAdp: number,
  currentPick: number,
  delta: MarketDelta,
): string {
  const raw = `${label} ADP ${marketAdp} against pick ${currentPick}`;
  if (delta.tone === 'even') return `${raw}: he is going at about this market`;
  const picks = Math.abs(delta.picks);
  const noun = picks === 1 ? 'pick' : 'picks';
  return delta.tone === 'reach'
    ? `${raw}: taking him here is ${picks} ${noun} ahead of this market`
    : `${raw}: he has lasted ${picks} ${noun} past this market`;
}
