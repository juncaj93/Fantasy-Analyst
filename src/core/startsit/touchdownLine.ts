/**
 * A touchdown over/under, as the any-touchdown chance it implies.
 *
 * The odds provider quotes one full-game `touchdowns` over/under per player,
 * and the adapter files it as `anytime_td` whatever its line. Over 0.5 is
 * "scores a touchdown". Over 1.5 is "scores two or more", and by the week-5
 * board of October 2026 that was the line for 14 of Alex's 15 players. Read as
 * an any-touchdown chance it made every market number too low (Bijan Robinson
 * 31%, where his any-touchdown chance is about 64%), so a player ranked on
 * Rotowire's week could beat a fully priced one he should have lost to.
 *
 * Alex chose the conversion (finding F1, option B): keep the betting line as
 * the base and turn the price into the chance it implies. Touchdowns in a game
 * are counted as a Poisson process, the standard model for them: find the rate
 * at which the chance of *more than the line* is the quoted price, then read
 * the chance of at least one at that rate. Over 0.5 is returned unchanged; it
 * already is the any-touchdown chance.
 *
 * A line above 2.5 is not converted and reads as no price at all: three or
 * more touchdowns is too far into the tail for one quote to pin a rate, and
 * the "no number" rule prefers a missing market to a guessed one.
 */

/** The highest line converted. Above it the quote is treated as missing. */
export const MAX_CONVERTED_LINE = 2.5;

/** P(N >= k) for a Poisson count with rate `rate`. */
function atLeast(k: number, rate: number): number {
  let term = Math.exp(-rate);
  let below = term;
  for (let i = 1; i < k; i += 1) {
    term *= rate / i;
    below += term;
  }
  return Math.max(0, Math.min(1, 1 - below));
}

/**
 * The any-touchdown chance a `touchdowns` over/under implies, or null when the
 * quote cannot honestly be read as one.
 *
 * `line` is the quoted line (null or 0.5 for an anytime price), `over` the
 * margin-free chance of the over.
 */
export function anytimeChance(line: number | null, over: number | null): number | null {
  if (over == null || !Number.isFinite(over)) return null;
  const p = Math.max(0, Math.min(1, over));
  if (line == null || line <= 0.5) return p;
  if (!Number.isFinite(line) || line > MAX_CONVERTED_LINE) return null;
  const k = Math.floor(line) + 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // atLeast(k, rate) rises with the rate, so bisection finds the one that fits.
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (atLeast(k, mid) < p) lo = mid;
    else hi = mid;
  }
  const rate = (lo + hi) / 2;
  return 1 - Math.exp(-rate);
}
