/**
 * What the planner says when it does not know.
 *
 * §20 of the brief in one file. The failure mode it guards against is specific
 * and it is the worst one available to this feature: a rookie with no market,
 * a bye-week roster nobody has priced, a league synced before the season — all
 * of them look, to a model that treats missing data as zero, exactly like a
 * player worth nothing. Handing somebody a confident instruction to cut the
 * player the app understands least is how a tool loses a user for good.
 *
 * Unknown is allowed. It is, in these cases, the only honest answer.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, NOW, SHAPE, at, roster, targets, wire } from './helpers/waiverPlanner.ts';

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

describe('unknowns', () => {
  it('never cuts a player it cannot score', () => {
    const withGhost = [...roster().slice(0, 9), at('ghost', 'No Market Rookie', 'WR', null)];
    const result = plan({ roster: withGhost });

    expect(result.claims.length).toBeGreaterThan(0);
    for (const claim of result.claims) expect(claim.dropPlayerId).not.toBe('ghost');
    expect(result.protectedPlayers.find((p) => p.playerId === 'ghost')?.reason).toBe('unscorable');
    expect(result.dropAdvice).toBe('available');
  });

  it('keeps the add and withholds the drop when the roster cannot be read', () => {
    /*
     * The degraded branch. Every roster player unscorable — no props, no
     * market, nothing — so there is no roster utility, therefore no drop cost,
     * no net gain and no contingency structure, because all four are
     * subtractions over a quantity that does not exist.
     *
     * What survives is everything that is a fact about the *wire*: who is worth
     * claiming and what he costs. The reader is told what to add and left to
     * pick the cut themselves, which is where the product stood before this
     * lane existed.
     */
    const blind = roster().map((player) => at(player.player.id, player.player.fullName, player.player.position, null));
    const result = plan({
      roster: blind,
      targets: targets(wire(), { wireRb: { recommended: 24, doNotExceed: 29 } }),
      budget: { remaining: 60, usesFaab: true },
    });

    expect(result.dropAdvice).toBe('unavailable');
    expect(result.reasons.map((r) => r.code)).toContain('roster_not_scorable');
    expect(result.claims.length).toBeGreaterThan(0);

    for (const claim of result.claims) {
      expect(claim.dropPlayerId).toBeNull();
      expect(claim.netGain).toBeNull();
      expect(claim.reasons.map((r) => r.code)).toContain('roster_not_scorable');
    }
    /* The bid survives, because pricing a wire player never needed the roster. */
    expect(result.claims.find((c) => c.addPlayerId === 'wireRb')?.bid).toBe(24);
    /* And nothing is claimed about outcomes, which would all be fabrications. */
    expect(result.outcomes).toEqual([]);
    expect(result.relationships).toEqual([]);
  });

  it('skips a target it cannot score rather than ranking it last', () => {
    const withGhostTarget = [...wire(), at('ghostTarget', 'Unpriced Wire Player', 'WR', null)];
    const result = plan({ targets: targets(withGhostTarget) });

    for (const claim of result.claims) expect(claim.addPlayerId).not.toBe('ghostTarget');
    expect(result.reasons.map((r) => r.code)).toContain('target_not_scorable');
    expect(result.dropRanking.map((r) => r.addPlayerId)).not.toContain('ghostTarget');
  });

  it('says why an empty plan is empty', () => {
    /*
     * Two quite different quiet weeks, and a screen showing the same blank
     * space for both would be hiding the more interesting one.
     */
    const nothingWorthHaving = plan({ targets: targets([at('dud', 'Waiver Dud', 'WR', 0.4)]) });
    expect(nothingWorthHaving.claims).toEqual([]);
    expect(nothingWorthHaving.reasons.map((r) => r.code)).toContain('net_gain_below_bar');

    /*
     * And a roster with nothing on offer: a settled starting seven, and a bench
     * of two players nobody has priced. Every starter is protected because he
     * is starting and every bench player because he cannot be scored, so there
     * is no cut to name — which is a different sentence from "nothing is worth
     * claiming", and the plan says which one it means.
     */
    const unpricedBench = [
      ...roster().slice(0, 7),
      at('rookieA', 'Unpriced Rookie', 'WR', null),
      at('rookieB', 'Unpriced Rookie Two', 'RB', null),
    ];
    const nothingToCut = plan({ roster: unpricedBench, targets: targets([at('modest', 'Modest Target', 'WR', 5)]) });
    expect(nothingToCut.dropAdvice).toBe('available');
    expect(nothingToCut.claims).toEqual([]);
    expect(nothingToCut.reasons.map((r) => r.code)).toContain('no_eligible_drop');
  });

  it('ignores a target the reader already owns', () => {
    /* The board and the roster are two reads; a row for a player already owned
     * is the kind of mistake that costs the trust the rest of the plan earned. */
    const alreadyOwned = at('wr1', 'Alpha Receiver', 'WR', 13);
    const result = plan({ targets: targets([...wire(), alreadyOwned]) });

    expect(result.claims.map((c) => c.addPlayerId)).not.toContain('wr1');
    expect(result.dropRanking.map((r) => r.addPlayerId)).not.toContain('wr1');
  });

  it('leaves a defence to the DST planner rather than claiming it generically', () => {
    const result = plan({ targets: targets([...wire(), at('wireDef', 'Wire Defence', 'DEF', 8)]) });
    expect(result.claims.map((c) => c.addPlayerId)).not.toContain('wireDef');
    expect(result.dropRanking.map((r) => r.addPlayerId)).not.toContain('wireDef');
  });
});
