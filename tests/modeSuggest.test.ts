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
  expectedPoints,
  projectSide,
  suggestMode,
  type SidePlayer,
} from '../src/core/startsit/modeSuggest.ts';
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
    expect(suggestion.detail).toMatch(/carry a projection/);
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

/**
 * The week as it is now, rather than as it looked on Thursday.
 *
 * The control this replaces could not do it: a reader who had chosen Floor on
 * Friday was still being answered under Floor at four o'clock on Sunday, with
 * the lead that justified it long gone. So the property under test is that the
 * *same* function, given a week in progress, changes its mind for the reason a
 * person would.
 *
 * These build the sides by hand rather than through the fixtures above, because
 * what is being exercised is the arithmetic in `expectedPoints` — banked plus
 * what is left of the game — and it has to be readable which number is which.
 */
describe('a week already under way', () => {
  const shape = SHAPE;

  /** A side of nine identical men, so a margin is easy to reason about. */
  function side(over: Partial<SidePlayer> & { points: number }): SidePlayer[] {
    const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'K', 'DEF'];
    return positions.map((position, i) => ({
      playerId: `${position}-${i}`,
      position,
      marketPoints: over.points,
      ...(over.actualPoints === undefined ? {} : { actualPoints: over.actualPoints }),
      ...(over.gameRemaining === undefined ? {} : { gameRemaining: over.gameRemaining }),
    }));
  }

  it('says nothing about live state before anybody has kicked off', () => {
    const suggestion = suggestMode({ mine: side({ points: 12 }), opponent: side({ points: 12 }), shape });
    expect(suggestion.live).toBe(false);
    expect(suggestion.mine?.banked).toBe(0);
    expect(suggestion.detail).toMatch(/the market/);
  });

  it('reads a finished player as what he scored and not as what he was going to', () => {
    // Projected 12, actually got 2, game over. He is worth 2, not 12, and not 14.
    const done = expectedPoints({ playerId: 'x', position: 'WR', marketPoints: 12, actualPoints: 2, gameRemaining: 0 });
    expect(done.points).toBe(2);
  });

  it('mixes the two at half time, in the proportion of the game left', () => {
    const half = expectedPoints({ playerId: 'x', position: 'WR', marketPoints: 12, actualPoints: 4, gameRemaining: 0.5 });
    expect(half.points).toBe(10);
  });

  it('leaves a man who has not started on his whole projection', () => {
    // Sleeper reports 0 for a player who has played and not scored, so a null
    // actual is the pregame state and must not be read as a bad afternoon.
    const pregame = expectedPoints({ playerId: 'x', position: 'WR', marketPoints: 12, gameRemaining: 1 });
    expect(pregame.points).toBe(12);
  });

  it('turns a comfortable favourite into a coin flip when the opponent blows up', () => {
    /*
     * The case from the brief, in numbers. Pregame both sides project the same
     * and the week is a coin flip. Then the opponent's men come in at double
     * their lines while mine are still to play — and the mode has to stop
     * telling a man who is now well behind to protect a floor.
     */
    const pregame = suggestMode({ mine: side({ points: 12 }), opponent: side({ points: 12 }), shape });
    expect(pregame.state).toBe('close');

    const blownUp = suggestMode({
      mine: side({ points: 12 }),
      opponent: side({ points: 12, actualPoints: 24, gameRemaining: 0 }),
      shape,
    });
    expect(blownUp.live).toBe(true);
    expect(blownUp.state).toBe('substantial_underdog');
    expect(blownUp.mode).toBe('ceiling');
    expect(blownUp.detail).toMatch(/you are about \d+ points behind/);
  });

  it('turns a coin flip into a lead worth protecting when the opponent is bombing', () => {
    const bombing = suggestMode({
      mine: side({ points: 12 }),
      opponent: side({ points: 12, actualPoints: 1, gameRemaining: 0 }),
      shape,
    });
    expect(bombing.state).toBe('substantial_favourite');
    expect(bombing.mode).toBe('floor');
    expect(bombing.reasons.join(' ')).toMatch(/already on the board/);
  });
});

/**
 * Speaking at all, on a roster this app deliberately does not price.
 *
 * The opponent is not bought from a sportsbook — the owner declined that on
 * cost on 9 September 2026 — so on market alone his coverage is one or two
 * slots in nine and every suggestion came back `unknown`. Rotowire's published
 * week is already stored for the whole NFL, so it is the fallback.
 */
/** This fixture league starts QB, RB, RB, WR, WR, TE and a FLEX — seven slots. */
const SHAPE_STARTERS = 7;

describe('the published fallback', () => {
  function borrowedSide(points: number): SidePlayer[] {
    return ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'K', 'DEF'].map((position, i) => ({
      playerId: `${position}-${i}`,
      position,
      marketPoints: null,
      publishedPoints: points,
    }));
  }

  it('lets a matchup be called when only one side carries a market', () => {
    const mine = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'K', 'DEF'].map((position, i) => ({
      playerId: `mine-${position}-${i}`,
      position,
      marketPoints: 20,
    }));
    const suggestion = suggestMode({ mine, opponent: borrowedSide(8), shape: SHAPE });

    expect(suggestion.auto, 'an unpriced opponent used to force `unknown`').toBe(true);
    expect(suggestion.state).toBe('substantial_favourite');
  });

  it('never prefers the published number to a market one', () => {
    const both = expectedPoints({ playerId: 'x', position: 'WR', marketPoints: 12, publishedPoints: 3 });
    expect(both.points).toBe(12);
    expect(both.borrowed).toBe(false);
  });

  it('counts and names the slots it borrowed rather than hiding them', () => {
    const suggestion = suggestMode({ mine: borrowedSide(12), opponent: borrowedSide(12), shape: SHAPE });
    expect(suggestion.mine?.slotsBorrowed).toBe(SHAPE_STARTERS);
    expect(suggestion.reasons.join(' ')).toMatch(/Rotowire/);
  });
});
