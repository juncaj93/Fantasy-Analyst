/**
 * Bench opportunity cost, the trade ladder and consolidation.
 *
 * The three pins the brief names — a bench slot judged against what it could
 * become, ladder ordering, and consolidation going both ways — are each written
 * as the case that would break if the module quietly acquired a house view.
 */

import { describe, expect, it } from 'vitest';
import { dropLine, evaluateBench, valueOfSlot, type HeldPlayer } from '../src/core/roster/bench.ts';
import { buildLadder, ladderIsOrdered, type LadderInputs } from '../src/core/trades/ladder.ts';
import { assessConsolidation, type ConsolidationInput } from '../src/core/trades/consolidation.ts';
import type { ManagerTradeProfile } from '../src/core/managers/tradeProfile.ts';

function held(over: Partial<HeldPlayer> = {}): HeldPlayer {
  return {
    playerId: 'p1',
    name: 'Bench Guy',
    position: 'WR',
    role: 'bench',
    restOfSeasonValue: 8,
    fourWeekValue: 8,
    insuranceValue: 0,
    upside: 'none',
    coversBye: false,
    streamingReplacement: 6,
    ...over,
  };
}

describe('bench-slot opportunity cost (§7)', () => {
  it('judges a slot against what it could become, not against its own position', () => {
    /*
     * The brief's own example. A QB2 who scores well in QB terms but is barely
     * better than the quarterback anybody could stream is worth less than a
     * lower-scoring back who insures a starter and could take the job.
     */
    const qb2 = valueOfSlot(
      held({ playerId: 'qb2', name: 'Mediocre QB2', position: 'QB', restOfSeasonValue: 16, streamingReplacement: 15 }),
    );
    const handcuff = valueOfSlot(
      held({
        playerId: 'rb4',
        name: 'Handcuff',
        position: 'RB',
        restOfSeasonValue: 5,
        insuranceValue: 12,
        upside: 'high',
        streamingReplacement: 4,
      }),
    );
    expect(qb2.slotValue).toBeGreaterThan(handcuff.slotValue);
    expect(handcuff.surplus).toBeGreaterThan(qb2.surplus);
  });

  it('discounts insurance rather than counting it in full', () => {
    const withInsurance = valueOfSlot(held({ insuranceValue: 12 }));
    const without = valueOfSlot(held({ insuranceValue: 0 }));
    expect(withInsurance.slotValue - without.slotValue).toBeCloseTo(3, 5);
  });

  it('treats a slot no free agent can fill as worth more, not less', () => {
    const scarce = valueOfSlot(held({ streamingReplacement: 0 }));
    const streamable = valueOfSlot(held({ streamingReplacement: 8 }));
    expect(scarce.surplus).toBeGreaterThan(streamable.surplus);
    expect(streamable.reasons.join(' ')).toContain('earning nothing');
  });

  it('never offers a starter or a reserve-slot player as a drop', () => {
    const advice = evaluateBench([
      held({ playerId: 'a', name: 'Starter', role: 'starter', restOfSeasonValue: 1, streamingReplacement: 9 }),
      held({ playerId: 'b', name: 'IR Guy', role: 'reserve', restOfSeasonValue: 0, streamingReplacement: 9 }),
      held({ playerId: 'c', name: 'Bench', role: 'bench', restOfSeasonValue: 2, streamingReplacement: 5 }),
    ]);
    expect(advice.dropCandidates.map((c) => c.name)).toEqual(['Bench']);
    expect(advice.notes.join(' ')).toContain('excluded from the drop list');
  });

  it('names what the slot could become instead', () => {
    const candidate = valueOfSlot(held({ name: 'Spare Part', restOfSeasonValue: 6, fourWeekValue: 6, streamingReplacement: 6 }));
    expect(dropLine(candidate, { name: 'Waiver Back', surplus: 4 })).toContain('Waiver Back');
    expect(dropLine(candidate, null)).toContain('no more than a free agent');
  });

  it('counts bye coverage and optionality as real slot value', () => {
    const plain = valueOfSlot(held());
    const useful = valueOfSlot(held({ coversBye: true, upside: 'high' }));
    expect(useful.slotValue).toBeGreaterThan(plain.slotValue);
    expect(useful.reasons.join(' ')).toContain('bye week');
  });
});

function ladderInputs(over: Partial<LadderInputs> = {}): LadderInputs {
  return {
    targetPlayerId: 't1',
    targetName: 'Target Man',
    targetValue: 100,
    targetValueToMe: 120,
    targetCostToPartner: 60,
    offering: { value: 90, valueToReceiver: 90, playerIds: ['a'], names: ['Mine'] },
    partner: null,
    ...over,
  };
}

function profile(over: Partial<ManagerTradeProfile> = {}): ManagerTradeProfile {
  return {
    rosterId: 2,
    ownerName: 'Partner',
    sample: 6,
    minSample: 4,
    confident: true,
    initiationRate: 0.5,
    tradesPerSeason: 2,
    prefersConsolidation: false,
    tradesPicks: false,
    tradesFaab: false,
    acquiresPositions: [],
    sendsPositions: [],
    negotiation: 'unknown',
    notes: [],
    seasonsObserved: ['2025'],
    ...over,
  };
}

