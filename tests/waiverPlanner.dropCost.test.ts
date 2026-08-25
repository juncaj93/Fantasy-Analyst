/**
 * The drop half of a waiver claim, which is the half nobody builds.
 *
 * The test that carries this file is `an incoming tight end makes the backup
 * tight end expendable, and an incoming back does not`. If that ever comes out
 * the same both ways, the planner has collapsed back into a single "worst
 * player on the roster" ranking and the entire premise of the lane is gone.
 *
 * Everything here runs through the real scoring engine on real fixture props.
 * Nothing is stubbed, so a number moving means a model moved.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRosterSimulation,
  eligibleDrops,
  rankDropsFor,
  PROTECTED_LINEUP_COST,
} from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, KICKOFF, NOW, SHAPE, at, heldFor, roster, thinWire, wire } from './helpers/waiverPlanner.ts';
import { defence } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING } from '../src/core/demo/fixtures/dst.ts';

function simulation(rosterInputs = roster(), wireInputs = wire(), held?: ReturnType<typeof heldFor>[]) {
  return buildRosterSimulation({
    pool: [...rosterInputs, ...wireInputs],
    rosterIds: rosterInputs.map((r) => r.player.id),
    wireIds: wireInputs.map((r) => r.player.id),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    ...(held ? { held } : {}),
  });
}

const costOf = (drops: ReturnType<typeof rankDropsFor>, id: string) =>
  drops.find((d) => d.playerId === id) as (typeof drops)[number];

describe('drop cost', () => {
  it('prefers the obvious bench scrub', () => {
    const drops = eligibleDrops(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireRb' }));
    expect(drops[0]?.playerId).toBe('benchRb');
    expect(drops[0]?.cost).toBe(0);
    expect(drops[0]?.reasons.map((r) => r.code)).toContain('drop_outside_lineup');
  });

  it('never offers a player in the recommended lineup', () => {
    for (const add of ['wireRb', 'wireWr', 'wireTe']) {
      const drops = rankDropsFor({ simulation: simulation(), addPlayerId: add });
      for (const starter of ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1']) {
        expect(costOf(drops, starter).protection).toBe('in_lineup');
      }
      expect(eligibleDrops(drops).map((d) => d.playerId)).not.toContain('rb1');
    }
  });

  it('protects a player whose removal would cost the lineup real points', () => {
    /*
     * The bar, checked against the thing it is a bar on.
     *
     * Every protected starter here loses the lineup more than
     * `PROTECTED_LINEUP_COST`, which is the second, independent gate behind
     * `in_lineup` — the one that would still hold if a starter were somehow
     * offered.
     */
    const drops = rankDropsFor({ simulation: simulation(), addPlayerId: 'wireWr' });
    expect(costOf(drops, 'wr1').lineupCost).toBeGreaterThanOrEqual(PROTECTED_LINEUP_COST);
    expect(costOf(drops, 'qb1').protection).toBe('in_lineup');
  });

  it('makes the backup tight end expendable when a tight end is arriving', () => {
    /*
     * The load-bearing test of the whole lane.
     *
     * Same roster, same backup tight end, two different incoming players. With
     * a tight end arriving he is covered and cheap; with a running back
     * arriving he is the only cover at a position the league must start, and
     * the cover charge says so.
     */
    const withTe = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireTe' }), 'te2');
    const withRb = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireRb' }), 'te2');

    expect(withTe.cost as number).toBeLessThan(withRb.cost as number);
    expect(withRb.reasons.map((r) => r.code)).toContain('drop_leaves_position_bare');
    expect(withTe.reasons.map((r) => r.code)).not.toContain('drop_leaves_position_bare');
  });

  it('ranks drops differently for different targets', () => {
    const forRb = eligibleDrops(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireRb' })).map((d) => d.playerId);
    const forTe = eligibleDrops(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireTe' })).map((d) => d.playerId);
    const forWr = eligibleDrops(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireWr' })).map((d) => d.playerId);

    expect(forRb).not.toEqual(forTe);
    expect(forRb).not.toEqual(forWr);
    expect(forTe).not.toEqual(forWr);
    /*
     * The order is the visible half and the prices are the real one: the same
     * backup tight end is a third as expensive when a tight end is arriving,
     * which is a fact the ranking positions can round away and the numbers
     * cannot.
     */
    const te2ForTe = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireTe' }), 'te2').cost as number;
    const te2ForRb = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireRb' }), 'te2').cost as number;
    const rb3ForTe = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireTe' }), 'rb3').cost as number;
    const rb3ForRb = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireRb' }), 'rb3').cost as number;
    expect(te2ForTe).toBeLessThan(te2ForRb);
    expect(rb3ForTe).toBeLessThan(rb3ForRb);
  });

  it('charges nothing for a player the wire matches', () => {
    /*
     * Against a strong wire a roster filler is worth exactly what a free agent
     * is worth, which is what `drop_at_or_below_replacement` means.
     */
    const drop = costOf(rankDropsFor({ simulation: simulation(), addPlayerId: 'wireWr' }), 'benchWr');
    expect(drop.cost).toBe(0);
    expect(drop.optionValue).toBe(0);
    expect(drop.reasons.map((r) => r.code)).toContain('drop_at_or_below_replacement');
  });

  it('charges for a bench player the wire cannot match', () => {
    /*
     * The same bench, a wire with nothing on it. Every option value that was
     * zero against a strong wire is now real, and the backup tight end — cheap
     * to cut when a better one was freely available — is the most expensive
     * bench player on the roster.
     */
    const thin = simulation(roster(), thinWire());
    const drops = eligibleDrops(rankDropsFor({ simulation: thin, addPlayerId: 'fillerWr' }));
    const te2 = costOf(drops, 'te2');
    const benchWr = costOf(drops, 'benchWr');
    expect(te2.cost as number).toBeGreaterThan(benchWr.cost as number);
    expect(te2.optionValue).toBeGreaterThan(0);
  });

  it('lets a caller-supplied handcuff signal protect a bench player', () => {
    /*
     * The `held` input, doing the one job it exists for.
     *
     * Two bench players the engine scores identically; one of them insures a
     * starter the roster cannot replace. The planner has no source for that
     * fact and does not invent one — the caller supplies it, the existing bench
     * valuation discounts it, and the cut order changes.
     */
    const plain = simulation(roster(), thinWire());
    const insured = simulation(roster(), thinWire(), [
      heldFor('benchRb', 'Depth Back', 'RB', 2.5, { insuranceValue: 12 }),
    ]);

    const before = costOf(rankDropsFor({ simulation: plain, addPlayerId: 'fillerWr' }), 'benchRb');
    const after = costOf(rankDropsFor({ simulation: insured, addPlayerId: 'fillerWr' }), 'benchRb');
    expect(after.cost as number).toBeGreaterThan(before.cost as number);

    const order = eligibleDrops(rankDropsFor({ simulation: insured, addPlayerId: 'fillerWr' })).map((d) => d.playerId);
    expect(order.indexOf('benchWr')).toBeLessThan(order.indexOf('benchRb'));
  });

  it('reports an unscorable player as unknown rather than as free', () => {
    /*
     * §20 of the brief, in the case that matters: a rookie with no market is
     * the player this app understands least, and treating "no data" as "no
     * value" would make him the first name on every cut list.
     */
    const withGhost = [...roster().slice(0, 9), at('ghost', 'No Market Rookie', 'WR', null)];
    const drops = rankDropsFor({ simulation: simulation(withGhost), addPlayerId: 'wireRb' });
    const ghost = costOf(drops, 'ghost');

    expect(ghost.cost).toBeNull();
    expect(ghost.protection).toBe('unscorable');
    expect(ghost.reasons.map((r) => r.code)).toEqual(['protected_unscorable']);
    expect(eligibleDrops(drops).map((d) => d.playerId)).not.toContain('ghost');
  });

  it('never prices a drop as an improvement', () => {
    /*
     * The invariant the option term can violate and must not.
     *
     * Removing a player cannot make a roster better, and the floor in
     * `rankDropsFor` guarantees it whatever the approximation underneath does.
     * Checked across every add against both wires, because the pathological
     * case is a cover cycle between two similar bench players and it does not
     * show up on a single fixture.
     */
    for (const wireInputs of [wire(), thinWire()]) {
      const sim = simulation(roster(), wireInputs);
      for (const target of wireInputs) {
        for (const drop of rankDropsFor({ simulation: sim, addPlayerId: target.player.id })) {
          if (drop.cost == null) continue;
          expect(drop.cost).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('refuses to cut a defence, which belongs to the DST planner', () => {
    /*
     * The boundary with the DST lane, asserted in the league where it is
     * actually at risk: one that starts a defence, publishes rules this app can
     * read, and therefore produces a defence with a real score. An unscorable
     * defence would be excluded for the wrong reason and would prove nothing.
     *
     * Streaming a defence in and out is a genuine waiver decision and a good
     * one — it is simply not this planner's, because transaction cost, how long
     * an add survives and what a playoff stash is worth are all things the DST
     * planner knows and this file has never heard of.
     */
    const dstShape = buildRosterShape(DST_ROSTER_POSITIONS);
    const dstProfile = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);
    const dstRoster = [
      at('qb1', 'Anchor Quarterback', 'QB', 18),
      at('rb1', 'Feature Back', 'RB', 14),
      at('rb2', 'Second Back', 'RB', 11),
      at('wr1', 'Alpha Receiver', 'WR', 13),
      at('wr2', 'Second Receiver', 'WR', 10),
      at('wr3', 'Third Receiver', 'WR', 8),
      at('te1', 'Starting Tight End', 'TE', 9),
      at('benchWr', 'Roster Filler', 'WR', 1.5),
      defence('def1', 'Home Defence', { spread: -6, total: 41, opponent: 'ARI' }, { kickoff: KICKOFF, now: NOW }),
    ];
    const sim = buildRosterSimulation({
      pool: [...dstRoster, ...wire()],
      rosterIds: dstRoster.map((r) => r.player.id),
      wireIds: wire().map((r) => r.player.id),
      shape: dstShape,
      profile: dstProfile,
      now: NOW,
    });

    expect(sim.unscored.has('def1')).toBe(false);
    const drops = rankDropsFor({ simulation: sim, addPlayerId: 'wireRb' });
    expect(costOf(drops, 'def1').protection).toBe('core_value');
    expect(eligibleDrops(drops).map((d) => d.playerId)).not.toContain('def1');
  });
});
