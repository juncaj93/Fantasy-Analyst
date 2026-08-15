/**
 * What the board draws from the tier ladder.
 *
 * Two decisions, both easy to get subtly wrong and neither visible in a unit
 * test of `tiers.ts`:
 *
 *   - the boards mark the last one or two players of the group you are actually
 *     choosing from at a position. Two failure modes, and this project has now
 *     shipped both: a warning on every player at a position, which is
 *     wallpaper; and a warning on a group two tiers down while the group above
 *     it is still there, which points at the wrong card;
 *   - a position-filtered board draws a line where the position breaks. The
 *     failure mode is the list being ordered by the ranking and not by draft
 *     order, so the tiers interleave — first it drew the same boundary several
 *     times, and once that was stopped it drew one boundary in a place that put
 *     a player on the wrong side of his own tier. A line across an interleaved
 *     list is not a line that can be true, so the rows are banded first.
 */

import { describe, expect, it } from 'vitest';
import {
  activeTierCliffWarnings,
  groupByTier,
  tierCliffWarning,
  tierDividerFlags,
  type WarnablePlayer,
} from '../src/core/draft/tierBoard.ts';
import { buildPositionTierMap, NO_CLIFF, type TierCliff } from '../src/core/draft/tiers.ts';

/** A tier assessment with only the fields this layer reads set. */
function tier(over: Partial<TierCliff>): TierCliff {
  return { ...NO_CLIFF, tierIndex: 0, tierSize: 1, tierEndsAtBoundary: true, tierEndsAtCliff: true, ...over };
}

/**
 * A position, as a ladder of ADPs, read the way the board reads it.
 *
 * Availability is the only input that moves: the map is rebuilt from whoever is
 * left, so "the best tier still available" needs no state of its own and
 * drafting somebody is just a shorter array.
 */
function board(position: string, available: number[], names: Record<number, string> = {}): WarnablePlayer[] {
  const map = buildPositionTierMap(position, available, { picksUntilNext: 9 });
  return available.map((adp) => ({
    playerId: names[adp] ?? `${position}-${adp}`,
    position,
    tier: map.at(adp),
  }));
}

/** Who is warned, and what their chip says. */
const warned = (players: WarnablePlayer[]) =>
  [...activeTierCliffWarnings(players)].map(([id, w]) => `${id}: ${w.label}`);

describe('the tier-cliff warning', () => {
  it('marks the last player in the active tier', () => {
    expect(tierCliffWarning(tier({ tierSize: 1 }))?.label).toBe('Tier cliff · last 1');
  });

  it('marks both when two are left', () => {
    expect(tierCliffWarning(tier({ tierSize: 2 }))?.label).toBe('Tier cliff · 2 left');
  });

  it('counts players remaining, never picks', () => {
    // The copy this replaced said "2 away" and "1 away", which reads as a
    // distance to something. The number has always been a headcount.
    for (const size of [1, 2]) {
      const warning = tierCliffWarning(tier({ tierSize: size }))!;
      expect(warning.label).not.toMatch(/away/);
      expect(warning.remaining).toBe(size);
      expect(warning.label).toContain(String(size));
      expect(warning.short).toBe(`Cliff · ${size}`);
    }
  });

  it('says nothing while three are left', () => {
    expect(tierCliffWarning(tier({ tierSize: 3 }))).toBeNull();
  });

  /**
   * The bug that made the tag worthless the first time: being *somewhere* in a
   * tier that eventually has a cliff describes every player in that tier.
   */
  it('says nothing about a tier that is merely large and ends in a cliff', () => {
    expect(tierCliffWarning(tier({ tierSize: 7 }))).toBeNull();
  });

  /**
   * The bug that made it wrong the second time, and the one this pass exists
   * for. A group below the one you are choosing from is not endangered by
   * anything yet — everything above it has to go first.
   */
  it('says nothing about a tier below the active one, however small', () => {
    expect(tierCliffWarning(tier({ tierIndex: 1, tierSize: 2 }))).toBeNull();
    expect(tierCliffWarning(tier({ tierIndex: 3, tierSize: 1 }))).toBeNull();
  });

  /**
   * The other half of the repair. `tierEndsAtCliff` also demands an absolute
   * hole in picks — twelve at quarterback — which is the right bar for
   * interrupting a reader about a hole and the wrong one for "this group is
   * down to its last player". The boundary is the test.
   */
  it('marks a lone player above an ordinary boundary, not only above an alarm', () => {
    const ordinary = tier({ tierSize: 1, tierEndsAtBoundary: true, tierEndsAtCliff: false });
    expect(tierCliffWarning(ordinary)?.label).toBe('Tier cliff · last 1');
  });

  it('says nothing when the board ran out rather than the tier', () => {
    expect(tierCliffWarning(tier({ tierSize: 1, tierEndsAtBoundary: false, tierEndsAtCliff: false }))).toBeNull();
    expect(tierCliffWarning(tier({ tierSize: 2, tierEndsAtBoundary: false, tierEndsAtCliff: false }))).toBeNull();
  });

  it('says nothing about a player with no draft order at all', () => {
    expect(tierCliffWarning(NO_CLIFF)).toBeNull();
  });
});

