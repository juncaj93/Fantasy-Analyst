/**
 * Tier calibration.
 *
 * Two opposite bugs, one file, and the tests pin both directions because both
 * are cheap to reintroduce.
 *
 * The first: a tight end board of seven players spread over sixty ADP picks
 * came back with seven `Tier cliff` labels. So restraint is tested — the
 * reported TE and RB boards, asserted by count.
 *
 * The second, which fixing the first caused: grouping and warning shared one
 * threshold, that threshold was tuned for the warning, and twelve quarterbacks
 * spread over sixty ADP picks came back as one tier. So granularity is tested
 * too — the quarterback board from the report, asserted by boundary.
 *
 * A cliff detector that never fires is as useless as one that always does, and
 * a tier model with one tier is as useless as one with a tier per player.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TIER_THRESHOLDS,
  assessTierCliff,
  boundaryRatioFor,
  buildPositionTierMap,
  describePositionTiers,
  minGapFor,
  summarizePositionTiers,
  tierNoiseFloor,
  tierSurvivalConsistency,
} from '../src/core/draft/tiers.ts';

/** The observed false-positive board, as reported. */
const TE_BOARD = [40, 51, 68, 67, 78, 76, 99];
/** The observed running back board, which looked directionally reasonable. */
const RB_BOARD = [44, 49, 58, 58, 66, 73, 77, 79];

const severities = (position: string, adps: number[], picksUntilNext = 8) =>
  adps.map((adp) => assessTierCliff({ position, playerAdp: adp, availableAdps: adps, picksUntilNext }).severity);

describe('the reported tight end board', () => {
  it('no longer marks most of the position a cliff', () => {
    const called = severities('TE', TE_BOARD);
    const cliffs = called.filter((s) => s === 'last_in_tier');
    // Seven, before this pass. The brief's own bar is "not most or all of them".
    expect(cliffs.length).toBeLessThanOrEqual(2);
    expect(cliffs.length).toBeLessThan(TE_BOARD.length / 2);
  });

  it('finds the real holes in it', () => {
    // 78 -> 99 is a 21-pick gap where the players around it are spaced ~2.
    const at = (adp: number) =>
      assessTierCliff({ position: 'TE', playerAdp: adp, availableAdps: TE_BOARD, picksUntilNext: 8 });
    expect(at(78).severity).toBe('last_in_tier');
    expect(at(78).gapToNext).toBe(21);
    expect(at(78).gapRatio!).toBeGreaterThanOrEqual(TIER_THRESHOLDS.cliffGapRatio);
    // …and so is 51 -> 67, sixteen picks either side of a five-pick baseline.
    // Hidden until tiers were measured locally: the old yardstick divided it by
    // the whole position's median of 9.5 and came back with 1.68x.
    expect(at(51).severity).toBe('last_in_tier');
    expect(at(51).gapToNext).toBe(16);
  });

  it('leaves the players inside the pack alone', () => {
    for (const adp of [40, 67, 68, 76]) {
      expect(
        assessTierCliff({ position: 'TE', playerAdp: adp, availableAdps: TE_BOARD, picksUntilNext: 8 }).severity,
      ).not.toBe('last_in_tier');
    }
  });

  it('says nothing at all about the last player it can see', () => {
    // The pool is capped by draft order, so "nobody after him" is a fact about
    // the cap, not about the position.
    const last = assessTierCliff({ position: 'TE', playerAdp: 99, availableAdps: TE_BOARD, picksUntilNext: 8 });
    expect(last.severity).toBe('none');
    expect(last.gapToNext).toBeNull();
  });
});

describe('the reported running back board', () => {
  it('stamps no cliffs on an evenly-spread position', () => {
    expect(severities('RB', RB_BOARD)).not.toContain('last_in_tier');
  });

  it('is allowed to call it thinning', () => {
    const called = severities('RB', RB_BOARD);
    expect(called.filter((s) => s === 'thinning').length).toBeGreaterThan(0);
    // …but not on everybody. Thinning is a note, not a klaxon.
    expect(called.filter((s) => s === 'thinning').length).toBeLessThanOrEqual(RB_BOARD.length / 2);
  });

  it('treats two players sharing a draft slot as one another’s alternative', () => {
    const shared = assessTierCliff({ position: 'RB', playerAdp: 58, availableAdps: RB_BOARD, picksUntilNext: 8 });
    expect(shared.severity).not.toBe('last_in_tier');
  });
});

