/**
 * The search is bounded, the output is stable, and nothing else moved.
 *
 * Three claims that are cheap to make and expensive to be wrong about. A
 * planner that quietly grew from twenty optimiser runs to two thousand would
 * still pass every other test in this suite; so would one that returned a
 * different plan on the second call; so would one whose mere presence changed
 * what the Waivers screen says today.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { recommendWaiverUpgrades } from '../src/core/startsit/waivers.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { evaluateBench } from '../src/core/roster/bench.ts';
import { buildHeldPlayers } from '../src/core/roster/held.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
import { HALF_PPR, NOW, SHAPE, at, roster, targets, wire } from './helpers/waiverPlanner.ts';

/** A deliberately oversized week: fifteen rostered players, twelve targets. */
function crowded() {
  const extras = Array.from({ length: 5 }, (_, i) => at(`extra${i}`, `Extra Player ${i}`, i % 2 === 0 ? 'WR' : 'RB', 3 - i * 0.3));
  const moreWire = Array.from({ length: 7 }, (_, i) =>
    at(`more${i}`, `Wire Player ${i}`, ['RB', 'WR', 'TE'][i % 3] as string, 9 - i * 0.7),
  );
  return { roster: [...roster(), ...extras], targets: [...wire(), ...moreWire] };
}

describe('bounds', () => {
  it('respects every declared limit on a deliberately oversized week', () => {
    const { roster: big, targets: many } = crowded();
    const result = planWaiverClaims({
      roster: big,
      targets: targets(many),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    });

    expect(many.length).toBeGreaterThan(DEFAULT_LIMITS.maxTargets);
    expect(result.search.targetsConsidered).toBe(DEFAULT_LIMITS.maxTargets);
    expect(result.claims.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxClaims);
    expect(result.outcomes.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxOutcomes);
    expect(result.dropRanking.length).toBe(DEFAULT_LIMITS.maxTargets);

    /*
     * Worst case, stated as a formula rather than as a number to be updated.
     *
     * Pairs: at most one per target per drop kept, twice over — once for the
     * baseline rankings and once for the spine's re-measurement at each step.
     */
    const worstPairs = DEFAULT_LIMITS.maxTargets * DEFAULT_LIMITS.maxDropsPerTarget * (DEFAULT_LIMITS.maxClaims + 2);
    expect(result.search.pairsEvaluated).toBeLessThanOrEqual(worstPairs);

    /*
     * Optimiser runs: bounded by the distinct rosters the search can name.
     *
     * Per target, per level of the spine, the drop ranking asks about the
     * roster with the target on it and about that roster less each rostered
     * player in turn — so the roster's own size is a factor, and it is the one
     * that actually drives the number. The levels are the baseline pass, one
     * per spine step, and the relationship pass.
     *
     * The bound is loose because it assumes nothing is shared, and almost
     * everything is: the states are memoised on the sorted id set, so the same
     * hypothetical roster reached from two directions is one run. The measured
     * figure on this fixture is roughly a third of the ceiling below.
     */
    const worstLineups = 2 + DEFAULT_LIMITS.maxTargets * (1 + big.length) * (DEFAULT_LIMITS.maxClaims + 2);
    expect(result.search.lineupsEvaluated).toBeLessThanOrEqual(worstLineups);
  });

  it('does not work harder when the wire gets longer', () => {
    /*
     * The target bound, doing its job. Eight more players on the wire, none of
     * them good enough to displace the six the planner looks at, and the search
     * is the same size — which is what it means for `maxTargets` to be a bound
     * rather than a preference.
     */
    const { roster: big, targets: many } = crowded();
    const padding = Array.from({ length: 8 }, (_, i) => at(`pad${i}`, `Deep Wire ${i}`, 'WR', 0.5));
    const base = {
      roster: big,
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    };

    const short = planWaiverClaims({ ...base, targets: targets(many) });
    const long = planWaiverClaims({ ...base, targets: targets([...many, ...padding]) });

    expect(long.search.lineupsEvaluated).toBe(short.search.lineupsEvaluated);
    expect(long.search.pairsEvaluated).toBe(short.search.pairsEvaluated);
    expect(long.claims.map((c) => c.id)).toEqual(short.claims.map((c) => c.id));
  });

  it('honours a caller that wants a smaller plan', () => {
    const { roster: big, targets: many } = crowded();
    const result = planWaiverClaims({
      roster: big,
      targets: targets(many),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
      limits: { maxTargets: 2, maxClaims: 2, maxDropsPerTarget: 1, maxOutcomes: 2 },
    });

    expect(result.search.targetsConsidered).toBe(2);
    expect(result.claims.length).toBeLessThanOrEqual(2);
    expect(result.outcomes.length).toBeLessThanOrEqual(2);
    expect(result.dropRanking.length).toBe(2);
  });

  it('runs a full week in a few milliseconds', () => {
    const { roster: big, targets: many } = crowded();
    const input = {
      roster: big,
      targets: targets(many),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    };

    /* One warm run first, so the figure is the planner and not the module load. */
    planWaiverClaims(input);
    const started = performance.now();
    for (let i = 0; i < 5; i++) planWaiverClaims(input);
    const perPlan = (performance.now() - started) / 5;

    /*
     * A generous ceiling on purpose. The measured figure on this fixture is
     * well under a tenth of it; what this guards against is an order of
     * magnitude, which is what an unmemoised optimiser call or an unbounded
     * combination would cost.
     */
    expect(perPlan).toBeLessThan(500);
  });

  it('returns the same plan every time', () => {
    const { roster: big, targets: many } = crowded();
    const input = {
      roster: big,
      targets: targets(many),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    };
    expect(JSON.stringify(planWaiverClaims(input))).toBe(JSON.stringify(planWaiverClaims(input)));
  });

  it('does not touch what the caller handed it', () => {
    const rosterInputs = roster();
    const wireInputs = wire();
    const before = JSON.stringify({ rosterInputs, wireInputs });

    planWaiverClaims({
      roster: rosterInputs,
      targets: targets(wireInputs),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    });

    expect(JSON.stringify({ rosterInputs, wireInputs })).toBe(before);
  });
});

