/**
 * One rule for the grey `Sleeper` number on every screen (15 October 2026).
 */
import { describe, expect, it } from 'vitest';
import { isSleeperSource, sleeperClass, weekIsSleeper, SLEEPER_NUM_CLASS } from '../src/web/sleeperFallback.ts';
import { weekPointsFrom } from '../src/core/startsit/weekPoints.ts';

describe('the Sleeper fallback rule', () => {
  it('greys a number built on Sleeper’s week, whatever the surface calls it', () => {
    expect(isSleeperSource('published')).toBe(true);
    expect(isSleeperSource('sleeper')).toBe(true);
    expect(isSleeperSource(true)).toBe(true);
    for (const other of ['market', 'preseason', 'partial', 'unpriced', 'none', false, null, undefined]) {
      expect(isSleeperSource(other), String(other)).toBe(false);
    }
  });

  it('reads a WeekPoints the same way, and never greys a dash or an Out', () => {
    expect(weekIsSleeper(weekPointsFrom({ points: 9.2, basis: 'published', base: 9.2, adjustments: 0 }))).toBe(true);
    expect(weekIsSleeper(weekPointsFrom({ points: 12.2, basis: 'market', base: 12, adjustments: 0.2 }))).toBe(false);
    // A fragment has no number at all, so nothing to grey.
    expect(weekIsSleeper(weekPointsFrom({ points: 1.6, basis: 'partial', base: 1.6, adjustments: 0 }))).toBe(false);
    expect(weekIsSleeper(weekPointsFrom({ points: 9.2, basis: 'published', base: 9.2, adjustments: 0 }, true))).toBe(false);
    expect(weekIsSleeper(null)).toBe(false);
  });

  it('adds the one shared class', () => {
    expect(sleeperClass('proj', true)).toBe(`proj ${SLEEPER_NUM_CLASS}`);
    expect(sleeperClass('proj', false)).toBe('proj');
  });
});
