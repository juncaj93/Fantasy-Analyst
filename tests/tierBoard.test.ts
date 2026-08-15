/**
 * What the board draws from the tier ladder.
 *
 * Two decisions, both easy to get subtly wrong and neither visible in a unit
 * test of `tiers.ts`:
 *
 *   - the mixed-position boards mark the last one or two players of the tier in
 *     play. The failure mode is the one this project has already shipped once —
 *     a warning on every player at a position, which is wallpaper;
 *   - a position-filtered board draws a line where the position breaks. The
 *     failure mode is the list being ordered by the ranking and not by draft
 *     order, so the tiers interleave — first it drew the same boundary several
 *     times, and once that was stopped it drew one boundary in a place that put
 *     a player on the wrong side of his own tier. A line across an interleaved
 *     list is not a line that can be true, so the rows are banded first.
 */

import { describe, expect, it } from 'vitest';
import { groupByTier, tierCliffProximity, tierDividerFlags } from '../src/core/draft/tierBoard.ts';
import { buildPositionTierMap, NO_CLIFF, type TierCliff } from '../src/core/draft/tiers.ts';

/** A tier assessment with only the fields this layer reads set. */
function tier(over: Partial<TierCliff>): TierCliff {
  return { ...NO_CLIFF, tierIndex: 0, tierSize: 1, tierEndsAtCliff: true, ...over };
}

describe('the tier-cliff proximity tag', () => {
  it('marks the last player in the tier in play', () => {
    expect(tierCliffProximity(tier({ tierSize: 1 }))).toBe(1);
  });

  it('marks both when two are left', () => {
    expect(tierCliffProximity(tier({ tierSize: 2 }))).toBe(2);
  });

  it('says nothing while three are left', () => {
    expect(tierCliffProximity(tier({ tierSize: 3 }))).toBeNull();
  });

  /**
   * The bug that made the tag worthless the first time: being *somewhere* in a
   * tier that eventually has a cliff describes every player in that tier.
   */
  it('says nothing about a tier that is merely large and ends in a cliff', () => {
    expect(tierCliffProximity(tier({ tierSize: 7 }))).toBeNull();
  });

  /**
   * The rule this replaced only marked tier 0, which made sense when a position
   * had four or five tiers and tier 0 was most of the board. Granular tiers
   * turned it into a filter that threw away every useful warning: a real
   * quarterback board has a dozen tiers, and the two-man group above a 14-pick
   * hole is tier 1.
   */
  it('marks a small group wherever it sits at the position', () => {
    expect(tierCliffProximity(tier({ tierIndex: 1, tierSize: 2 }))).toBe(2);
    expect(tierCliffProximity(tier({ tierIndex: 3, tierSize: 1 }))).toBe(1);
  });

  it('still says nothing about a large group, wherever it sits', () => {
    expect(tierCliffProximity(tier({ tierIndex: 1, tierSize: 3 }))).toBeNull();
    expect(tierCliffProximity(tier({ tierIndex: 5, tierSize: 9 }))).toBeNull();
  });

  it('says nothing when the board ran out rather than the tier', () => {
    expect(tierCliffProximity(tier({ tierSize: 2, tierEndsAtCliff: false }))).toBeNull();
  });

  it('says nothing about a player with no draft order at all', () => {
    expect(tierCliffProximity(NO_CLIFF)).toBeNull();
  });

  /**
   * Live, against the real model rather than a hand-made shape: the count is of
   * players still available, so it falls as they are taken and the next group
   * becomes the one in play when the first is gone.
   */
  describe('as the draft takes them', () => {
    const at = (adps: number[], adp: number) =>
      buildPositionTierMap('TE', adps, { picksUntilNext: 8 }).at(adp);

    // Three tight ends, then a 28-pick hole, then three more.
    const FULL = [28, 31, 34, 62, 66, 70];

    it('says nothing while three remain in the tier', () => {
      for (const adp of [28, 31, 34]) expect(tierCliffProximity(at(FULL, adp))).toBeNull();
    });

    it('marks both once one has been drafted', () => {
      const left = [31, 34, 62, 66, 70];
      expect(tierCliffProximity(at(left, 31))).toBe(2);
      expect(tierCliffProximity(at(left, 34))).toBe(2);
    });

    it('marks the last one once another has been drafted', () => {
      const left = [34, 62, 66, 70];
      expect(tierCliffProximity(at(left, 34))).toBe(1);
    });

    /**
     * Once the tier is exhausted the next one becomes the tier in play — and
     * with nothing after it, there is no cliff left to be near.
     */
    it('promotes the next tier when the first is gone', () => {
      const left = [62, 66, 70];
      expect(at(left, 62).tierIndex).toBe(0);
      expect(tierCliffProximity(at(left, 62))).toBeNull();
    });
  });

  /**
   * The regression this rule was rewritten for, on the board that showed it.
   *
   * The live quarterback ladder at pick 55: twelve tiers, and the top one is
   * two players closed by an 8-pick step — real enough to draw a line, too
   * small to be worth an alarm. Under the tier-0 rule the whole position went
   * unmarked, including a two-man group above a 14-pick hole and a one-man
   * group above a 21-pick one. Those are exactly the two cards a drafting
   * reader needs marked.
   */
  describe('the live board that had no warnings at all', () => {
    const QB = [
      53.2, 55.3, 63.4, 65.8, 79.4, 81, 90.2, 93.7, 97.6, 105.4, 111.5, 114.5, 116.9, 127.9, 149.3, 151, 164.1, 165.4,
      169.4, 178.7, 191.7, 193.7, 195.2, 199.6, 223.9, 231.8, 239.8, 247.9, 249.1, 261.3, 287, 291.8, 305.5, 319.5, 322,
    ];
    const marked = (adps: number[]) => {
      const map = buildPositionTierMap('QB', adps, { picksUntilNext: 13 });
      return adps.filter((adp) => tierCliffProximity(map.at(adp)) != null);
    };

    it('marks the groups that are one or two from a real hole', () => {
      expect(marked(QB)).toEqual([63.4, 65.8, 127.9]);
    });

    it('does not mark the top group, which is two players above an ordinary step', () => {
      // 8.1 picks. A boundary — the board does step down — but under the
      // 12-pick floor a quarterback board needs before it is worth an alarm.
      const map = buildPositionTierMap('QB', QB, { picksUntilNext: 13 });
      expect(map.at(53.2).tierSize).toBe(2);
      expect(map.at(53.2).tierEndsAtBoundary).toBe(true);
      expect(map.at(53.2).tierEndsAtCliff).toBe(false);
      expect(tierCliffProximity(map.at(53.2))).toBeNull();
    });

    /**
     * The property that makes this a warning rather than wallpaper, measured on
     * a real position rather than asserted about a shape. Cliffs are capped at a
     * fifth of a position and only the smallest groups behind one are marked, so
     * the two caps compound.
     */
    it('leaves the overwhelming majority of the position unmarked', () => {
      expect(marked(QB).length).toBeLessThanOrEqual(Math.ceil(QB.length * 0.15));
    });

    it('keeps marking a one-man group as the board empties above it', () => {
      // Drafting the top of the position does not disturb a hole ten tiers
      // down, and the reader who wants that player still needs telling.
      for (const taken of [0, 4, 8]) expect(marked(QB.slice(taken))).toContain(127.9);
    });
  });
});

