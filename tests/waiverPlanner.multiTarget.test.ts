/**
 * Whether two targets are worth chasing at once — decided by simulation.
 *
 * The claim under test is that nothing in this app labels two players as
 * substitutes. The same two receivers are substitutes on a roster that starts
 * two and complements on a roster that starts three, and the only way to get
 * both answers right is to acquire the first one and ask again.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, NOW, SHAPE, at, holeRoster, roster, targets, wire } from './helpers/waiverPlanner.ts';

function plan(overrides: Partial<Parameters<typeof planWaiverClaims>[0]> = {}) {
  return planWaiverClaims({
    roster: roster(),
    targets: targets(wire()),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    generatedAt: '2025-10-05T14:00:00.000Z',
    ...overrides,
  });
}

describe('multiple targets', () => {
  it('pursues two complementary targets and pays for both', () => {
    const result = plan();
    const acquired = result.claims.filter((c) => c.relation !== 'fallback').map((c) => c.addPlayerId);

    expect(new Set(acquired).size).toBeGreaterThanOrEqual(2);
    /* Two acquisitions means two drops, and they are different players. */
    const drops = result.claims.filter((c) => c.relation !== 'fallback').map((c) => c.dropPlayerId);
    expect(new Set(drops).size).toBe(drops.length);
  });

  it('does not spend a second drop on a substitute', () => {
    /*
     * A hole at tight end and two tight ends on the wire. The first fills the
     * slot; the second is a bench body behind him. The plan lands one of them
     * and never both.
     */
    const twoTightEnds = [at('teA', 'Good Tight End', 'TE', 9), at('teB', 'Poor Tight End', 'TE', 2)];
    const result = plan({ roster: holeRoster(), targets: targets(twoTightEnds) });

    const acquisitions = result.claims.filter((c) => c.relation !== 'fallback');
    expect(acquisitions.map((c) => c.addPlayerId)).toEqual(['teA']);

    /* And no outcome lands both of them, because no branch can. */
    for (const outcome of result.outcomes) {
      expect(outcome.addedPlayerIds.includes('teA') && outcome.addedPlayerIds.includes('teB')).toBe(false);
    }
  });

  it('requires the second target to clear its own drop cost', () => {
    const result = plan();
    for (const claim of result.claims) {
      if (claim.relation === 'fallback') continue;
      expect(claim.netGain as number).toBeGreaterThanOrEqual(result.limits.minNetGain);
    }
  });

  it('reads a relationship off the roster rather than off the players', () => {
    /*
     * The same two receivers, twice, and the only thing that changes is how
     * many the league starts.
     *
     * On the two-receiver roster the second man is a bench body behind the
     * first and worth 3.4 more points of roster. Give the league a third
     * receiver slot — currently occupied by a filler nobody would defend — and
     * the same player is worth half again as much, because there is a slot for
     * him to walk into.
     *
     * Nothing about the players changed. Nobody labelled them. The number came
     * out of acquiring the first one and asking again.
     */
    const wideShape = {
      ...SHAPE,
      starters: { QB: 1, RB: 2, WR: 3, TE: 1 },
      totalStarters: 8,
    };
    const receivers = [at('wrA', 'First Receiver', 'WR', 12), at('wrB', 'Second Receiver Target', 'WR', 11)];

    const narrow = plan({ targets: targets(receivers) });
    const wide = plan({ targets: targets(receivers), shape: wideShape });

    const narrowRelation = narrow.relationships.find((r) => r.secondPlayerId === 'wrB');
    const wideRelation = wide.relationships.find((r) => r.secondPlayerId === 'wrB');

    expect(narrowRelation).toBeDefined();
    expect(wideRelation).toBeDefined();
    expect(wideRelation?.incrementalGain as number).toBeGreaterThan(narrowRelation?.incrementalGain as number);

    /*
     * Both leagues still pursue him — the ratio bands describe *proportion*,
     * and a target can be a smaller share of a much larger standalone value
     * and still be the second best thing to do with the week.
     */
    for (const result of [narrow, wide]) {
      const second = result.claims.filter((c) => c.addPlayerId === 'wrB' && c.relation === 'compatible');
      expect(second.length).toBe(1);
      expect(second[0]?.netGain as number).toBeGreaterThanOrEqual(result.limits.minNetGain);
    }
  });

  it('names which drop a conditional complement needs', () => {
    /*
     * `conditional_complement` is the reading a hand-authored label could never
     * produce: still worth having after the first claim, but only by spending a
     * second and different drop than the one it originally wanted.
     */
    const result = plan();
    const conditional = result.relationships.filter((r) => r.relation === 'conditional_complement');
    expect(conditional.length).toBeGreaterThan(0);
    for (const relationship of conditional) {
      expect(relationship.reasons.map((r) => r.code)).toContain('requires_second_drop');
      const reason = relationship.reasons.find((r) => r.code === 'requires_second_drop');
      expect(reason?.playerId).toBeTruthy();
    }
  });

  it('never protects a player it has already offered as a drop in the same claim', () => {
    const result = plan();
    const protectedIds = new Set(result.protectedPlayers.map((p) => p.playerId));
    for (const claim of result.claims) {
      if (claim.dropPlayerId == null) continue;
      const ranking = result.dropRanking.find((r) => r.addPlayerId === claim.addPlayerId);
      const entry = ranking?.drops.find((d) => d.playerId === claim.dropPlayerId);
      expect(entry?.protection).toBeNull();
      /* A starter may be protected against one add and not another — what must
       * never happen is a claim dropping somebody it protected from itself. */
      if (protectedIds.has(claim.dropPlayerId)) expect(entry?.protection).toBeNull();
    }
  });
});
