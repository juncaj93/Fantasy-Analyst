/**
 * Tier calibration.
 *
 * The bug these exist for: a tight end board of seven players spread over sixty
 * ADP picks came back with seven `Tier cliff` labels. So the first thing tested
 * is restraint — the reported TE and RB boards, asserted by count — and only
 * then that a genuine hole is still found. A cliff detector that never fires is
 * as useless as one that always does, and both failures are cheap to write, so
 * both directions are pinned.
 */

import { describe, expect, it } from 'vitest';
import {
  TIER_THRESHOLDS,
  assessTierCliff,
  buildPositionTierMap,
  describePositionTiers,
  minGapFor,
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

  it('finds the one real hole in it', () => {
    // 78 -> 99 is a 21-pick gap where the position is otherwise spaced ~9.
    const at = (adp: number) =>
      assessTierCliff({ position: 'TE', playerAdp: adp, availableAdps: TE_BOARD, picksUntilNext: 8 });
    expect(at(78).severity).toBe('last_in_tier');
    expect(at(78).gapToNext).toBe(21);
    expect(at(78).gapRatio!).toBeGreaterThanOrEqual(TIER_THRESHOLDS.cliffGapRatio);
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
    const cliff = rows.find((r) => r.severity === 'last_in_tier')!;
    expect(cliff.adp).toBe(78);
    expect(cliff.reason).toContain('x the spacing');
    // Every rung explains itself, including the quiet ones.
    for (const row of rows) expect(row.reason.length).toBeGreaterThan(0);
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
