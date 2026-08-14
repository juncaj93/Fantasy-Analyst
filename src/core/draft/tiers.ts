/**
 * Where the market actually breaks at a position.
 *
 * The old rule asked one question — "is anybody left in this player's tier who
 * will still be here at my next pick?" — and answered it per player, from a
 * tier ladder built with a single global gap threshold. Both halves were wrong
 * in the same direction:
 *
 *   - the ladder used one gap floor (8 picks) for every position, and tight
 *     ends are naturally spaced further apart than receivers, so nearly every
 *     adjacent pair of TEs started a new tier;
 *   - "last in tier" was computed from the players at or after this one, so
 *     every one-man tier — and, by construction, the last man of every tier —
 *     qualified.
 *
 * Run those together on a real tight end board (ADP 40, 51, 67, 68, 76, 78, 99)
 * and all seven come back `Tier cliff`. A warning that fires on everything is
 * not a warning.
 *
 * What replaces it is a distribution. A gap is only a cliff if it is large in
 * absolute terms *for that position*, large relative to how the position is
 * spaced right there and overall, and not simply the point where the whole
 * position turns sparse. On the same seven tight ends that is one cliff and one
 * thinning; on the reported running backs it is no cliff at all.
 *
 * Deliberately market-only. Roster need, the news ledger, My Guy, AVOID and
 * Vegas all move the ranking elsewhere and none of them may move this: whether
 * the board has a hole in it is a fact about the board.
 */

// --------------------------------------------------------------- thresholds

/**
 * Every number the tier layer depends on, in one place.
 *
 * Positions differ because their draft-order spacing differs, and that is the
 * whole point: a 9-pick hole between running backs is ordinary and the same
 * hole between quarterbacks is the end of the run on starters.
 */
export const TIER_THRESHOLDS = {
  /** Available players either side of the gap that define "right here". */
  window: { before: 3, after: 4 },

  /**
   * A gap this small is never a cliff however anomalous it looks.
   *
   * Sparse positions need a bigger hole before it means anything, because they
   * are full of big holes; dense ones do not.
   */
  minGap: { QB: 12, RB: 8, WR: 8, TE: 13, DEF: 14 } as Record<string, number>,
  defaultMinGap: 10,

  /** Cliff: gap this many times the local/position baseline spacing. */
  cliffGapRatio: 2,
  /** Thinning: the same measure, more permissive. */
  thinningGapRatio: 1.25,
  /** Thinning ignores gaps below this share of the position's cliff floor. */
  thinningGapFloor: 0.6,

  /**
   * The gap must also stand out from what follows it.
   *
   * If the players past the gap are spaced just as widely, this is not a break
   * in the position — it is where the position ran out of depth, which the
   * thinning label already says without the alarm.
   */
  confirmRatio: 1.4,

  /** No cliff at all in a pool this small: everything looks like an edge. */
  minPoolForCliff: 4,
  /**
   * Hard ceiling on how much of one position may be called a cliff at once.
   *
   * The last line of defence against the bug this file exists to fix. Even if
   * the ratios all pass, only the most anomalous gaps keep the label.
   */
  maxCliffShare: 0.2,

  /** Below this many picks until your turn, a cliff cannot bite before you act. */
  minPicksUntilNext: 3,
} as const;

// ------------------------------------------------------------------- shapes

export type CliffSeverity = 'none' | 'thinning' | 'last_in_tier';

