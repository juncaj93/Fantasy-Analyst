/**
 * What the Score's colour is saying, settled without a browser.
 *
 * The band is presentation — it moves no player and changes no number — but it
 * is the thing a reader glances at instead of reading forty composites, so
 * being wrong about it is being wrong out loud. The rules it has to hold:
 *
 *  - the absolute anchors mean the same thing on every board;
 *  - a board with no shape gets no context, so nothing is invented from
 *    rounding;
 *  - a player at the edge of a *spread* board can move one band, and only one;
 *  - an unpriced player stays neutral rather than being called bad.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SPREAD,
  FAIR_FLOOR,
  MATERIAL_GAP,
  STRONG_FLOOR,
  scoreBand,
  scoreBandLabel,
  scoreBands,
} from '../src/core/draft/scoreBand.ts';

/** A pool with no shape at all: context must decline to speak about it. */
const FLAT = [90, 90, 90, 90, 90, 90];

describe('the absolute anchors', () => {
  it('calls 80 and over strong, whatever the board looks like', () => {
    expect(scoreBand(STRONG_FLOOR, FLAT)).toBe('strong');
    expect(scoreBand(95, FLAT)).toBe('strong');
    expect(scoreBand(100, FLAT)).toBe('strong');
  });

  it('calls the sixties and seventies fair', () => {
    expect(scoreBand(FAIR_FLOOR, [])).toBe('fair');
    expect(scoreBand(70, [])).toBe('fair');
    expect(scoreBand(STRONG_FLOOR - 1, [])).toBe('fair');
  });

  it('calls anything under sixty weak', () => {
    expect(scoreBand(FAIR_FLOOR - 1, [])).toBe('weak');
    expect(scoreBand(20, [])).toBe('weak');
    expect(scoreBand(0, [])).toBe('weak');
  });

  /**
   * An unpriced player has no Score, and no Score is not a bad one.
   *
   * The board already draws him a dash rather than a number — see the note on
   * `score-value` — and the colour has to agree rather than paint the dash red.
   */
  it('says nothing at all about a player it cannot compare', () => {
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scoreBand(missing as number | null, [90, 40, 70, 55])).toBe('unknown');
    }
    expect(scoreBandLabel('unknown')).toBe('not comparable');
  });
});

describe('what the board is allowed to add', () => {
  /**
   * The example the brief is built around.
   *
   * One player near 80 and a pool in the forties: the good one has to read
   * green and the rest have to read red, and here the absolute anchors already
   * agree — which is the point. Context is a correction, not the mechanism.
   */
  it('reads a lone strong candidate in a weak pool the obvious way', () => {
    const pool = [80, 47, 45, 44, 43, 42, 41, 40];
    expect(scoreBand(80, pool)).toBe('strong');
    for (const weak of [47, 44, 40]) expect(scoreBand(weak, pool)).toBe('weak');
  });

  /**
   * A board that is all fair, but genuinely spread.
   *
   * Nobody here reaches 80 and nobody falls under 60, so the anchors alone
   * would paint twelve identical amber numbers on a board where the top is
   * seventeen points clear of the bottom. One band each way, and only at the
   * edges.
   */
  it('promotes the clear top and demotes the clear bottom of a spread pool', () => {
    const pool = [78, 76, 74, 72, 70, 68, 66, 64, 62, 61];
    expect(scoreBand(78, pool), 'the top of the board').toBe('strong');
    expect(scoreBand(70, pool), 'the middle of the board').toBe('fair');
    expect(scoreBand(61, pool), 'the bottom of the board').toBe('weak');
  });

  /**
   * …and never two bands, however far out the player is.
   *
   * A single outlier must not be able to turn red into green, or the colour
   * stops being anchored to the number at all.
   */
  it('moves a verdict to its neighbour and no further', () => {
    const pool = [59, 20, 18, 16, 14, 12, 10, 8];
    // Absolutely weak, and the clear top of the pool: fair, not strong.
    expect(scoreBand(59, pool)).toBe('fair');

    const rich = [99, 98, 97, 96, 95, 94, 93, 81];
    // Absolutely strong, and the clear bottom of the pool: fair, not weak.
    expect(scoreBand(81, rich)).toBe('fair');
  });

  /**
   * A flat board has no top and no bottom.
   *
   * This is the rule that stops the colour twitching. Every one of these is on
   * the same number, so calling any of them the worst would be manufacturing a
   * difference out of nothing.
   */
  it('declines to rank a pool that has not spread', () => {
    for (const band of scoreBands(FLAT)) expect(band).toBe('strong');

    /*
     * …and the same one step below the threshold, on a board that is entirely
     * inside one anchor band. Every member is in the sixties or seventies, so
     * anything other than twelve amber numbers here would be context speaking
     * when it was told not to.
     */
    const tight = [71, 71, 70, 69, 68, 66, 65, 61];
    expect(tight[0]! - tight[tight.length - 1]!, 'the fixture must stay under the threshold').toBeLessThan(
      CONTEXT_SPREAD,
    );
    for (const band of scoreBands(tight)) expect(band).toBe('fair');
  });

  /**
   * Being at the edge is not the same as being materially better.
   *
   * The pool below spreads far enough for context to be allowed to look, but
   * the top row is only a couple of points clear of the middle — which is a
   * position in a list, not a fact about the player.
   */
  it('asks for a real gap and not merely a place in the order', () => {
    const spread = [72, 71, 70, 70, 70, 70, 69, 58];
    expect(72 - 70).toBeLessThan(MATERIAL_GAP);
    expect(scoreBand(72, spread), 'two points clear of the middle is not a promotion').toBe('fair');
    // …and the genuine outlier at the bottom still moves.
    expect(scoreBand(58, spread)).toBe('weak');
  });
});

describe('the shape of the answer', () => {
  it('is the same every time for the same board', () => {
    const pool = [88, 85, 82, 76, 74, 71, 68, 64, 59, 52];
    const once = scoreBands(pool);
    for (let i = 0; i < 5; i++) expect(scoreBands(pool)).toEqual(once);
  });

  it('reads every row of a board against one distribution', () => {
    const pool = [88, 74, 52, 74, 88, 52];
    const bands = scoreBands(pool);
    // The same number is the same verdict wherever it appears in the list.
    expect(bands[0]).toBe(bands[4]);
    expect(bands[1]).toBe(bands[3]);
    expect(bands[2]).toBe(bands[5]);
    expect(bands).toHaveLength(pool.length);
  });

  /**
   * A missing Score is dropped from the pool rather than counted as zero.
   *
   * Counting it would drag the median down with a number nobody computed, and
   * a board of unpriced players would start painting its priced ones green for
   * the crime of existing.
   */
  it('leaves the players it cannot compare out of the distribution', () => {
    const withMissing = [88, null, 74, undefined, 52, null, 74, 88, 52, undefined];
    const without = [88, 74, 52, 74, 88, 52];
    for (const score of without) {
      expect(scoreBand(score, withMissing), `${score} moved because of the unpriced rows`).toBe(
        scoreBand(score, without),
      );
    }
  });

  it('falls back to the anchors when there is barely a board at all', () => {
    for (const pool of [[], [90], [90, 40], [90, 70, 40]]) {
      expect(scoreBand(90, pool)).toBe('strong');
      expect(scoreBand(40, pool)).toBe('weak');
    }
  });

  it('says each band in a word, for anyone not looking at the colour', () => {
    expect(scoreBandLabel('strong')).toBe('strong');
    expect(scoreBandLabel('fair')).toBe('fair');
    expect(scoreBandLabel('weak')).toBe('weak');
  });
});