/**
 * The reported board, and the state machine it walks through.
 *
 * The live quarterback ladder with the best one already drafted: one player
 * alone in the top tier above an 8-pick step, then two, then two, then three.
 * Shipped, the lone player said nothing and the two below him both said
 * `Tier cliff · 2 away` — pointing at the group you would fall *into* rather
 * than the one that was about to run out.
 */
describe('the reported quarterback board', () => {
  const NAMES: Record<number, string> = {
    55.3: 'top', 63.4: 'second-a', 65.8: 'second-b', 79.4: 'third-a', 81: 'third-b',
    90.2: 'fourth-a', 93.7: 'fourth-b', 97.6: 'fourth-c',
  };
  const FULL = [
    55.3, 63.4, 65.8, 79.4, 81, 90.2, 93.7, 97.6, 105.4, 111.5, 114.5, 116.9, 127.9, 149.3, 151, 164.1, 165.4, 169.4,
  ];
  const qb = (available: number[]) => board('QB', available, NAMES);

  it('warns the lone player in the best tier left, and nobody else', () => {
    expect(warned(qb(FULL))).toEqual(['top: Tier cliff · last 1']);
  });

  it('promotes the next tier once he is drafted, and warns both of them', () => {
    expect(warned(qb(FULL.slice(1)))).toEqual([
      'second-a: Tier cliff · 2 left',
      'second-b: Tier cliff · 2 left',
    ]);
  });

  it('counts down to the last of that tier', () => {
    // 63.4 drafted; 65.8 alone at the top of the position.
    expect(warned(qb(FULL.filter((a) => a !== 55.3 && a !== 63.4)))).toEqual(['second-b: Tier cliff · last 1']);
  });

  it('promotes again when that tier is exhausted', () => {
    const left = FULL.filter((a) => a > 70);
    expect(warned(qb(left))).toEqual(['third-a: Tier cliff · 2 left', 'third-b: Tier cliff · 2 left']);
  });

  it('says nothing at all while the best tier still has three in it', () => {
    // Straight to the four-man band: nothing is about to run out.
    expect(warned(qb(FULL.filter((a) => a >= 90.2)))).toEqual([]);
  });
});

/**
 * The state machine, as a fixture rather than a board. Three tiers, drafted one
 * player at a time, with the right answer written down at every step.
 */
describe('drafting through a position', () => {
  //  A            | B, C          | D, E
  const LADDER = [10, 40, 42, 80, 82];
  const NAMES: Record<number, string> = { 10: 'A', 40: 'B', 42: 'C', 80: 'D', 82: 'E' };
  const at = (available: number[]) => warned(board('WR', available, NAMES));

  it('starts with the singleton top tier warned alone', () => {
    expect(board('WR', LADDER).map((p) => p.tier.tierIndex)).toEqual([0, 1, 1, 2, 2]);
    expect(at(LADDER)).toEqual(['A: Tier cliff · last 1']);
  });

  it('warns both of the next tier once A is gone', () => {
    expect(at([40, 42, 80, 82])).toEqual(['B: Tier cliff · 2 left', 'C: Tier cliff · 2 left']);
  });

  it('warns the survivor once B is gone', () => {
    expect(at([42, 80, 82])).toEqual(['C: Tier cliff · last 1']);
  });

  it('promotes the last tier once C is gone — and it has nothing below it', () => {
    // D and E are now the whole position. Running out of board is not a cliff.
    expect(at([80, 82])).toEqual([]);
  });
});

/**
 * §29's threshold fixture: a three-player top tier stays quiet until it is not.
 */