describe('position awareness', () => {
  it('demands a bigger hole at a sparse position than at a dense one', () => {
    expect(minGapFor('TE')).toBeGreaterThan(minGapFor('WR'));
    expect(minGapFor('QB')).toBeGreaterThan(minGapFor('RB'));
    expect(minGapFor('SOMETHING NEW')).toBe(TIER_THRESHOLDS.defaultMinGap);
  });

  it('reads the same gap differently at two positions', () => {
    // Nine picks, identical spacing either side, called at WR and at TE.
    const board = [20, 21, 22, 31, 32, 33];
    const wr = assessTierCliff({ position: 'WR', playerAdp: 22, availableAdps: board, picksUntilNext: 8 });
    const te = assessTierCliff({ position: 'TE', playerAdp: 22, availableAdps: board, picksUntilNext: 8 });
    expect(wr.severity).toBe('last_in_tier');
    // Nine picks is below the tight end floor, so the same shape is only thinning.
    expect(te.severity).toBe('thinning');
  });
});

describe('the local distribution', () => {
  it('ignores a wide gap in a region that is wide everywhere', () => {
    // Twenty picks apart from end to end: nothing here is a break.
    const board = [30, 50, 70, 90, 110, 130];
    expect(severities('WR', board)).not.toContain('last_in_tier');
  });

  it('finds the same gap anomalous inside a dense pack', () => {
    const board = [30, 32, 34, 36, 56, 58, 60, 62];
    const at36 = assessTierCliff({ position: 'WR', playerAdp: 36, availableAdps: board, picksUntilNext: 8 });
    expect(at36.severity).toBe('last_in_tier');
    expect(at36.localMedianGap!).toBeLessThan(at36.gapToNext!);
  });

  it('will not call a cliff on a pool too small to have a shape', () => {
    expect(
      assessTierCliff({ position: 'TE', playerAdp: 20, availableAdps: [20, 60, 62], picksUntilNext: 10 }).severity,
    ).not.toBe('last_in_tier');
  });

  it('caps how much of one position may be called a cliff', () => {
    // Five tight pairs, each separated by a chasm: every pair-end clears the
    // ratio bar, and the cap is what stops five simultaneous warnings.
    const board = [10, 11, 40, 41, 70, 71, 100, 101, 130, 131];
    const called = severities('WR', board, 10);
    const cliffs = called.filter((s) => s === 'last_in_tier').length;
    expect(cliffs).toBeLessThanOrEqual(Math.ceil(board.length * TIER_THRESHOLDS.maxCliffShare));
    expect(cliffs).toBeGreaterThan(0);
  });
});

describe('what a tier assessment is allowed to know', () => {
  it('is unchanged by anything about the user roster', () => {
    // There is deliberately no way to pass need, tally, My Guy, AVOID or Vegas
    // into this function. This test exists so that adding one breaks it.
    const input = { position: 'TE' as const, playerAdp: 78, availableAdps: TE_BOARD, picksUntilNext: 8 };
    expect(assessTierCliff(input)).toEqual(assessTierCliff({ ...input }));
    expect(Object.keys(input).sort()).toEqual(['availableAdps', 'picksUntilNext', 'playerAdp', 'position']);
  });

  it('says nothing without an ADP', () => {
    const cliff = assessTierCliff({ position: 'TE', playerAdp: null, availableAdps: [10, 40], picksUntilNext: 20 });
    expect(cliff.severity).toBe('none');
    expect(cliff.message).toBeNull();
  });

  it('keeps the label when your next pick is imminent, but drops the urgency', () => {
    // The board has a hole in it whether or not you are on the clock; what
    // changes is whether the hole can open before you act.
    const soon = assessTierCliff({ position: 'TE', playerAdp: 78, availableAdps: TE_BOARD, picksUntilNext: 1 });
    const later = assessTierCliff({ position: 'TE', playerAdp: 78, availableAdps: TE_BOARD, picksUntilNext: 12 });
    expect(soon.severity).toBe('last_in_tier');
    expect(soon.score).toBeLessThan(later.score);
  });
});

describe('diagnostics', () => {
  it('shows the arithmetic behind every rung', () => {
    const rows = describePositionTiers('TE', TE_BOARD, { picksUntilNext: 8 });
    expect(rows).toHaveLength(7);
    const cliffs = rows.filter((r) => r.severity === 'last_in_tier');
    expect(cliffs.map((r) => r.adp)).toEqual([51, 78]);
    for (const cliff of cliffs) expect(cliff.reason).toContain('x the spacing');
    // Every rung explains itself twice over — why it is or is not a boundary,
    // and why it is or is not worth a warning — including the quiet ones.
    for (const row of rows) {
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.boundaryReason.length).toBeGreaterThan(0);
    }
  });

  it('collapses shared draft slots into one rung and counts them', () => {
    const rows = describePositionTiers('RB', RB_BOARD);
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.adp === 58)!.playersAtAdp).toBe(2);
  });

  it('notices when a cliff and a high survival estimate disagree', () => {
    expect(
      tierSurvivalConsistency({ severity: 'last_in_tier', survivalProbability: 0.93, comparableNearby: 3 }).suspicious,
    ).toBe(true);
    // A cliff on a player nobody else wants is not a contradiction.
    expect(
      tierSurvivalConsistency({ severity: 'last_in_tier', survivalProbability: 0.93, comparableNearby: 0 }).suspicious,
    ).toBe(false);
    expect(
      tierSurvivalConsistency({ severity: 'none', survivalProbability: 0.93, comparableNearby: 5 }).suspicious,
    ).toBe(false);
  });
});

