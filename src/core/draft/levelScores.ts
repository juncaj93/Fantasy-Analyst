/**
 * Which rows on the board are level with the row next to them.
 *
 * The board prints Score as a whole number in [0, 100], and near the top it
 * prints the same whole number several times in a row. That is not a rounding
 * accident to be engineered away — it is the shape of the thing. `draftScore`
 * is `round(100 · logistic((total + 2.5) / 1.6))`, so on a real board the top
 * three composites of 1.1310, 1.1310 and 1.1130 land on 90.63, 90.63 and
 * 90.54. Two of them are an exact tie and the third is nine hundredths of a
 * point behind, which is not a distinction anybody should act on.
 *
 * What that costs the reader is confidence. A player can slide from first to
 * fifth while his Score never moves, because the four players around him are
 * all on the same number and the order among them is settled by a tie-break
 * that legitimately shifts as the draft clock advances. The movement is
 * correct and it reads as arbitrary.
 *
 * So the board says which rows are level. Not by adding precision — printing
 * `90.6` against `90.5` would dress a rounding-level gap as a real difference
 * and make the screen less truthful, not more — but by admitting that two rows
 * showing the same number *are* the same number.
 *
 * Adjacency, not grouping by value: two players three rows apart who happen to
 * share a Score are not what confuses anybody, and marking them would put the
 * mark on most of the board. A run is a run.
 */

/**
 * For each score in board order, whether the row above or below shows the same.
 *
 * `null` is a player no market has priced, whose composite is real but not on
 * the priced scale — he prints a dash rather than a number, so he is never
 * level with anybody and never makes anybody level with him.
 */
export function levelWithNeighbour(scores: (number | null)[]): boolean[] {
  return scores.map((score, i) => {
    if (score == null) return false;
    return scores[i - 1] === score || scores[i + 1] === score;
  });
}

/**
 * How many rows in the run this one belongs to, counting itself.
 *
 * Used for the row's accessible name — "level with two others" is the sentence
 * that explains the movement, and a screen reader gets it in words rather than
 * inferring it from a shared background.
 */
export function levelRunSize(scores: (number | null)[], index: number): number {
  const score = scores[index];
  if (score == null) return 1;
  let size = 1;
  for (let i = index - 1; i >= 0 && scores[i] === score; i--) size++;
  for (let i = index + 1; i < scores.length && scores[i] === score; i++) size++;
  return size;
}
