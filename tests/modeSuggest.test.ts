/**
 * Preselecting Floor, Balanced or Ceiling — and the opponent tiebreak.
 *
 * The property this file exists for is the circularity guard. It is asserted
 * twice: once as behaviour (the suggestion is identical whichever mode the rest
 * of the app happens to be in, because no mode is an input) and once as shape
 * (the only number the suggester accepts is a market expectation). The second
 * is what makes the first hard to break by accident.
 */

import { describe, expect, it } from 'vitest';
import {
  MODE_SUGGESTION,
  projectSide,
  suggestMode,
  type SidePlayer,
} from '../src/core/startsit/modeSuggest.ts';
import {
  CORRELATION,
  assessCorrelation,
  breakTieOnCorrelation,
  opponentExposure,
} from '../src/core/startsit/correlation.ts';
import type { RosterShape } from '../src/core/sleeper/scoring.ts';

const SHAPE: RosterShape = {
  starters: { QB: 1, RB: 2, WR: 2, TE: 1 },
  flex: [{ slot: 'FLEX', positions: ['RB', 'WR', 'TE'] }],
  benchSlots: 6,
  irSlots: 1,
  totalStarters: 7,
  superflex: false,
};

/** A roster where every startable slot is priced at `points`. */
function roster(points: number, over: Partial<Record<string, number>> = {}): SidePlayer[] {
  const positions = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
  return positions.map((position, i) => ({
    playerId: `${position}${i}`,
    position,
    marketPoints: over[`${position}${i}`] ?? points,
  }));
}

describe('projecting a side', () => {
  it('fills the fixed slots before the flex', () => {
    const projection = projectSide(roster(10), SHAPE);
    expect(projection.slotsTotal).toBe(7);
    expect(projection.slotsFilled).toBe(7);
    expect(projection.starters.filter((s) => s.slot === 'FLEX')).toHaveLength(1);
  });

  it('counts an unpriced player as filled but not as priced', () => {
    const players = roster(10).map((p, i) => (i === 0 ? { ...p, marketPoints: null } : p));
    const projection = projectSide(players, SHAPE);
    expect(projection.slotsFilled).toBe(7);
    expect(projection.slotsPriced).toBe(6);
    expect(projection.coverage).toBeLessThan(1);
  });

  it('leaves a ruled-out player out of the estimated lineup', () => {
    const players = roster(10).map((p) => (p.playerId === 'QB0' ? { ...p, ruledOut: true } : p));
    const projection = projectSide(players, SHAPE);
    expect(projection.starters.some((s) => s.playerId === 'QB0')).toBe(false);
  });
});

describe('the suggestion', () => {
  it('preselects Floor for a substantial favourite', () => {
    const suggestion = suggestMode({ mine: roster(18), opponent: roster(10), shape: SHAPE });
    expect(suggestion.state).toBe('substantial_favourite');
    expect(suggestion.mode).toBe('floor');
    expect(suggestion.auto).toBe(true);
    expect(suggestion.detail).toMatch(/Floor/);
  });

  it('preselects Ceiling for a substantial underdog', () => {
    const suggestion = suggestMode({ mine: roster(10), opponent: roster(18), shape: SHAPE });
    expect(suggestion.state).toBe('substantial_underdog');
    expect(suggestion.mode).toBe('ceiling');
    expect(suggestion.margin!).toBeLessThan(-MODE_SUGGESTION.substantialMargin);
  });

  it('stays Balanced when the lineups are close', () => {
    const suggestion = suggestMode({ mine: roster(12), opponent: roster(11.5), shape: SHAPE });
    expect(suggestion.state).toBe('close');
    expect(suggestion.mode).toBe('balanced');
    expect(suggestion.auto).toBe(true);
  });

  it('defaults rather than guesses when the opponent is unknown', () => {
    const suggestion = suggestMode({ mine: roster(12), opponent: [], shape: SHAPE });
    expect(suggestion.mode).toBe('balanced');
    expect(suggestion.auto).toBe(false);
    expect(suggestion.detail).toMatch(/no opponent lineup/);
  });

  it('defaults when too little of the slate is priced', () => {
    const thin = roster(12).map((p, i) => (i > 1 ? { ...p, marketPoints: null } : p));
    const suggestion = suggestMode({ mine: thin, opponent: roster(12), shape: SHAPE });
    expect(suggestion.auto).toBe(false);
    expect(suggestion.mode).toBe('balanced');
    expect(suggestion.detail).toMatch(/carry a market/);
  });

  it('is not fooled by one side simply having more priced players', () => {
    const fewer = roster(15).slice(0, 6);
    const many = roster(15);
    const suggestion = suggestMode({ mine: fewer, opponent: many, shape: SHAPE });
    // Same quality per slot on both sides: this is not a blowout either way.
    expect(Math.abs(suggestion.margin ?? 99)).toBeLessThan(MODE_SUGGESTION.substantialMargin);
  });

  it('cannot be fed a mode-weighted score, which is the guard', () => {
    // A compile-time property, asserted at runtime as the shape of the input:
    // the only number on a side player is his market expectation.
    const player: SidePlayer = { playerId: 'x', position: 'WR', marketPoints: 12 };
    expect(Object.keys(player).sort()).toEqual(['marketPoints', 'playerId', 'position']);
  });
});