/**
 * Tiers are bands, and a divider is a claim about everything either side of it.
 *
 * The reported failure, in full: the quarterback tab drew one line after the
 * first row and the reader concluded — correctly, from what was on screen —
 * that the top tier had one player in it and the next had three. The model said
 * neither. It said the first two ADPs are one tier and the next two are the
 * next, which is what the `Tier cliff · 2 away` tags a few pixels away were
 * also saying. The list was ordered by the ranking, the ranking interleaves
 * tiers, and a divider drawn across an interleaved list cannot be true.
 */
describe('drawing a position as bands', () => {
  const QB = [
    53.2, 55.3, 63.4, 65.8, 79.4, 81, 90.2, 93.7, 97.6, 105.4, 111.5, 114.5, 116.9, 127.9, 149.3, 151, 164.1, 165.4,
  ];
  /** The tab exactly as the ranking ordered it: 65.8 outranks 55.3. */
  const RANKED = [53.2, 65.8, 55.3, 63.4, 81, 79.4, 90.2, 93.7, 97.6];

  const map = () => buildPositionTierMap('QB', QB, { picksUntilNext: 13 });
  const drawn = () => {
    const m = map();
    const ordered = groupByTier(RANKED, (adp) => m.at(adp).tierIndex);
    const flags = tierDividerFlags(ordered.map((adp) => m.at(adp).tierIndex));
    return { ordered, flags, m };
  };

  it('puts a tier-mate back beside his tier rather than across the line', () => {
    const { ordered } = drawn();
    // 55.3 belongs with 53.2 and was being drawn below the divider, among the
    // players it is two picks better than.
    expect(ordered.slice(0, 4)).toEqual([53.2, 55.3, 65.8, 63.4]);
  });

  it('draws each break once, between the bands it separates', () => {
    const { ordered, flags, m } = drawn();
    const opensAt = ordered.filter((_, i) => flags[i]);
    expect(opensAt).toEqual([65.8, 81, 90.2]);
    // And the tier above every line is complete before the line is drawn.
    for (let i = 1; i < ordered.length; i++) {
      const above = m.at(ordered[i - 1]!).tierIndex!;
      const here = m.at(ordered[i]!).tierIndex!;
      expect(here).toBeGreaterThanOrEqual(above);
      expect(flags[i]).toBe(here > above);
    }
  });

  /** The contradiction the reader spotted: a line said three, a chip said two. */
  it('agrees with the tags drawn beside it', () => {
    const { ordered, flags, m } = drawn();
    const band = (start: number) => {
      const out = [ordered[start]!];
      for (let i = start + 1; i < ordered.length && !flags[i]; i++) out.push(ordered[i]!);
      return out;
    };
    const second = band(ordered.findIndex((_, i) => flags[i]));
    expect(second).toEqual([65.8, 63.4]);
    for (const adp of second) {
      expect(m.at(adp).tierSize).toBe(second.length);
      expect(tierCliffProximity(m.at(adp))).toBe(second.length);
    }
  });

  it('keeps the ranking inside a band', () => {
    // 65.8 still comes before 63.4: they are one decision, and which of them to
    // prefer is exactly what the ranking is for.
    const { ordered } = drawn();
    expect(ordered.indexOf(65.8)).toBeLessThan(ordered.indexOf(63.4));
    expect(ordered.indexOf(81)).toBeLessThan(ordered.indexOf(79.4));
  });
});

