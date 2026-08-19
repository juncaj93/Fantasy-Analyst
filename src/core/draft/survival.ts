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
  /**
   * How wide this room's own draft order is running against the market.
   *
   * 1 is the published market. Below 1 is a room that has been tracking ADP
   * tightly, so the distribution narrows and the board becomes more
   * predictable; above 1 is a room full of reaches, where everything is
   * likelier to move early and likelier to fall. Measured from the picks
   * already made — see `readRoom` — and bounded, because a dozen picks is not
   * enough evidence to rewrite the market.
   */
  dispersion?: number;
  /**
   * The pick he would have to survive to if you passed on him now.
   *
   * **Never the pick on the clock.** On the clock that is the selection being
   * made, and asking whether a player available now is available now is a
   * question with one answer for everybody — see `waitHorizonForSlot`, which is
   * where this comes from.
   *
   * `null` on the final selection of a draft: there is no later pick, so there
   * is nothing to survive to and the answer is unknown rather than certain.
   */
  nextPick: number | null;
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
 * How far a room may be allowed to disagree with the market.
 *
 * A room that has taken twelve players within a pick of their ADP is a more
 * predictable room than the published market describes, and one that has been
 * reaching wildly is a less predictable one. Both are real, and neither is
 * worth more than a modest adjustment: a draft is a few dozen observations of
 * a distribution built from thousands.
 */
export const DISPERSION_BOUNDS = { min: 0.75, max: 1.35 } as const;

/**
 * ADP noise grows with draft position. Round 1 picks go close to ADP; a player
 * with ADP 120 routinely goes 20 picks either side.
 *
 * `dispersion` scales the whole curve for a room that is running tighter or
 * looser than the market. It defaults to 1, which is the market as published.
 */
export function adpSpread(adp: number, dispersion = 1): number {
  const base = Math.max(4, 3 + 0.22 * adp);
  return base * clamp(dispersion, DISPERSION_BOUNDS.min, DISPERSION_BOUNDS.max);
}

/**
 * How idiosyncratic the room becomes as the draft runs on.
 *
 * ## Why this exists, and why it is not a wider spread
 *
 * Late `Next%` was far too confident: pick 148, next pick 153, a player at ADP
 * 164, and the board said he was as good as certain to last. The obvious repair
 * is to widen `adpSpread` late, and it is the wrong one — measured, it makes the
 * problem worse. For a player sitting *before* his ADP the per-pick hazard is
 * `1.702 · (1 − S) / spread`; widening raises `(1 − S)` a little and divides by
 * a much larger spread, so survival goes **up**:
 *
 *     spread 39 (today)   148 -> 153, ADP 164:  92.5%
 *     spread 60                                  94.4%
 *     spread 90                                  96.0%
 *     spread 140                                 97.3%
 *
 * A wider symmetric distribution says "we are less sure where he goes", but the
 * question here is not where he goes — it is whether anyone takes him in the
 * next five picks, and a flatter curve spreads that risk *away* from the picks
 * immediately ahead.
 *
 * What actually happens late in a draft is different in kind. Managers stop
 * drafting the board and start drafting their guy: a handcuff somebody has
 * wanted since July, a stack, a rookie, a name from a podcast. ADP stops
 * describing the room. That is not extra variance around the market ordering,
 * it is a floor under everybody's chance of being taken regardless of ordering —
 * so that is what this is.
 *
 * The result is that near-certainty late has to be earned by a short wait
 * rather than granted by a distant ADP, which is exactly the brief's ask.
 *
 * ## The numbers
 *
 * Deliberately gentle. At full strength one late pick in forty goes to somebody
 * the market did not expect, which over a fourteen-pick wait is about a third of
 * a chance — enough to turn "certain" into "likely", never enough to make a
 * three-pick wait look risky.
 *
 * ## Keyed on the draft, not on the player
 *
 * The depth that matters is **where the intervening picks are**, not how deep
 * the player is. Being idiosyncratic is a property of a phase of a draft: in
 * round two managers take the board, and they do that whether the player under
 * consideration is ranked twentieth or hundred-and-twentieth. Keying this on
 * the player's own ADP instead said that a receiver at ADP 120 might vanish
 * between picks 15 and 30 — ninety picks before anyone was close to taking him —
 * which is not late-round chaos, it is arithmetic applied in the wrong place.
 */
export const LATE_NOISE = {
  /** Before this *pick*, the market explains the room and this adds nothing. */
  onset: 60,
  /** The pick by which the effect reaches full strength. */
  saturation: 200,
  /** Per-pick probability, at full strength, of being taken for reasons ADP cannot see. */
  maxHazard: 0.025,
  /**
   * How much Underdog pricing him earlier than Sleeper may widen that tail.
   *
   * A **multiplier on the late-round term, never an addend**, and that shape is
   * the whole of "DOG stays secondary". Written as its own hazard it was worth
   * more than the entire Sleeper ADP range in the deep-late regime — the market
   * model is nearly flat there, so an independent DOG term simply took over. As
   * a gain on a base that is zero for the whole early board, DOG cannot act on
   * its own at any depth: it can widen a tail that draft depth already opened,
   * by at most half again, and it can never open one.
   *
   * A player Sleeper has at 164 and Underdog at 126 is one sharp drafters like
   * more than this room's ADP implies, and the honest effect is *less
   * confidence that he lasts* — never a different central estimate of where he
   * goes.
   */
  disagreementGain: 0.5,
  /** How far DOG must lead Sleeper, in picks, for that gain to reach its cap. */
  disagreementFull: 40,
} as const;

