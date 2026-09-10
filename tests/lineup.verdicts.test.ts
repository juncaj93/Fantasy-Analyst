/**
 * One list of slots, each with a verdict, against the lineup Sleeper holds.
 *
 * The screen this backs replaced two lists the reader had to reconcile against
 * a third screen. So the properties worth holding are about *coverage and
 * correspondence* rather than about any single sentence: every starting slot
 * gets a row, the rows are the league's own slots in the league's own order,
 * and each row's verdict is a true statement about the two lineups it sits
 * between.
 */

import { describe, expect, it } from 'vitest';
import { buildLineupVerdicts, startingSlotLabels, assignByEligibility } from '../src/core/startsit/sleeperLineup.ts';
import { recommendLineup, type LineupSlot } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, defence } from './helpers/startsit.ts';
import { DST_SCORING } from '../src/core/demo/fixtures/dst.ts';

/** Tony's Pizza: 1 QB, 2 RB, 3 WR, 2 FLEX, 1 DEF, and a bench. */
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(POSITIONS);
const PROFILE = buildScoringProfile(DST_SCORING as Record<string, number>, POSITIONS);

function roster() {
  return [
    candidate('qb1', 'Passer One', 'QB', 21),
    candidate('rb1', 'Back One', 'RB', 14),
    candidate('rb2', 'Back Two', 'RB', 11),
    candidate('wr1', 'Catcher One', 'WR', 15),
    candidate('wr2', 'Catcher Two', 'WR', 12),
    candidate('wr3', 'Catcher Three', 'WR', 10),
    candidate('fx1', 'Flex One', 'RB', 9),
    candidate('fx2', 'Flex Two', 'WR', 8),
    defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5, opponent: 'CAR' }, { team: 'JAX' }),
    candidate('bn1', 'Bench One', 'WR', 4),
  ];
}

const POSITION_OF: Record<string, string> = {
  qb1: 'QB', rb1: 'RB', rb2: 'RB', wr1: 'WR', wr2: 'WR', wr3: 'WR',
  fx1: 'RB', fx2: 'WR', def1: 'DEF', bn1: 'WR',
};
const positionOf = (id: string) => POSITION_OF[id] ?? null;

const SLEEPER_LINEUP = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'fx1', 'fx2', 'def1'];

function verdictsFor(over: { starterIds?: string[]; starterSlotIds?: (string | null)[]; inputs?: ReturnType<typeof roster> } = {}) {
  const inputs = over.inputs ?? roster();
  const starterIds = over.starterIds ?? SLEEPER_LINEUP;
  const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: starterIds });
  return buildLineupVerdicts({
    rosterPositions: POSITIONS,
    starterIds,
    ...(over.starterSlotIds ? { starterSlotIds: over.starterSlotIds } : {}),
    slots: lineup.slots,
    suggestedSwapIns: new Set(lineup.swaps.map((s) => s.inPlayerId)),
    positionOf,
  });
}

describe('the slot list itself', () => {
  it('drops bench, IR and taxi, which are not lineup slots', () => {
    expect(startingSlotLabels([...POSITIONS, 'IR', 'TAXI'])).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'DEF',
    ]);
  });

  it('draws one row per starting slot, in the league’s own order', () => {
    expect(verdictsFor().map((r) => r.slot)).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'DEF',
    ]);
  });

  it('draws every slot even when nothing is wrong with any of them', () => {
    // The reason the screen shows them at all: silence about a slot cannot be
    // told apart from having not looked at it.
    const rows = verdictsFor();
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.verdict === 'keep')).toBe(true);
  });
});

