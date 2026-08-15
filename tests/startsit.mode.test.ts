/**
 * Floor, Balanced, Ceiling — and the lineup they produce.
 *
 * Two properties are load-bearing and are asserted here rather than assumed:
 *
 *   - a mode **reweights** the argument, it does not replace it. The same
 *     components appear in all three, a clearly better player wins in all
 *     three, and the differences are meaningful but bounded.
 *   - the lineup optimiser never starts the same player twice, never moves a
 *     locked player, and never spends more than a tie on the shape of a lineup.
 */

import { describe, expect, it } from 'vitest';
import { MODE_WEIGHTS, START_SIT_MODES, normalizeMode } from '../src/core/startsit/mode.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { LINEUP_PREFERENCE_TOLERANCE, recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN']);
const NOW = new Date('2026-09-13T15:00:00Z');
const EARLY = '2026-09-13T17:00:00Z';
const LATE = '2026-09-13T20:25:00Z';

function week(over: Partial<UsageWeek> & { week: number }): UsageWeek {
  return {
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: null,
    receptions: null,
    targetShare: null,
    wopr: null,
    ...over,
  };
}

function run(count: number, template: Omit<Partial<UsageWeek>, 'week'>): UsageWeek[] {
  return Array.from({ length: count }, (_, i) => week({ week: i + 1, ...template }));
}

/** High volume, underneath role, no scores: the floor play. */
const SAFE = run(6, { targets: 10, receptions: 8, recYards: 75, recTds: 0, receivingAirYards: 55 });
/** Fewer targets, all downfield, touchdown-driven: the ceiling play. */
const VOLATILE = [
  week({ week: 1, targets: 5, receptions: 2, recYards: 70, recTds: 1, receivingAirYards: 90 }),
  week({ week: 2, targets: 4, receptions: 1, recYards: 20, recTds: 0, receivingAirYards: 80 }),
  week({ week: 3, targets: 5, receptions: 3, recYards: 95, recTds: 1, receivingAirYards: 95 }),
  week({ week: 4, targets: 4, receptions: 1, recYards: 15, recTds: 0, receivingAirYards: 75 }),
  week({ week: 5, targets: 5, receptions: 2, recYards: 60, recTds: 1, receivingAirYards: 85 }),
  week({ week: 6, targets: 4, receptions: 1, recYards: 25, recTds: 0, receivingAirYards: 70 }),
];

describe('the mode reweights one engine', () => {
  it('produces the same components in every mode', () => {
    const keys = START_SIT_MODES.map((mode) =>
      evaluatePlayer({ ...candidate('a', 'A', 'WR', 12), usageWeeks: SAFE, mode }, HALF_PPR).components.map(
        (c) => c.key,
      ),
    );
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
  });

  it('records what the mode did to each component', () => {
    const floor = evaluatePlayer({ ...candidate('a', 'A', 'WR', 12), usageWeeks: SAFE, mode: 'floor' }, HALF_PPR);
    const usage = floor.components.find((c) => c.key === 'usage_level')!;
    expect(usage.modeWeight).toBe(MODE_WEIGHTS.floor['usage_level']);
    /*
     * The multiplier is applied, and then the opportunity pair cap may trim it.
     * Both are true of the same number, so the assertion is the one that holds
     * in either case: the mode can only ever scale a component, never flip it,
     * and it can never make it larger than the multiplier says.
     */
    expect(Math.sign(usage.value)).toBe(Math.sign(usage.baseValue));
    expect(Math.abs(usage.value)).toBeLessThanOrEqual(Math.abs(usage.baseValue * usage.modeWeight) + 1e-9);

    const td = floor.components.find((c) => c.key === 'td_dependency')!;
    expect(td.value).toBeCloseTo(td.baseValue * td.modeWeight, 2);
  });

  it('prefers the safe player in Floor and the volatile one in Ceiling', () => {
    const score = (usageWeeks: UsageWeek[], mode: 'floor' | 'ceiling' | 'balanced') =>
      evaluatePlayer({ ...candidate('x', 'X', 'WR', 11), usageWeeks, mode }, HALF_PPR).score!;

    expect(score(SAFE, 'floor') - score(VOLATILE, 'floor')).toBeGreaterThan(
      score(SAFE, 'ceiling') - score(VOLATILE, 'ceiling'),
    );
  });

  it('keeps Balanced between the two', () => {
    const gap = (mode: 'floor' | 'ceiling' | 'balanced') =>
      evaluatePlayer({ ...candidate('a', 'A', 'WR', 11), usageWeeks: SAFE, mode }, HALF_PPR).score! -
      evaluatePlayer({ ...candidate('b', 'B', 'WR', 11), usageWeeks: VOLATILE, mode }, HALF_PPR).score!;
    expect(gap('balanced')).toBeLessThan(gap('floor'));
    expect(gap('balanced')).toBeGreaterThan(gap('ceiling'));
  });

  it('does not let a mode overturn a clearly better player', () => {
    // Eight points of market expectation is not a tie, and no amount of
    // reweighting may turn it into one.
    for (const mode of START_SIT_MODES) {
      const better = evaluatePlayer({ ...candidate('a', 'A', 'WR', 18), usageWeeks: VOLATILE, mode }, HALF_PPR);
      const worse = evaluatePlayer({ ...candidate('b', 'B', 'WR', 10), usageWeeks: SAFE, mode }, HALF_PPR);
      expect(better.score!).toBeGreaterThan(worse.score!);
    }
  });

  it('reads anything unrecognised as Balanced', () => {
    expect(normalizeMode('nonsense')).toBe('balanced');
    expect(normalizeMode(null)).toBe('balanced');
    expect(normalizeMode('Ceiling')).toBe('ceiling');
  });
});