describe('trade offer ladder (§8)', () => {
  it('orders opening ≤ fair ≤ do-not-exceed', () => {
    for (const cost of [0, 20, 60, 110]) {
      for (const mine of [30, 120, 400]) {
        const ladder = buildLadder(ladderInputs({ targetCostToPartner: cost, targetValueToMe: mine }));
        expect(ladderIsOrdered(ladder)).toBe(true);
      }
    }
  });

  it('opens below fair but never below what the player costs his owner', () => {
    const ladder = buildLadder(ladderInputs({ targetCostToPartner: 118, targetValueToMe: 120 }));
    expect(ladder.opening).toBeGreaterThanOrEqual(118);
    expect(ladder.opening).toBeLessThanOrEqual(ladder.fair.low);
  });

  it('leaves more room against a manager who counters everything', () => {
    const haggler = buildLadder(ladderInputs({ partner: profile({ negotiation: 'counters_often' }) }));
    const decisive = buildLadder(ladderInputs({ partner: profile({ negotiation: 'accepts_or_declines' }) }));
    expect(haggler.opening).toBeLessThan(decisive.opening);
    expect(haggler.reasons.join(' ')).toContain('leave room');
  });

  it('refuses to build a ladder where no deal exists', () => {
    const ladder = buildLadder(ladderInputs({ targetValueToMe: 50, targetCostToPartner: 90 }));
    expect(ladder.blocked).toContain('worth more to his current roster');
    expect(ladder.rungs).toHaveLength(0);
  });

  it('never auto-sends', () => {
    expect(buildLadder(ladderInputs()).advisory).toBe('never auto-sent');
  });

  it('says when a thin sample is behind the partner’s tendencies', () => {
    const ladder = buildLadder(ladderInputs({ partner: profile({ sample: 2, confident: false }) }));
    expect(ladder.reasons.join(' ')).toContain('only 2 trade(s)');
  });
});

function consolidation(over: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return {
    sending: [
      { playerId: 'a', name: 'Depth A', position: 'WR', weeklyValue: 9 },
      { playerId: 'b', name: 'Depth B', position: 'RB', weeklyValue: 8 },
    ],
    receiving: { playerId: 'c', name: 'Stud', position: 'WR', weeklyValue: 18 },
    startingPointsNow: 100,
    startingPointsAfter: 104,
    usableDepth: { WR: 3, RB: 3 },
    fragileStarters: 0,
    startingSlots: 9,
    rosterSize: 15,
    week: 10,
    finalWeek: 14,
    uncoveredByes: 0,
    ...over,
  };
}

describe('roster consolidation (§9)', () => {
  it('says yes when the roster is deep and the ceiling is real', () => {
    const advice = assessConsolidation(consolidation());
    expect(advice.verdict).toBe('consolidate');
    expect(advice.headline).toBe('2-for-1 consolidation makes sense');
  });

  it('says no when the same trade would leave the roster fragile', () => {
    const advice = assessConsolidation(
      consolidation({ usableDepth: { WR: 1, RB: 0 }, fragileStarters: 2, week: 4, uncoveredByes: 1 }),
    );
    expect(advice.verdict).toBe('keep_depth');
    expect(advice.headline).toBe('Keep depth; consolidation increases fragility');
    expect(advice.counterpoints.join(' ')).toContain('injury designation');
  });

  it('does not universally favour consolidation', () => {
    /*
     * The brief's explicit warning. The same depth and the same lineup gain must
     * be able to produce both answers, and the thing that decides is fragility
     * rather than a preference baked into the module.
     */
    const deep = assessConsolidation(consolidation());
    const thin = assessConsolidation(consolidation({ usableDepth: { WR: 0, RB: 0 }, week: 3 }));
    expect(deep.verdict).not.toBe(thin.verdict);
  });

  it('refuses the trade that would leave the lineup unfillable', () => {
    const advice = assessConsolidation(consolidation({ rosterSize: 9 }));
    expect(advice.verdict).toBe('keep_depth');
    expect(advice.headline).toContain('unable to fill its own slots');
    expect(advice.confidence).toBe('high');
  });

  it('costs no depth when the players leaving were never startable', () => {
    const advice = assessConsolidation(
      consolidation({
        sending: [
          { playerId: 'a', name: 'Nobody', position: 'WR', weeklyValue: 0 },
          { playerId: 'b', name: 'Nobody Else', position: 'RB', weeklyValue: 0 },
        ],
      }),
    );
    expect(advice.depthCost).toBe(0);
    expect(advice.reasons.join(' ')).toContain('Costs no startable depth');
  });

  it('lets ceiling win late in the season', () => {
    const early = assessConsolidation(consolidation({ week: 2, usableDepth: { WR: 1, RB: 0 } }));
    const late = assessConsolidation(consolidation({ week: 13, usableDepth: { WR: 1, RB: 0 } }));
    expect(early.verdict).toBe('keep_depth');
    expect(late.verdict).toBe('consolidate');
    expect(late.reasons.join(' ')).toContain('few weeks left to be injured in');
  });

  it('will not call a lineup downgrade a consolidation', () => {
    const advice = assessConsolidation(consolidation({ startingPointsAfter: 99 }));
    expect(advice.verdict).toBe('keep_depth');
    expect(advice.lineupGain).toBeLessThan(0);
  });
});