describe('the verdict on one slot', () => {
  it('says keep where Sleeper already has the right player', () => {
    expect(verdictsFor().find((r) => r.slot === 'QB')?.verdict).toBe('keep');
  });

  it('says swap, naming both players, where it disagrees', () => {
    /* Sleeper is starting the weak bench receiver over a better one. */
    const starters = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'bn1', 'fx1', 'fx2', 'def1'];
    const rows = verdictsFor({ starterIds: starters });
    const swap = rows.find((r) => r.verdict === 'swap');

    expect(swap).toBeDefined();
    expect(swap!.currentPlayerId).toBe('bn1');
    expect(swap!.recommendedPlayerId).toBe('wr3');
    expect(swap!.recommendedName).toBe('Catcher Three');
  });

  it('says fill where Sleeper has left a slot empty', () => {
    const starters = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'fx1', 'fx2'];
    const rows = verdictsFor({ starterIds: starters, starterSlotIds: [...starters, null] });

    expect(rows.find((r) => r.slot === 'DEF')?.verdict).toBe('fill');
  });

  it('says no_pick, not bench, for a player it cannot put a number on', () => {
    /*
     * The Jacksonville case. Refusing to rank him is the behaviour; saying
     * "bench him" would be this app inventing an opinion out of its own gap.
     */
    const inputs = roster();
    inputs[8] = defence('def1', 'Jacksonville', { spread: null, total: null, opponent: 'CAR' }, { team: 'JAX' });
    const rows = verdictsFor({ inputs });
    const def = rows.find((r) => r.slot === 'DEF')!;

    expect(def.verdict).toBe('no_pick');
    expect(def.currentPlayerId).toBe('def1');
    expect(def.recommendedPlayerId).toBeNull();
    expect(def.vacancy[0]?.name).toBe('Jacksonville');
  });

  it('carries the reason on an empty slot a rostered player could have filled', () => {
    /*
     * The defence nobody has quoted, sitting on the bench rather than in the
     * lineup: Sleeper has the slot empty and this app will not fill it either.
     * `Nobody eligible yet` is true of a half-drafted roster and false of this
     * one, and the row has to be able to tell them apart — this is precisely
     * the slot where the reader has nothing else to go on.
     */
    const inputs = roster();
    inputs[8] = defence('def1', 'Jacksonville', { spread: null, total: null, opponent: 'CAR' }, { team: 'JAX' });
    /* Sleeper is not starting the defence at all. */
    const starters = SLEEPER_LINEUP.filter((id) => id !== 'def1');
    const rows = verdictsFor({ inputs, starterIds: starters, starterSlotIds: [...starters, null] });
    const def = rows.find((r) => r.slot === 'DEF')!;

    expect(def.verdict).toBe('empty');
    expect(def.currentPlayerId).toBeNull();
    expect(def.vacancy[0]?.name).toBe('Jacksonville');
    expect(def.vacancy[0]?.detail).toBe('no game line for this defence');
  });

  it('says empty when there is nobody in it and nobody for it', () => {
    const thin = [candidate('qb1', 'Passer One', 'QB', 21)];
    const lineup = recommendLineup(thin, SHAPE, PROFILE, { currentStarterIds: ['qb1'] });
    const rows = buildLineupVerdicts({
      rosterPositions: POSITIONS,
      starterIds: ['qb1'],
      starterSlotIds: ['qb1', null, null, null, null, null, null, null, null],
      slots: lineup.slots,
      positionOf,
    });

    expect(rows.find((r) => r.slot === 'DEF')?.verdict).toBe('empty');
    expect(rows.find((r) => r.slot === 'QB')?.verdict).toBe('keep');
  });
});

