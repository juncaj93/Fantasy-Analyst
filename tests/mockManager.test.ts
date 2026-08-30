/**
 * What a bot manager does on the clock, and what it refuses to do.
 *
 * The brief names three inputs and their order of importance — ADP heaviest,
 * then a sample-gated tendency, then bounded jitter — so the assertions here
 * are about that ordering rather than about any particular pick. Three claims,
 * and all three are properties rather than golden values:
 *
 *  1. **The market is the anchor.** Over many draws the bot takes near the top
 *     of the board far more often than anywhere else, and a player forty places
 *     down is never taken at all.
 *  2. **History nudges, and only with a sample.** A manager whose profile is
 *     `usable` moves his own weights by a bounded amount; one below the
 *     threshold moves nothing, and drafts exactly as he would have before
 *     `core/managers/` existed.
 *  3. **The randomness is drawn, not generated.** The same board, manager and
 *     draw give the same pick — in this process, in a Worker, and in a browser.
 */

import { describe, expect, it } from 'vitest';
import {
  MOCK_MANAGER,
  bestAvailable,
  mockManagerMultipliers,
  pickForMockManager,
  type MockCandidate,
  reachTolerance,
} from '../src/core/draft/mockManager.ts';
import { advanceMockDraft, createMockDraft, type MockRoom } from '../src/core/draft/mockDraft.ts';
import { MANAGER_PRIOR } from '../src/core/draft/nextpick/managerPrior.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import type { ManagerTendencies, PositionTendency } from '../src/core/managers/managerTendencies.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

/** A board where the market order is the player number, and positions cycle. */
function board(size = 60): MockCandidate[] {
  const positions = ['RB', 'WR', 'QB', 'TE'];
  return Array.from({ length: size }, (_, i) => ({
    playerId: `p${i + 1}`,
    position: positions[i % positions.length]!,
    marketRank: i + 1,
  }));
}

function tendencies(lift: Record<string, number>, usable = true): ManagerTendencies {
  const byPosition = new Map<string, PositionTendency>();
  for (const [position, value] of Object.entries(lift)) {
    byPosition.set(position, {
      position,
      lift: value,
      medianFirstRound: null,
      roomMedianFirstRound: null,
      rateByBucket: {},
      draftsWithPosition: 2,
      spread: null,
      confidence: 0.8,
    });
  }
  return {
    userId: 'u1',
    displayName: 'Rival',
    draftsObserved: 2,
    picksObserved: 30,
    seasons: ['2024', '2025'],
    usable,
    byPosition,
    notes: [],
  };
}

/** Every pick the model can make over the whole draw space, at fine resolution. */
function distribution(input: Parameters<typeof pickForMockManager>[0] extends never ? never : {
  candidates: MockCandidate[];
  tendencies?: ManagerTendencies | null;
  held?: Record<string, number>;
}): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < 1000; i++) {
    const pick = pickForMockManager({
      candidates: input.candidates,
      tendencies: input.tendencies ?? null,
      ...(input.held ? { held: input.held } : {}),
      shape: SHAPE,
      draw: i / 1000,
    })!;
    out.set(pick.playerId, (out.get(pick.playerId) ?? 0) + 1);
  }
  return out;
}