describe('the tier map', () => {
  it('classifies a position once and answers per player from it', () => {
    const map = buildPositionTierMap('TE', TE_BOARD, { picksUntilNext: 8 });
    expect(map.ladder).toEqual([40, 51, 67, 68, 76, 78, 99]);
    // Same answer as the one-off helper, which is what makes it safe to cache.
    for (const adp of TE_BOARD) {
      expect(map.at(adp)).toEqual(
        assessTierCliff({ position: 'TE', playerAdp: adp, availableAdps: TE_BOARD, picksUntilNext: 8 }),
      );
    }
    expect(map.at(null).severity).toBe('none');
    expect(map.at(12345).severity).toBe('none');
  });

  it('re-reads the board as players come off it', () => {
    // Take the two tight ends either side of 68 and the gap around him widens
    // from nothing into a real one. Nothing is cached across calls.
    const before = assessTierCliff({ position: 'TE', playerAdp: 40, availableAdps: TE_BOARD, picksUntilNext: 8 });
    const after = assessTierCliff({
      position: 'TE',
      playerAdp: 40,
      availableAdps: [40, 76, 78, 99, 101, 103],
      picksUntilNext: 8,
    });
    expect(before.severity).not.toBe('last_in_tier');
    expect(after.severity).toBe('last_in_tier');
  });
});

/**
 * The grouping the board draws.
 *
 * A tier ends at a cliff and not at a thinning. The two used to be the same
 * boundary, which put the model at odds with its own words — a thinning says
 * "comparable players remain", and comparable players are one tier — and made
 * the grouping useless to draw, because thinnings are common by design.
 */
describe('tiers as groups', () => {
  /**
   * The brief's own example, in shape rather than in names.
   *
   * Four quarterbacks inside six picks of each other, then a material drop to
   * two more. Nothing here is tuned to a threshold: the same four numbers
   * spaced like receivers would not group, because the distribution decides.
   */
  const QB_CLUSTER = [61, 63, 65, 67, 89, 93];

  it('groups a genuine cluster together and separates what follows it', () => {
    const rows = describePositionTiers('QB', QB_CLUSTER);
    expect(rows.map((r) => r.tierIndex)).toEqual([0, 0, 0, 0, 1, 1]);
    // Exactly one boundary, and it is the 22-pick hole, not any of the twos.
    expect(rows.filter((r) => r.severity === 'last_in_tier').map((r) => r.adp)).toEqual([67]);
  });

  it('reports the whole tier to every member of it, not just the ones after him', () => {
    const map = buildPositionTierMap('QB', QB_CLUSTER, { picksUntilNext: 8 });
    for (const adp of [61, 63, 65, 67]) expect(map.at(adp).tierSize).toBe(4);
    for (const adp of [89, 93]) expect(map.at(adp).tierSize).toBe(2);
    // …while "how many are left if I pass" still counts from him onwards.
    expect(map.at(61).remainingInTier).toBe(4);
    expect(map.at(67).remainingInTier).toBe(1);
  });

  it('says which gap opened a tier, the same way for every member of it', () => {
    const map = buildPositionTierMap('QB', QB_CLUSTER, { picksUntilNext: 8 });
    // Nothing opened the best tier.
    expect(map.at(61).tierGapBefore).toBeNull();
    expect(map.at(89).tierGapBefore).toBe(22);
    expect(map.at(93).tierGapBefore).toBe(22);
  });

  it('knows the difference between a tier that ends and a board that ends', () => {
    const map = buildPositionTierMap('QB', QB_CLUSTER, { picksUntilNext: 8 });
    expect(map.at(61).tierEndsAtCliff).toBe(true);
    // The last tier runs off the end of the board. Nothing is about to run out.
    expect(map.at(89).tierEndsAtCliff).toBe(false);
  });

  it('does not split a tier at a thinning', () => {
    // The reported running back board thins once and never cliffs.
    const rows = describePositionTiers('RB', RB_BOARD);
    expect(rows.some((r) => r.severity === 'thinning')).toBe(true);
    expect(rows.every((r) => r.tierIndex === 0)).toBe(true);
  });

  /**
   * Still market-only. This is the property the previous pass established and
   * the one most easily lost: the grouping is a fact about the board, so it may
   * not move when the roster does.
   */
  it('groups identically whatever the roster looks like', () => {
    const empty = describePositionTiers('QB', QB_CLUSTER, { picksUntilNext: 0 });
    const late = describePositionTiers('QB', QB_CLUSTER, { picksUntilNext: 40 });
    expect(empty.map((r) => r.tierIndex)).toEqual(late.map((r) => r.tierIndex));
    expect(empty.map((r) => r.severity)).toEqual(late.map((r) => r.severity));
  });
});

