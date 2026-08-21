/**
 * The draft card's one line of advice.
 *
 * `bestMove` turns the need breakdown into a sentence, and the whole point of
 * it living in core rather than in the screen is that the sentence is a
 * conclusion about a roster and can therefore be wrong. These are the ways it
 * could be wrong: naming a position that is already covered, naming the whole
 * roster back at a manager who has drafted nobody, or changing its mind when
 * nothing about the roster changed.
 *
 * Nothing here scores a player or reads ADP, and neither does the function —
 * it is a reading of `computeNeed`, which the board already uses.
 */

import { describe, expect, it } from 'vitest';
import { bestMove } from '../src/core/draft/bestMove.ts';
import { computeNeed } from '../src/core/draft/need.ts';
import type { RosterShape } from '../src/core/sleeper/scoring.ts';

/** A conventional league: QB, 2 RB, 2 WR, TE and one RB/WR/TE flex. */
const SHAPE: RosterShape = {
  starters: { QB: 1, RB: 2, WR: 2, TE: 1 },
  flex: [{ slot: 'FLEX', positions: ['RB', 'WR', 'TE'] }],
  benchSlots: 6,
  irSlots: 1,
  totalStarters: 7,
  superflex: false,
};

const move = (counts: Record<string, number>) => bestMove(computeNeed(SHAPE, counts));

describe('the best move', () => {
  it('names the one position with an empty starting slot', () => {
    // Everything filled except a receiver.
    const result = move({ QB: 1, RB: 2, WR: 1, TE: 1 });
    expect(result.kind).toBe('starter');
    expect(result.positions).toEqual(['WR']);
    expect(result.text).toBe('WR is the priority.');
  });

  it('names both when two are open', () => {
    const result = move({ QB: 0, RB: 2, WR: 1, TE: 1 });
    expect(result.kind).toBe('starter');
    expect(result.text).toMatch(/^(QB and WR|WR and QB) are the priority\.$/);
    expect(result.positions).toHaveLength(2);
  });

  /**
   * An empty roster is the case that tempts a list.
   *
   * At the first pick every position is unfilled, and "QB, RB, WR and TE are
   * the priority" is the roster read back rather than advice. It counts the
   * holes and names the two worst instead.
   */
  it('counts the holes rather than listing every position, early on', () => {
    const result = move({});
    expect(result.kind).toBe('starter');
    // Six dedicated starting slots: 1 QB, 2 RB, 2 WR, 1 TE.
    expect(result.text).toMatch(/^6 starting slots still open — \w+ and \w+ first\.$/);
    expect(result.positions).toHaveLength(2);
  });

  it('sends you to the flex once every dedicated slot is covered', () => {
    const result = move({ QB: 1, RB: 2, WR: 2, TE: 1 });
    expect(result.kind).toBe('flex');
    expect(result.text).toContain('fill the flex');
    // The flex takes any of the three, and the line says so rather than picking.
    for (const position of ['RB', 'WR', 'TE']) expect(result.positions).toContain(position);
  });

  it('talks about upside once nothing is missing', () => {
    const result = move({ QB: 1, RB: 3, WR: 3, TE: 2 });
    expect(result.kind).toBe('depth');
    expect(result.text).toContain('upside depth');
    expect(result.positions).toHaveLength(2);
  });

  /**
   * The same roster gives the same answer.
   *
   * `computeNeed` returns an object, and iterating an object is insertion
   * order — which is the order the roster happened to be counted in, not a
   * fact about the roster. Without the name as a final sort key, two positions
   * tied on need would swap places between two identical calls and the advice
   * would appear to change on its own.
   */
  it('does not depend on the order the positions were counted in', () => {
    const one = bestMove(computeNeed(SHAPE, { QB: 0, RB: 0, WR: 2, TE: 1 }));
    const two = bestMove(computeNeed(SHAPE, { TE: 1, WR: 2, RB: 0, QB: 0 }));
    expect(two.text).toBe(one.text);
    expect(two.positions).toEqual(one.positions);
  });

  /** A position this league does not start is not advice, whatever it scores. */
  it('ignores positions the league does not use', () => {
    const result = move({ QB: 1, RB: 2, WR: 2, TE: 1, K: 0, DEF: 0 });
    expect(result.text).not.toMatch(/\bK\b|DEF/);
  });

  it('always says something', () => {
    const rosters: Record<string, number>[] = [{}, { QB: 9 }, { QB: 1, RB: 2, WR: 2, TE: 1 }];
    for (const counts of rosters) {
      expect(bestMove(computeNeed(SHAPE, counts)).text.length).toBeGreaterThan(0);
    }
  });
});
