/**
 * What passing on him actually costs.
 *
 * The board already answers "how good is he" from six directions. It has never
 * answered the question a drafter actually asks with a clock running, which is
 * not about him at all:
 *
 * > If I take somebody else now, what is still here when my turn comes round?
 *
 * Two different facts hide inside that question, and conflating them is the way
 * this feature goes wrong. They are separated here on purpose, measured from
 * different quantities, and then added together exactly once under a single cap.
 *
 *   - **Opportunity cost** is about *count*. Nine receivers rated within a
 *     whisker of this one will not all disappear in eleven picks; two backs
 *     might. It reads how many *comparable* players are expected to survive and
 *     says nothing about how much better he is than them.
 *
 *   - **Replacement value** is about *size*. It reads the gap between him and
 *     the best player expected to still be there at your next pick — the
 *     VORP-shaped question, but against this board and your actual next
 *     selection rather than against a league-average replacement level that
 *     nobody in this draft is choosing between.
 *
 * A thin position with a small drop scores on the first and not the second. A
 * deep position with one outstanding player scores on the second and not the
 * first. Both at once is the case that deserves both, and the cap is what stops
 * that from becoming a third of a round.
 *
 * ## What this must not double-count, and how it avoids it
 *
 * Three components already on the board are in the neighbourhood:
 *
 *   - `separation` (score.ts) pays a player for being clear of the next few
 *     alternatives **now**. Replacement value measures the gap **later**, so the
 *     part they share is real: this module subtracts the separation gap from the
 *     replacement gap and scores only what is left, which is precisely "what
 *     waiting costs" rather than "how good he is".
 *   - `scarcity` (need.ts) counts remaining ADPs at the position. It cannot see
 *     quality: at the moment it matters, the last two startable backs and the
 *     last two backs of any kind look identical to it. Opportunity cost counts
 *     only players the composite rates comparably, which is a different
 *     population and a different claim.
 *   - `tier_cliff` (tiers.ts) measures ADP *spacing*. It knows the gap after him
 *     is unusually wide; it does not know whether the players inside the gap
 *     survive to your pick, which is the only thing that decides whether the
 *     gap costs you anything.
 *
 * The remaining overlap is bounded rather than argued away: the combined
 * contribution can never exceed {@link OPPORTUNITY.weight}.
 *
 * ## Bounded so BPA still wins
 *
 * 0.3 of composite is about six picks of ADP — enough to lift a back over a
 * receiver the market rates one or two spots higher, never enough to lift him
 * over one it rates a round higher. A clearly better player stays ahead of a
 * clearly worse one whose position is thin, which is the rule the whole board
 * is built on and this component is not an exception to it.
 *
 * Pure and deterministic. Nothing here reads the clock, the network, or the
 * board's own output.
 */

/** Everything this module is allowed to be worth, and how it is split. */
export const OPPORTUNITY = {
  /**
   * How close in composite another player has to be to count as comparable.
   *
   * 0.35 is a little under half of {@link SEPARATION.full}, the gap the board
   * already treats as decisive separation from the alternatives. Anybody inside
   * it is a player you would be content to take instead; anybody outside it is
   * a downgrade, and counting him as a comparable alternative would be telling
   * the user their position is fine when it is not.
   */
  comparableBand: 0.35,
  /**
   * Expected comparable survivors at which the position stops being a worry.
   *
   * Three, matching `SEPARATION.alternatives` — the same "who would I take
   * instead" horizon the separation component uses, so the two are answering
   * the same question at two different times rather than two questions.
   */
  comfortableSurvivors: 3,
  /**
   * The replacement gap, in composite points, at which that half saturates.
   *
   * Deliberately the same 0.8 the separation component measured against a live
   * board, where the gap between a player and the mean of his next three ran
   * p50 0.33 and p90 0.89. A replacement gap is that quantity projected forward,
   * so it lives on the same scale and saturating it somewhere else would make
   * the two components incomparable for no reason.
   */
  fullGap: 0.8,
  /** The combined ceiling, in composite points. About six picks of ADP. */
  weight: 0.3,
  /**
   * How the ceiling is split.
   *
   * Replacement value takes slightly more because it is the more actionable of
   * the two: "the next one is much worse" is a reason to act, where "there are
   * only two left" is a reason to worry.
   */
  share: { opportunity: 0.45, replacement: 0.55 },
  /**
   * How much of the component survives when the roster does not need the
   * position at all.
   *
   * A fourth tight end being scarce is not a reason to draft a fourth tight
   * end. This is a damper rather than a gate: scarcity at a filled position
   * still means something in a deep league, just much less.
   */
  satisfiedDamping: 0.4,
} as const;

