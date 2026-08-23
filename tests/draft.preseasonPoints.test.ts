/**
 * The imported preseason projection, as a bounded draft signal.
 *
 * The numbers below are the real ones from the proven StartWho import, so what
 * is asserted here is what the board will actually do rather than what a
 * convenient fixture would.
 *
 * Two properties carry the whole design: exactly one market-derived opinion
 * reaches the ranking per player, and a player nobody projected is treated the
 * same as an ordinary one rather than a bad one.
 */

import { describe, expect, it } from 'vitest';
import { preseasonPointsPool, preseasonPointsScore } from '../src/core/draft/preseasonPoints.ts';
import { DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { hasPreseasonPointsCoverage, sortBoard, SORT_LABELS, SORT_MODES } from '../src/core/draft/boardSort.ts';

/** Real values, from the import proved in Phase 1. */
const REAL: [string, string, number][] = [
  ['Josh Allen', 'QB', 386.1],
  ['Drake Maye', 'QB', 347.5],
  ['Joe Burrow', 'QB', 355.4],
  ['Lamar Jackson', 'QB', 335.0],
  ['Brock Purdy', 'QB', 336.7],
  ['Jahmyr Gibbs', 'RB', 292.0],
  ['Bijan Robinson', 'RB', 280.1],
  ['Christian McCaffrey', 'RB', 253.1],
  ['Derrick Henry', 'RB', 238.7],
  ['Ashton Jeanty', 'RB', 212.4],
  ["Ja'Marr Chase", 'WR', 247.4],
  ['Puka Nacua', 'WR', 234.8],
  ['Amon-Ra St. Brown', 'WR', 232.2],
  ['CeeDee Lamb', 'WR', 209.5],
  ['Nico Collins', 'WR', 190.5],
  ['Trey McBride', 'TE', 183.7],
  ['Brock Bowers', 'TE', 175.2],
  ['Kyle Pitts', 'TE', 135.0],
  ['Travis Kelce', 'TE', 127.7],
];

const POOL = preseasonPointsPool(
  REAL.map(([name, position, points]) => ({ playerId: name, position, points })),
);

const scoreOf = (name: string) => {
  const row = REAL.find(([n]) => n === name)!;
  return preseasonPointsScore({ position: row[1], points: row[2] }, POOL);
};

describe('the standing is positional', () => {
  it('rates a player against his own position, not the board', () => {
    // Josh Allen's 386.1 and Gibbs's 292.0 are not comparable quantities; both
    // lead their positions and both score at the top.
    expect(scoreOf('Josh Allen')).toBeGreaterThan(0);
    expect(scoreOf('Jahmyr Gibbs')).toBeGreaterThan(0);
    // Kelce's 127.7 is the lowest tight end and scores below the middle, even
    // though it would be an absurd number for a quarterback to be judged by.
    expect(scoreOf('Travis Kelce')).toBeLessThan(0);
  });

  it('puts an ordinary player near zero', () => {
    // The median of the pool is the neutral point, which is what lets an
    // unprojected player contribute exactly what an average one does.
    const all = REAL.map(([n]) => scoreOf(n)).filter((s): s is number => s != null);
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    expect(Math.abs(mean)).toBeLessThan(0.35);
  });

  it('leaves a player out of his own comparison pool', () => {
    // Otherwise a player drags the median toward himself, which flatters the
    // outliers exactly where the board is being asked to separate people.
    const solo = preseasonPointsPool([{ playerId: 'a', position: 'QB', points: 400 }]);
    expect(preseasonPointsScore({ position: 'QB', points: 400 }, solo)).toBeNull();
  });
});

describe('the contribution is bounded', () => {
  it('never exceeds the market component\'s own weight', () => {
    const w = DEFAULT_WEIGHTS.marketExpectation;
    for (const [name] of REAL) {
      const s = scoreOf(name);
      if (s == null) continue;
      expect(Math.abs(s * w)).toBeLessThanOrEqual(w + 1e-9);
    }
    // ±0.2 against a total weight of about 3.6 across every component.
    expect(w).toBe(0.2);
  });

  it('does not change the weight it rides on', () => {
    // The whole point of the fallback design: no new weight, no retuning.
    expect(DEFAULT_WEIGHTS.marketExpectation).toBe(0.2);
  });
});

describe('unknown stays unknown', () => {
  it('is null for a player with no projection', () => {
    expect(preseasonPointsScore({ position: 'QB', points: null }, POOL)).toBeNull();
  });

  it('is null when too few of his peers are projected', () => {
    const thin = preseasonPointsPool([
      { playerId: 'a', position: 'K', points: 120 },
      { playerId: 'b', position: 'K', points: 118 },
    ]);
    expect(preseasonPointsScore({ position: 'K', points: 120 }, thin)).toBeNull();
  });

  it('is null for a position the snapshot never covered', () => {
    expect(preseasonPointsScore({ position: 'DEF', points: 116 }, POOL)).toBeNull();
  });
});

describe('the PTS sort', () => {
  const rows = REAL.map(([name, , points], i) => ({
    playerId: name,
    name,
    score: 50,
    total: 1 - i / 100,
    adp: i + 1,
    dogAdp: null,
    preseasonPoints: points,
  }));

  it('is a mode the control offers, labelled PTS', () => {
    expect(SORT_MODES).toContain('pts');
    expect(SORT_LABELS.pts).toBe('PTS');
  });

  it('puts the highest projection first', () => {
    // Descending, unlike ADP and DOG: a projection is a quantity, not a draft
    // position, so reading it as "smallest first" would invert the board while
    // looking entirely normal.
    const sorted = sortBoard(rows, 'pts');
    expect(sorted[0]?.name).toBe('Josh Allen');
    expect(sorted[1]?.name).toBe('Joe Burrow');
  });

  it('puts players with no projection last, not at zero', () => {
    const withGap = [...rows, { ...rows[0]!, playerId: 'nobody', name: 'Nobody', preseasonPoints: null }];
    const sorted = sortBoard(withGap, 'pts');
    expect(sorted[sorted.length - 1]?.name).toBe('Nobody');
  });

  it('breaks ties deterministically, by the board\'s own order', () => {
    const tied = [
      { playerId: 'b', name: 'B', score: 50, total: 0.4, adp: 2, dogAdp: null, preseasonPoints: 200 },
      { playerId: 'a', name: 'A', score: 50, total: 0.9, adp: 1, dogAdp: null, preseasonPoints: 200 },
    ];
    expect(sortBoard(tied, 'pts').map((r) => r.name)).toEqual(['A', 'B']);
    expect(sortBoard([...tied].reverse(), 'pts').map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('knows when it has nothing to order by', () => {
    expect(hasPreseasonPointsCoverage(rows)).toBe(true);
    expect(hasPreseasonPointsCoverage(rows.map((r) => ({ ...r, preseasonPoints: null })))).toBe(false);
  });

  it('leaves the other modes alone', () => {
    expect(sortBoard(rows, 'adp')[0]?.name).toBe('Josh Allen');
    expect(sortBoard(rows, 'score')[0]?.name).toBe('Josh Allen');
  });
});