export interface TierCliff {
  severity: CliffSeverity;
  /** Which tier the player sits in, 0-based, best available first. */
  tierIndex: number | null;
  /** Players in his tier from him onwards, himself included. */
  remainingInTier: number;
  /**
   * Every available player in his tier, wherever he sits in it.
   *
   * `remainingInTier` answers "how many are left if I pass on him", which is
   * the question the ranking asks. This answers "how big is this group", which
   * is the question the board asks — and the two differ for everyone except the
   * first player in a tier.
   */
  tierSize: number;
  /**
   * True when the tier is closed by a real cliff rather than by running out of
   * board. The last tier at a position has nothing after it, and "last group
   * left" is not a warning about scarcity.
   */
  tierEndsAtCliff: boolean;
  /**
   * The cliff gap that opened this tier, in picks — the same value for every
   * member of it, `null` for the best tier, which nothing opened.
   *
   * Carried by every member rather than only by the first because the board is
   * ordered by the ranking and not by draft order, so which member of a tier
   * appears first on screen is not knowable here.
   */
  tierGapBefore: number | null;
  /** Picks to the next tier, when he is at the edge of one. */
  gapToNextTier: number | null;
  /** Cluster-mates expected to still be there at the user's next pick. */
  survivingTierMates: number;
  /** Picks to the next available player at the position, whoever he is. */
  gapToNext: number | null;
  /** That gap over the baseline spacing. The anomaly measure. */
  gapRatio: number | null;
  /** Median spacing in the window around him. */
  localMedianGap: number | null;
  /** Median spacing across the whole available position. */
  positionMedianGap: number | null;
  /** 0..1, folded into the ranking. Market only — no need, no news. */
  score: number;
  /** One short sentence, or null when there is nothing worth saying. */
  message: string | null;
}

/** One rung of the ladder, with its arithmetic exposed for diagnostics. */
export interface TierRow {
  position: string;
  adp: number;
  /** Players sharing this exact draft slot. More than one is an alternative. */
  playersAtAdp: number;
  gapToNext: number | null;
  localMedianGap: number | null;
  positionMedianGap: number | null;
  gapRatio: number | null;
  severity: CliffSeverity;
  tierIndex: number;
  /** Why the label is what it is — the failing test, when one failed. */
  reason: string;
}

export const NO_CLIFF: TierCliff = {
  severity: 'none',
  tierIndex: null,
  remainingInTier: 0,
  tierSize: 0,
  tierEndsAtCliff: false,
  tierGapBefore: null,
  gapToNextTier: null,
  survivingTierMates: 0,
  gapToNext: null,
  gapRatio: null,
  localMedianGap: null,
  positionMedianGap: null,
  score: 0,
  message: null,
};

export interface TierMapOptions {
  /** Picks between now and the user's next selection. Scores urgency only. */
  picksUntilNext: number;
}

/**
 * Every rung of one position's ladder, classified once.
 *
 * Built per position per board, not per player: the arithmetic is over the same
 * sorted array every time, and a live draft redraws forty rows on every pick.
 */
export interface PositionTierMap {
  position: string;
  /** Distinct available ADPs, ascending. */
  ladder: number[];
  rows: TierRow[];
  /** The assessment for a player at this ADP. */
  at(adp: number | null): TierCliff;
}

// ---------------------------------------------------------------- the model

export function minGapFor(position: string): number {
  return TIER_THRESHOLDS.minGap[position.toUpperCase()] ?? TIER_THRESHOLDS.defaultMinGap;
}