/** One available player at the same position, as this module needs him. */
export interface Alternative {
  /** The composite before separation and before this component. */
  base: number;
  /**
   * Probability he lasts to your next pick, from `estimateSurvival`.
   *
   * `null` when his ADP is unknown, which is not a zero: an unpriced player is
   * a player nobody can say anything about, and treating that as "certainly
   * gone" would manufacture scarcity out of a gap in the ADP file.
   */
  survival: number | null;
}

export interface OpportunityInput {
  /** The player's composite before separation and before this component. */
  base: number;
  /**
   * Every other available player at his position. He must not be in this list.
   *
   * Players the composite rates *above* him are included and then ignored for
   * the comparable count — see `evaluateOpportunity`. They still matter to the
   * replacement calculation, because a better player surviving is the best
   * possible thing that can happen to your next pick.
   */
  alternatives: Alternative[];
  /**
   * The separation gap this player has already been paid for, in composite
   * points. Pass 0 when the separation component did not run.
   */
  separationGap: number;
  /**
   * How badly the roster needs this position, 0..1, as `computeNeed` scores it.
   *
   * Only ever used to damp: a position with nothing left to fill gets
   * {@link OPPORTUNITY.satisfiedDamping} of the component and no more.
   */
  needScore: number;
  /** Null when there is no later pick, which makes the whole question moot. */
  nextPick: number | null;
}

export interface OpportunityResult {
  /** Combined 0..1 score. Never negative — this component only ever adds. */
  score: number;
  /** The scarcity half, 0..1. */
  opportunityScore: number;
  /** The size half, 0..1, after the separation gap has been netted out. */
  replacementScore: number;
  /** Expected number of comparable players still there at your next pick. */
  expectedComparableSurvivors: number | null;
  /** Composite of the best alternative expected to be available then. */
  expectedReplacement: number | null;
  /** `base - expectedReplacement`, before netting. Null when unknowable. */
  replacementValueRaw: number | null;
  /** The part of that gap this component actually scored. */
  replacementValueNet: number | null;
  /** How much of the pool could be priced at all. */
  confidence: 'high' | 'medium' | 'low';
  /** The single sentence the breakdown shows. Never a bare label. */
  reason: string;
  /** The one driver worth a bullet, or null when neither half is loud. */
  driver: string | null;
}

const UNKNOWN: OpportunityResult = {
  score: 0,
  opportunityScore: 0,
  replacementScore: 0,
  expectedComparableSurvivors: null,
  expectedReplacement: null,
  replacementValueRaw: null,
  replacementValueNet: null,
  confidence: 'low',
  reason: 'no later pick to measure what waiting would cost',
  driver: null,
};

/**
 * Score both halves and combine them once.
 *
 * The arithmetic is short; the care is all in which population each half reads.
 */
