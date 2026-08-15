/**
 * Where the market actually breaks at a position.
 *
 * This file answers two questions that were, until this pass, one question.
 *
 *   - **Where does a tier end?** A grouping question. Two players are in the
 *     same tier when they are close enough in market value to be reasonable
 *     substitutes inside one draft decision; the line falls where the board
 *     genuinely steps down.
 *   - **Is that step worth a warning?** An alarm question. A hole is only worth
 *     interrupting the reader for when passing on this player means waiting a
 *     long time — in picks, not in ratios — for the next one.
 *
 * Answering both from one threshold is what widened the tiers. The threshold in
 * question was calibrated for the alarm, because the bug that produced it was an
 * alarm bug: a tight end board of seven players spread over sixty ADP picks came
 * back with seven `Tier cliff` labels, so the bar was raised until it was rare.
 * Grouping then inherited a bar tuned for rarity and did the only thing it
 * could — it stopped grouping. Twelve quarterbacks between ADP 53 and ADP 111,
 * three obvious steps down inside them, all one tier.
 *
 * A second cause compounded it. The yardstick a gap was measured against was
 * `max(local spacing, whole-position spacing)`, and a quarterback pool runs from
 * ADP 53 to ADP 260. The deep tail — where twenty picks between backups is
 * ordinary — set a position median of about eleven, and every real hole at the
 * top of the board was then divided by eleven instead of by the two-and-a-half
 * that the players either side of it were actually spaced. The top of a position
 * was being judged by the bottom of it, which also meant that drafting a
 * fortieth-string quarterback nobody wanted re-tiered the starters.
 *
 * So: boundaries are found from *local* spacing only, against a floor that
 * scales with the region of the draft rather than one absolute number for the
 * whole board — four picks around ADP 40 is a real step and four picks around
 * ADP 220 is rounding. Cliffs — the alarm — are then a strictly stronger label
 * layered on top, keeping the absolute-picks floor and the cap that made them
 * rare. Every boundary is a place the board steps down; only some of them are
 * worth shouting about.
 *
 * Deliberately market-only. Roster need, the news ledger, My Guy, AVOID, Vegas,
 * survival and opportunity cost all move the ranking elsewhere and none of them
 * may move this: whether the board has a hole in it is a fact about the board.
 * The dependency runs one way — this model feeds the survival and opportunity
 * layers and never reads them — and there is deliberately no parameter through
 * which it could.
 */

// --------------------------------------------------------------- thresholds

/**
 * Every number the tier layer depends on, in one place.
 *
 * Two groups, and the split is the point of this file. `boundaryRatio` and the
 * noise floor decide *grouping*; `minGap`, `cliffGapRatio`, `confirmRatio` and
 * `maxCliffShare` decide *alarm*. Moving one may not move the other.
 */
