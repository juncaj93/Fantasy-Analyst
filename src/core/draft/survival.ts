/**
 * Probability a player is still available at the user's next pick.
 *
 * Deliberately a simple, inspectable logistic model — no ML, no training data.
 * It is an estimate and is always labelled as such in the UI.
 *
 * Model: the pick at which a player actually goes is treated as roughly normal
 * around their ADP. P(survives to pick N) = P(actual draft pick > N), which we
 * approximate with a logistic CDF whose spread grows with ADP (later players
 * have much noisier draft capital).
 */

export interface SurvivalInput {
  /** ADP as an overall pick number. Null when unknown. */
  adp: number | null;
  /** The overall pick number currently on the clock. */
  currentPick: number;
  /** The user's next pick number (>= currentPick). */
  nextPick: number;
}

export interface SurvivalEstimate {
  /** Probability in [0,1], or null when ADP is unknown. */
  probability: number | null;
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
      spread: null,
      picksUntilNext,
      note: 'no ADP available, survival unknown',
    };
  }
  if (picksUntilNext === 0) {
    return { probability: 1, spread: null, picksUntilNext: 0, note: 'you are on the clock' };
  }

  const spread = adpSpread(input.adp);
  // P(actual pick > nextPick). Positive z means ADP is later than your next
  // pick, i.e. the player is likely to survive.
  const z = (input.adp - input.nextPick) / spread;
  const probability = 1 / (1 + Math.exp(-LOGISTIC_SCALE * z));

  return {
    probability: round3(probability),
    spread: round3(spread),
    picksUntilNext,
    note: `estimate: ADP ${input.adp} vs your next pick ${input.nextPick}`,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