export function evaluateOpportunity(input: OpportunityInput): OpportunityResult {
  if (input.nextPick == null) return UNKNOWN;

  const priced = input.alternatives.filter((a) => Number.isFinite(a.base) && a.survival != null);
  if (priced.length === 0) {
    return {
      ...UNKNOWN,
      reason: 'nothing else at the position can be priced, so the cost of waiting is unknown',
    };
  }

  // --- the scarcity half ----------------------------------------------------
  // Only players he could be swapped for: rated at or below him, and inside the
  // comparable band. Somebody 0.9 of composite worse is not an alternative, he
  // is what you settle for, and counting him would report a healthy position.
  const comparable = priced.filter(
    (a) => a.base <= input.base && input.base - a.base <= OPPORTUNITY.comparableBand,
  );
  const expectedSurvivors = round2(comparable.reduce((total, a) => total + (a.survival ?? 0), 0));
  const opportunityScore = clamp01(1 - expectedSurvivors / OPPORTUNITY.comfortableSurvivors);

  // --- the size half --------------------------------------------------------
  const replacement = expectedBestAvailable(priced);
  const rawGap = replacement == null ? null : round3(input.base - replacement);
  /*
   * Netting, which is the whole double-counting guard in one line.
   *
   * `separationGap` is what the board already paid him for standing clear of
   * the players behind him *now*. Whatever is left is the part that only exists
   * because you would be waiting — the alternatives that disappear between this
   * pick and yours. Scoring the whole gap would pay for the same distance
   * twice, once as separation and once as replacement value.
   */
  const netGap = rawGap == null ? null : round3(Math.max(0, rawGap - Math.max(0, input.separationGap)));
  const replacementScore = netGap == null ? 0 : clamp01(netGap / OPPORTUNITY.fullGap);

  const blended =
    OPPORTUNITY.share.opportunity * opportunityScore + OPPORTUNITY.share.replacement * replacementScore;
  // Roster context, applied to the combined figure rather than to either half,
  // so the damping cannot change which of the two is doing the talking.
  const damping = input.needScore <= 0.2 ? OPPORTUNITY.satisfiedDamping : 1;
  const score = round3(clamp01(blended) * damping);

  const coverage = priced.length / Math.max(1, input.alternatives.length);
  const confidence: 'high' | 'medium' | 'low' =
    coverage >= 0.8 && priced.length >= 3 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';

  return {
    score,
    opportunityScore: round3(opportunityScore),
    replacementScore: round3(replacementScore),
    expectedComparableSurvivors: expectedSurvivors,
    expectedReplacement: replacement,
    replacementValueRaw: rawGap,
    replacementValueNet: netGap,
    confidence,
    reason: describe(expectedSurvivors, netGap, damping),
    driver: driverOf(opportunityScore, replacementScore, expectedSurvivors, netGap),
  };
}

/**
 * The composite of the best player expected to be available at your next pick.
 *
 * Exact under one stated assumption: that the alternatives survive
 * independently. They do not quite — a run on the position takes several at
 * once — and the error is in the safe direction, because correlated departures
 * make the *best* survivor worse than this says, not better. A model that
 * overstates what will be left is a model that tells you to wait; this one
 * would rather be slightly too willing to wait than manufacture urgency.
 *
 *     E[best] = Σ base_i · P(i survives) · Π_{j better than i} P(j does not)
 *
 * with the residual probability that nobody survives assigned to the worst
 * alternative on the list. That is conservative too: the true replacement in
 * that case is somebody off the end of the pool, who is worse.
 */
export function expectedBestAvailable(alternatives: Alternative[]): number | null {
  const sorted = alternatives
    .filter((a) => Number.isFinite(a.base) && a.survival != null)
    .sort((a, b) => b.base - a.base);
  if (sorted.length === 0) return null;

  let noneYet = 1;
  let expected = 0;
  for (const candidate of sorted) {
    const survival = clamp01(candidate.survival ?? 0);
    expected += candidate.base * survival * noneYet;
    noneYet *= 1 - survival;
  }
  // Whatever probability is left over is "the position is empty by then". The
  // floor is the worst alternative actually on the board rather than a number
  // invented for the occasion.
  expected += (sorted.at(-1)?.base ?? 0) * noneYet;
  return round3(expected);
}

function describe(survivors: number, netGap: number | null, damping: number): string {
  const bits: string[] = [];
  bits.push(
    survivors === 0
      ? 'no comparable alternative expected to last'
      : survivors < 1
        ? 'less than one comparable alternative expected to last'
        : `${survivors} comparable alternatives expected to last`,
  );
  if (netGap != null && netGap > 0) bits.push(`${netGap} clear of the likely replacement`);
  if (damping < 1) bits.push('discounted — the roster does not need the position');
  return bits.join(' · ');
}

/**
 * Which half to say out loud, when either is loud enough to be worth a line.
 *
 * Thresholds rather than always-on: a bullet reading "2.9 comparable
 * alternatives expected to last" on every row is the kind of line this board
 * keeps having to delete.
 */
function driverOf(
  opportunityScore: number,
  replacementScore: number,
  survivors: number,
  netGap: number | null,
): string | null {
  if (opportunityScore < 0.4 && replacementScore < 0.4) return null;
  if (replacementScore >= opportunityScore) {
    return `replacement edge · ${netGap} of composite clear of what is likely left at your next pick`;
  }
  return `opportunity cost · about ${survivors} comparable alternatives expected to survive to your next pick`;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}
