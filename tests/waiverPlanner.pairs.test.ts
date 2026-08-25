/**
 * Why a waiver decision is a pair and not two rankings.
 *
 * The test this file exists for is `the best available player is not always the
 * best claim`. If that ever stops holding on a fixture built to make it hold,
 * the planner has quietly gone back to ranking adds and drops separately and
 * stapling the tops together — which is the thing it was written to replace.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterSimulation, pairsForTarget, viablePairs, DEFAULT_LIMITS } from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, NOW, SHAPE, at, roster, wire } from './helpers/waiverPlanner.ts';

function simulation(rosterInputs = roster(), wireInputs = wire()) {
  return buildRosterSimulation({
    pool: [...rosterInputs, ...wireInputs],
    rosterIds: rosterInputs.map((r) => r.player.id),
    wireIds: wireInputs.map((r) => r.player.id),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
  });
}

describe('add and drop as one decision', () => {
  it('measures the add once and the drop against it', () => {
    const sim = simulation();
    const { pairs } = pairsForTarget({ simulation: sim, addPlayerId: 'wireRb', limits: DEFAULT_LIMITS });
    const best = pairs[0];

    expect(best).toBeDefined();
    expect(best?.addPlayerId).toBe('wireRb');
    expect(best?.dropPlayerId).toBe('benchRb');
    /* The identity the whole model rests on, checked rather than assumed. */
    expect(best?.netGain).toBeCloseTo((best?.addValue ?? 0) - (best?.dropCost ?? 0), 6);
    expect(best?.reasons.map((r) => r.code)).toContain('add_enters_lineup');
  });

  it('is bounded by the drop limit', () => {
    const sim = simulation();
    const limits = { ...DEFAULT_LIMITS, maxDropsPerTarget: 2 };
    const { pairs, pairsEvaluated } = pairsForTarget({ simulation: sim, addPlayerId: 'wireRb', limits });
    expect(pairs.length).toBeLessThanOrEqual(2);
    expect(pairsEvaluated).toBeLessThanOrEqual(2);
  });

  it('prefers the smaller add when the bigger one costs an expensive drop', () => {
    /*
     * The case that justifies the whole file.
     *
     * A roster with one bench spot, and the only man in it is the backup tight
     * end. The back on the wire is worth more to this lineup than the tight end
     * is — he beats the flex by more than the tight end beats the starter — so
     * an add-value ranking puts him first. Fitting him means cutting the only
     * cover at a position the league must start. Fitting the tight end costs a
     * spare back nobody would miss.
     *
     * Ranked by what the player is worth, the back wins. Ranked by what
     * actually happens to the roster, he does not, and the second ranking is
     * the one a claim is made on.
     */
    const tight = [
      at('qb1', 'Anchor Quarterback', 'QB', 18),
      at('rb1', 'Feature Back', 'RB', 14),
      at('rb2', 'Second Back', 'RB', 11),
      at('wr1', 'Alpha Receiver', 'WR', 13),
      at('wr2', 'Second Receiver', 'WR', 10),
      at('te1', 'Starting Tight End', 'TE', 9),
      at('rb3', 'Flex Back', 'RB', 8.5),
      at('te2', 'Backup Tight End', 'TE', 6),
    ];
    const thin = [at('wireRb', 'Breakout Back', 'RB', 9), at('wireTe', 'Streaming Tight End', 'TE', 10)];
    const sim = simulation(tight, thin);
    const limits = DEFAULT_LIMITS;

    const backPairs = viablePairs(pairsForTarget({ simulation: sim, addPlayerId: 'wireRb', limits }).pairs, limits);
    const tePairs = viablePairs(pairsForTarget({ simulation: sim, addPlayerId: 'wireTe', limits }).pairs, limits);

    const back = backPairs[0];
    const tightEnd = tePairs[0];
    expect(back).toBeDefined();
    expect(tightEnd).toBeDefined();

    expect((back as NonNullable<typeof back>).addValue).toBeGreaterThan((tightEnd as NonNullable<typeof tightEnd>).addValue);
    expect((back as NonNullable<typeof back>).dropCost).toBeGreaterThan((tightEnd as NonNullable<typeof tightEnd>).dropCost);
    expect((tightEnd as NonNullable<typeof tightEnd>).netGain).toBeGreaterThan((back as NonNullable<typeof back>).netGain);
  });

  it('offers the displaced starter as the drop when the arrival takes his slot', () => {
    /*
     * Protection is measured *after* the add, and this is what that buys.
     *
     * A settled seven for seven slots, and a back on the wire better than the
     * one in the flex. There is no bench to cut from — and there does not need
     * to be, because once the arrival is on the roster the old flex back is not
     * in the lineup and is not protected by the rule that keeps starters safe.
     * The claim is a straight upgrade, which is exactly what it should be.
     *
     * Measuring protection *before* the add would make this roster unable to
     * claim anybody, which is both wrong and the obvious way to write it.
     */
    const settled = roster().slice(0, 7);
    const sim = simulation(settled);
    const pairs = viablePairs(pairsForTarget({ simulation: sim, addPlayerId: 'wireRb', limits: DEFAULT_LIMITS }).pairs, DEFAULT_LIMITS);

    expect(pairs[0]?.dropPlayerId).toBe('rb3');
    expect(pairs[0]?.lineupGain).toBeGreaterThan(0);
    expect(pairs[0]?.reasons.map((r) => r.code)).toContain('add_enters_lineup');
  });

  it('never produces a move that empties a starting slot', () => {
    /*
     * A second gate behind the protection rule, asserted as an invariant.
     *
     * In practice it should be unreachable: a player whose removal would leave
     * a slot unfillable is a player the optimiser is starting, and a starter is
     * protected before a pair is ever built. That is exactly why it is worth
     * checking — an invariant nobody can trip is only known to be an invariant
     * while somebody checks it.
     */
    const sim = simulation();
    for (const target of wire()) {
      const { pairs } = pairsForTarget({ simulation: sim, addPlayerId: target.player.id, limits: DEFAULT_LIMITS });
      for (const pair of pairs) expect(pair.opensSlot).toBe(false);
      for (const pair of viablePairs(pairs, DEFAULT_LIMITS)) {
        expect(pair.reasons.map((r) => r.code)).not.toContain('pair_opens_starting_slot');
      }
    }
  });

  it('marks a pair that does not clear the bar without hiding it', () => {
    const sim = simulation();
    const { pairs } = pairsForTarget({ simulation: sim, addPlayerId: 'fillerRb', limits: DEFAULT_LIMITS });
    const belowBar = pairs.filter((p) => p.netGain < DEFAULT_LIMITS.minNetGain);

    expect(belowBar.length).toBeGreaterThan(0);
    for (const pair of belowBar) expect(pair.reasons.map((r) => r.code)).toContain('net_gain_below_bar');
    expect(viablePairs(pairs, DEFAULT_LIMITS)).not.toContain(belowBar[0]);
  });

  it('grades a bench-for-bench move below a lineup upgrade', () => {
    const sim = simulation();
    const upgrade = pairsForTarget({ simulation: sim, addPlayerId: 'wireRb', limits: DEFAULT_LIMITS }).pairs[0];
    const stash = pairsForTarget({ simulation: sim, addPlayerId: 'fillerWr', limits: DEFAULT_LIMITS }).pairs[0];

    expect(upgrade?.lineupGain).toBeGreaterThan(0);
    expect(stash?.lineupGain).toBe(0);
    expect(stash?.reasons.map((r) => r.code)).toContain('add_bench_depth');
  });
});
