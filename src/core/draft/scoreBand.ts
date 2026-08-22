/**
 * How strong a Score is, said as one of three words.
 *
 * The draft board prints a composite from 0 to 100 beside every player, and a
 * number on its own asks the reader to hold the whole board in their head to
 * know whether 74 is good. This turns it into a verdict — strong, fair, weak —
 * which the screen paints on the numeral and states in words for anyone not
 * looking at the colour.
 *
 * **It decides nothing about the board.** Not the order, not the score, not
 * what is on it. The scores arrive already computed by the engine and this
 * reads them; a change here cannot move a player by one place. See
 * `docs/MODEL_INTEGRITY.md` for why that boundary matters and
 * `core/draft/engine.ts` for the thing on the other side of it.
 *
 * Two signals, blended, and the blend is the whole design:
 *
 *  1. **Absolute anchors.** 80 and over is strong, 60 to 79 is fair, under 60
 *     is weak. These are what make the colour mean the same thing on Tuesday as
 *     it did on Sunday — a board read purely by percentile would paint a green
 *     number on the best of a bad lot and teach the reader nothing.
 *  2. **Where the board actually sits.** A pool can be compressed, or uniformly
 *     weak, or uniformly strong, and the absolute bands then say the same word
 *     about every row — which is also useless. So a player who is clearly at
 *     the top of *this* pool can be promoted one band, and one clearly at the
 *     bottom demoted one band.
 *
 * Three rules keep the second signal from making the colour twitchy, which is
 * the failure mode that would make it worth less than no colour at all:
 *
 *  - **the pool has to have a shape.** Context does nothing until the scores
 *    actually spread — see {@link CONTEXT_SPREAD}. A board where everybody is
 *    on 90 has no top and no bottom, and painting one of them red because it is
 *    a point behind would be inventing a difference.
 *  - **being at the edge is not enough; the gap has to be material.** A player
 *    in the top quarter is only promoted if he is {@link MATERIAL_GAP} clear of
 *    the median. Percentiles alone would promote somebody a point above the
 *    middle of a tight board.
 *  - **one band, never two.** The most context can do is move a verdict to its
 *    neighbour, so nothing goes from red to green because one player was drafted
 *    and the pool shifted under it.
 *
 * Everything here is a pure function of the numbers it is handed, so the same
 * board always produces the same colours — there is nothing to cache, nothing
 * to time out, and no service to be down.
 */

/** The verdict on one Score. `unknown` is the honest answer for an unpriced player. */
export type ScoreBand = 'strong' | 'fair' | 'weak' | 'unknown';

/** At or above this, a Score is strong whatever the rest of the board is doing. */
export const STRONG_FLOOR = 80;

/** At or above this — and below {@link STRONG_FLOOR} — it is fair. Below it, weak. */
export const FAIR_FLOOR = 60;

/**
 * How far the pool must spread before its shape is allowed to say anything.
 *
 * Twelve points, which is a real difference on a 0-100 composite and about the
 * width of a tier. Under it the board is telling the reader that these players
 * are interchangeable, and the colour should agree rather than manufacture a
 * ranking out of rounding.
 */
export const CONTEXT_SPREAD = 12;

/**
 * How far clear of the median a player must be for his position in the pool to
 * count as a fact about him rather than about where the middle happens to fall.
 */
export const MATERIAL_GAP = 6;

/** The share of the pool at each end that context is even willing to look at. */
export const EDGE_QUANTILE = 0.25;

/**
 * The reading of one Score against the pool it was drawn from.
 *
 * `pool` is the Scores of the candidates the reader is actually looking at —
 * the board after its filter and its search, not the whole player universe,
 * because "strong for a tight end" is the question being asked when the tight
 * end filter is on. Nulls are dropped rather than counted as zero: an unpriced
 * player has no Score, and treating him as the worst on the board would drag
 * the median down with a number nobody computed.
 */
export function scoreBand(score: number | null | undefined, pool: readonly (number | null | undefined)[]): ScoreBand {
  if (score == null || !Number.isFinite(score)) return 'unknown';

  const absolute = absoluteBand(score);
  const finite = [...pool].filter((s): s is number => s != null && Number.isFinite(s)).sort((a, b) => a - b);

  /*
   * Two candidates is not a distribution.
   *
   * A median, a quartile and a spread all need something to be a shape of, and
   * on a board filtered down to a couple of players the absolute anchors are
   * the only honest reading left.
   */
  if (finite.length < 4) return absolute;

  const spread = finite[finite.length - 1]! - finite[0]!;
  if (spread < CONTEXT_SPREAD) return absolute;

  const middle = quantile(finite, 0.5);
  if (score >= quantile(finite, 1 - EDGE_QUANTILE) && score - middle >= MATERIAL_GAP) return promote(absolute);
  if (score <= quantile(finite, EDGE_QUANTILE) && middle - score >= MATERIAL_GAP) return demote(absolute);
  return absolute;
}

/**
 * Every band on a board, in the order the scores were given.
 *
 * The pool is the same list, so a screen colouring forty rows sorts once here
 * rather than forty times — and, more to the point, every row on one board is
 * read against exactly the same distribution.
 */
export function scoreBands(scores: readonly (number | null | undefined)[]): ScoreBand[] {
  return scores.map((score) => scoreBand(score, scores));
}

/** The word the band is, for a title and an accessible name. Never colour alone. */
export function scoreBandLabel(band: ScoreBand): string {
  return band === 'strong' ? 'strong' : band === 'fair' ? 'fair' : band === 'weak' ? 'weak' : 'not comparable';
}

function absoluteBand(score: number): ScoreBand {
  if (score >= STRONG_FLOOR) return 'strong';
  return score >= FAIR_FLOOR ? 'fair' : 'weak';
}

function promote(band: ScoreBand): ScoreBand {
  return band === 'weak' ? 'fair' : band === 'fair' ? 'strong' : band;
}

function demote(band: ScoreBand): ScoreBand {
  return band === 'strong' ? 'fair' : band === 'fair' ? 'weak' : band;
}

/**
 * The linear-interpolated quantile of an already-sorted list.
 *
 * The same definition NumPy and R's type 7 use, so "the 75th percentile" means
 * what a reader checking this by hand would expect it to mean rather than
 * whatever an index rounding happened to land on.
 */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}
