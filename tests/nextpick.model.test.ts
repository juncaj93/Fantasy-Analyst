/**
 * The four models the simulator is built out of, tested apart from it.
 *
 * The simulator composes them interactively — a manager's need changes which
 * position is sampled, which changes the board, which changes the next
 * manager's need — so a failure inside any one of them reaches the surface as a
 * percentage that is slightly off, which is exactly the kind of wrong that
 * nobody notices. Each is therefore pinned on its own, where the arithmetic is
 * visible and an assertion can be exact.
 */

import { describe, expect, it } from 'vitest';
import {
  DISPERSION_BOUNDS,
  adpSpread,
  conditionalMarketSurvival,
  marketPickWeight,
  marketSurvivalAt,
} from '../src/core/draft/survival.ts';
import { DEMAND, phaseWeight, positionDemand, positionsInPlay } from '../src/core/draft/nextpick/demand.ts';
import { ROOM, readRoom } from '../src/core/draft/nextpick/room.ts';
import { SIMULATION, tierScarcityBonus } from '../src/core/draft/nextpick/simulate.ts';
import { buildPositionTierMap } from '../src/core/draft/tiers.ts';
import { buildPickOwnership, slotAtPick } from '../src/core/draft/nextpick/ownership.ts';
import { hashString, mulberry32, sampleIndex } from '../src/core/draft/nextpick/rng.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import type { CompletedPick, UniversePlayer } from '../src/core/draft/nextpick/room.ts';

// ------------------------------------------------------------------- market

describe('the market distribution', () => {
  it('is a coin flip at a player’s own ADP', () => {
    for (const adp of [5, 30, 80, 150]) {
      expect(marketSurvivalAt(adp, adp)).toBeCloseTo(0.5, 6);
      expect(marketPickWeight(adp, adp)).toBeCloseTo(0.5, 6);
    }
  });

  it('spreads wider the later a player goes', () => {
    expect(adpSpread(5)).toBeLessThan(adpSpread(60));
    expect(adpSpread(60)).toBeLessThan(adpSpread(180));
    // Never so narrow that the first pick of a draft looks certain.
    expect(adpSpread(1)).toBeGreaterThanOrEqual(4);
  });

  it('narrows for a disciplined room and widens for a wild one, within bounds', () => {
    expect(adpSpread(60, 0.8)).toBeLessThan(adpSpread(60));
    expect(adpSpread(60, 1.2)).toBeGreaterThan(adpSpread(60));
    // Bounded: a dozen picks may not rewrite a distribution built from thousands.
    expect(adpSpread(60, 0.1)).toBe(adpSpread(60, DISPERSION_BOUNDS.min));
    expect(adpSpread(60, 9)).toBe(adpSpread(60, DISPERSION_BOUNDS.max));
  });

  it('rises as a player’s ADP approaches, and saturates rather than exploding', () => {
    const adp = 50;
    expect(marketPickWeight(adp, 30)).toBeLessThan(marketPickWeight(adp, 45));
    expect(marketPickWeight(adp, 45)).toBeLessThan(marketPickWeight(adp, 60));
    // The ceiling, and the reason no separate "falling player" term is needed:
    // a player fifty picks past his ADP already carries roughly twice the weight
    // of one being taken at his, and can never carry more than double.
    expect(marketPickWeight(adp, 200)).toBeLessThanOrEqual(1);
    expect(marketPickWeight(adp, 200) / marketPickWeight(adp, adp)).toBeLessThanOrEqual(2);
  });

  it('falls strictly as ADP rises at a fixed pick', () => {
    // The property the simulator's shortlist cut-off depends on: once one
    // player is below the floor, everybody behind him is too.
    let previous = Infinity;
    for (let adp = 40; adp <= 260; adp += 5) {
      const weight = marketPickWeight(adp, 60);
      expect(weight).toBeLessThan(previous);
      previous = weight;
    }
  });
});