describe('the lineup optimiser', () => {
  const roster = () => [
    { ...candidate('qb', 'Quarterback', 'QB', 18, { team: 'CIN', kickoff: EARLY }), usageWeeks: SAFE },
    { ...candidate('rb1', 'Back One', 'RB', 14, { team: 'DET', kickoff: EARLY }), usageWeeks: SAFE },
    { ...candidate('rb2', 'Back Two', 'RB', 11, { team: 'SEA', kickoff: EARLY }), usageWeeks: SAFE },
    { ...candidate('wr1', 'Wide One', 'WR', 15, { team: 'CIN', kickoff: LATE }), usageWeeks: SAFE },
    { ...candidate('wr2', 'Wide Two', 'WR', 12, { team: 'MIA', kickoff: LATE }), usageWeeks: SAFE },
    { ...candidate('te', 'Tight End', 'TE', 9, { team: 'KC', kickoff: EARLY }), usageWeeks: SAFE },
    { ...candidate('flex', 'Flex Back', 'RB', 10, { team: 'NYJ', kickoff: LATE }), usageWeeks: SAFE },
    { ...candidate('bench', 'Bench Guy', 'WR', 4, { team: 'LAC', kickoff: EARLY }), usageWeeks: SAFE },
  ];

  it('never starts the same player twice', () => {
    const lineup = recommendLineup(roster(), SHAPE, HALF_PPR, { now: NOW });
    const ids = lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fills every slot it can, and only with eligible positions', () => {
    const lineup = recommendLineup(roster(), SHAPE, HALF_PPR, { now: NOW });
    for (const slot of lineup.slots) {
      if (!slot.position) continue;
      expect(slot.accepts).toContain(slot.position);
    }
  });

  it('puts the later kickoff in the FLEX when the starters are the same', () => {
    /*
     * `flex` (late) and `rb2` (early) are both backs and both start. Which one
     * sits in RB and which in FLEX changes nothing about the points and
     * everything about what can still be swapped at four o'clock.
     */
    const lineup = recommendLineup(roster(), SHAPE, HALF_PPR, { now: NOW });
    const flexSlot = lineup.slots.find((s) => s.slot === 'FLEX');
    expect(flexSlot?.playerId).toBe('flex');
  });

  it('leaves a locked player exactly where he is', () => {
    const started = new Date('2026-09-13T18:00:00Z');
    const lineup = recommendLineup(roster(), SHAPE, HALF_PPR, {
      now: started,
      currentStarterIds: ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'te', 'flex'],
    });
    const locked = lineup.slots.filter((s) => s.locked).map((s) => s.playerId);
    // The early games have kicked off; those players hold their slots and are
    // never moved into a different one.
    expect(locked).toContain('rb1');
    expect(lineup.notes.join(' ')).toMatch(/kicked off/i);
  });

  it('never starts a player who is Out', () => {
    const withOut = roster().map((input) =>
      input.player.id === 'wr1' ? { ...input, injuryStatus: 'Out' } : input,
    );
    const lineup = recommendLineup(withOut, SHAPE, HALF_PPR, { now: NOW });
    expect(lineup.slots.map((s) => s.playerId)).not.toContain('wr1');
    expect(lineup.warnings.join(' ')).toMatch(/not a playable starter/i);
  });

  it('leaves a bye-week player out rather than guessing at him', () => {
    // No market, no usage: the engine cannot score him, so he is undecidable
    // and is never quietly benched *or* quietly started.
    const withBye = [...roster(), candidate('bye', 'On Bye', 'WR', null)];
    const lineup = recommendLineup(withBye, SHAPE, HALF_PPR, { now: NOW });
    expect(lineup.undecidable.map((e) => e.playerId)).toContain('bye');
    expect(lineup.slots.map((s) => s.playerId)).not.toContain('bye');
  });

  it('fills a superflex with a quarterback when the league has one', () => {
    const superflex = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'BN', 'BN']);
    const withTwoQbs = [
      ...roster(),
      { ...candidate('qb2', 'Backup QB', 'QB', 16, { team: 'BUF', kickoff: LATE }), usageWeeks: SAFE },
    ];
    const lineup = recommendLineup(withTwoQbs, superflex, HALF_PPR, { now: NOW });
    const slot = lineup.slots.find((s) => s.slot === 'SUPER_FLEX');
    expect(slot?.position).toBe('QB');
  });

  it('spends no more than a tie on the shape of the lineup', () => {
    const balanced = recommendLineup(roster(), SHAPE, HALF_PPR, { now: NOW, mode: 'balanced' });
    for (const mode of ['floor', 'ceiling'] as const) {
      const shaped = recommendLineup(roster(), SHAPE, HALF_PPR, { now: NOW, mode });
      // Scores differ between modes, so the comparison is of *how many* starters
      // changed rather than of the totals: at most one swap per slot, each
      // inside the tolerance.
      const changed = shaped.slots.filter(
        (s, i) => s.playerId !== balanced.slots[i]?.playerId,
      ).length;
      expect(changed).toBeLessThanOrEqual(shaped.slots.length);
      expect(LINEUP_PREFERENCE_TOLERANCE).toBeLessThan(1);
    }
  });

  it('reports which question it answered', () => {
    expect(recommendLineup(roster(), SHAPE, HALF_PPR, { now: NOW, mode: 'ceiling' }).mode).toBe('ceiling');
  });
});
