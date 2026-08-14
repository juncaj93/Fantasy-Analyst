/**
 * The composite, as a number a person can read.
 *
 * The board is ordered by `total` — the sum of every weighted component the
 * engine produces. That number is not showable: on a real board at pick 49 it
 * ran from −17.7 to +0.6, and **the top twenty players occupied 1.59 of that
 * 18.3-point range**, or under nine per cent. It is a ranking key, not a score.
 *
 * This turns it into one, without becoming a second opinion about anybody.
 * `draftScore` is a pure function of `total`: same total, same score, forever,
 * whoever else is on the board.
 *
 * ## Why a logistic and not a linear map
 *
 * The distribution is long-tailed to the left, because market value is
 * proportional to how far a player has fallen and a player two hundred picks
 * past his ADP is hundreds of points of "value" adrift. A linear map over the
 * observed range would put every player worth considering between 96 and 100
 * and every other player at 0 — technically monotonic, and useless.
 *
 * A logistic spends its resolution in the middle and compresses both tails,
 * which is the right shape here: the difference between the best player left
 * and the fourth-best is a decision, and the difference between the 150th and
 * the 180th is not.
 *
 * ## Why the constants are fixed
 *
 * They are calibrated once, against a measured production distribution, and
 * they do not move when the board does. Scaling against the current pool —
 * min-max over available players — would mean a player's score changed because
 * somebody unrelated at the bottom of the board was drafted, which is exactly
 * the instability this must not have.
 */

/**
 * Calibration, measured rather than guessed.
 *
 * From a live board of 195 players at pick 49: median total −5.15, p95 −0.54,
 * best +0.56, worst −17.7. The centre sits below the contested top of the board
 * on purpose, so the players actually being chosen between land in the upper
 * half of the curve where it has the most resolution; the scale is chosen so
 * that top fifteen spans roughly 73–87 rather than all rounding to the same
 * number.
 *
 * Re-derive these with `scripts/probe-score-distribution.mjs` if the weight
 * table ever changes materially. Do not tune them to move one player.
 */
export const SCORE_CALIBRATION = {
  /** The total that maps to 50. */
  centre: -2.5,
  /** Points of total per logistic unit. Larger flattens, smaller sharpens. */
  scale: 1.6,
} as const;

/**
 * A whole number in [0, 100], higher is better.
 *
 * Monotonic in `total` by construction — the logistic is strictly increasing,
 * and rounding preserves order up to ties, which the brief allows and the
 * board's existing tie-breakers resolve.
 */
export function draftScore(total: number): number {
  // Not a number at all is 0; an infinite one still has a direction, and the
  // logistic below already answers it correctly.
  if (Number.isNaN(total)) return 0;
  const z = (total - SCORE_CALIBRATION.centre) / SCORE_CALIBRATION.scale;
  // Written to avoid overflow at the tails: exp(709) is Infinity, and the
  // bottom of a real board is far enough out to reach it.
  const p = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

// --------------------------------------------------- live board separation

/**
 * How much better he is than the players who would replace him.
 *
 * This is the one genuinely new ranking input in this pass, and it exists
 * because of a specific behaviour the board did not have: a strong player who
 * keeps sliding while comparable players come off the board is becoming a
 * better pick, and nothing said so.
 *
 * Half of that was already handled. Market value is a function of how far past
 * his ADP the draft has gone, so a player who falls is already gaining — until
 * it saturates, which it does at about thirty picks of fall. What was missing
 * is the other half: **who is left instead of him**. Three receivers going in
 * the six picks before your turn does not change his ADP by one, and it changes
 * the decision completely.
 *
 * So this measures the gap between him and the next few available players at
 * his own position, and nothing else.
 */
export const SEPARATION = {
  /** How many alternatives behind him count as "who I would take instead". */
  alternatives: 3,
  /**
   * The gap, in composite points, at which separation is as strong as it gets.
   *
   * On the measured board the best receiver led the mean of the next three by
   * 0.71. Full credit at 0.8 makes a genuinely isolated player nearly maximal
   * without making an ordinary half-point edge look like one.
   */
  full: 0.8,
  /**
   * What it is worth, and the ceiling on the whole idea.
   *
   * 0.25 of composite is about five picks of ADP: enough to separate two
   * players the board otherwise rates alike, never enough to carry somebody the
   * market and the ledger both dislike. A player falling twenty picks does not
   * become a lock — he becomes better *relative to what is left*, which is the
   * claim being made.
   */
  weight: 0.25,
} as const;

export interface SeparationInput {
  /** The player's composite *before* this component. */
  base: number;
  /**
   * Composites of the **other** available players at his position, before this
   * component, in any order. He must not be in this list — a player is not one
   * of his own alternatives, and leaving himself in would report a gap of zero
   * for everybody.
   */
  positionBases: number[];
}

export interface SeparationResult {
  /** 0..1. */
  score: number;
  /** Composite points between him and the mean of the next few. */
  gap: number | null;
  /** How many alternatives the gap was measured against. */
  comparedWith: number;
  reason: string;
}

/**
 * Separation from the alternatives, on a 0..1 scale.
 *
 * **Computed from base composites, never from board rank.** That is what keeps
 * it out of a feedback loop: if this fed on ordinal position, a player would
 * score highly because he was ranked highly and rank highly because he scored
 * highly, and the number would drift upward on its own. Base composites are
 * fixed before any of this runs, so the input cannot be moved by its own
 * output.
 *
 * Only players the composite already rates at or below him count as
 * alternatives, so this can add to a player's ranking but never subtract from
 * it. It exists to notice isolation, not to re-litigate the ordering: the
 * best receiver left is measured against the receivers you would take instead
 * of him, and the fifth-best against the sixth.
 */
export function separationScore(input: SeparationInput): SeparationResult {
  const behind = input.positionBases
    .filter((b) => Number.isFinite(b) && b <= input.base)
    .sort((a, b) => b - a)
    .slice(0, SEPARATION.alternatives);

  if (behind.length === 0) {
    return {
      score: 0,
      gap: null,
      comparedWith: 0,
      reason: 'nothing behind him at the position to measure against',
    };
  }

  const mean = behind.reduce((a, b) => a + b, 0) / behind.length;
  const gap = round3(input.base - mean);
  const score = clamp01(gap / SEPARATION.full);
  return {
    score: round3(score),
    gap,
    comparedWith: behind.length,
    reason:
      score <= 0
        ? `no separation from the next ${behind.length} at the position`
        : `${gap} clear of the next ${behind.length} available at the position`,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  // -0 is a real value in JavaScript and it prints as "-0". Nothing here has a
  // signed zero to express.
  return r === 0 ? 0 : r;
}