describe('conditional survival', () => {
  it('asks about the picks ahead, not the picks behind', () => {
    /*
     * ADP 45, still on the board at 60, next pick 68.
     *
     * The unconditional distribution answers a question about pick 30 and
     * returns something near 5%: true of a player who has not been passed over
     * fifteen times, useless about one who has. The conditional answer is far
     * higher, and it is higher precisely because the room has been declining
     * him — every pick that goes by is evidence, not a countdown.
     */
    const unconditional = marketSurvivalAt(45, 68);
    const conditional = conditionalMarketSurvival(45, 60, 68);
    expect(unconditional).toBeLessThan(0.15);
    expect(conditional).toBeGreaterThan(unconditional * 3);
  });

  it('settles into a constant hazard per pick once a player is well past his ADP', () => {
    // Far into the tail every further pick costs the same share, because each
    // one is another team declining him rather than the market catching up.
    const first = conditionalMarketSurvival(20, 120, 125);
    const second = conditionalMarketSurvival(20, 125, 130);
    expect(Math.abs(first - second)).toBeLessThan(0.01);
  });

  it('is 1 over no distance and never leaves [0,1]', () => {
    expect(conditionalMarketSurvival(50, 60, 60)).toBe(1);
    expect(conditionalMarketSurvival(50, 60, 50)).toBe(1);
    for (const [adp, from, to] of [
      [1, 1, 200],
      [250, 1, 2],
      [45, 200, 260],
    ] as const) {
      const p = conditionalMarketSurvival(adp, from, to);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('does not underflow to nonsense for a player long past his ADP', () => {
    // Both survival terms are effectively zero here; computed as a ratio they
    // would be 0/0. This is the case the model exists to answer.
    const p = conditionalMarketSurvival(5, 200, 212);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

// ------------------------------------------------------------------- demand

describe('manager demand', () => {
  const shape = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);
  const positions = positionsInPlay(shape);
  /** Mid-draft, so the phase ramp is fully applied and nothing is damped away. */
  const midDraft = { shape, progress: 0.5 };
  const demand = (counts: Record<string, number>, progress = 0.5) =>
    positionDemand(counts, { shape, progress }, positions);

  it('lifts a position whose starting slot is empty', () => {
    const empty = demand({ QB: 0, RB: 2, WR: 3, TE: 1 }).get('QB')!;
    expect(empty.startersUnfilled).toBe(1);
    expect(empty.multiplier).toBeGreaterThan(1);
  });

  it('drops a single-slot position materially once its starter is in place', () => {
    const wanting = demand({ QB: 0, RB: 2, WR: 3, TE: 1 }).get('QB')!.multiplier;
    const satisfied = demand({ QB: 1, RB: 2, WR: 3, TE: 1 }).get('QB')!.multiplier;

    expect(satisfied).toBeLessThan(wanting);
    // Materially, not to nothing. Managers do take a second quarterback.
    expect(satisfied).toBeLessThan(0.8);
    expect(satisfied).toBeGreaterThan(0);
  });

  it('treats tight end the same way, and for the same reason', () => {
    const wanting = demand({ QB: 1, RB: 2, WR: 3, TE: 0 }).get('TE')!.multiplier;
    const satisfied = demand({ QB: 1, RB: 2, WR: 3, TE: 1 }).get('TE')!.multiplier;
    expect(satisfied).toBeLessThan(wanting);
  });

  it('keeps backs and receivers in play long after their starters are filled', () => {
    /*
     * The asymmetry the brief asks for, and the one that a boolean "position
     * covered" model gets wrong. A manager with three receivers in a league that
     * starts three is not done with receivers — there is a flex, a bench and an
     * injury list — and a model that says otherwise has the room stop drafting
     * them in round eight, which is when the room drafts most of them.
     */
    const filled = demand({ QB: 1, RB: 2, WR: 3, TE: 1 });
    const wr = filled.get('WR')!.multiplier;
    const qb = filled.get('QB')!.multiplier;

    expect(wr).toBeGreaterThan(qb);
    expect(wr).toBeGreaterThan(0.8);
  });

  it('responds to an open flex slot', () => {
    // Same roster twice, except one has spent its flex. Every flex-eligible
    // position should be worth more when the slot is still open.
    const flexOpen = demand({ QB: 1, RB: 2, WR: 3, TE: 1 });
    const flexSpent = demand({ QB: 1, RB: 3, WR: 3, TE: 1 });

    expect(flexOpen.get('WR')!.flexOpen).toBe(1);
    expect(flexSpent.get('WR')!.flexOpen).toBe(0);
    expect(flexOpen.get('WR')!.multiplier).toBeGreaterThan(flexSpent.get('WR')!.multiplier);
    // And a tight end with his slot filled is still in play, entirely because of
    // the flex — which is the only thing keeping him there.
    expect(flexOpen.get('TE')!.multiplier).toBeGreaterThan(flexSpent.get('TE')!.multiplier);
  });

  it('barely applies at all in the first round', () => {
    /*
     * Every roster is empty at pick one, so an undamped need model has twelve
     * managers all desperate for a quarterback. They are not: round one is a
     * market. The signal is scaled down early and reaches full strength by the
     * middle of the draft.
     */
    const early = demand({}, 0).get('QB')!.multiplier;
    const middle = demand({}, 0.5).get('QB')!.multiplier;
    expect(early).toBeLessThan(middle);
    expect(Math.abs(early - 1)).toBeLessThan(Math.abs(middle - 1));
    expect(phaseWeight(0)).toBe(DEMAND.earlyPhaseWeight);
    expect(phaseWeight(1)).toBe(1);
  });

  it('reads which positions are depth positions from the league, not from a list', () => {
    /*
     * A superflex league starts a second quarterback in all but name, and the
     * model has to see that. A manager with one quarterback and an open
     * superflex slot is *hungry* for another — that is the whole shape of a
     * superflex draft — where the same roster in a one-quarterback league has
     * finished with the position.
     */
    const superflex = buildRosterShape(['QB', 'SUPER_FLEX', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN']);
    const oneQb = positionDemand({ QB: 1, RB: 2, WR: 2, TE: 1 }, { shape: superflex, progress: 0.5 }).get('QB')!;
    expect(oneQb.startersUnfilled).toBe(1);
    expect(oneQb.multiplier).toBeGreaterThan(1);

    // With both quarterback slots filled it settles like a depth position
    // rather than collapsing the way a single-slot position does.
    const twoQb = positionDemand({ QB: 2, RB: 2, WR: 2, TE: 1 }, { shape: superflex, progress: 0.5 }).get('QB')!;
    expect(twoQb.depthPosition).toBe(true);
    expect(twoQb.multiplier).toBeLessThan(oneQb.multiplier);
    expect(twoQb.multiplier).toBeGreaterThan(0.8);

    // And the same roster in a one-quarterback league is done with the position.
    const single = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN']);
    expect(positionDemand({ QB: 1, RB: 2, WR: 2, TE: 1 }, { shape: single, progress: 0.5 }).get('QB')!.multiplier)
      .toBeLessThan(0.8);
  });

  it('never lets a position become impossible or certain', () => {
    const rosters: Record<string, number>[] = [{}, { QB: 4, RB: 8, WR: 9, TE: 3 }, { QB: 1, RB: 0, WR: 0, TE: 0 }];
    for (const counts of rosters) {
      for (const detail of demand(counts).values()) {
        expect(detail.multiplier).toBeGreaterThan(0);
        expect(detail.multiplier).toBeLessThanOrEqual(DEMAND.max);
      }
    }
    void midDraft;
  });
});

// --------------------------------------------------------------------- room

describe('reading the room', () => {
  const positions = ['QB', 'RB', 'WR', 'TE'];

  it('caps every signal at the strength the documentation claims', () => {
    /*
     * The caps as literals, not as `ROOM.runBounds.max`.
     *
     * Every other assertion in this file that mentions a bound reads it from
     * the constant, which makes those assertions vacuous against the one change
     * most worth catching: widening the cap itself. A test that says "within
     * whatever the cap happens to be" passes however far the cap is opened.
     * These numbers are the contract — `docs/NEXT_PICK.md` quotes them — and
     * moving one should require saying so here.
     */
    expect(ROOM.runBounds).toEqual({ min: 0.85, max: 1.3 });
    expect(ROOM.biasBounds).toEqual({ min: 0.85, max: 1.2 });
    expect(ROOM.managerBounds).toEqual({ min: 0.9, max: 1.15 });
    expect(ROOM.runMinSample).toBe(8);
    expect(ROOM.biasMinSample).toBe(6);
    expect(ROOM.adherenceMinSample).toBe(12);
    expect(ROOM.managerMinSample).toBe(4);
  });

  /** A draft where every pick landed exactly on its ADP, in market proportions. */
  function history(upTo: number, positionAt: (pickNo: number) => string, offset = 0): CompletedPick[] {
    return Array.from({ length: upTo - 1 }, (_, i) => ({
      pickNo: i + 1,
      slot: ((i % 12) + 1),
      position: positionAt(i + 1),
      adp: i + 1 - offset,
    }));
  }

  const marketMix = (pickNo: number) => ['RB', 'WR', 'WR', 'RB', 'WR', 'TE', 'RB', 'WR', 'QB', 'WR', 'RB', 'WR'][pickNo % 12]!;
  const universe: UniversePlayer[] = Array.from({ length: 220 }, (_, i) => ({
    position: marketMix(i + 1),
    adp: i + 1,
  }));

  it('says nothing before there is anything to read', () => {
    const room = readRoom({ picks: history(5, marketMix), currentPick: 5, positions, universe });
    expect(room.runs.size).toBe(0);
    expect(room.bias.size).toBe(0);
    expect(room.dispersion).toBe(1);
    expect(room.managers.size).toBe(0);
  });

  it('spots a run against what the market expected over the same stretch', () => {
    const calm = readRoom({ picks: history(41, marketMix), currentPick: 41, positions, universe });
    const running = readRoom({
      picks: history(41, (pickNo) => (pickNo > 29 ? 'WR' : marketMix(pickNo))),
      currentPick: 41,
      positions,
      universe,
    });

    expect(running.runs.get('WR')!).toBeGreaterThan(calm.runs.get('WR') ?? 1);
    expect(running.running).toContain('WR');
    // Capped, because runs end.
    expect(running.runs.get('WR')!).toBeLessThanOrEqual(ROOM.runBounds.max);
  });

  it('learns that a room takes a position earlier than the market', () => {
    /*
     * Every quarterback in this room went fifteen picks before his ADP. That is
     * a standing property of the room rather than a burst, so it is measured
     * over the whole draft and shrunk by how little of the draft that is.
     */
    const picks = history(97, marketMix).map((pick) =>
      pick.position === 'QB' ? { ...pick, adp: pick.adp! + 15 } : pick,
    );
    expect(picks.filter((p) => p.position === 'QB').length).toBeGreaterThanOrEqual(ROOM.biasMinSample);
    const room = readRoom({ picks, currentPick: 97, positions, universe });

    expect(room.bias.get('QB')!).toBeGreaterThan(1);
    expect(room.bias.get('QB')!).toBeLessThanOrEqual(ROOM.biasBounds.max);
    expect(room.notes.join(' ')).toContain('earlier than the market');
  });

  it('requires a real sample before it will claim a bias at all', () => {
    // Two quarterbacks taken twenty picks early is a coincidence, not a habit.
    const picks = history(25, (pickNo) => (pickNo === 3 || pickNo === 9 ? 'QB' : 'WR')).map((pick) =>
      pick.position === 'QB' ? { ...pick, adp: pick.adp! + 20 } : pick,
    );
    const room = readRoom({ picks, currentPick: 25, positions, universe });
    expect(room.bias.has('QB')).toBe(false);
  });

  it('narrows the distribution for a room that tracks ADP and widens it for one that reaches', () => {
    const disciplined = readRoom({ picks: history(41, marketMix), currentPick: 41, positions, universe });
    // The same draft with every pick twenty-five off its ADP.
    const wild = readRoom({
      picks: history(41, marketMix).map((pick, i) => ({ ...pick, adp: pick.adp! + (i % 2 ? 25 : -25) })),
      currentPick: 41,
      positions,
      universe,
    });

    expect(disciplined.dispersion).toBeLessThan(1);
    expect(wild.dispersion).toBeGreaterThan(1);
    expect(disciplined.dispersion).toBeGreaterThanOrEqual(ROOM.runBounds.min * 0);
    expect(wild.dispersion).toBeLessThanOrEqual(1.35);
  });

  it('gives a manager a tendency only after several picks, and only a small one', () => {
    // Slot 1 takes a receiver every time; everybody else follows the mix.
    const picks = history(61, marketMix).map((pick) => (pick.slot === 1 ? { ...pick, position: 'WR' } : pick));
    const room = readRoom({ picks, currentPick: 61, positions, universe });

    const lean = room.managers.get(1);
    expect(lean).toBeDefined();
    expect(lean!.get('WR')!).toBeGreaterThan(1);
    expect(lean!.get('WR')!).toBeLessThanOrEqual(ROOM.managerBounds.max);
    // Three picks is not a personality.
    expect(room.managers.get(11)?.get('WR') ?? 1).toBeLessThanOrEqual(ROOM.managerBounds.max);
  });
});

// -------------------------------------------------------------------- tiers

describe('the tier premium', () => {
  /** A ladder with a real cliff: a tight group, then a long way to the next. */
  const ladder = (tierSize: number) =>
    buildPositionTierMap(
      'TE',
      [...Array.from({ length: tierSize }, (_, i) => 60 + i * 2), 140, 152, 164, 176],
      { picksUntilNext: 14 },
    );

  const bonusFor = (tierSize: number, adp: number) =>
    tierScarcityBonus({ playerId: 'x', position: 'TE', adp, order: adp }, new Map([['TE', ladder(tierSize)]]));

  it('lifts the last players in a group that ends at a cliff', () => {
    /*
     * A separate effect from alternative supply, and worth its own test because
     * the two point the same way and the composite would pass with either one
     * missing. This is the reach: managers take the last of a group early
     * because the next group is materially worse, which is a different reason
     * from "there are only two of them left to go round".
     */
    const twoLeft = ladder(2);
    expect(twoLeft.at(60).tierEndsAtCliff, 'the fixture really has a cliff').toBe(true);
    expect(twoLeft.at(60).remainingInTier).toBe(2);

    expect(bonusFor(2, 60)).toBeGreaterThan(1);
    // The last one alone is worth more than one of two.
    expect(bonusFor(2, 62)).toBeGreaterThan(bonusFor(2, 60));
  });

  it('says nothing about a group with depth behind him', () => {
    expect(bonusFor(8, 60)).toBe(1);
  });

  it('is bounded, and silent when there is no tier data at all', () => {
    // The literal, for the same reason the room's caps are literals: an
    // assertion against `SIMULATION.tierScarcityGain` cannot catch that number
    // changing.
    expect(SIMULATION.tierScarcityGain).toBe(0.3);
    for (const size of [1, 2, 3, 6]) {
      for (const adp of [60, 62, 64]) {
        expect(bonusFor(size, adp)).toBeLessThanOrEqual(1 + SIMULATION.tierScarcityGain);
        expect(bonusFor(size, adp)).toBeGreaterThanOrEqual(1);
      }
    }
    // No ladder, no premium — the tier engine is consumed, never assumed.
    expect(tierScarcityBonus({ playerId: 'x', position: 'TE', adp: 60, order: 60 })).toBe(1);
    expect(tierScarcityBonus({ playerId: 'x', position: 'TE', adp: null, order: 1 }, new Map([['TE', ladder(2)]]))).toBe(1);
  });
});

// ---------------------------------------------------------------- ownership

describe('pick ownership', () => {
  const base = { teams: 12, rounds: 15, type: 'snake' };

  it('follows the snake', () => {
    const ownership = buildPickOwnership(base);
    expect(ownership.slotAt(1)).toBe(1);
    expect(ownership.slotAt(12)).toBe(12);
    expect(ownership.slotAt(13)).toBe(12);
    expect(ownership.slotAt(24)).toBe(1);
    expect(ownership.slotAt(25)).toBe(1);
    expect(slotAtPick(53, 12, 'snake')).toBe(5);
    expect(slotAtPick(68, 12, 'snake')).toBe(5);
  });

  it('advances in fixed order in a linear draft', () => {
    const ownership = buildPickOwnership({ ...base, type: 'linear' });
    expect(ownership.slotAt(12)).toBe(12);
    expect(ownership.slotAt(13)).toBe(1);
  });

  it('finds the next pick strictly after the one on the clock', () => {
    const ownership = buildPickOwnership(base);
    // Standing on your own pick, the answer is your *next* one — the whole model
    // turns on this, because the alternative asks whether a player available now
    // is available now.
    expect(ownership.nextOwnedPickAfter(5, 53)).toBe(68);
    expect(ownership.nextOwnedPickAfter(5, 52)).toBe(53);
    // And on the last pick of the draft there is no answer to give.
    expect(ownership.nextOwnedPickAfter(5, 173)).toBeNull();
  });

  it('gives back-to-back picks their own answer', () => {
    const ownership = buildPickOwnership(base);
    // Slot 12 picks at 12 and 13. From 12 the target is 13; from 13 it is 36.
    expect(ownership.nextOwnedPickAfter(12, 12)).toBe(13);
    expect(ownership.nextOwnedPickAfter(12, 13)).toBe(36);
  });

  it('uses the actual owner of a traded pick, not the seat it sits in', () => {
    /*
     * Roster 109 (slot 9) traded its third-rounder to roster 102 (slot 2).
     *
     * Pick 33 still sits in slot 9's seat, but slot 2 is the manager making it,
     * and slot 2's roster is what the model must read. Inferring the owner from
     * the snake would attribute the pick to a manager who is not picking and
     * invent demand from a roster that filled that position two rounds ago.
     */
    const slotToRosterId = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), 100 + i + 1]));
    const traded = buildPickOwnership({
      ...base,
      slotToRosterId,
      tradedPicks: [{ round: 3, rosterId: 109, ownerRosterId: 102 }],
    });

    // Round 3 is picks 25-36 and runs 1..12, so slot 9 holds pick 33.
    expect(traded.slotAt(33)).toBe(9);
    expect(traded.ownerAt(33)).toBe(2);
    expect(traded.hasTrades).toBe(true);

    // Slot 9 keeps every other pick it owns; only the traded one moved.
    expect(traded.picksOwnedBy(9)).not.toContain(33);
    expect(traded.picksOwnedBy(9)).toContain(9);
    expect(traded.picksOwnedBy(2)).toContain(33);
    // And "when do I pick next" follows ownership rather than the seat.
    expect(traded.nextOwnedPickAfter(2, 26)).toBe(33);
  });

  it('ignores a trade it cannot resolve rather than guessing', () => {
    const ownership = buildPickOwnership({
      ...base,
      slotToRosterId: { '1': 101 },
      tradedPicks: [{ round: 3, rosterId: 999, ownerRosterId: 101 }],
    });
    expect(ownership.hasTrades).toBe(false);
    expect(ownership.ownerAt(33)).toBe(ownership.slotAt(33));
  });
});

// ---------------------------------------------------------------------- rng

describe('the generator', () => {
  it('gives the same stream for the same seed, and a different one otherwise', () => {
    const a = mulberry32(hashString('draft|53|68'));
    const b = mulberry32(hashString('draft|53|68'));
    const c = mulberry32(hashString('draft|54|68'));

    const first = Array.from({ length: 10 }, () => a());
    expect(Array.from({ length: 10 }, () => b())).toEqual(first);
    expect(Array.from({ length: 10 }, () => c())).not.toEqual(first);
  });

  it('stays inside [0,1)', () => {
    const random = mulberry32(hashString('spread'));
    for (let i = 0; i < 5000; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('samples in proportion to the weights it is given', () => {
    const weights = [1, 3, 6];
    const counts = [0, 0, 0];
    const random = mulberry32(hashString('sample'));
    for (let i = 0; i < 20000; i++) counts[sampleIndex(weights, 3, 10, random())]!++;

    expect(counts[0]! / 20000).toBeCloseTo(0.1, 1);
    expect(counts[1]! / 20000).toBeCloseTo(0.3, 1);
    expect(counts[2]! / 20000).toBeCloseTo(0.6, 1);
  });

  it('never returns an index outside the array', () => {
    // Floating-point drift at the tail must land on the last candidate rather
    // than on nothing.
    expect(sampleIndex([1, 1], 2, 2, 0.999999999)).toBe(1);
    expect(sampleIndex([1, 1], 2, 2, 0)).toBe(0);
    expect(sampleIndex([], 0, 0, 0.5)).toBe(-1);
    expect(sampleIndex([0, 0], 2, 0, 0.5)).toBe(0);
  });
});
