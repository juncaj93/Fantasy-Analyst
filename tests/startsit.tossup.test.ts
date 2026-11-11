/**
 * One toss-up bar for every start/sit call (Alex's decision, 4 November 2026;
 * review findings X1 and S5). Under two points between two options is a
 * toss-up: the app names its lean and both numbers, and never makes it a Best
 * move, a lineup change or a "Pick up and start" card. A real hole (Out, IR,
 * suspended, Doubtful, a bye, an empty slot) is never a toss-up.
 *
 * The "before" margins were 0.75 for a Team swap, 0.6 for Compare's tie and
 * 0.5 for Pick up and start; the cases marked X1 fail on that code.
 */
import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { buildLineupVerdicts } from '../src/core/startsit/sleeperLineup.ts';
import { TOSSUP_POINTS, isRealHole, isTossUp } from '../src/core/startsit/tossup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const ONE_WR = buildRosterShape(['WR', 'BN', 'BN']);

const pts = (r: ReturnType<typeof recommendLineup>, id: string) =>
  [...r.starters, ...r.bench].find((e) => e.playerId === id)!.decision!.points;

describe('the rule', () => {
  it('is two points, on the ranking numbers', () => {
    expect(TOSSUP_POINTS).toBe(2);
    expect(isTossUp({ points: 11.9 }, { points: 10 })).toBe(true);
    expect(isTossUp({ points: 12 }, { points: 10 })).toBe(false);
    /* A Sleeper-only 12.5 ranks 11.5: 1.5 over a priced 10, a toss-up. */
    expect(isTossUp({ points: 12.5, borrowed: true }, { points: 10 })).toBe(true);
    /* A Sleeper-only 13 ranks 12: exactly the bar over a priced 10, not a toss-up. */
    expect(isTossUp({ points: 13, borrowed: true }, { points: 10 })).toBe(false);
  });

  it('never calls a real hole a toss-up', () => {
    expect(isTossUp({ points: 10.5 }, { points: 10, hole: true })).toBe(false);
    expect(isTossUp({ points: 3 }, { points: null })).toBe(false);
    expect(isRealHole({ ruledOut: true })).toBe(true);
    expect(isRealHole({ onReserve: true })).toBe(true);
    expect(isRealHole({ onBye: true })).toBe(true);
    expect(isRealHole({ designation: 'doubtful' })).toBe(true);
    expect(isRealHole({ designation: 'questionable' })).toBe(false);
    expect(isRealHole({ designation: 'healthy' })).toBe(false);
  });
});

