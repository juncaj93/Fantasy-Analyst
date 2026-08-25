/**
 * The A/B/C/D structure, which is the reason this lane exists.
 *
 * §9 of the brief describes a plan that looks like a mistake and is not:
 *
 *     1. Add A — drop C
 *     2. Add B — drop C
 *     3. Add B — drop D
 *
 * One player claimed twice, one drop spent twice. It works because Sleeper
 * processes claims in order and a claim whose drop is gone does not execute —
 * so claim 2 is unreachable exactly when claim 1 succeeds, and claim 3 is the
 * only way to land B in that world.
 *
 * If these tests ever come back with three independent claims in board order,
 * the contingency engine has been replaced by a sort.
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

describe('claim contingencies', () => {
  it('produces A→C, B→C, B→D', () => {
    const claims = plan().claims;

    expect(claims.length).toBeGreaterThanOrEqual(3);
    const [first, second, third] = claims;

    /* A → C: the best single move on the roster as it stands. */
    expect(first?.addPlayerId).toBe('wireRb');
    expect(first?.dropPlayerId).toBe('benchRb');
    expect(first?.relation).toBe('primary');

    /* B → C: the same drop, so it exists only if A failed. */
    expect(second?.addPlayerId).toBe('wireWr');
    expect(second?.dropPlayerId).toBe('benchRb');
    expect(second?.relation).toBe('fallback');

    /* B → D: the second drop, so it survives A succeeding. */
    expect(third?.addPlayerId).toBe('wireWr');
    expect(third?.dropPlayerId).toBe('benchWr');
    expect(third?.relation).toBe('compatible');
  });

  it('blocks the fallback with the claim that would consume its drop', () => {
    const claims = plan().claims;
    const [first, second, third] = claims;

    expect(second?.blockedBy).toEqual([first?.id]);
    expect(second?.reasons.map((r) => r.code)).toContain('blocked_by_earlier_claim');
    expect(second?.reasons.map((r) => r.code)).toContain('fallback_for_earlier_claim');

    /* The third claim survives the first: a different drop pays for it. */
    expect(third?.blockedBy).toEqual([]);
    expect(third?.dependsOn).toEqual([first?.id]);
  });

  it('marks the two claims for the same target as mutually exclusive', () => {
    const claims = plan().claims;
    const forB = claims.filter((c) => c.addPlayerId === 'wireWr');

    expect(forB.length).toBe(2);
    expect(forB[0]?.mutuallyExclusiveWith).toContain(forB[1]?.id);
    expect(forB[1]?.mutuallyExclusiveWith).toContain(forB[0]?.id);
  });

  it('prefers the cheaper drop for B when A fails', () => {
    /*
     * The ordering is the mechanism. Entered in this order, the run reaches the
     * fallback before the second-drop claim, so a failed A lands B for the
     * drop it actually wanted.
     */
    const claims = plan().claims;
    const fallback = claims.find((c) => c.relation === 'fallback' && c.addPlayerId === 'wireWr');
    const compatible = claims.find((c) => c.relation === 'compatible' && c.addPlayerId === 'wireWr');

    expect(fallback?.rank).toBeLessThan(compatible?.rank as number);
    expect(fallback?.netGain as number).toBeGreaterThan(compatible?.netGain as number);
  });

  it('reaches every branch the claim list allows and no others', () => {
    const result = plan();
    const ids = new Map(result.claims.map((c) => [c.id, c]));

    for (const outcome of result.outcomes) {
      const added = new Set<string>();
      const dropped = new Set<string>();
      for (const claimId of outcome.claimIds) {
        const claim = ids.get(claimId);
        expect(claim).toBeDefined();
        /* No target landed twice, no drop spent twice. */
        expect(added.has((claim as NonNullable<typeof claim>).addPlayerId)).toBe(false);
        added.add((claim as NonNullable<typeof claim>).addPlayerId);
        const drop = (claim as NonNullable<typeof claim>).dropPlayerId;
        if (drop != null) {
          expect(dropped.has(drop)).toBe(false);
          dropped.add(drop);
        }
      }
    }

    /* Doing nothing is always on the list, and is always worth nothing. */
    const none = result.outcomes.find((o) => o.kind === 'none');
    expect(none).toBeDefined();
    expect(none?.netGain).toBe(0);
    expect(none?.claimIds).toEqual([]);

    /* The best case lands both targets the spine was built around. */
    const best = result.outcomes.find((o) => o.kind === 'best');
    expect(best?.addedPlayerIds).toContain('wireRb');
    expect(best?.addedPlayerIds).toContain('wireWr');
    expect(best?.netGain as number).toBeGreaterThan(result.claims[0]?.netGain as number);
  });

  it('shows the world where the first claim fails', () => {
    const result = plan();
    const withoutA = result.outcomes.filter((o) => !o.addedPlayerIds.includes('wireRb') && o.claimIds.length > 0);
    expect(withoutA.length).toBeGreaterThan(0);
    /* B still lands, for the drop A would have taken. */
    expect(withoutA.some((o) => o.addedPlayerIds.includes('wireWr') && o.droppedPlayerIds.includes('benchRb'))).toBe(true);
  });

  it('suppresses a second target that adds nothing once the first has landed', () => {
    /*
     * §22's redundancy case, on the roster where it is unambiguous: a hole at
     * tight end and two tight ends on the wire, one good and one barely worth a
     * roster spot. The poor one is a real claim while the slot is empty and
     * worth almost nothing the moment it is filled.
     *
     * So he appears exactly once, as the fallback for the claim that would make
     * him redundant — never as a second acquisition alongside it.
     */
    const twoTightEnds = [at('teA', 'Good Tight End', 'TE', 9), at('teB', 'Poor Tight End', 'TE', 2)];
    const result = plan({ roster: holeRoster(), targets: targets(twoTightEnds) });

    const forB = result.claims.filter((c) => c.addPlayerId === 'teB');
    expect(forB.length).toBe(1);
    expect(forB[0]?.relation).toBe('fallback');
    expect(forB[0]?.blockedBy).toEqual([result.claims[0]?.id]);

    const relationship = result.relationships.find((r) => r.secondPlayerId === 'teB');
    expect(relationship?.relation).toBe('redundant');
    expect(relationship?.incrementalGain).toBeLessThan(relationship?.standaloneGain as number);
    expect(result.reasons.map((r) => r.code)).toContain('redundant_after_earlier_claim');
  });

  it('blocks a claim with every earlier claim that would spend its drop', () => {
    /*
     * Three targets that all want the same cheap drop, and room in the plan for
     * all three. The third is unreachable if *either* of the two above it lands,
     * and saying so is not pedantry — a **See Why** sheet that named only one
     * blocker would be describing a branch that does not exist.
     */
    const result = plan({ limits: { maxClaims: 6 } });
    const onBenchRb = result.claims.filter((c) => c.dropPlayerId === 'benchRb');

    expect(onBenchRb.length).toBeGreaterThanOrEqual(3);
    const last = onBenchRb[onBenchRb.length - 1];
    expect(last?.blockedBy).toEqual(onBenchRb.slice(0, -1).map((c) => c.id));

    /* And the outcome tree agrees: no branch spends that drop twice. */
    for (const outcome of result.outcomes) {
      expect(outcome.droppedPlayerIds.filter((id) => id === 'benchRb').length).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()));
  });
});