describe('the market is the anchor', () => {
  it('takes best available more often than anybody else, by a distance', () => {
    const counts = distribution({ candidates: board() });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0]![0], 'the most-taken player is the top of the market').toBe('p1');
    expect(counts.get('p1')!).toBeGreaterThan(counts.get('p2')!);
    expect(counts.get('p2')!).toBeGreaterThan(counts.get('p5')!);
  });

  it('never reaches past the window, however the draw falls', () => {
    const counts = distribution({ candidates: board() });
    for (const playerId of counts.keys()) {
      expect(Number(playerId.slice(1)), `${playerId} is inside the window`).toBeLessThanOrEqual(
        MOCK_MANAGER.window,
      );
    }
  });

  it('is not a deterministic replay: a different draw is a different draft', () => {
    const counts = distribution({ candidates: board() });
    expect(counts.size, 'more than one player is reachable').toBeGreaterThan(4);
  });

  it('sorts unpriced players behind everybody the market has a number for', () => {
    const pool: MockCandidate[] = [
      { playerId: 'unpriced', position: 'WR', marketRank: null },
      { playerId: 'cheap', position: 'WR', marketRank: 200 },
      { playerId: 'top', position: 'RB', marketRank: 1 },
    ];
    expect(bestAvailable(pool, 3).map((c) => c.playerId)).toEqual(['top', 'cheap', 'unpriced']);
  });

  it('breaks ties on the player id, so a query plan cannot change a mock', () => {
    const a: MockCandidate[] = [
      { playerId: 'b', position: 'WR', marketRank: 4 },
      { playerId: 'a', position: 'WR', marketRank: 4 },
    ];
    expect(bestAvailable(a, 2).map((c) => c.playerId)).toEqual(['a', 'b']);
    expect(bestAvailable([...a].reverse(), 2).map((c) => c.playerId)).toEqual(['a', 'b']);
  });
});

/**
 * What the market anchor is actually worth, in the unit that matters.
 *
 * The old model decayed over a candidate's *index* in the best-available list,
 * which cannot tell a near-tie from a chasm: the top player carried 25.7% of the
 * mass whether he was one pick clear of the field or thirteen. Over four hundred
 * seeded rooms the consensus number-one went first 30% of the time and fell past
 * pick nine in 7% of them — one room in fourteen, which is how the owner met it
 * (Gibbs, ADP 1, gone at pick 10).
 *
 * Every test in the block above passed before that was fixed and passes after,
 * which is why it survived: "takes best available more often than anybody else"
 * is true at 25.7% and at 69%. These are the assertions that tell them apart.
 */