/**
 * Per-pick probability that somebody takes him for reasons his ADP cannot see.
 *
 * Zero for the whole of the early board, so nothing about round one changes.
 */
export function idiosyncraticHazard(
  currentPick: number | null,
  opts: { adp?: number | null; dogAdp?: number | null } = {},
): number {
  if (currentPick == null || !Number.isFinite(currentPick)) return 0;
  const { onset, saturation, maxHazard, disagreementGain, disagreementFull } = LATE_NOISE;
  const depth = clamp((currentPick - onset) / (saturation - onset), 0, 1);
  const base = maxHazard * depth;
  if (base === 0) return 0;

  /*
   * And Underdog, as a gain on that base rather than a term beside it.
   *
   * Only the direction that means danger counts: DOG *earlier* than Sleeper is
   * early-selection risk this room's ADP has not priced. DOG later than Sleeper
   * is not evidence he lasts longer — the room drafts against Sleeper — so it is
   * ignored rather than rewarded.
   */
  const { adp, dogAdp } = opts;
  const leads =
    adp == null || dogAdp == null || !Number.isFinite(adp) || !Number.isFinite(dogAdp)
      ? 0
      : Math.max(0, adp - dogAdp);
  const gain = 1 + disagreementGain * clamp(leads / disagreementFull, 0, 1);

  return Math.round(base * gain * 10_000) / 10_000;
}

/** `(1 - hazard)` compounded over `picks` selections, in [0, 1]. */
export function idiosyncraticSurvival(hazard: number, picks: number): number {
  if (hazard <= 0 || picks <= 0) return 1;
  return Math.pow(1 - clamp(hazard, 0, 1), Math.max(0, picks));
}

const LOGISTIC_SCALE = 1.702; // logistic approximation to the normal CDF

/**
 * The chance the market has not yet reached him at a given pick, `S(pick)`.
 *
 * The single definition of the ADP distribution in this codebase. Everything
 * that asks a question about where a player goes — the conditional estimate
 * below, the simulator's per-pick hazard, the diagnostics — goes through this
 * or through the two functions under it, so there is one curve to tune and one
 * curve to test.
 */
export function marketSurvivalAt(adp: number, pick: number, dispersion = 1): number {
  return logistic((LOGISTIC_SCALE * (adp - pick)) / adpSpread(adp, dispersion));
}

/**
 * `P(lasts to `to` | lasted to `from`)` — the number this file exists for.
 *
 * Computed as a difference of logs rather than a ratio of probabilities:
 * deep in the tail both terms underflow to zero and the ratio becomes 0/0,
 * which is precisely the case that matters — the player long past his ADP who
 * is somehow still on the board.
 */
export function conditionalMarketSurvival(
  adp: number,
  from: number,
  to: number,
  dispersion = 1,
  opts: { dogAdp?: number | null } = {},
): number {
  if (!Number.isFinite(adp)) return 0;
  if (to <= from) return 1;
  const spread = adpSpread(adp, dispersion);
  const z = (pick: number) => (LOGISTIC_SCALE * (adp - pick)) / spread;
  const ordered = clamp01(Math.exp(softplus(-z(from)) - softplus(-z(to))));
  /*
   * And the picks that were never about the ordering.
   *
   * Compounded over the selections actually in the way, so a three-pick wait
   * barely notices it and a fourteen-pick wait late in a draft does. See
   * `idiosyncraticHazard`.
   */
  return clamp01(
    ordered * idiosyncraticSurvival(idiosyncraticHazard(from, { adp, dogAdp: opts.dogAdp ?? null }), to - from),
  );
}

/**
 * How ready the market is to take this player at this exact pick, in [0,1).
 *
 * The hazard of the same distribution, up to the constant `1/spread` that the
 * simulator normalises away: `1 - S(pick)`. It is 0.5 at his ADP, small before
 * it, and it *saturates* rather than growing without bound after it.
 *
 * That ceiling is the whole point. A player fifty picks past his ADP is at the
 * top of what the market can say about him — the room has been declining him
 * every pick, and a distribution that kept climbing would claim he is more
 * certain to go than the best player available, which is the opposite of what
 * the board is showing. It is also why the simulator needs no separate
 * "falling player" term: he already carries roughly twice the weight of a
 * player being taken at his own ADP, and no more.
 */
export function marketPickWeight(adp: number, pick: number, dispersion = 1): number {
  if (!Number.isFinite(adp)) return 0;
  return 1 - marketSurvivalAt(adp, pick, dispersion);
}

export function estimateSurvival(input: SurvivalInput): SurvivalEstimate {
  /*
   * No later pick at all — the last selection of the draft.
   *
   * There is nothing to survive to, so there is no probability. This used to
   * arrive here as "next pick = this pick" and come back as a confident 100%,
   * which is the opposite of what it means: not "he is certain to be there"
   * but "there is no there".
   */
  if (input.nextPick == null) {
    return {
      probability: null,
      unconditional: null,
      spread: null,
      picksUntilNext: 0,
      note: 'no pick after this one, so there is nothing for him to last until',
    };
  }

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
    // S(x)/S(x). True, and no longer reachable from a board: the horizon is
    // always a pick later than the one on the clock.
    return {
      probability: 1,
      unconditional: 1,
      spread: null,
      picksUntilNext: 0,
      note: 'the horizon is this pick, so there is nothing to wait through',
    };
  }

  const dispersion = input.dispersion ?? 1;
  const spread = adpSpread(input.adp, dispersion);
  const probability = conditionalMarketSurvival(input.adp, input.currentPick, input.nextPick, dispersion);
  const unconditional = marketSurvivalAt(input.adp, input.nextPick, dispersion);

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

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
