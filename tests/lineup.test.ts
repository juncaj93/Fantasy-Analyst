/**
 * Slot-aware lineup recommendation.
 *
 * The cases that matter are the ones a naive slot-filler gets wrong: flex slots
 * with different eligibility, players who cannot be scored at all, and swaps
 * that are not worth making.
 */

import { describe, expect, it } from 'vitest';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

/** Build a candidate whose Vegas expectation lands on a chosen points total. */
function candidate(
  id: string,
  name: string,
  position: string,
  points: number | null,
  extra: { status?: string | null; signal?: PlayerSignal | null } = {},
): StartSitInput {
  const props: PlayerProp[] = [];
  if (points != null) {
    // Receiving yards convert at 0.1 pts/yd, so yards = points * 10.
    const market = position === 'QB' ? 'pass_yards' : 'receiving_yards';
    const line = position === 'QB' ? points / 0.04 : points * 10;
    props.push({
      playerId: id,
      sourcePlayerName: name,
      market,
      line,
      overPrice: -110,
      underPrice: -110,
      bookCount: 3,
      consensusMethod: 'median',
      books: ['a', 'b', 'c'],
      impliedProbability: null,
    });
  }
  return {
    player: player({ id, fullName: name, position, team: 'NE' }),
    props,
    signal: extra.signal ?? null,
    injuryStatus: extra.status ?? null,
    propsStale: false,
  };
}

function signalWithNet(net: number, items = 3): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last21 = { ...s.raw };
  return s;
}

const SIMPLE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