describe('the three-player threshold', () => {
  const NAMES: Record<number, string> = { 10: 'A', 12: 'B', 14: 'C' };
  // Three at the top, then a chasm, then three more — deep enough that taking
  // the top band apart still leaves the model a ladder to read.
  const LOWER = [60, 62, 64];
  const at = (available: number[]) => warned(board('WR', [...available, ...LOWER], NAMES));

  it('says nothing while three remain', () => {
    expect(at([10, 12, 14])).toEqual([]);
  });

  it('speaks the moment there are two', () => {
    expect(at([12, 14])).toEqual(['B: Tier cliff · 2 left', 'C: Tier cliff · 2 left']);
  });

  it('and again at one', () => {
    expect(at([14])).toEqual(['C: Tier cliff · last 1']);
  });
});

describe('when there is nothing to fall to', () => {
  it('never warns a position that is all one tier', () => {
    expect(warned(board('WR', [20, 21, 22]))).toEqual([]);
    expect(warned(board('WR', [20]))).toEqual([]);
    expect(warned(board('WR', [20, 21]))).toEqual([]);
  });

  it('never warns the last player at a position', () => {
    const players = board('TE', [28, 31, 34, 62, 66, 70]);
    const last = players.at(-1)!;
    expect(last.tier.tierIndex).toBeGreaterThan(0);
    expect(tierCliffWarning(last.tier)).toBeNull();
  });
});

/**
 * §7 and §31. Each position runs out of its own best group on its own
 * schedule, and the board says so about all of them at once.
 */
describe('positions are independent', () => {
  it('warns each position from its own active tier', () => {
    const players = [
      // One quarterback left above a break, then a lower band.
      ...board('QB', [50, 80, 84, 88], { 50: 'qb-top', 80: 'qb-b1', 84: 'qb-b2', 88: 'qb-b3' }),
      // Two tight ends, then a chasm.
      ...board('TE', [30, 33, 90, 94, 98], { 30: 'te-a', 33: 'te-b' }),
      // Four receivers in the top band: nothing about to run out.
      ...board('WR', [40, 41, 42, 43, 70, 71], { 40: 'wr-a', 41: 'wr-b', 42: 'wr-c', 43: 'wr-d' }),
    ];
    expect(warned(players)).toEqual([
      'qb-top: Tier cliff · last 1',
      'te-a: Tier cliff · 2 left',
      'te-b: Tier cliff · 2 left',
    ]);
  });

  /** §23 and §24, asserted over a whole board rather than a shape. */
  it('never warns a worse tier while a better one at the position survives', () => {
    const players = [
      ...board('QB', [55.3, 63.4, 65.8, 79.4, 81, 90.2, 93.7, 97.6, 105.4, 111.5]),
      ...board('TE', [30, 33, 90, 94, 98]),
      ...board('RB', [20, 22, 24, 26, 60, 62]),
    ];
    const warnings = activeTierCliffWarnings(players);
    const byPosition = new Map<string, Set<number>>();
    for (const player of players) {
      if (!warnings.has(player.playerId)) continue;
      const seen = byPosition.get(player.position) ?? new Set<number>();
      seen.add(player.tier.tierIndex!);
      byPosition.set(player.position, seen);
      // Nothing below the active tier may warn, ever.
      expect(player.tier.tierIndex).toBe(0);
    }
    // At most one warned tier per position, and never zero-sized.
    for (const tiers of byPosition.values()) expect(tiers.size).toBe(1);
  });
});

/**
 * §33. The two views draw the chip differently and must agree about who gets
 * one — eligibility is a fact about the draft, not about the filter.
 */
describe('the filtered and mixed views agree', () => {
  it('picks the same quarterbacks either way', () => {
    const QB = [55.3, 63.4, 65.8, 79.4, 81, 90.2, 93.7];
    const filtered = board('QB', QB);
    const mixed = [...board('QB', QB), ...board('WR', [40, 41, 90, 92])];
    const fromMixed = [...activeTierCliffWarnings(mixed)].filter(([id]) => id.startsWith('QB-'));
    expect(fromMixed).toEqual([...activeTierCliffWarnings(filtered)]);
  });
});

/** §11 and §34. Unknown stays unknown. */
describe('players the market has not priced', () => {
  it('gives them no warning and lets them change nobody else\'s', () => {
    const priced = board('QB', [55.3, 63.4, 65.8, 79.4, 81]);
    const withUnpriced: WarnablePlayer[] = [...priced, { playerId: 'unpriced', position: 'QB', tier: NO_CLIFF }];
    expect(activeTierCliffWarnings(withUnpriced).has('unpriced')).toBe(false);
    expect(warned(withUnpriced)).toEqual(warned(priced));
  });
});