export const TIER_THRESHOLDS = {
  /**
   * Gaps either side of a candidate that define "right here".
   *
   * Three each way — six neighbouring gaps, so roughly three or four players
   * above and below the candidate. The candidate's own gap is excluded, which
   * matters more than it sounds: a large gap included in its own baseline
   * inflates that baseline and hides itself, and the smaller the window the
   * worse it hides.
   */
  window: { before: 3, after: 3 },

  /**
   * How much of an ADP is measurement noise.
   *
   * ADP is an average over drafts and its dispersion grows with the number
   * itself: the fourth pick of a draft is the fourth pick of every draft, and
   * the two-hundredth is anybody's guess. A fixed floor therefore says two
   * incompatible things at once — too coarse to see a real step at the top of
   * the board, too fine to ignore noise at the bottom.
   *
   * So the smallest gap that may open a tier is a share of the ADP it sits at:
   * about three picks around ADP 50, about six around ADP 100, about thirteen
   * around ADP 220. The clamps stop it vanishing in the first round and stop it
   * swallowing a genuine chasm in the last.
   */
  noiseShareOfAdp: 0.06,
  minNoiseFloor: 2.5,
  maxNoiseFloor: 20,

  /**
   * Boundary: gap this many times the *local* spacing.
   *
   * Position-specific because positions are drafted in different shapes, and
   * this is the whole of §6:
   *
   *   - **QB** goes in bands. A dozen starters separated by two or three real
   *     steps is the normal shape of the position, and the bands are what the
   *     reader is choosing between, so the bar is low.
   *   - **TE** is cliffs and puddles. Small tiers and sharp drops are the
   *     truth about the position, not an artefact.
   *   - **RB/WR** are dense and deep. Dozens of interchangeable players sit
   *     inside a few picks of each other, so the bar is higher: split only
   *     where the local spacing really does step up.
   */
  boundaryRatio: { QB: 1.7, TE: 1.7, RB: 2, WR: 2, DEF: 2.2 } as Record<string, number>,
  defaultBoundaryRatio: 2,

  /**
   * A gap this anomalous opens a tier whatever else says otherwise.
   *
   * §7. An elite player alone above a chasm is a one-man tier, and a rule that
   * merged him downward to keep tiers a respectable size would be describing a
   * board that does not exist. Strong gaps are exempt from the fragmentation
   * cap below for the same reason.
   */
  strongBoundaryRatio: 3,

  /**
   * Ceiling on how much of one position may be a boundary at once.
   *
   * §8 and §9: the goal is better granularity, not maximum tier count. Roughly
   * one break per three rungs, which is the shape of a position that has real
   * bands; past that, only the most anomalous gaps keep their line — except the
   * strong ones, which are never trimmed.
   *
   * It is a safeguard and not a target. A position whose distribution is flat
   * comes back as one tier and nothing here objects.
   */
  maxBoundaryShare: 0.35,

  /**
   * Alarm floor, in picks. Below this, a break is not worth a warning however
   * anomalous it is locally.
   *
   * Unlike the boundary floor this one is absolute, because the question it
   * answers is absolute: `Tier cliff` claims you will wait a long time for the
   * next one, and "a long time" is a number of picks. Sparse positions need a
   * bigger hole before it means anything, because they are full of big holes.
   */
  minGap: { QB: 12, RB: 8, WR: 8, TE: 13, DEF: 14 } as Record<string, number>,
  defaultMinGap: 10,

  /** Cliff: gap this many times the local baseline spacing. */
  cliffGapRatio: 2,
  /** Thinning: the same measure, more permissive. */
  thinningGapRatio: 1.25,
  /** Thinning ignores gaps below this share of the position's cliff floor. */
  thinningGapFloor: 0.6,

  /**
   * A cliff must also stand out from what follows it.
   *
   * If the players past the gap are spaced just as widely, this is not a break
   * in the position — it is where the position ran out of depth, which the
   * thinning label already says without the alarm. Grouping does not use this:
   * a step down into a sparser region is still a step down.
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
   * True when the tier is closed by a gap big enough to warn about, rather than
   * by running out of board.
   *
   * Deliberately stricter than "closed by a boundary". Since this pass every
   * tier but the last is closed by a boundary, so that reading would be true of
   * almost every player and the warnings built on it — `Tier cliff · N away`,
   * the one-line tier context — would go back to being wallpaper. What the
   * warnings want to know is whether the drop below this group is one you would
   * regret, which is what `last_in_tier` means and has always meant.
   */
  tierEndsAtCliff: boolean;
  /** True when the tier is closed by any boundary at all, cliff or not. */
  tierEndsAtBoundary: boolean;
  /**
   * The boundary gap that opened this tier, in picks — the same value for every
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
  /** That gap over the local baseline spacing. The anomaly measure. */
  gapRatio: number | null;
  /** Median spacing in the window around him, excluding his own gap. */
  localMedianGap: number | null;
  /** Median spacing across the whole available position. Diagnostic only. */
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
  /** The smallest gap that could have opened a tier here, given the region. */
  noiseFloor: number;
  /** True when a tier ends after this rung. */
  boundaryAfter: boolean;
  /** Why the boundary is there, or why it is not. */
  boundaryReason: string;
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
  tierEndsAtBoundary: false,
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

/** How much bigger than the local spacing a gap must be to open a tier. §6. */
export function boundaryRatioFor(position: string): number {
  return (
    TIER_THRESHOLDS.boundaryRatio[position.toUpperCase()] ?? TIER_THRESHOLDS.defaultBoundaryRatio
  );
}

/**
 * The smallest gap that may open a tier at this point on the board. §10.
 *
 * A share of the ADP itself, clamped at both ends: three picks in round five is
 * a step, three picks in round eighteen is the same two players in a different
 * order.
 */
export function tierNoiseFloor(adp: number): number {
  const { noiseShareOfAdp, minNoiseFloor, maxNoiseFloor } = TIER_THRESHOLDS;
  return round2(clamp(noiseShareOfAdp * adp, minNoiseFloor, maxNoiseFloor));
}

export function buildPositionTierMap(
  position: string,
  availableAdps: Array<number | null | undefined>,
  opts: TierMapOptions,
): PositionTierMap {
  /*
   * §11. A player the market has not priced is unknown, not infinitely far
   * away. Dropping him here is the whole of the handling: he keeps his place on
   * the board, is ranked on what is actually known about him, and contributes
   * nothing to a distribution he has no place in. The alternative — treating a
   * missing ADP as a number — would invent a chasm on either side of him and
   * split a tier that the market never split.
   */
  const finite = availableAdps
    .filter((a): a is number => typeof a === 'number' && Number.isFinite(a))
    .sort((a, b) => a - b);

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
  const boundaryBar = boundaryRatioFor(position);
  const thinningFloor = floor * TIER_THRESHOLDS.thinningGapFloor;
  const poolBigEnough = finite.length >= TIER_THRESHOLDS.minPoolForCliff;

  const rows: TierRow[] = ladder.map((adp, i) => {
    const gapToNext = i + 1 < ladder.length ? gaps[i]! : null;
    /*
     * Local only. The whole-position median is still computed and still
     * reported, because it is the number that explains a diagnostic — but it no
     * longer sets the yardstick, because a position's tail has no business
     * deciding whether its head has a hole in it.
     */
    const localMedianGap = localBaseline(gaps, i, positionMedianGap);
    const gapRatio =
      gapToNext == null || localMedianGap == null || localMedianGap <= 0
        ? null
        : round2(gapToNext / localMedianGap);

    const noiseFloor = tierNoiseFloor(adp);
    const boundary = decideBoundary({ gapToNext, gapRatio, noiseFloor, boundaryBar });

    const verdict = classify({
      gapToNext,
      gapRatio,
      floor,
      thinningFloor,
      playersAtAdp: countAt.get(adp) ?? 1,
      poolBigEnough,
      isBoundary: boundary.isBoundary,
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
      noiseFloor,
      boundaryAfter: boundary.isBoundary,
      boundaryReason: boundary.reason,
      severity: verdict.severity,
      tierIndex: 0, // filled in below, once the breaks are known
      reason: verdict.reason,
    };
  });

  capBoundaries(rows);
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
  availableAdps: Array<number | null | undefined>;
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
  availableAdps: Array<number | null | undefined>,
  opts: TierMapOptions = { picksUntilNext: 0 },
): TierRow[] {
  return buildPositionTierMap(position, availableAdps, opts).rows;
}

// -------------------------------------------------------------- diagnostics

/** One tier, as a diagnostic reads it. §16. */
export interface TierGroup {
  /** 0-based, best group first. */
  index: number;
  /** How many players, counting shared draft slots individually. */
  size: number;
  /** The distinct ADPs in it, ascending. */
  adps: number[];
  /** The gap that opened it, `null` for the best group. */
  openedByGap: number | null;
  /** Local spacing at the boundary that opened it. */
  openedByLocalMedianGap: number | null;
  /** That gap over that spacing. */
  openedByRatio: number | null;
  /** Why the boundary above it is there, `null` for the best group. */
  openedByReason: string | null;
  /** Whether the group is closed by a warning-grade cliff. */
  endsAtCliff: boolean;
}

/** A whole position, grouped, with the arithmetic behind every boundary. §16. */
export interface PositionTierSummary {
  position: string;
  /** Players available at the position, shared draft slots counted individually. */
  availableCount: number;
  /** Available players the market has not priced, excluded from the ladder. */
  unpricedCount: number;
  tierCount: number;
  /** Sizes in order, best group first. */
  tierSizes: number[];
  positionMedianGap: number | null;
  tiers: TierGroup[];
  rows: TierRow[];
}

/**
 * Everything about one position's ladder, in the shape a person reads. §16.
 *
 * Read-only and free of side effects: it builds the same map the board builds
 * and regroups the rows. It exists so that "why did that line move" is answered
 * with the numbers the model used rather than by rerunning the model in one's
 * head — see `scripts/probe-tier-granularity.mjs`, which prints it for the live
 * board, and the before/after report in the tier tests.
 */
export function summarizePositionTiers(
  position: string,
  availableAdps: Array<number | null | undefined>,
  opts: TierMapOptions = { picksUntilNext: 0 },
): PositionTierSummary {
  const map = buildPositionTierMap(position, availableAdps, opts);
  const priced = availableAdps.filter((a) => typeof a === 'number' && Number.isFinite(a)).length;

  const tiers: TierGroup[] = [];
  for (const row of map.rows) {
    const at = countOf(map.rows, row.adp);
    let group = tiers[row.tierIndex];
    if (!group) {
      const opener = map.rows.find((r) => r.tierIndex === row.tierIndex - 1 && r.boundaryAfter);
      group = {
        index: row.tierIndex,
        size: 0,
        adps: [],
        openedByGap: opener?.gapToNext ?? null,
        openedByLocalMedianGap: opener?.localMedianGap ?? null,
        openedByRatio: opener?.gapRatio ?? null,
        openedByReason: opener?.boundaryReason ?? null,
        endsAtCliff: false,
      };
      tiers[row.tierIndex] = group;
    }
    group.size += at;
    group.adps.push(row.adp);
    if (row.boundaryAfter) group.endsAtCliff = row.severity === 'last_in_tier';
  }

  return {
    position,
    availableCount: priced,
    unpricedCount: availableAdps.length - priced,
    tierCount: tiers.length,
    tierSizes: tiers.map((t) => t.size),
    positionMedianGap: map.rows[0]?.positionMedianGap ?? null,
    tiers,
    rows: map.rows,
  };
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

/**
 * Does a tier end here? The grouping question, and nothing else.
 *
 * Two tests and they do different jobs. The ratio asks whether this gap is a
 * step up from how the players around it are spaced — the question §4 is about,
 * and the only one that can see a three-pick hole in a one-pick cluster. The
 * noise floor asks whether the gap is big enough to be a fact rather than an
 * artefact of averaging, which is the question §8 is about and the ratio alone
 * cannot answer: in a dense enough cluster every rounding error is anomalous.
 */
function decideBoundary(input: {
  gapToNext: number | null;
  gapRatio: number | null;
  noiseFloor: number;
  boundaryBar: number;
}): { isBoundary: boolean; strong: boolean; reason: string } {
  const { gapToNext, gapRatio, noiseFloor, boundaryBar } = input;
  if (gapToNext == null) return { isBoundary: false, strong: false, reason: 'last rung; nothing after it to separate' };
  if (gapRatio == null) return { isBoundary: false, strong: false, reason: 'no local spacing to compare against' };

  if (gapToNext < noiseFloor) {
    return {
      isBoundary: false,
      strong: false,
      reason: `gap ${gapToNext} is inside ADP noise this deep (floor ${noiseFloor})`,
    };
  }
  if (gapRatio < boundaryBar) {
    return {
      isBoundary: false,
      strong: false,
      reason: `gap ${gapToNext} is only ${gapRatio}x local spacing (needs ${boundaryBar}x)`,
    };
  }
  const strong = gapRatio >= TIER_THRESHOLDS.strongBoundaryRatio;
  return {
    isBoundary: true,
    strong,
    reason: `gap ${gapToNext} is ${gapRatio}x local spacing${strong ? ', a strong break' : ''}`,
  };
}

/**
 * Is the break worth a warning? The alarm question, asked only of breaks.
 *
 * Strictly narrower than a boundary by construction: a cliff is a boundary that
 * also clears an absolute floor in picks, is twice the local spacing rather than
 * the position's boundary bar, is not shared with another player at the same
 * slot, and is not simply the point where the position turns sparse. That
 * ordering is the invariant this file is built on — every cliff is a boundary,
 * and most boundaries are not cliffs.
 */
function classify(input: {
  gapToNext: number | null;
  gapRatio: number | null;
  floor: number;
  thinningFloor: number;
  playersAtAdp: number;
  poolBigEnough: boolean;
  isBoundary: boolean;
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
    input.isBoundary &&
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
          : !input.isBoundary
            ? 'not a tier boundary'
            : 'the players past the gap are spaced just as widely';
  return { severity: 'thinning', reason: why };
}

/**
 * §8/§9 protection: cap how many boundaries one position may claim at once.
 *
 * The goal is better granularity, not maximum tier count, and a ratio is a
 * relative measure — a position whose spacing is bimodal can clear the bar
 * everywhere at once. Keeping the most anomalous breaks and dissolving the rest
 * costs nothing when the board really does have three bands, and is the
 * difference between structure and a line every other row when it does not.
 *
 * Strong breaks are exempt. §7 is explicit that a real elite cliff may not be
 * suppressed to keep tiers a respectable size, and a cap that trimmed the
 * biggest holes on the board to protect the reader from them would be the same
 * mistake this file exists to undo, in the other direction.
 */
function capBoundaries(rows: TierRow[]): void {
  const marginal = rows.filter(
    (r) => r.boundaryAfter && (r.gapRatio ?? 0) < TIER_THRESHOLDS.strongBoundaryRatio,
  );
  const strong = rows.filter((r) => r.boundaryAfter).length - marginal.length;
  const allowed = Math.max(1, Math.ceil(rows.length * TIER_THRESHOLDS.maxBoundaryShare)) - strong;
  if (marginal.length <= allowed) return;

  // Descending anomaly, then ascending ADP so a tie is broken the same way on
  // every board and every refresh. §12: no jitter, ever.
  const keep = new Set(
    [...marginal]
      .sort((a, b) => (b.gapRatio ?? 0) - (a.gapRatio ?? 0) || a.adp - b.adp)
      .slice(0, Math.max(0, allowed)),
  );
  for (const row of marginal) {
    if (keep.has(row)) continue;
    row.boundaryAfter = false;
    row.boundaryReason = `dissolved: ${marginal.length} ordinary breaks at this position, keeping the ${Math.max(0, allowed)} most anomalous`;
    if (row.severity === 'last_in_tier') {
      row.severity = 'thinning';
      row.reason = 'the break it sat on was dissolved by the fragmentation cap';
    }
  }
}

/**
 * §6 protection: cap how many *cliffs* one position may claim at once.
 *
 * Unchanged in intent from the pass that introduced it, and still separate from
 * the boundary cap above: this one protects the reader from a row of alarms,
 * that one protects them from a row of lines. Demoting a cliff to a thinning
 * leaves the tier boundary where it was — the board still steps down there,
 * it is just no longer worth interrupting anybody about.
 */
function capCliffs(rows: TierRow[]): void {
  const cliffs = rows.filter((r) => r.severity === 'last_in_tier');
  const allowed = Math.max(1, Math.ceil(rows.length * TIER_THRESHOLDS.maxCliffShare));
  if (cliffs.length <= allowed) return;
  const keep = new Set(
    [...cliffs].sort((a, b) => (b.gapRatio ?? 0) - (a.gapRatio ?? 0) || a.adp - b.adp).slice(0, allowed),
  );
  for (const row of cliffs) {
    if (keep.has(row)) continue;
    row.severity = 'thinning';
    row.reason = `demoted: ${cliffs.length} gaps at this position cleared the cliff bar, keeping the ${allowed} most anomalous`;
  }
}

/**
 * A tier ends at a boundary. Tier 0 is the best group left.
 *
 * It used to end at a *cliff*, which is why the tiers were too broad: the cliff
 * bar is an alarm bar, deliberately rare and capped at a fifth of a position, so
 * a board with three genuine steps down in it reported one tier or none. The
 * grouping now reads the grouping test and the alarm reads the alarm test, and
 * `tierEndsAtCliff` still asks the alarm — so the warnings built on it did not
 * move when the lines did.
 *
 * Nothing about ranking moves either. `score` is computed from severity, anomaly
 * and urgency and never from which tier a player landed in.
 */
function numberTiers(rows: TierRow[]): void {
  let tier = 0;
  for (const row of rows) {
    row.tierIndex = tier;
    if (row.boundaryAfter) tier += 1;
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
    tierEndsAtBoundary: false,
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

  // The rung that closes his tier, and how it closes it. `null` when the tier
  // runs off the end of the board, which is not a fact about the position.
  const closer = rows.find((r) => r.tierIndex === row.tierIndex && r.boundaryAfter) ?? null;
  base.tierEndsAtBoundary = closer != null;
  base.tierEndsAtCliff = closer?.severity === 'last_in_tier';

  // His tier, from him to its end: the players who are genuinely the same
  // decision as him. Everything before him is better and goes first.
  let remaining = 0;
  let surviving = 0;
  const horizon = row.adp + opts.picksUntilNext;
  for (let j = i; j < rows.length && rows[j]!.tierIndex === row.tierIndex; j++) {
    const at = countAt.get(rows[j]!.adp) ?? 1;
    remaining += at;
    if (rows[j]!.adp > horizon) surviving += at;
  }
  base.remainingInTier = remaining;
  base.survivingTierMates = surviving;

  // The whole tier, including the players ahead of him in it, and the boundary
  // that opened it. Both are facts about the group rather than about him, so
  // every member reports the same numbers.
  let size = 0;
  for (const other of rows) {
    if (other.tierIndex === row.tierIndex) size += countAt.get(other.adp) ?? 1;
  }
  base.tierSize = size;
  if (row.tierIndex > 0) {
    const opener = rows.find((r) => r.tierIndex === row.tierIndex - 1 && r.boundaryAfter);
    base.tierGapBefore = opener?.gapToNext ?? null;
  }

  // Picks to the next tier: a fact about the edge of a group, so it is read
  // from the boundary and not from the alarm. A break can be real without being
  // worth a warning, and the distance to the next group is the same either way.
  base.gapToNextTier = row.boundaryAfter ? row.gapToNext : null;

  if (row.severity === 'none') return base;

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

/**
 * The yardstick a gap is measured against: how the players *around* it are
 * spaced, and nothing else.
 *
 * Two decisions in four lines, and both of them are the fix.
 *
 * The candidate's own gap is excluded from its own baseline. A 14-pick hole
 * inside a window of six 2-pick gaps is 7x the spacing around it; include it and
 * the median moves and the hole starts hiding itself, worst exactly where the
 * window is small and the answer matters most.
 *
 * And the whole-position median is a *fallback*, not a co-equal. It used to be
 * `max(local, position)`, which meant a quarterback board whose tail ran to ADP
 * 260 judged its own top by the spacing of backups. Now it is consulted only
 * when there is no local window at all — a two- or three-rung ladder — where
 * "around it" has no meaning and something has to stand in.
 */
function localBaseline(gaps: number[], i: number, positionMedian: number | null): number | null {
  const local = median(localGaps(gaps, i));
  if (local != null && local > 0) return local;
  return positionMedian != null && positionMedian > 0 ? positionMedian : null;
}

/** Gaps inside the window around rung `i`, excluding rung `i`'s own gap. */
function localGaps(gaps: number[], i: number): number[] {
  const from = Math.max(0, i - TIER_THRESHOLDS.window.before);
  const to = Math.min(gaps.length, i + TIER_THRESHOLDS.window.after + 1);
  const out: number[] = [];
  for (let j = from; j < to; j++) if (j !== i) out.push(gaps[j]!);
  return out;
}

/** Spacing among the players just past the gap, used to confirm the drop. */
function followingMean(gaps: number[], i: number): number | null {
  const after = gaps.slice(i + 1, i + 1 + 3);
  if (after.length < 2) return null;
  return after.reduce((a, b) => a + b, 0) / after.length;
}

function countOf(rows: TierRow[], adp: number): number {
  return rows.find((r) => r.adp === adp)?.playersAtAdp ?? 1;
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
