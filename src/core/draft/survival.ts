/**
 * Probability a player is still available at the user's next pick.
 *
 * Deliberately a simple, inspectable model — no ML, no training data. It is an
 * estimate and is always labelled as such in the UI.
 *
 * The pick a player actually goes at is treated as roughly normal around his
 * ADP, approximated with a logistic CDF whose spread grows with ADP (a player
 * ranked 120th routinely goes twenty picks either side; the first pick does
 * not). Write `S(x)` for the chance he lasts past pick `x`.
 *
 * The number that matters is **conditional**. The board already knows something
 * the distribution does not: he is still here *now*. A player with ADP 45 who
 * is on the board at pick 60 has plainly been passed over by everyone who was
 * meant to take him, and asking `S(68)` outright answers a question about pick
 * 30 — it returns 5%, which is both wrong and useless with a clock running.
 * What is asked instead is
 *
 *     P(lasts to your next pick | lasted to the current pick) = S(next) / S(now)
 *
 * which for that player is about 38%: he is being passed over, and the estimate
 * says so. Far past his ADP the ratio settles into a constant hazard per pick,
 * which is the honest shape — every pick that goes by is another team declining
 * him, not evidence he is about to go.
 */

// --------------------------------------------------------------- thresholds

/**
 * Where the colour changes.
 *
 * Round numbers on purpose — roughly a third and two thirds — because a reader
 * has to hold them in their head between picks. Defined here rather than in the
 * screen so the band and the number can never come from different rules.
 */
export const SURVIVAL_BANDS = {
  /** At or below: he will not last. */
  gone: 0.3,
  /** Below: a coin flip. At or above: there is time. */
  safe: 0.66,
} as const;

export type SurvivalBand = 'unknown' | 'gone' | 'coinflip' | 'safe';

export function survivalBand(probability: number | null): SurvivalBand {
  if (probability == null) return 'unknown';
  if (probability <= SURVIVAL_BANDS.gone) return 'gone';
  if (probability < SURVIVAL_BANDS.safe) return 'coinflip';
  return 'safe';
}

export interface SurvivalInput {
  /** ADP as an overall pick number. Null when unknown. */
  adp: number | null;
  /** The overall pick number currently on the clock. */
  currentPick: number;
  /** The user's next pick number, straight from the live snake order. */
  nextPick: number;
}

export interface SurvivalEstimate {
  /** Probability in [0,1], or null when ADP is unknown. Conditional on now. */
  probability: number | null;
  /** The same thing ignoring that he is still on the board, for inspection. */
  unconditional: number | null;
  /** Standard-deviation-like spread used, exposed for inspection. */
  spread: number | null;
  /** How many picks between now and the user's next selection. */
  picksUntilNext: number;
  note: string;
}

/**
 * ADP noise grows with draft position. Round 1 picks go close to ADP; a player
 * with ADP 120 routinely goes 20 picks either side.
 */
export function adpSpread(adp: number): number {
  return Math.max(4, 3 + 0.22 * adp);
}

const LOGISTIC_SCALE = 1.702; // logistic approximation to the normal CDF

export function estimateSurvival(input: SurvivalInput): SurvivalEstimate {
  const picksUntilNext = Math.max(0, input.nextPick - input.currentPick);

  if (input.adp == null || !Number.isFinite(input.adp)) {
    return {
      probability: null,
      unconditional: null,
      spread: null,
      picksUntilNext,
      note: 'no ADP available, survival unknown',
    };
  }
  if (picksUntilNext === 0) {
    return {
      probability: 1,
      unconditional: 1,
      spread: null,
      picksUntilNext: 0,
      note: 'you are on the clock',
    };
  }

  const spread = adpSpread(input.adp);
  const z = (pick: number) => (LOGISTIC_SCALE * (input.adp! - pick)) / spread;

  /*
   * Computed as a ratio of logs, not of probabilities.
   *
   * Deep in the tail both survival terms underflow to zero and the ratio
   * becomes 0/0 — which is precisely the case this model exists to handle, the
   * player long past his ADP who is somehow still there.
   */
  const logRatio = softplus(-z(input.currentPick)) - softplus(-z(input.nextPick));
  const probability = clamp01(Math.exp(logRatio));
  const unconditional = logistic(z(input.nextPick));

  return {
    probability: round3(probability),
    unconditional: round3(unconditional),
    spread: round3(spread),
    picksUntilNext,
    note: `estimate: ADP ${input.adp}, still available at pick ${input.currentPick}, your next pick is ${input.nextPick}`,
  };
}

function logistic(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** log(1 + e^x), without overflowing for large x. */
function softplus(x: number): number {
  return x > 30 ? x : Math.log1p(Math.exp(x));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