export function buildPositionTierMap(
  position: string,
  availableAdps: number[],
  opts: TierMapOptions,
): PositionTierMap {
  const finite = availableAdps.filter((a) => Number.isFinite(a)).sort((a, b) => a - b);

  /*
   * Duplicates collapse into one rung, and are counted.
   *
   * Two players sharing a draft slot are each other's alternative: whatever the
   * board looks like after them, passing on one costs you the other, not the
   * gap. So the ladder is built from distinct positions on the board and the
   * count travels with the rung.
   */
  const ladder: number[] = [];
  const countAt = new Map<number, number>();
  for (const adp of finite) {
    const seen = countAt.get(adp);
    if (seen == null) {
      ladder.push(adp);
      countAt.set(adp, 1);
    } else {
      countAt.set(adp, seen + 1);
    }
  }

  const gaps: number[] = [];
  for (let i = 0; i + 1 < ladder.length; i++) gaps.push(round1(ladder[i + 1]! - ladder[i]!));
  const positionMedianGap = median(gaps);

  const floor = minGapFor(position);
  const thinningFloor = floor * TIER_THRESHOLDS.thinningGapFloor;
  const poolBigEnough = finite.length >= TIER_THRESHOLDS.minPoolForCliff;

  const rows: TierRow[] = ladder.map((adp, i) => {
    const gapToNext = i + 1 < ladder.length ? gaps[i]! : null;
    const localMedianGap = median(localGaps(gaps, i));
    const baseline = baselineGap(localMedianGap, positionMedianGap);
    const gapRatio = gapToNext == null || baseline == null ? null : round2(gapToNext / baseline);

    const verdict = classify({
      gapToNext,
      gapRatio,
      floor,
      thinningFloor,
      playersAtAdp: countAt.get(adp) ?? 1,
      poolBigEnough,
      followMean: followingMean(gaps, i),
    });

    return {
      position,
      adp,
      playersAtAdp: countAt.get(adp) ?? 1,
      gapToNext,
      localMedianGap,
      positionMedianGap,
      gapRatio,
      severity: verdict.severity,
      tierIndex: 0, // filled in below, once the breaks are known
      reason: verdict.reason,
    };
  });

  capCliffs(rows);
  numberTiers(rows);

  const byAdp = new Map<number, TierCliff>();
  for (let i = 0; i < rows.length; i++) {
    byAdp.set(rows[i]!.adp, toCliff(rows, i, countAt, position, opts));
  }

  return {
    position,
    ladder,
    rows,
    at: (adp) => (adp == null ? NO_CLIFF : (byAdp.get(adp) ?? NO_CLIFF)),
  };
}

/**
 * One player's assessment, for callers that have no map to hand.
 *
 * Building the whole ladder to read one rung is wasteful, so the engine holds a
 * map per position instead. Tests and one-off checks use this.
 */
export function assessTierCliff(input: {
  position: string;
  playerAdp: number | null;
  availableAdps: number[];
  picksUntilNext: number;
}): TierCliff {
  if (input.playerAdp == null) return NO_CLIFF;
  return buildPositionTierMap(input.position, input.availableAdps, {
    picksUntilNext: input.picksUntilNext,
  }).at(input.playerAdp);
}

/**
 * The ladder as a table: player slot, spacing, ratio, verdict.
 *
 * Not user-facing. It exists so that "why is this a cliff" can be answered with
 * the same numbers the classifier used, in a test or at a console, rather than
 * by reading the classifier.
 */
export function describePositionTiers(
  position: string,
  availableAdps: number[],
  opts: TierMapOptions = { picksUntilNext: 0 },
): TierRow[] {
  return buildPositionTierMap(position, availableAdps, opts).rows;
}

// ------------------------------------------------------------ consistency

export interface ConsistencyInput {
  severity: CliffSeverity;
  /** Chance the player is still there at the user's next pick, 0..1. */
  survivalProbability: number | null;
  /** Available players at the position within a tier's reach after him. */
  comparableNearby: number;
}

/**
 * Tier and survival are separate models, and they are allowed to disagree — a
 * genuine cliff on a player nobody else wants is exactly that combination. What
 * they should not do is disagree *often*, so the contradiction is recorded
 * rather than resolved: neither model overrules the other, and a run of these
 * is the signal that a threshold needs moving.
 */
export function tierSurvivalConsistency(input: ConsistencyInput): { suspicious: boolean; note: string | null } {
  if (input.severity === 'last_in_tier' && (input.survivalProbability ?? 0) >= 0.85 && input.comparableNearby >= 2) {
    return {
      suspicious: true,
      note: `cliff called with ${Math.round((input.survivalProbability ?? 0) * 100)}% survival and ${input.comparableNearby} comparable players nearby`,
    };
  }
  return { suspicious: false, note: null };
}

// ------------------------------------------------------------------ innards