describe('the market anchor holds', () => {
  /** How much of the draw space one player owns. */
  const massOf = (candidates: MockCandidate[], playerId: string): number => {
    const counts = distribution({ candidates });
    return (counts.get(playerId) ?? 0) / 1000;
  };

  it('gives the best available most of the board at the top of the draft', () => {
    // Not "more than anyone else" — most of it. A coin that comes up tails
    // three times in four is what let nine managers in a row pass the same man.
    expect(massOf(board(), 'p1')).toBeGreaterThan(0.6);
  });

  it('treats a player the market rates a round higher as near-certain', () => {
    /*
     * The near-tie clause, stated as its opposite. Thirteen picks of daylight
     * between the top player and the rest is not a decision a room agonises
     * over, and randomness has no business overriding it.
     */
    const gapped: MockCandidate[] = [
      { playerId: 'clear', position: 'RB', marketRank: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({
        playerId: `p${i + 2}`,
        position: (['RB', 'WR', 'QB', 'TE'] as const)[i % 4]!,
        marketRank: 14 + i,
      })),
    ];
    expect(massOf(gapped, 'clear')).toBeGreaterThan(0.98);
  });

  it('still shares a genuine near-tie, because that is what the draw is for', () => {
    // Four players the market cannot separate. Nobody owns this pick.
    const tied: MockCandidate[] = ['a', 'b', 'c', 'd'].map((id, i) => ({
      playerId: id,
      position: 'RB',
      marketRank: 20 + i * 0.2,
    }));
    const best = massOf(tied, 'a');
    expect(best, 'the best of four alike is not a foregone conclusion').toBeLessThan(0.5);
    expect(massOf(tied, 'b'), 'and the next one is a real possibility').toBeGreaterThan(0.15);
  });

  it('loosens as the board gets deeper, because the market does', () => {
    // Nobody reaches at 1.01; everybody reaches in the fourteenth round.
    expect(reachTolerance(1)).toBeLessThan(reachTolerance(25));
    expect(reachTolerance(25)).toBeLessThan(reachTolerance(120));
    // The fifth round is where the old flat constant sat, and it stays there.
    expect(reachTolerance(60)).toBeCloseTo(3.5, 2);
  });

  it('is not tighter late than the model it replaced', () => {
    const deep = (rank0: number): MockCandidate[] =>
      Array.from({ length: 20 }, (_, i) => ({
        playerId: `d${i}`,
        position: (['RB', 'WR', 'QB', 'TE'] as const)[i % 4]!,
        marketRank: rank0 + i,
      }));
    // Deep in the draft the whole window is genuinely in play, as before.
    const counts = distribution({ candidates: deep(150) });
    expect(counts.size).toBeGreaterThan(8);
  });

  it('does not let the consensus number one slide, over a whole room', () => {
    const room: MockRoom = { teams: 12, rounds: 2, type: 'snake', mySlot: null, shape: SHAPE };
    const slots: number[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const advanced = advanceMockDraft(
        createMockDraft({ draftId: 'dr', seed, startedAt: '2026-08-30T00:00:00.000Z' }),
        room,
        board(80),
      );
      const at = advanced.state.picks.findIndex((pick) => pick.playerId === 'p1');
      expect(at, 'the top of the market is drafted inside two rounds').toBeGreaterThanOrEqual(0);
      slots.push(at + 1);
    }
    /*
     * The assertion the reported defect fails. Before the fix the worst slot
     * over four hundred rooms was 18 and 7% of rooms went past pick nine.
     */
    expect(Math.max(...slots), 'the number one never slides out of the first round').toBeLessThanOrEqual(6);
    const topThree = slots.filter((slot) => slot <= 3).length / slots.length;
    expect(topThree, 'and is almost always gone inside three picks').toBeGreaterThan(0.95);
  });

  it('leaves an unpriced player unreachable early and ordinary late', () => {
    const withUnpriced = (rank0: number): MockCandidate[] => [
      ...Array.from({ length: 6 }, (_, i) => ({
        playerId: `p${i}`,
        position: 'WR',
        marketRank: rank0 + i,
      })),
      { playerId: 'unpriced', position: 'RB', marketRank: null },
    ];
    expect(massOf(withUnpriced(1), 'unpriced'), 'nobody reaches a round for an unknown at pick one').toBe(0);
    expect(
      massOf(withUnpriced(180), 'unpriced'),
      'and in the last rounds a real draft is taking players off nobody\u2019s board',
    ).toBeGreaterThan(0);
  });
});