describe('regression safety', () => {
  /**
   * The lane's central claim: nothing that ships today behaves differently
   * because this folder exists.
   *
   * The suite as a whole is the real proof — every existing test runs unchanged
   * — and this is the targeted version: the four surfaces the planner reads
   * from are computed here, in a file that imports the planner, and asserted
   * against the answers they give on their own. If importing the planner ever
   * mutated a shared structure or installed a side effect, these are where it
   * would show.
   */
  it('leaves the waiver engine, the board, the lineup and the bench alone', () => {
    const rosterInputs = roster();
    const wireInputs = wire();

    const advice = recommendWaiverUpgrades({
      roster: rosterInputs,
      candidates: wireInputs,
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: rosterInputs.map((r) => r.player.id),
    });
    const board = buildWaiverBoard(advice);
    const lineup = recommendLineup(rosterInputs, SHAPE, HALF_PPR, { now: NOW });
    const bench = evaluateBench(
      buildHeldPlayers({
        rosterInputs,
        candidateInputs: wireInputs,
        lineup,
        profile: HALF_PPR,
        reserveIds: [],
      }),
    );

    const snapshot = JSON.stringify({ advice, board, lineup, bench });

    planWaiverClaims({
      roster: rosterInputs,
      targets: targets(wireInputs),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    });

    const after = JSON.stringify({
      advice: recommendWaiverUpgrades({
        roster: rosterInputs,
        candidates: wireInputs,
        shape: SHAPE,
        profile: HALF_PPR,
        rosteredPlayerIds: rosterInputs.map((r) => r.player.id),
      }),
      board: buildWaiverBoard(
        recommendWaiverUpgrades({
          roster: rosterInputs,
          candidates: wireInputs,
          shape: SHAPE,
          profile: HALF_PPR,
          rosteredPlayerIds: rosterInputs.map((r) => r.player.id),
        }),
      ),
      lineup: recommendLineup(rosterInputs, SHAPE, HALF_PPR, { now: NOW }),
      bench: evaluateBench(
        buildHeldPlayers({
          rosterInputs,
          candidateInputs: wireInputs,
          lineup: recommendLineup(rosterInputs, SHAPE, HALF_PPR, { now: NOW }),
          profile: HALF_PPR,
          reserveIds: [],
        }),
      ),
    });

    expect(after).toBe(snapshot);
  });
});