function classify(input: {
  gapToNext: number | null;
  gapRatio: number | null;
  floor: number;
  thinningFloor: number;
  playersAtAdp: number;
  poolBigEnough: boolean;
  followMean: number | null;
}): { severity: CliffSeverity; reason: string } {
  const { gapToNext, gapRatio } = input;
  // Nothing after him on the board we can see. The pool is capped by draft
  // order, so "nobody left" here usually means "nobody left in the top 300" —
  // not a fact about the position, and not something to raise an alarm over.
  if (gapToNext == null) return { severity: 'none', reason: 'last available at the position; no gap to measure' };
  if (gapRatio == null) return { severity: 'none', reason: 'no spacing baseline yet' };

  if (gapToNext < input.thinningFloor || gapRatio < TIER_THRESHOLDS.thinningGapRatio) {
    return { severity: 'none', reason: `gap ${gapToNext} is ordinary spacing here (${gapRatio}x)` };
  }

  const cliffable =
    input.poolBigEnough &&
    input.playersAtAdp === 1 &&
    gapToNext >= input.floor &&
    gapRatio >= TIER_THRESHOLDS.cliffGapRatio &&
    (input.followMean == null || gapToNext >= TIER_THRESHOLDS.confirmRatio * input.followMean);

  if (cliffable) return { severity: 'last_in_tier', reason: `gap ${gapToNext} is ${gapRatio}x the spacing around it` };

  const why = !input.poolBigEnough
    ? 'too few left at the position to call a cliff'
    : input.playersAtAdp > 1
      ? 'another player shares this draft slot'
      : gapToNext < input.floor
        ? `gap ${gapToNext} is below the ${input.floor}-pick floor for this position`
        : gapRatio < TIER_THRESHOLDS.cliffGapRatio
          ? `gap is only ${gapRatio}x the spacing around it`
          : 'the players past the gap are spaced just as widely';
  return { severity: 'thinning', reason: why };
}

/**
 * §6 protection: cap how many cliffs one position may claim at once.
 *
 * Ratios are relative measures, and a position whose spacing is bimodal can
 * produce several at once. Keeping the most anomalous and demoting the rest
 * costs nothing when the board really has one hole, and is the difference
 * between a warning and wallpaper when it does not.
 */
function capCliffs(rows: TierRow[]): void {
  const cliffs = rows.filter((r) => r.severity === 'last_in_tier');
  const allowed = Math.max(1, Math.ceil(rows.length * TIER_THRESHOLDS.maxCliffShare));
  if (cliffs.length <= allowed) return;
  const keep = new Set(
    [...cliffs].sort((a, b) => (b.gapRatio ?? 0) - (a.gapRatio ?? 0)).slice(0, allowed),
  );
  for (const row of cliffs) {
    if (keep.has(row)) continue;
    row.severity = 'thinning';
    row.reason = `demoted: ${cliffs.length} gaps at this position cleared the cliff bar, keeping the ${allowed} most anomalous`;
  }
}

/**
 * A tier ends at a cliff. Tier 0 is the best group left.
 *
 * It used to end at *either* label, cliff or thinning, which put the model at
 * odds with its own words: a thinning says in as many words that "comparable
 * players remain", and players who are comparable to each other are one tier by
 * definition. Splitting there also made the count useless to draw — thinnings
 * are common by design (any gap 1.25× the local spacing qualifies), so a real
 * receiver board carried about twenty of them across eighty players, and a line
 * every four rows is wallpaper rather than structure. Cliffs are rare and
 * capped: seven across those same eighty.
 *
 * Nothing about ranking moves. `score` is computed from severity, anomaly and
 * urgency and never from which tier a player landed in; the grouping is read by
 * the board and by the messages, both of which now mean one thing.
 */
function numberTiers(rows: TierRow[]): void {
  let tier = 0;
  for (const row of rows) {
    row.tierIndex = tier;
    if (row.severity === 'last_in_tier') tier += 1;
  }
}

