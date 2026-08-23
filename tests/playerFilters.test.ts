/**
 * The Players chip row, in the one order it is allowed to have.
 *
 * Asserted here rather than in the browser suite for a reason that is the whole
 * point of the rule: the demo league starts no defence, so the chip this is
 * about would not be drawn at any width. A browser test would have asserted
 * `ALL · QB · RB · WR · TE · FLX` and passed just as happily with DEF back in
 * the middle of the row.
 */

import { describe, expect, it } from 'vitest';
import { playerFilterChips } from '../src/web/playerFilters.ts';

describe('the Players position filters', () => {
  /**
   * The order the brief asks for, exactly.
   *
   * DEF last, after FLX, rather than between the tight ends and the flex view
   * where `orderPositions` puts it — that helper is shared with the draft board
   * and Team and is deliberately not changed for this.
   */
  it('puts the defence last, after the flex view', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE', 'DEF'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'DEF',
    ]);
  });

  /** The order the league starts them in cannot change the row's own order. */
  it('reads the same however the league lists its slots', () => {
    expect(playerFilterChips(['DEF', 'TE', 'QB', 'WR', 'RB'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'FLX',
      'DEF',
    ]);
  });

  /**
   * A kicker stays among the positions.
   *
   * It is a roster slot a reader browses like any other, and the change that
   * moved the defence was about the defence.
   */
  it('leaves a kicker where the shared order puts it', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])).toEqual([
      'ALL',
      'QB',
      'RB',
      'WR',
      'TE',
      'K',
      'FLX',
      'DEF',
    ]);
  });

  /**
   * A chip that could only ever return nothing is worse than no chip.
   *
   * The demo league's own shape, and the reason this rule needed a unit test:
   * no defence slot, so no defence chip to put anywhere.
   */
  it('offers no defence chip to a league that starts none', () => {
    expect(playerFilterChips(['QB', 'RB', 'WR', 'TE'])).toEqual(['ALL', 'QB', 'RB', 'WR', 'TE', 'FLX']);
  });

  /** No flex-eligible positions, no flex view — and the defence still last. */
  it('drops the flex view when nothing is flex-eligible', () => {
    expect(playerFilterChips(['QB', 'DEF'])).toEqual(['ALL', 'QB', 'DEF']);
  });

  /** Nothing to derive a row from means no row, rather than a lone ALL. */
  it('draws no row at all for a league that starts nothing', () => {
    expect(playerFilterChips([])).toEqual([]);
  });
});