describe('recommendLineup', () => {
  it('fills every slot with an eligible player', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 20),
        candidate('rb1', 'Runner One', 'RB', 15),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('rb3', 'Runner Three', 'RB', 11),
        candidate('wr1', 'Catcher One', 'WR', 14),
        candidate('wr2', 'Catcher Two', 'WR', 10),
        candidate('te1', 'End One', 'TE', 8),
      ],
      SIMPLE,
      HALF_PPR,
    );

    expect(result.slots).toHaveLength(7);
    for (const slot of result.slots) {
      expect(slot.playerId).not.toBeNull();
      expect(slot.accepts).toContain(slot.position);
    }
    // The flex takes the best leftover, which is the third back at 11.
    const flex = result.slots.find((s) => s.slot === 'FLEX')!;
    expect(flex.name).toBe('Runner Three');
  });

  it('never starts the same player twice', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 20),
        candidate('rb1', 'Runner One', 'RB', 15),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('wr1', 'Catcher One', 'WR', 14),
        candidate('wr2', 'Catcher Two', 'WR', 10),
        candidate('te1', 'End One', 'TE', 8),
        candidate('te2', 'End Two', 'TE', 7),
      ],
      SIMPLE,
      HALF_PPR,
    );
    const ids = result.slots.map((s) => s.playerId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The case a greedy slot-filler gets wrong. REC_FLEX accepts only WR/TE,
   * FLEX accepts RB too. Filling FLEX first with the best leftover (the RB)
   * would be fine, but filling it with the best leftover receiver strands the
   * RB — the engine has to look ahead.
   */
  it('assigns overlapping flex slots to maximise total points', () => {
    const shape = buildRosterShape(['RB', 'WR', 'FLEX', 'REC_FLEX', 'BN']);
    const result = recommendLineup(
      [
        candidate('rb1', 'Runner One', 'RB', 20),
        candidate('rb2', 'Runner Two', 'RB', 18),
        candidate('wr1', 'Catcher One', 'WR', 17),
        candidate('wr2', 'Catcher Two', 'WR', 16),
        candidate('te1', 'End One', 'TE', 3),
      ],
      shape,
      HALF_PPR,
    );

    const started = result.slots.map((s) => s.name).sort();
    // REC_FLEX cannot take a back, so the only way to start all four of the
    // best players is RB+RB in RB and FLEX, WR+WR in WR and REC_FLEX. Putting
    // the best leftover receiver in FLEX would strand a back on the bench.
    expect(started).toEqual(['Catcher One', 'Catcher Two', 'Runner One', 'Runner Two']);
    expect(result.slots.find((s) => s.slot === 'FLEX')!.position).toBe('RB');
    expect(result.bench.map((e) => e.name)).toEqual(['End One']);
  });

  it('lets a quarterback fill a superflex slot', () => {
    const shape = buildRosterShape(['QB', 'RB', 'SUPER_FLEX', 'BN']);
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 22),
        candidate('qb2', 'Passer Two', 'QB', 19),
        candidate('rb1', 'Runner One', 'RB', 12),
        candidate('rb2', 'Runner Two', 'RB', 9),
      ],
      shape,
      HALF_PPR,
    );
    const sf = result.slots.find((s) => s.slot === 'SUPER_FLEX')!;
    expect(sf.name).toBe('Passer Two');
  });

  it('keeps an unscorable player out of the lineup and out of the maths', () => {
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 20),
        candidate('rb1', 'Runner One', 'RB', 15),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('wr1', 'Catcher One', 'WR', 14),
        candidate('wr2', 'Catcher Two', 'WR', 10),
        candidate('te1', 'End One', 'TE', 8),
        candidate('mystery', 'No Data', 'WR', null),
      ],
      SIMPLE,
      HALF_PPR,
    );

    expect(result.undecidable.map((e) => e.name)).toEqual(['No Data']);
    expect(result.slots.map((s) => s.playerId)).not.toContain('mystery');
    expect(result.bench.map((e) => e.name)).not.toContain('No Data');
    expect(result.notes.join(' ')).toContain('could not be scored');
  });

  it('suggests a swap when the current lineup leaves points on the bench', () => {
    // Six slots, seven players: exactly one has to sit, and the current lineup
    // sits the wrong one.
    const noFlex = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN', 'BN']);
    const result = recommendLineup(
      [
        candidate('qb1', 'Passer One', 'QB', 20),
        candidate('rb1', 'Runner One', 'RB', 15),
        candidate('rb2', 'Runner Two', 'RB', 12),
        candidate('wr1', 'Catcher One', 'WR', 14),
        candidate('wr2', 'Catcher Two', 'WR', 10),
        candidate('te1', 'End One', 'TE', 8),
        candidate('wr3', 'Catcher Three', 'WR', 13),
      ],
      noFlex,
      HALF_PPR,
      { currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1'] },
    );

    const swap = result.swaps.find((s) => s.inName === 'Catcher Three');
    expect(swap).toBeDefined();
    expect(swap!.outName).toBe('Catcher Two');
    expect(swap!.gain).toBeCloseTo(3, 1);
    expect(swap!.reason).toBeTruthy();
  });

  it('stays quiet when the current lineup is already optimal', () => {
    const roster = [
      candidate('qb1', 'Passer One', 'QB', 20),
      candidate('rb1', 'Runner One', 'RB', 15),
      candidate('rb2', 'Runner Two', 'RB', 12),
      candidate('wr1', 'Catcher One', 'WR', 14),
      candidate('wr2', 'Catcher Two', 'WR', 10),
      candidate('te1', 'End One', 'TE', 8),
      candidate('rb3', 'Runner Three', 'RB', 11),
    ];
    const result = recommendLineup(roster, SIMPLE, HALF_PPR, {
      currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'],
    });
    expect(result.swaps).toEqual([]);
    expect(result.currentPoints).toBeCloseTo(result.recommendedPoints, 2);
  });

  it('does not suggest a swap worth less than the threshold', () => {
    const result = recommendLineup(
      [
        candidate('wr1', 'Catcher One', 'WR', 10),
        candidate('wr2', 'Catcher Two', 'WR', 10.2),
      ],
      buildRosterShape(['WR', 'BN']),
      HALF_PPR,
      { currentStarterIds: ['wr1'] },
    );
    expect(result.swaps).toEqual([]);
  });

  it('proposes benching a player who is ruled out, and says why', () => {
    const result = recommendLineup(
      [
        candidate('wr1', 'Catcher One', 'WR', 14, { status: 'Out' }),
        candidate('wr2', 'Catcher Two', 'WR', 9),
      ],
      buildRosterShape(['WR', 'BN']),
      HALF_PPR,
      { currentStarterIds: ['wr1'] },
    );
    const swap = result.swaps[0]!;
    expect(swap.inName).toBe('Catcher Two');
    expect(swap.outName).toBe('Catcher One');
    expect(swap.reason).toContain('Out');
  });

  it('refuses to suggest a change against a player it could not score', () => {
    const result = recommendLineup(
      [
        candidate('wr1', 'No Data', 'WR', null),
        candidate('wr2', 'Catcher Two', 'WR', 9),
      ],
      buildRosterShape(['WR', 'BN']),
      HALF_PPR,
      { currentStarterIds: ['wr1'] },
    );
    expect(result.swaps).toEqual([]);
    expect(result.warnings.join(' ')).toContain('could not be scored');
  });

  it('withholds a current total when a current starter cannot be scored', () => {
    const result = recommendLineup(
      [candidate('wr1', 'No Data', 'WR', null), candidate('wr2', 'Catcher Two', 'WR', 9)],
      buildRosterShape(['WR', 'BN']),
      HALF_PPR,
      { currentStarterIds: ['wr1', 'wr2'] },
    );
    expect(result.currentPoints).toBeNull();
  });

  it('reports a slot it cannot fill rather than leaving it silently empty', () => {
    const result = recommendLineup(
      [candidate('wr1', 'Catcher One', 'WR', 14)],
      buildRosterShape(['QB', 'WR', 'BN']),
      HALF_PPR,
    );
    const qb = result.slots.find((s) => s.slot === 'QB')!;
    expect(qb.playerId).toBeNull();
    expect(result.warnings.join(' ')).toContain('QB');
  });

  it('flags a recommended starter who carries an injury designation', () => {
    const result = recommendLineup(
      [candidate('wr1', 'Catcher One', 'WR', 20, { status: 'Questionable' })],
      buildRosterShape(['WR', 'BN']),
      HALF_PPR,
    );
    expect(result.warnings.join(' ')).toContain('Questionable');
  });

  it('takes recent news into account when the market is level', () => {
    const result = recommendLineup(
      [
        candidate('wr1', 'Catcher One', 'WR', 12, { signal: signalWithNet(-4) }),
        candidate('wr2', 'Catcher Two', 'WR', 12, { signal: signalWithNet(4) }),
      ],
      buildRosterShape(['WR', 'BN']),
      HALF_PPR,
      { currentStarterIds: ['wr1'] },
    );
    expect(result.slots[0]!.name).toBe('Catcher Two');
    expect(result.swaps[0]!.reason).toContain('signal');
  });

  it('never returns more starters than the league has slots', () => {
    const result = recommendLineup(
      Array.from({ length: 20 }, (_, i) => candidate(`wr${i}`, `Catcher ${i}`, 'WR', 20 - i)),
      SIMPLE,
      HALF_PPR,
    );
    const started = result.slots.filter((s) => s.playerId != null);
    expect(started.length).toBeLessThanOrEqual(SIMPLE.totalStarters);
  });
});