function toCliff(
  rows: TierRow[],
  i: number,
  countAt: Map<number, number>,
  position: string,
  opts: TierMapOptions,
): TierCliff {
  const row = rows[i]!;
  const base: TierCliff = {
    severity: row.severity,
    tierIndex: row.tierIndex,
    remainingInTier: 0,
    tierSize: 0,
    tierEndsAtCliff: false,
    tierGapBefore: null,
    gapToNextTier: null,
    survivingTierMates: 0,
    gapToNext: row.gapToNext,
    gapRatio: row.gapRatio,
    localMedianGap: row.localMedianGap,
    positionMedianGap: row.positionMedianGap,
    score: 0,
    message: null,
  };

  // His tier, from him to its end: the players who are genuinely the same
  // decision as him. Everything before him is better and goes first.
  let remaining = 0;
  let surviving = 0;
  const horizon = row.adp + opts.picksUntilNext;
  for (let j = i; j < rows.length; j++) {
    const at = countAt.get(rows[j]!.adp) ?? 1;
    remaining += at;
    if (rows[j]!.adp > horizon) surviving += at;
    if (rows[j]!.severity === 'last_in_tier') {
      base.tierEndsAtCliff = true;
      break;
    }
  }
  base.remainingInTier = remaining;
  base.survivingTierMates = surviving;

  // The whole tier, including the players ahead of him in it, and the cliff
  // that opened it. Both are facts about the group rather than about him, so
  // every member reports the same numbers.
  let size = 0;
  for (const other of rows) {
    if (other.tierIndex === row.tierIndex) size += countAt.get(other.adp) ?? 1;
  }
  base.tierSize = size;
  if (row.tierIndex > 0) {
    const opener = rows.find((r) => r.tierIndex === row.tierIndex - 1 && r.severity === 'last_in_tier');
    base.tierGapBefore = opener?.gapToNext ?? null;
  }

  if (row.severity === 'none') return base;

  base.gapToNextTier = row.gapToNext;

  /*
   * Urgency, not importance.
   *
   * The label is a fact about the board and never moves. What it is worth to
   * the ranking does depend on whether the hole can open before the user acts
   * again: on the clock, a cliff is something you are about to resolve
   * yourself.
   */
  const urgency = clamp(opts.picksUntilNext / TIER_THRESHOLDS.minPicksUntilNext, 0, 1);
  const anomaly = clamp(((row.gapRatio ?? 0) - TIER_THRESHOLDS.thinningGapRatio) / TIER_THRESHOLDS.cliffGapRatio, 0, 1);
  const weightBySeverity = row.severity === 'last_in_tier' ? 1 : 0.45;
  base.score = round3(clamp(weightBySeverity * (0.55 + 0.45 * anomaly) * urgency, 0, 1));

  const gapPhrase = `the next ${position} is ~${Math.round(row.gapToNext ?? 0)} picks later`;
  base.message =
    row.severity === 'last_in_tier'
      ? remaining === 1
        ? `Last ${position} in this group — ${gapPhrase}.`
        : `${remaining} ${position}s left in this group — ${gapPhrase}.`
      : `${position} board is thinning here — ${gapPhrase}, though comparable players remain.`;

  return base;
}

/** Gaps inside the window around rung `i`, which is what "right here" means. */
function localGaps(gaps: number[], i: number): number[] {
  const from = Math.max(0, i - TIER_THRESHOLDS.window.before);
  const to = Math.min(gaps.length, i + TIER_THRESHOLDS.window.after);
  return gaps.slice(from, to);
}

/** Spacing among the players just past the gap, used to confirm the drop. */
function followingMean(gaps: number[], i: number): number | null {
  const after = gaps.slice(i + 1, i + 1 + 3);
  if (after.length < 2) return null;
  return after.reduce((a, b) => a + b, 0) / after.length;
}

/**
 * The yardstick a gap is measured against.
 *
 * Both medians, because either alone lies. Local spacing alone calls the first
 * hole in a dense patch a cliff even when the whole position is spaced that way
 * ten picks later; the position median alone misses that the top of a position
 * is packed and the bottom is not.
 */
function baselineGap(local: number | null, position: number | null): number | null {
  const candidates = [local, position].filter((v): v is number => v != null && v > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