describe('grouping rows into bands', () => {
  const rows = (tiers: (number | null)[]) => tiers.map((tier, i) => ({ tier, id: i }));
  const tiersOf = (out: { tier: number | null }[]) => out.map((r) => r.tier);

  it('is stable inside a band', () => {
    const out = groupByTier(rows([0, 1, 0, 1, 2]), (r) => r.tier);
    expect(tiersOf(out)).toEqual([0, 0, 1, 1, 2]);
    expect(out.map((r) => r.id)).toEqual([0, 2, 1, 3, 4]);
  });

  it('leaves an already-ordered board exactly as it was', () => {
    const before = rows([0, 0, 1, 2, 2]);
    expect(groupByTier(before, (r) => r.tier)).toEqual(before);
  });

  it('keeps players with no draft order at the tail', () => {
    const out = groupByTier(rows([1, null, 0, null]), (r) => r.tier);
    expect(tiersOf(out)).toEqual([0, 1, null, null]);
  });

  it('handles an empty board', () => {
    expect(groupByTier([], () => null)).toEqual([]);
  });
});

describe('where a tier divider goes', () => {
  it('draws one line at each boundary and none inside a tier', () => {
    expect(tierDividerFlags([0, 0, 0, 1, 1, 2])).toEqual([false, false, false, true, false, true]);
  });

  it('never draws above the first row', () => {
    expect(tierDividerFlags([0, 0])).toEqual([false, false]);
    // Even when the list happens to start below the best tier — a filtered
    // board whose top tier is already fully drafted.
    expect(tierDividerFlags([2, 2, 3])).toEqual([false, false, true]);
  });

  it('draws nothing when the whole position is one tier', () => {
    expect(tierDividerFlags([0, 0, 0, 0])).toEqual([false, false, false, false]);
  });

  /**
   * The ranking is not draft order. A player lifted above his tier-mates by the
   * news ledger must not open his tier a second time on the way past.
   */
  it('draws a boundary once even when the ranking crosses back over it', () => {
    expect(tierDividerFlags([0, 1, 0, 1, 1])).toEqual([false, true, false, false, false]);
  });

  it('skips a tier that no available player is left in', () => {
    // Tier 1 is fully drafted; the line above tier 2 is still drawn once.
    expect(tierDividerFlags([0, 0, 2, 2])).toEqual([false, false, true, false]);
  });

  it('ignores players with no tier at all', () => {
    expect(tierDividerFlags([0, null, 0, 1])).toEqual([false, false, false, true]);
  });
});