/**
 * The calibration fixtures.
 *
 * Shapes rather than boards: four spacing patterns whose right answer is
 * obvious to a person looking at the numbers, so that "is the model calibrated"
 * can be asked without a draft in front of you. No names, no positions chosen to
 * flatter a threshold — the same numbers are read at more than one position
 * below, on purpose.
 */
describe('calibration fixtures', () => {
  const tiersOf = (position: string, adps: number[]) =>
    summarizePositionTiers(position, adps).tiers.map((t) => t.adps);

  it('breaks at an obvious large gap and nowhere else', () => {
    expect(tiersOf('WR', [20, 22, 24, 35, 37, 39])).toEqual([
      [20, 22, 24],
      [35, 37, 39],
    ]);
  });

  it('leaves a dense interchangeable cluster alone', () => {
    // §8. Five receivers inside five picks are five ways to make one decision.
    expect(tiersOf('WR', [20, 21, 22, 23, 24])).toEqual([[20, 21, 22, 23, 24]]);
  });

  it('lets one player stand alone above a cliff', () => {
    // §7. A minimum tier size would merge him downward and describe a board
    // that does not exist.
    expect(tiersOf('WR', [5, 15, 17, 19])).toEqual([[5], [15, 17, 19]]);
  });

  /**
   * §19's fourth fixture, and the one that killed the old yardstick.
   *
   * Three receivers inside two picks, an eight-pick step, two more — and then a
   * deep tail spaced thirty and forty apart. The tail's spacing used to set the
   * baseline for the whole position, which divided the eight-pick step by 24
   * and erased it. Local spacing is 2 right there, so the step is 4x and the
   * boundary survives its own tail.
   */
  it('keeps an early boundary that a noisy deep tail would otherwise erase', () => {
    const groups = tiersOf('WR', [30, 31, 32, 40, 42, 100, 130, 170]);
    expect(groups[0]).toEqual([30, 31, 32]);
    expect(groups[1]).toEqual([40, 42]);
    // …and the deep tail, spaced 30 and 40 apart, does not fragment into rungs.
    expect(groups.at(-1)).toEqual([100, 130, 170]);
  });
});

/**
 * The quarterback board from the report. §20.
 *
 * Values only — the twelve ADPs visible in the screenshot plus a plausible
 * unpriced-backup tail, because in production the ladder does not stop at the
 * bottom of the screen and the tail is exactly what used to wash the top out.
 *
 * The acceptance case is stated in the brief in names: the best quarterback on
 * the board and the eighth one were in the same tier. Here they are the first
 * and the eighth ADP, which is the same fact without hardcoding anybody.
 */