describe('a tendency needs a sample', () => {
  it('claims nothing at all for a manager below the threshold', () => {
    const short = tendencies({ QB: 0.35 }, false);
    expect(mockManagerMultipliers({ tendencies: short, shape: SHAPE, positions: ['QB', 'RB', 'WR', 'TE'] }).size).toBe(
      0,
    );
    const pick = pickForMockManager({
      candidates: board(),
      tendencies: short,
      shape: SHAPE,
      draw: 0.5,
    })!;
    expect(pick.basis).toBe('market');
    expect(pick.multipliers).toEqual({});
    expect(pick.notes.join(' ')).toContain('no usable draft history');
  });

  it('drafts identically with a short sample and with no history at all', () => {
    const withShort = distribution({ candidates: board(), tendencies: tendencies({ QB: 0.35 }, false) });
    const withNone = distribution({ candidates: board(), tendencies: null });
    expect([...withShort.entries()].sort()).toEqual([...withNone.entries()].sort());
  });

  it('nudges a manager with a sample, within the bounds the prior already sets', () => {
    const multipliers = mockManagerMultipliers({
      tendencies: tendencies({ QB: 0.35, TE: -0.35 }),
      shape: SHAPE,
      positions: ['QB', 'RB', 'WR', 'TE'],
    });
    /*
     * The strongest tendency the model can hold, in both directions, and the
     * two do not land symmetrically — which is the prior's own asymmetry
     * showing through rather than anything this module decided.
     *
     * 0.35 of lift × a gain of 0.4 is 0.14. Upwards that is 1.14, inside a
     * ceiling of 1.15, so the arithmetic decides. Downwards it would be 0.86
     * and the floor of 0.87 catches it: `MANAGER_PRIOR.bounds` is deliberately
     * tighter below 1 than above, because "he never takes one early" is a
     * weaker claim than "he always does" — an absence is evidence of much less.
     * Asserting both numbers rather than the clamp is what makes this notice if
     * either the gain or the bounds move.
     */
    expect(multipliers.get('QB')).toBe(1.14);
    expect(multipliers.get('TE')).toBe(MANAGER_PRIOR.bounds.min);
    expect(multipliers.get('QB')!).toBeLessThanOrEqual(MANAGER_PRIOR.bounds.max);
    expect(multipliers.has('RB'), 'a position with no tendency is untouched').toBe(false);
  });

  it('takes a quarterback more often than an identical manager with no history', () => {
    const eager = distribution({ candidates: board(), tendencies: tendencies({ QB: 0.35 }) });
    const plain = distribution({ candidates: board(), tendencies: null });
    const qbs = (counts: Map<string, number>) =>
      [...counts.entries()]
        .filter(([id]) => Number(id.slice(1)) % 4 === 3)
        .reduce((sum, [, n]) => sum + n, 0);
    expect(qbs(eager)).toBeGreaterThan(qbs(plain));
  });

  it('stops claiming anything once he has filled the position', () => {
    const eager = tendencies({ QB: 0.35 });
    const open = mockManagerMultipliers({ tendencies: eager, shape: SHAPE, positions: ['QB', 'RB'] });
    const filled = mockManagerMultipliers({
      tendencies: eager,
      held: { QB: 1 },
      shape: SHAPE,
      positions: ['QB', 'RB'],
    });
    expect(open.get('QB')).toBeGreaterThan(1);
    expect(filled.has('QB'), 'today outranks history').toBe(false);
  });

  it('says which of the two models decided, in the pick itself', () => {
    const withHistory = pickForMockManager({
      candidates: board(),
      tendencies: tendencies({ QB: 0.35 }),
      shape: SHAPE,
      draw: 0.5,
    })!;
    expect(withHistory.basis).toBe('market+history');
    expect(withHistory.notes.join(' ')).toContain('2 historical draft(s)');
  });

  it('reports the position as filled rather than as unknown when history is spent', () => {
    const pick = pickForMockManager({
      candidates: board(),
      tendencies: tendencies({ QB: 0.35 }),
      held: { QB: 1 },
      shape: SHAPE,
      draw: 0.5,
    })!;
    expect(pick.basis).toBe('market');
    expect(pick.notes.join(' ')).toContain('already filled');
  });
});

describe('the draw is the only source of randomness', () => {
  it('gives the same pick for the same board, manager and draw', () => {
    const args = {
      candidates: board(),
      tendencies: tendencies({ QB: 0.2 }),
      shape: SHAPE,
      draw: 0.4321,
    };
    expect(pickForMockManager(args)).toEqual(pickForMockManager(args));
  });

  it('calls no clock and no global generator', () => {
    /*
     * Structural rather than behavioural, because the failure it catches is
     * somebody reaching for `Math.random` in a year's time — at which point a
     * mock stops being replayable and a support snapshot captured from one
     * stops being worth anything.
     */
    const source = new URL('../src/core/draft/mockManager.ts', import.meta.url);
    const code = require('node:fs').readFileSync(source, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('Math.random');
    expect(code).not.toContain('Date.now');
  });

  it('returns null rather than inventing a pick when the board is empty', () => {
    expect(pickForMockManager({ candidates: [], shape: SHAPE, draw: 0.5 })).toBeNull();
  });

  it('survives a draw outside [0,1) rather than reading past the end', () => {
    for (const draw of [-1, 0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const pick = pickForMockManager({ candidates: board(), shape: SHAPE, draw });
      expect(pick, `draw ${draw}`).not.toBeNull();
      expect(pick!.marketIndex).toBeGreaterThanOrEqual(0);
      expect(pick!.marketIndex).toBeLessThan(MOCK_MANAGER.window);
    }
  });
});