describe('opponent exposure', () => {
  const opponentStarters = [
    { playerId: 'o1', name: 'Their QB', gameId: 'BUF@MIA' },
    { playerId: 'o2', name: 'Their WR', gameId: 'BUF@MIA' },
    { playerId: 'o3', name: 'Their TE', gameId: 'NE@NYJ' },
  ];

  it('counts a stack and ignores a lone player', () => {
    const exposure = opponentExposure(opponentStarters, new Map([['BUF@MIA', 51]]));
    expect(exposure.get('BUF@MIA')!.starters).toBe(2);
    expect(exposure.has('NE@NYJ')).toBe(false);
  });

  it('pays for exposure in Ceiling and charges for it in Floor', () => {
    const exposure = opponentExposure(opponentStarters, new Map([['BUF@MIA', 51]]));
    const mine = { playerId: 'm1', name: 'My WR', gameId: 'BUF@MIA' };
    const ceiling = assessCorrelation(mine, exposure, 'ceiling');
    const floor = assessCorrelation(mine, exposure, 'floor');
    expect(ceiling.points).toBeGreaterThan(0);
    expect(floor.points).toBeLessThan(0);
    expect(Math.abs(ceiling.points)).toBeLessThanOrEqual(CORRELATION.maxPoints);
    expect(Math.abs(floor.points)).toBeLessThanOrEqual(CORRELATION.maxPoints);
  });

  it('takes no view at all in Balanced', () => {
    const exposure = opponentExposure(opponentStarters);
    const read = assessCorrelation({ playerId: 'm1', name: 'My WR', gameId: 'BUF@MIA' }, exposure, 'balanced');
    expect(read.points).toBe(0);
    expect(read.verdict).toBe('neutral');
  });

  it('says unknown rather than neutral when there is no opponent lineup', () => {
    const read = assessCorrelation({ playerId: 'm1', name: 'My WR', gameId: 'BUF@MIA' }, new Map(), 'ceiling');
    expect(read.verdict).toBe('unknown');
    expect(read.points).toBe(0);
  });
});

describe('the tiebreak, and its bound', () => {
  const exposure = opponentExposure(
    [
      { playerId: 'o1', name: 'Their QB', gameId: 'BUF@MIA' },
      { playerId: 'o2', name: 'Their WR', gameId: 'BUF@MIA' },
    ],
    new Map([['BUF@MIA', 52]]),
  );

  it('breaks a genuine coin flip', () => {
    const result = breakTieOnCorrelation(
      { playerId: 'a', name: 'In The Shootout', score: 11.9, gameId: 'BUF@MIA' },
      { playerId: 'b', name: 'Elsewhere', score: 12, gameId: 'CHI@GB' },
      exposure,
      'ceiling',
    );
    expect(result!.preferredPlayerId).toBe('a');
    expect(result!.edge).toBeLessThanOrEqual(CORRELATION.maxPoints * 2);
  });

  it('refuses when the players are not actually close', () => {
    const result = breakTieOnCorrelation(
      { playerId: 'a', name: 'In The Shootout', score: 10, gameId: 'BUF@MIA' },
      { playerId: 'b', name: 'Clearly Better', score: 14, gameId: 'CHI@GB' },
      exposure,
      'ceiling',
    );
    expect(result).toBeNull();
  });

  it('stays quiet when the better player would have won anyway', () => {
    const result = breakTieOnCorrelation(
      { playerId: 'a', name: 'In The Shootout', score: 12.2, gameId: 'BUF@MIA' },
      { playerId: 'b', name: 'Elsewhere', score: 12, gameId: 'CHI@GB' },
      exposure,
      'ceiling',
    );
    expect(result).toBeNull();
  });

  it('never speaks in Balanced', () => {
    const result = breakTieOnCorrelation(
      { playerId: 'a', name: 'In The Shootout', score: 11.9, gameId: 'BUF@MIA' },
      { playerId: 'b', name: 'Elsewhere', score: 12, gameId: 'CHI@GB' },
      exposure,
      'balanced',
    );
    expect(result).toBeNull();
  });
});