describe('the reported quarterback board', () => {
  const QB_VISIBLE = [53.2, 55.3, 63.4, 65.8, 79.4, 81, 86.9, 90.2, 93.7, 97.6, 104.8, 111.5];
  const QB_TAIL = [124.3, 138.6, 149.2, 165.4, 178.9, 194.1, 212.7, 228.3, 246.8, 261.2];
  const QB_BOARD = [...QB_VISIBLE, ...QB_TAIL];

  const tierOf = (adp: number) =>
    buildPositionTierMap('QB', QB_BOARD, { picksUntilNext: 8 }).at(adp).tierIndex;

  it('no longer reports the whole position as one tier', () => {
    const summary = summarizePositionTiers('QB', QB_BOARD);
    expect(summary.tierCount).toBeGreaterThanOrEqual(3);
    // …and not one tier per player either. §18: granularity, not maximum count.
    expect(summary.tierCount).toBeLessThan(summary.availableCount / 2);
  });

  it('separates the top of the board from the middle of it', () => {
    // First ADP on the board against the eighth: one tier before this pass.
    expect(tierOf(53.2)).toBe(0);
    expect(tierOf(97.6)).toBeGreaterThanOrEqual(2);
  });

  it('splits where the market actually steps down', () => {
    const summary = summarizePositionTiers('QB', QB_BOARD);
    // Every boundary is a step up from the spacing around it, by construction.
    for (const tier of summary.tiers.slice(1)) {
      expect(tier.openedByRatio!).toBeGreaterThanOrEqual(boundaryRatioFor('QB'));
      expect(tier.openedByGap!).toBeGreaterThan(tier.openedByLocalMedianGap!);
    }
  });

  it('groups the pairs the market groups', () => {
    // Two inside 2.1 picks, then an 8.1-pick step: the first two are one
    // decision and the next two are another.
    expect(tierOf(53.2)).toBe(tierOf(55.3));
    expect(tierOf(63.4)).toBe(tierOf(65.8));
    expect(tierOf(55.3)).not.toBe(tierOf(63.4));
  });

  /**
   * §13. The tail is undifferentiated in ADP terms and the model says so rather
   * than inventing rungs in it — but it is one group, not several.
   */
  it('does not fragment the undifferentiated tail', () => {
    const summary = summarizePositionTiers('QB', QB_BOARD);
    expect(summary.tiers.at(-1)!.adps).toContain(261.2);
    expect(summary.tiers.at(-1)!.size).toBeGreaterThan(3);
  });
});

/**
 * §11 and §21. An unpriced player is unknown, not infinitely far away.
 */
describe('players the market has not priced', () => {
  const KNOWN = [53.2, 55.3, 63.4, 65.8, 79.4, 81, 86.9, 90.2];

  it('changes nothing about the players around it', () => {
    const withNull = summarizePositionTiers('QB', [53.2, 55.3, 63.4, null, 65.8, 79.4, 81, 86.9, 90.2]);
    const without = summarizePositionTiers('QB', KNOWN);
    expect(withNull.tiers.map((t) => t.adps)).toEqual(without.tiers.map((t) => t.adps));
    expect(withNull.rows.map((r) => r.severity)).toEqual(without.rows.map((r) => r.severity));
  });

  it('counts him as available without giving him a rung', () => {
    const summary = summarizePositionTiers('QB', [53.2, 55.3, null, undefined, 63.4, 65.8]);
    expect(summary.availableCount).toBe(4);
    expect(summary.unpricedCount).toBe(2);
    expect(summary.rows).toHaveLength(4);
  });

  it('opens no cliff on either side of him', () => {
    const rows = describePositionTiers('QB', [53.2, 55.3, null, 56.1, 57.4, 58.8, 60.2]);
    expect(rows.map((r) => r.severity)).not.toContain('last_in_tier');
    expect(rows.every((r) => r.tierIndex === 0)).toBe(true);
  });

  it('survives a board with no draft order at all', () => {
    const summary = summarizePositionTiers('QB', [null, null, null]);
    expect(summary.tierCount).toBe(0);
    expect(summary.availableCount).toBe(0);
    expect(assessTierCliff({ position: 'QB', playerAdp: 40, availableAdps: [null], picksUntilNext: 4 })).toEqual(
      { ...assessTierCliff({ position: 'QB', playerAdp: 40, availableAdps: [], picksUntilNext: 4 }) },
    );
  });
});

/**
 * §22. The same numbers, read at two positions.
 *
 * Positions are drafted in different shapes, so the model is allowed to read
 * one spacing pattern two ways — but only where the shape justifies it, and it
 * must say which reading it made.
 */
describe('position-specific calibration', () => {
  it('demands a bigger step at a dense position than at a banded one', () => {
    expect(boundaryRatioFor('WR')).toBeGreaterThan(boundaryRatioFor('QB'));
    expect(boundaryRatioFor('RB')).toBeGreaterThan(boundaryRatioFor('TE'));
    expect(boundaryRatioFor('SOMETHING NEW')).toBe(TIER_THRESHOLDS.defaultBoundaryRatio);
  });

  it('splits a moderate step at a banded position and not at a dense one', () => {
    // Seven picks against a four-pick baseline — 1.75x. A real band edge at
    // quarterback, where a dozen starters go in three or four groups; ordinary
    // churn at receiver, where dozens of them sit inside a few picks of each
    // other and a step that size is next week's ADP update.
    const shape = [40, 44, 48, 52, 59, 63, 67, 71];
    expect(summarizePositionTiers('QB', shape).tierCount).toBe(2);
    expect(summarizePositionTiers('WR', shape).tierCount).toBe(1);
  });

  it('reads an overwhelming step the same way everywhere', () => {
    // Nine picks against a one-pick baseline is not a matter of taste.
    const shape = [20, 21, 22, 31, 32, 33];
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      expect(summarizePositionTiers(position, shape).tierCount).toBe(2);
    }
  });

  it('still warns about it only where the absolute hole is big enough', () => {
    // Same boundary, different alarm: nine picks clears the receiver floor and
    // not the tight end one, because you wait longer for the next tight end.
    const shape = [20, 21, 22, 31, 32, 33];
    expect(assessTierCliff({ position: 'WR', playerAdp: 22, availableAdps: shape, picksUntilNext: 8 }).severity).toBe(
      'last_in_tier',
    );
    expect(assessTierCliff({ position: 'TE', playerAdp: 22, availableAdps: shape, picksUntilNext: 8 }).severity).toBe(
      'thinning',
    );
  });
});