describe('a difference the optimiser would not suggest', () => {
  /*
   * The screen must not propose a change the app itself declined to make.
   *
   * `recommendLineup` computes the best lineup and, separately, the swaps worth
   * suggesting — a gain under `MIN_SWAP_GAIN` is left alone, and an incumbent is
   * protected from an unpriced challenger. A verdict list reading only the first
   * of those would put `Start X instead` on a row while the card above it said
   * hold, which is one screen answering to two rules and is the defect
   * `lineup.ts` was rewritten to stop.
   */
  it('reads keep, not swap, when no swap was suggested for it', () => {
    const starters = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'bn1', 'fx1', 'fx2', 'def1'];
    const inputs = roster();
    const lineup = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: starters });

    /* The same lineup, with the optimiser's own suggestions withheld. */
    const withheld = buildLineupVerdicts({
      rosterPositions: POSITIONS,
      starterIds: starters,
      slots: lineup.slots,
      suggestedSwapIns: new Set<string>(),
      positionOf,
    });

    expect(withheld.some((r) => r.verdict === 'swap')).toBe(false);
    /* And the row still knows who it would have named, for the card behind it. */
    const slot = withheld.find((r) => r.currentPlayerId === 'bn1')!;
    expect(slot.verdict).toBe('keep');
    expect(slot.recommendedPlayerId).toBe('wr3');
  });

  it('reports every difference when no swap list is passed at all', () => {
    const starters = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'bn1', 'fx1', 'fx2', 'def1'];
    const lineup = recommendLineup(roster(), SHAPE, PROFILE, { currentStarterIds: starters });
    const rows = buildLineupVerdicts({
      rosterPositions: POSITIONS,
      starterIds: starters,
      slots: lineup.slots,
      positionOf,
    });

    expect(rows.some((r) => r.verdict === 'swap')).toBe(true);
  });
});

describe('where Sleeper’s own slot order is known', () => {
  it('is used, so a row shows the player Sleeper has in that slot', () => {
    /*
     * Two interchangeable flex slots, filled the other way round from the way
     * eligibility would guess. The stored order is the authority.
     */
    const stored = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'fx2', 'fx1', 'def1'];
    const rows = verdictsFor({ starterSlotIds: stored });
    const flexes = rows.filter((r) => r.slot === 'FLEX');

    expect(flexes.map((r) => r.currentPlayerId)).toEqual(['fx2', 'fx1']);
  });

  it('falls back to eligibility when the order was never stored', () => {
    // A roster synced before migration 0039. The lineup is still drawn, and
    // every one of Sleeper's starters is somewhere in it.
    const rows = verdictsFor();
    const placed = rows.map((r) => r.currentPlayerId).filter(Boolean);

    expect(new Set(placed)).toEqual(new Set(SLEEPER_LINEUP));
  });

  it('falls back when the stored order is shorter than the lineup', () => {
    // A payload that does not cover every slot would otherwise leave the tail
    // silently unassigned, which reads as an empty slot the reader does not have.
    const rows = verdictsFor({ starterSlotIds: ['qb1', 'rb1'] });

    expect(new Set(rows.map((r) => r.currentPlayerId).filter(Boolean))).toEqual(new Set(SLEEPER_LINEUP));
  });
});

describe('placing a lineup by eligibility', () => {
  const slots: LineupSlot[] = [
    { slot: 'QB', accepts: ['QB'] },
    { slot: 'RB', accepts: ['RB'] },
    { slot: 'RB', accepts: ['RB'] },
    { slot: 'FLEX', accepts: ['RB', 'WR', 'TE'] },
  ].map((s) => ({ ...s, playerId: null, name: null, position: null, score: null, projection: null, projectionSource: null, alreadyStarting: false, locked: false, drivers: [], conflicts: [], vacancy: [] }));

  it('does not strand a player whose only slot is already taken', () => {
    /*
     * The greedy failure this avoids: the flex-eligible back arrives first and
     * takes an RB slot, then the third back has nowhere to go and the lineup
     * appears to have a hole in it that Sleeper does not have.
     */
    const placed = assignByEligibility(
      ['QB', 'RB', 'RB', 'FLEX'],
      ['rbA', 'rbB', 'rbC', 'qbA'],
      slots,
      (id) => (id.startsWith('qb') ? 'QB' : 'RB'),
    );

    expect(placed.filter(Boolean)).toHaveLength(4);
    expect(placed[0]).toBe('qbA');
  });

  it('leaves a slot empty rather than putting an ineligible player in it', () => {
    const placed = assignByEligibility(['QB', 'RB', 'RB', 'FLEX'], ['qbA'], slots, () => 'QB');

    expect(placed).toEqual(['qbA', null, null, null]);
  });
});
