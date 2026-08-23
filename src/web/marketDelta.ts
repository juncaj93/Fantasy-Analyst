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
 * The colour then follows the *size* of the cost rather than the sign alone — a
 * small reach is not a warning, and painting every `+` red made the colour
 * something the reader learned to look past. See {@link MarketDeltaBand} for
 * where the three bands sit. The sign itself is always printed, so the meaning
 * survives greyscale, colour blindness and a screen reader without the colour.
 */

/** Which way a delta points, in the terms a drafter thinks in. */
export type MarketDeltaTone = 'reach' | 'value' | 'even';

/**
 * How much the delta costs, as one of three words the row can paint.
 *
 * Separate from {@link MarketDeltaTone} on purpose, and the separation is the
 * point. The tone is the *semantics* — a positive delta is a reach, and that is
 * not negotiable. The band is how loudly the row says so, which is a threshold
 * somebody chose and may choose again.
 *
 * Bands are read off the number the row actually prints, so what the reader
 * sees and what the colour means are the same quantity:
 *
 *  - **fair** — `+10` or lower, which includes every negative. Taking a player
 *    up to ten picks ahead of a market is inside the noise of an ADP; painting
 *    it as a cost taught the reader to ignore the colour, because two thirds of
 *    a live board is inside ten picks of one market or the other.
 *  - **steep** — over `+10` and up to `+15`. Worth a second look.
 *  - **costly** — over `+15`. A real reach against this market.
 *
 * `fair` covers value as well as a small reach. That is deliberate: the sign is
 * printed on every row, so `-19` and `+4` are never confusable, and a fourth
 * band for "value" would spend a colour distinguishing two readings the reader
 * already has in front of them in plain digits.
 */
export type MarketDeltaBand = 'fair' | 'steep' | 'costly';

/** At or below this many picks of reach, the delta is fair. */
export const DELTA_FAIR_CEILING = 10;

/** Above {@link DELTA_FAIR_CEILING} and at or below this, it is steep. Above it, costly. */
export const DELTA_STEEP_CEILING = 15;

export interface MarketDelta {
  /** Whole picks, signed. Positive is a reach; negative is value. */
  picks: number;
  tone: MarketDeltaTone;
  /** How the row paints it. See {@link MarketDeltaBand}. */
  band: MarketDeltaBand;
  /** `+6`, `-19`, `0` — what the row prints. */
  label: string;
}

/**
 * The band for a printed delta.
 *
 * Total over every integer, and exported so a test can walk the boundaries
 * rather than trusting three examples: 10 is fair, 11 is steep, 15 is steep,
 * 16 is costly, and every negative is fair.
 */
export function marketDeltaBand(picks: number): MarketDeltaBand {
  if (picks <= DELTA_FAIR_CEILING) return 'fair';
  return picks <= DELTA_STEEP_CEILING ? 'steep' : 'costly';
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
  return { picks, tone, band: marketDeltaBand(picks), label: picks > 0 ? `+${picks}` : `${picks}` };
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