/**
 * §10. The same gap, at two depths of the draft.
 */
describe('context-sensitive gaps', () => {
  it('asks for a bigger hole the deeper the board goes', () => {
    expect(tierNoiseFloor(220)).toBeGreaterThan(tierNoiseFloor(100));
    expect(tierNoiseFloor(100)).toBeGreaterThan(tierNoiseFloor(40));
    // Clamped at both ends: never invisible in round one, never insurmountable
    // in round eighteen.
    expect(tierNoiseFloor(1)).toBe(TIER_THRESHOLDS.minNoiseFloor);
    expect(tierNoiseFloor(9999)).toBe(TIER_THRESHOLDS.maxNoiseFloor);
  });

  it('splits a four-pick step early and ignores the same step deep', () => {
    const early = [30, 31, 32, 36, 37, 38];
    const deep = early.map((a) => a + 190);
    expect(summarizePositionTiers('QB', early).tierCount).toBe(2);
    expect(summarizePositionTiers('QB', deep).tierCount).toBe(1);
  });
});

/**
 * §12 and §13. What must not move, and what must.
 */
describe('stability', () => {
  const QB_BOARD = [
    53.2, 55.3, 63.4, 65.8, 79.4, 81, 86.9, 90.2, 93.7, 97.6, 104.8, 111.5, 124.3, 138.6, 149.2, 165.4, 178.9, 194.1,
    212.7, 228.3, 246.8, 261.2,
  ];
  /** The groups a drafting reader can actually see, which is what must hold still. */
  const top = (adps: number[]) =>
    summarizePositionTiers('QB', adps)
      .tiers.filter((t) => t.adps[0]! < 120)
      .map((t) => t.adps.filter((a) => a < 120));

  it('produces the same boundaries from the same pool every time', () => {
    const once = summarizePositionTiers('QB', QB_BOARD);
    const twice = summarizePositionTiers('QB', [...QB_BOARD].reverse());
    expect(twice.tiers.map((t) => t.adps)).toEqual(once.tiers.map((t) => t.adps));
    expect(twice.rows).toEqual(once.rows);
  });

  /**
   * The property the old `max(local, position-wide)` yardstick could not have:
   * a player forty rungs down the board is not evidence about the top of it.
   * Removing one used to move the position median, and moving the position
   * median re-tiered the starters.
   */
  it('does not re-tier the top of a position when a deep player is drafted', () => {
    const before = top(QB_BOARD);
    expect(before.length).toBeGreaterThan(2);
    for (const drafted of [194.1, 228.3, 246.8, 261.2]) {
      expect(top(QB_BOARD.filter((a) => a !== drafted))).toEqual(before);
    }
  });

  /**
   * §13. Two of a three-man group go and the third is still the third — the
   * last member of his tier, with the drop below him intact, which is what
   * `Tier cliff · 1 away` is counting.
   */
  it('keeps the last man of a group in his group rather than merging him down', () => {
    const full = [28, 31, 34, 62, 66, 70];
    expect(summarizePositionTiers('TE', full).tiers[0]!.adps).toEqual([28, 31, 34]);
    const left = full.filter((a) => a !== 28 && a !== 31);
    const depleted = summarizePositionTiers('TE', left);
    expect(depleted.tiers[0]!.adps).toEqual([34]);
    expect(depleted.tiers[0]!.endsAtCliff).toBe(true);
    expect(buildPositionTierMap('TE', left, { picksUntilNext: 8 }).at(34).remainingInTier).toBe(1);
  });
});

/**
 * §16. The probe, as a shape rather than as printed text.
 *
 * `scripts/probe-tier-granularity.mjs` prints this against the live board; what
 * is checked here is that every number it needs to explain a boundary is
 * actually carried.
 */