/**
 * §35. Each of these fails under exactly one plausible regression, checked the
 * only way that proves anything — by making the change and watching it go red.
 */
describe('the regressions this rule must not allow back', () => {
  const QB = [55.3, 63.4, 65.8, 79.4, 81, 90.2, 93.7, 97.6];

  /** Mutation: drop the tier-0 gate. */
  it('keeps a two-player second tier quiet while one player holds the first', () => {
    const players = board('QB', QB, { 55.3: 'top', 63.4: 'b', 65.8: 'c' });
    expect(players.find((p) => p.playerId === 'b')!.tier.tierSize).toBe(2);
    expect(warned(players)).toEqual(['top: Tier cliff · last 1']);
  });

  /** Mutation: restore the `away` copy. */
  it('never says away', () => {
    for (const size of [1, 2]) {
      const warning = tierCliffWarning(tier({ tierSize: size }))!;
      expect(`${warning.label} ${warning.short}`).not.toMatch(/away/i);
    }
    expect(tierCliffWarning(tier({ tierSize: 1 }))!.label).toBe('Tier cliff · last 1');
    expect(tierCliffWarning(tier({ tierSize: 2 }))!.label).toBe('Tier cliff · 2 left');
  });

  /** Mutation: warn only the first of a two-player tier. */
  it('warns both members of a two-player active tier, not one', () => {
    const players = board('QB', QB.slice(1), { 63.4: 'b', 65.8: 'c' });
    expect(warned(players)).toEqual(['b: Tier cliff · 2 left', 'c: Tier cliff · 2 left']);
  });

  /** Mutation: raise the threshold to three. */
  it('never warns a three-player active tier', () => {
    expect(warned(board('QB', [90.2, 93.7, 97.6, 130, 133]))).toEqual([]);
  });

  /** Mutation: warn a singleton with nothing under it. */
  it('never warns the only tier at a position', () => {
    expect(warned(board('QB', [90]))).toEqual([]);
  });

  /**
   * Mutation: let the alarm floor gate the chip again.
   *
   * This is the shipped bug in one line. The top quarterback's tier ends at a
   * real boundary that is under the position's 12-pick alarm floor, so a rule
   * asking `tierEndsAtCliff` finds nothing to say about the one card that
   * needed it.
   */
  it('warns above a boundary the alarm floor would have swallowed', () => {
    const top = board('QB', QB, { 55.3: 'top' }).find((p) => p.playerId === 'top')!;
    expect(top.tier.tierEndsAtBoundary).toBe(true);
    expect(top.tier.tierEndsAtCliff).toBe(false);
    expect(tierCliffWarning(top.tier)?.remaining).toBe(1);
  });

  /**
   * Mutation: reach for the survival model.
   *
   * Warning eligibility and `Next%` answer different questions, and the type
   * this rule reads has no way to express one. A board where every player is
   * near-certain to survive warns exactly the same players.
   */
  it('takes nothing from the survival model', () => {
    const players = board('QB', QB);
    const surviving = players.map((p) => ({ ...p, tier: { ...p.tier, score: 0, survivingTierMates: 99 } }));
    expect(warned(surviving)).toEqual(warned(players));
    expect(Object.keys(tierCliffWarning(tier({ tierSize: 2 }))!).sort()).toEqual(['label', 'remaining', 'short']);
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

  /**
   * The contradiction the reader spotted: a line said three, a chip said two.
   *
   * Both halves are checked. The top band is the one the chips are about, so
   * every member of it carries the same count and the same chip; the band below
   * is drawn with its own divider and stays silent, because the group above it
   * has to go first.
   */
  it('agrees with the tags drawn beside it', () => {
    const { ordered, flags, m } = drawn();
    const band = (start: number) => {
      const out = [ordered[start]!];
      for (let i = start + 1; i < ordered.length && !flags[i]; i++) out.push(ordered[i]!);
      return out;
    };
    const first = band(0);
    expect(first).toEqual([53.2, 55.3]);
    for (const adp of first) {
      expect(m.at(adp).tierSize).toBe(first.length);
      expect(tierCliffWarning(m.at(adp))?.label).toBe('Tier cliff · 2 left');
    }
    const second = band(ordered.findIndex((_, i) => flags[i]));
    expect(second).toEqual([65.8, 63.4]);
    for (const adp of second) expect(tierCliffWarning(m.at(adp))).toBeNull();
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