describe('Team: swaps and Best move', () => {
  it('X1: a 0.75 gain is a toss-up, not a swap, and the row keeps Sleeper’s man', () => {
    const r = recommendLineup(
      [pricedCandidate('in', 'Bench Guy', 'WR', 10.75), pricedCandidate('out', 'Starter Guy', 'WR', 10)],
      ONE_WR,
      PROFILE,
      { currentStarterIds: ['out'] },
    );
    expect(pts(r, 'in') - pts(r, 'out')).toBeCloseTo(0.75, 1);
    expect(r.swaps).toEqual([]);
    expect(r.tossUps?.map((t) => [t.inPlayerId, t.outPlayerId])).toEqual([['in', 'out']]);
    const rows = buildLineupVerdicts({
      rosterPositions: ['WR', 'BN', 'BN'],
      starterIds: ['out'],
      starterSlotIds: ['out'],
      slots: r.slots,
      suggestedSwaps: r.swaps,
      positionOf: () => 'WR',
    });
    expect(rows.map((row) => row.verdict)).toEqual(['keep']);
  });

  it('X1: a 1.9 gain is still a toss-up', () => {
    const r = recommendLineup(
      [pricedCandidate('in', 'Bench Guy', 'WR', 11.9), pricedCandidate('out', 'Starter Guy', 'WR', 10)],
      ONE_WR,
      PROFILE,
      { currentStarterIds: ['out'] },
    );
    expect(r.swaps).toEqual([]);
    expect(r.tossUps).toHaveLength(1);
  });

  it('a 2.5 gain is a swap', () => {
    const r = recommendLineup(
      [pricedCandidate('in', 'Bench Guy', 'WR', 12.5), pricedCandidate('out', 'Starter Guy', 'WR', 10)],
      ONE_WR,
      PROFILE,
      { currentStarterIds: ['out'] },
    );
    expect(r.swaps.map((s) => s.inPlayerId)).toEqual(['in']);
    expect(r.tossUps).toEqual([]);
  });

  it('real hole: a starter who is Out and a healthy bench player still gets the swap, however small the number', () => {
    const r = recommendLineup(
      [pricedCandidate('in', 'Healthy Guy', 'WR', 1.2), pricedCandidate('out', 'Hurt Guy', 'WR', 10, { status: 'Out' })],
      ONE_WR,
      PROFILE,
      { currentStarterIds: ['out'] },
    );
    expect(r.swaps.map((s) => [s.inPlayerId, s.outPlayerId])).toEqual([['in', 'out']]);
    expect(r.tossUps).toEqual([]);
  });

  it('real hole: a Doubtful starter the healthy man edges is a swap, not a toss-up', () => {
    /* 16 Doubtful is 10 after the six points; the healthy 11 is one ahead. */
    const r = recommendLineup(
      [pricedCandidate('in', 'Healthy Guy', 'WR', 11), pricedCandidate('out', 'Doubtful Guy', 'WR', 16, { status: 'Doubtful' })],
      ONE_WR,
      PROFILE,
      { currentStarterIds: ['out'] },
    );
    expect(r.swaps.map((s) => s.inPlayerId)).toEqual(['in']);
  });

  it('real hole: an empty Sleeper slot is filled whatever the number', () => {
    const r = recommendLineup([pricedCandidate('in', 'Anybody', 'WR', 0.6), pricedCandidate('x', 'Other', 'TE', 5)], buildRosterShape(['WR', 'TE', 'BN']), PROFILE, {
      currentStarterIds: ['x'],
    });
    expect(r.fills?.map((f) => f.inPlayerId)).toEqual(['in']);
  });

  it('S6: a Sleeper-only bench player 2.5 ahead on his number but 1.5 ahead after the minus 1 is a toss-up', () => {
    const priced = pricedCandidate('p', 'Priced Receiver', 'WR', 10);
    const decided = recommendLineup([priced], ONE_WR, PROFILE, { currentStarterIds: ['p'] });
    const published = new Map([['s', pts(decided, 'p') + 2.5]]);
    const r = recommendLineup([priced, candidate('s', 'Sleeper Receiver', 'WR', 3)], ONE_WR, PROFILE, { currentStarterIds: ['p'], published });
    expect(r.swaps).toEqual([]);
    expect(r.tossUps?.map((t) => t.inPlayerId)).toEqual(['s']);
  });
});

describe('Compare agrees with Team', () => {
  it('X1: inside two points there is no Start, only a lean', () => {
    const c = compareStartSit([pricedCandidate('a', 'A Guy', 'WR', 11.5), pricedCandidate('b', 'B Guy', 'WR', 10)], PROFILE);
    expect(c.recommendedPlayerId).toBeNull();
    expect(c.tossUp).toEqual({ leanPlayerId: 'a', leanName: 'A Guy', otherPlayerId: 'b', otherName: 'B Guy' });
  });

  it('two points or more is a Start', () => {
    const c = compareStartSit([pricedCandidate('a', 'A Guy', 'WR', 12.5), pricedCandidate('b', 'B Guy', 'WR', 10)], PROFILE);
    expect(c.recommendedPlayerId).toBe('a');
    expect(c.tossUp).toBeUndefined();
  });

  it('against a Doubtful player it is a Start, not a toss-up', () => {
    const c = compareStartSit(
      [pricedCandidate('a', 'Healthy Guy', 'WR', 11), pricedCandidate('b', 'Doubtful Guy', 'WR', 16, { status: 'Doubtful' })],
      PROFILE,
    );
    expect(c.recommendedPlayerId).toBe('a');
    expect(c.tossUp).toBeUndefined();
  });

  it('the same pair: Team holds and Compare says toss-up, or Team swaps and Compare says Start', () => {
    for (const bench of [10.4, 11.9, 12.1, 15]) {
      const inputs = [pricedCandidate('in', 'Bench Guy', 'WR', bench), pricedCandidate('out', 'Starter Guy', 'WR', 10)];
      const r = recommendLineup(inputs, ONE_WR, PROFILE, { currentStarterIds: ['out'] });
      const c = compareStartSit(inputs, PROFILE);
      expect(r.swaps.length > 0).toBe(c.recommendedPlayerId === 'in');
      expect((r.tossUps ?? []).length > 0).toBe(c.tossUp?.leanPlayerId === 'in');
    }
  });
});