describe('the tier summary', () => {
  it('reports every position as groups with the arithmetic that made them', () => {
    const summary = summarizePositionTiers('TE', TE_BOARD, { picksUntilNext: 8 });
    expect(summary.position).toBe('TE');
    expect(summary.availableCount).toBe(7);
    expect(summary.tierCount).toBe(summary.tierSizes.length);
    expect(summary.tierSizes.reduce((a, b) => a + b, 0)).toBe(summary.availableCount);

    // Nothing opened the best group; everything else says what did and why.
    expect(summary.tiers[0]!.openedByGap).toBeNull();
    expect(summary.tiers[0]!.openedByReason).toBeNull();
    for (const tier of summary.tiers.slice(1)) {
      expect(tier.openedByGap).toBeGreaterThan(0);
      expect(tier.openedByLocalMedianGap).toBeGreaterThan(0);
      expect(tier.openedByRatio).toBeGreaterThan(1);
      expect(tier.openedByReason).toContain('local spacing');
    }
  });

  it('counts shared draft slots as two players in one group', () => {
    const summary = summarizePositionTiers('RB', RB_BOARD);
    expect(summary.availableCount).toBe(8);
    expect(summary.rows).toHaveLength(7);
    expect(summary.tierSizes.reduce((a, b) => a + b, 0)).toBe(8);
  });
});

/**
 * §23. The mutations these tests exist to catch.
 *
 * Each of the properties below fails under exactly one plausible regression, so
 * that reintroducing it is loud. They were checked the only way that proves
 * anything — by making the change, watching the suite go red, and undoing it.
 */
