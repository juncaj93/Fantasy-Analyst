/**
 * Incomplete information can no longer win a Compare (16 October 2026).
 *
 * A complete market is `pricedCandidate` (his whole board posted); a fallback
 * is `candidate` (one line posted) ranked on the Sleeper week in `published`.
 */
import { describe, expect, it } from 'vitest';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { completeFirst } from '../src/core/startsit/completeFirst.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

const compare = (inputs: Parameters<typeof compareStartSit>[0], published: Record<string, number>) =>
  compareStartSit(inputs, HALF_PPR, { published: new Map(Object.entries(published)) });

const basis = (c: ReturnType<typeof compare>, id: string) => c.evaluations.find((e) => e.playerId === id)!.decision!.basis;
const points = (c: ReturnType<typeof compare>, id: string) => c.evaluations.find((e) => e.playerId === id)!.decision!.points;

describe('a Sleeper-only player cannot win against complete markets', () => {
  it('one fallback among three: the best complete player wins and the fallback is the marked second choice', () => {
    const c = compare(
      [pricedCandidate('w', 'Garrett Wilson', 'WR', 12), pricedCandidate('c', 'Nico Collins', 'WR', 10), candidate('m', 'Ladd McConkey', 'WR', 3)],
      { m: 15 },
    );
    expect(basis(c, 'm')).toBe('published');
    expect(points(c, 'm')).toBeGreaterThan(points(c, 'w'));
    expect(c.recommendedPlayerId).toBe('w');
    expect(c.sleeperOnly).toMatchObject({ playerId: 'm', name: 'Ladd McConkey' });
    expect(c.sleeperOnly!.aheadBy).toBeCloseTo(points(c, 'm') - points(c, 'w'), 2);
    expect(c.margin, 'the margin is to the next complete player').toBeCloseTo(points(c, 'w') - points(c, 'c'), 2);
  });

  it('two fallbacks among four: the better fallback is the one named', () => {
    const c = compare(
      [
        pricedCandidate('w', 'Garrett Wilson', 'WR', 11),
        pricedCandidate('c', 'Nico Collins', 'WR', 9),
        candidate('m', 'Ladd McConkey', 'WR', 3),
        candidate('p', 'George Pickens', 'WR', 3),
      ],
      { m: 13, p: 16 },
    );
    expect(c.recommendedPlayerId).toBe('w');
    expect(c.sleeperOnly?.playerId).toBe('p');
  });

  it('all fallbacks: nothing changes, the best Sleeper number wins', () => {
    const c = compare([candidate('m', 'Ladd McConkey', 'WR', 3), candidate('p', 'George Pickens', 'WR', 3)], { m: 13, p: 16 });
    expect(c.recommendedPlayerId).toBe('p');
    expect(c.sleeperOnly).toBeUndefined();
  });

  it('all complete: nothing changes', () => {
    const c = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 9), pricedCandidate('c', 'Nico Collins', 'WR', 12)], {});
    expect(c.recommendedPlayerId).toBe('c');
    expect(c.sleeperOnly).toBeUndefined();
  });

  it('a fallback far ahead still does not win', () => {
    const c = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 6), candidate('m', 'Ladd McConkey', 'WR', 3)], { m: 25 });
    expect(c.recommendedPlayerId).toBe('w');
    expect(c.sleeperOnly?.playerId).toBe('m');
    expect(c.sleeperOnly!.aheadBy).toBeGreaterThan(15);
    expect(c.margin, 'no margin to speak of when the only rival is the Sleeper-only one').toBeNull();
    expect(c.reasons.join(' ')).toMatch(/higher on Sleeper only/);
  });

  it('a fallback behind the pick is not named at all', () => {
    const c = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 14), candidate('m', 'Ladd McConkey', 'WR', 3)], { m: 8 });
    expect(c.recommendedPlayerId).toBe('w');
    expect(c.sleeperOnly).toBeUndefined();
  });

  it('a tie between complete players is settled as before (by name), with the fallback still named', () => {
    const c = compare(
      [pricedCandidate('z', 'Zay Flowers', 'WR', 10), pricedCandidate('a', 'Adam Thielen', 'WR', 10), candidate('m', 'Ladd McConkey', 'WR', 3)],
      { m: 14 },
    );
    expect(points(c, 'z')).toBe(points(c, 'a'));
    expect(c.recommendedPlayerId).toBe('a');
    expect(c.sleeperOnly?.playerId).toBe('m');
  });
});

describe('completeFirst', () => {
  const e = (playerId: string, pts: number, basis: string, ruledOut = false) => ({ playerId, name: playerId, ruledOut, decision: { points: pts, basis } });

  it('never counts a ruled-out player as complete', () => {
    const { order, sleeperOnly } = completeFirst([e('pub', 12, 'published'), e('out', -90, 'market', true)]);
    expect(order[0]!.playerId).toBe('pub');
    expect(sleeperOnly).toBeNull();
  });

  it('puts complete players first and keeps each group in its order', () => {
    const { order } = completeFirst([e('p1', 20, 'published'), e('m1', 15, 'market'), e('p2', 14, 'published'), e('m2', 10, 'market')]);
    expect(order.map((x) => x.playerId)).toEqual(['m1', 'm2', 'p1', 'p2']);
  });
});