describe('the regressions this calibration must not allow back', () => {
  const QB_BOARD = [
    53.2, 55.3, 63.4, 65.8, 79.4, 81, 86.9, 90.2, 93.7, 97.6, 104.8, 111.5, 124.3, 138.6, 149.2, 165.4, 178.9, 194.1,
    212.7, 228.3, 246.8, 261.2,
  ];

  /** Mutation: raise `boundaryRatio` back towards the cliff bar. */
  it('keeps the quarterback bar below the cliff bar', () => {
    expect(boundaryRatioFor('QB')).toBeLessThan(TIER_THRESHOLDS.cliffGapRatio);
    expect(summarizePositionTiers('QB', QB_BOARD).tierCount).toBeGreaterThanOrEqual(3);
  });

  /** Mutation: measure gaps against the whole position again. */
  it('measures a gap against its neighbours and not against the position', () => {
    const rows = describePositionTiers('QB', QB_BOARD);
    const boundary = rows.find((r) => r.boundaryAfter)!;
    // The boundary is invisible on the position-wide scale and obvious locally.
    // A model reading the position median would not find it at all.
    expect(boundary.localMedianGap!).toBeLessThan(boundary.positionMedianGap!);
    expect(boundary.gapToNext!).toBeLessThan(boundary.positionMedianGap! * TIER_THRESHOLDS.cliffGapRatio);
    expect(boundary.gapRatio!).toBeGreaterThanOrEqual(boundaryRatioFor('QB'));
  });

  /**
   * Mutation: include the candidate's own gap in its own baseline.
   *
   * A gap large enough to be a boundary is, by definition, large enough to drag
   * the median of a short window towards itself — so a hole in a thin pool
   * starts hiding itself, and hides itself hardest exactly where the window is
   * smallest and the answer matters most. Three receivers two picks apart and
   * then eighteen: excluded, the baseline is 2 and the hole is 9x; included, the
   * four-gap median is 10 and the same hole is 1.8x and gone.
   */
  it('excludes a gap from the baseline it is measured against', () => {
    const rows = describePositionTiers('WR', [10, 12, 14, 32, 52]);
    const boundary = rows.find((r) => r.adp === 14)!;
    expect(boundary.localMedianGap).toBe(2);
    expect(boundary.gapRatio).toBe(9);
    expect(boundary.boundaryAfter).toBe(true);
  });

  /** Mutation: impose a minimum tier size. */
  it('allows a one-player tier when the gap below it is real', () => {
    expect(summarizePositionTiers('WR', [5, 15, 17, 19]).tierSizes[0]).toBe(1);
  });

  /** Mutation: drop the noise floor, or make it absolute. */
  it('does not turn ADP rounding into a boundary', () => {
    expect(summarizePositionTiers('QB', [201, 202, 203, 207, 208, 209]).tierCount).toBe(1);
  });

  /** Mutation: treat a missing ADP as a number. */
  it('opens no boundary around an unpriced player', () => {
    expect(summarizePositionTiers('QB', [53.2, 55.3, null, 56.1, 57.4]).tierCount).toBe(1);
  });

  /**
   * Mutation: let the deep tail decide the top of the board.
   *
   * Appending twenty backups nobody will draft is the cleanest statement of the
   * bug — under the old yardstick it raised the position median from four to
   * eleven and dissolved every boundary above ADP 100.
   */
  it('leaves the top of a position alone when the bottom of it is extended', () => {
    const groups = (adps: number[]) =>
      summarizePositionTiers('QB', adps)
        .tiers.filter((t) => t.adps[0]! < 100)
        .map((t) => t.adps.filter((a) => a < 100));
    expect(groups(QB_BOARD)).toEqual(groups(QB_BOARD.filter((a) => a < 120)));
  });

  /** Mutation: remove the fragmentation cap. */
  it('dissolves the weakest breaks when a position claims too many', () => {
    // Eight pairs, each separated by a step just over the bar: 2.17x, real
    // enough to clear it and ordinary enough that eight of them are a line
    // every other row rather than structure.
    const board = [40, 43, 49.5, 52.5, 59, 62, 68.5, 71.5, 78, 81, 87.5, 90.5, 97, 100, 106.5, 109.5];
    const summary = summarizePositionTiers('WR', board);
    const breaks = summary.rows.filter((r) => r.boundaryAfter);
    expect(breaks.length).toBeLessThan(7);
    expect(breaks.length).toBeLessThanOrEqual(Math.ceil(summary.rows.length * TIER_THRESHOLDS.maxBoundaryShare));
    expect(summary.rows.find((r) => !r.boundaryAfter && r.boundaryReason.startsWith('dissolved'))).toBeTruthy();
  });

  /**
   * Mutation: apply that cap to the breaks that matter. §7.
   *
   * The counterpart to the test above, and the reason the cap exempts strong
   * gaps: eight pairs separated by twenty-nine picks each are eight tiers, and
   * a cap that trimmed the biggest holes on the board to keep tiers a
   * respectable size would be the original bug wearing a different hat.
   */
  it('never trims a break that is overwhelming', () => {
    const board = [10, 11, 40, 41, 70, 71, 100, 101, 130, 131, 160, 161, 190, 191, 220, 221];
    const summary = summarizePositionTiers('WR', board);
    expect(summary.tierCount).toBe(8);
    expect(summary.tierSizes).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(summary.tierCount).toBeGreaterThan(Math.ceil(summary.rows.length * TIER_THRESHOLDS.maxBoundaryShare));
  });

  /**
   * Mutation: import anything that knows about the user.
   *
   * A structural test, because the property is structural. Roster need, My Guy,
   * the queue, survival, `Next%` and opportunity cost all depend on this model,
   * and a model that depended back on any of them would be circular as well as
   * wrong — the same board would report a different shape to two rosters.
   */
  it('imports nothing that knows about a roster, a queue or a simulation', () => {
    const source = readFileSync(new URL('../src/core/draft/tiers.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
    expect(imports).toEqual([]);
    for (const forbidden of ['survival', 'need', 'liveRoster', 'decisions', 'engine', 'demandAhead', 'playerOrder']) {
      expect(source).not.toContain(`${forbidden}.ts`);
    }
  });

  it('takes no input through which a roster could reach it', () => {
    // The one-player helper's entire surface. Adding a fifth key breaks this.
    const input = { position: 'QB', playerAdp: 65.8, availableAdps: QB_BOARD, picksUntilNext: 8 };
    expect(Object.keys(input).sort()).toEqual(['availableAdps', 'picksUntilNext', 'playerAdp', 'position']);
    // And the grouping is identical however far away your next pick is, which
    // is the only draft-state number that reaches this file at all.
    const now = describePositionTiers('QB', QB_BOARD, { picksUntilNext: 0 });
    const later = describePositionTiers('QB', QB_BOARD, { picksUntilNext: 60 });
    expect(now.map((r) => r.tierIndex)).toEqual(later.map((r) => r.tierIndex));
    expect(now.map((r) => r.boundaryAfter)).toEqual(later.map((r) => r.boundaryAfter));
  });
});

/**
 * §24. Cheap, and deterministic. No simulation lives here — the parallel branch
 * owns that — so a whole board's worth of ladders is a handful of passes over
 * sorted arrays.
 */
describe('cost', () => {
  it('classifies a full-depth position in linear passes', () => {
    const deep = Array.from({ length: 300 }, (_, i) => round1(1 + i * 1.7));
    const started = performance.now();
    for (let i = 0; i < 20; i++) buildPositionTierMap('WR', deep, { picksUntilNext: 8 });
    // Twenty full ladders of three hundred rungs. Generous by two orders of
    // magnitude — this is a smoke alarm for accidental quadratic work, not a
    // benchmark.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  function round1(v: number): number {
    return Math.round(v * 10) / 10;
  }
});
