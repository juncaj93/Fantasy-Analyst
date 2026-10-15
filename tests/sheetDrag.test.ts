/**
 * The sheet's swipe-to-dismiss arithmetic, without a browser.
 *
 * The numbers are Hungry's (see `src/web/sheetDrag.ts`); these hold the rules
 * the brief set: past roughly 30% of the card or a fast flick closes it,
 * anything less springs back, an upward drag barely moves it, and a drag on the
 * content only counts when the content is at its top.
 */

import { describe, expect, it } from 'vitest';
import {
  DISMISS_MAX,
  FLICK_MIN,
  FLICK_VELOCITY,
  INTENT_SLOP,
  LIFT_MAX,
  RESIST_AFTER,
  RESIST_SLOPE,
  dismissDistance,
  dragDecision,
  scrimOpacity,
  sheetOffset,
  shouldDismiss,
} from '../src/web/sheetDrag.ts';

describe('how far a card has to come down to close', () => {
  it('is 28% of a short card', () => {
    expect(dismissDistance(300)).toBeCloseTo(84, 6);
  });

  it('is capped for a tall card, so closing one is not a trek', () => {
    expect(dismissDistance(800)).toBe(DISMISS_MAX);
  });

  it('never goes negative', () => {
    expect(dismissDistance(-10)).toBe(0);
  });
});

describe('when letting go closes the card (threshold)', () => {
  it('closes a slow drag released past the line', () => {
    expect(shouldDismiss(DISMISS_MAX + 1, 0.05, 800)).toBe(true);
  });

  it('springs back from a slow drag released short of it', () => {
    expect(shouldDismiss(DISMISS_MAX - 1, 0.05, 800)).toBe(false);
  });

  it('closes exactly on the line', () => {
    expect(shouldDismiss(dismissDistance(400), 0, 400)).toBe(true);
  });
});

describe('when letting go closes the card (velocity)', () => {
  it('closes a quick flick well short of the line', () => {
    expect(shouldDismiss(40, FLICK_VELOCITY + 0.2, 800)).toBe(true);
  });

  it('does not close a fast nudge that barely moved the card', () => {
    expect(shouldDismiss(FLICK_MIN - 1, 3, 800)).toBe(false);
  });

  it('does not close an unhurried pull short of the line', () => {
    expect(shouldDismiss(80, 0.3, 800)).toBe(false);
  });

  it('keeps a card thrown back up, even past the line', () => {
    expect(shouldDismiss(DISMISS_MAX + 40, -FLICK_VELOCITY, 800)).toBe(false);
  });
});

describe('where the card is drawn for how far the finger went', () => {
  it('follows the finger one for one', () => {
    expect(sheetOffset(0)).toBe(0);
    expect(sheetOffset(50)).toBe(50);
    expect(sheetOffset(RESIST_AFTER)).toBe(RESIST_AFTER);
  });

  it('gets heavier past the resistance point', () => {
    expect(sheetOffset(RESIST_AFTER + 100)).toBeCloseTo(RESIST_AFTER + 100 * RESIST_SLOPE, 6);
  });

  it('only rubber-bands a few pixels on an upward drag, however far', () => {
    expect(sheetOffset(-10)).toBeLessThan(0);
    expect(sheetOffset(-10)).toBeGreaterThan(-LIFT_MAX);
    expect(sheetOffset(-10_000)).toBeGreaterThan(-LIFT_MAX);
    expect(sheetOffset(-200)).toBeLessThan(sheetOffset(-20));
  });
});

describe('what a movement on the card is (scroll-top rule)', () => {
  it('waits inside the slop', () => {
    expect(dragDecision(1, INTENT_SLOP - 1, 'body', true)).toBe('wait');
  });

  it('drags from the handle in either direction', () => {
    expect(dragDecision(0, 10, 'handle', false)).toBe('drag');
    expect(dragDecision(0, -10, 'handle', true)).toBe('drag');
  });

  it('drags from the body when it is at its top and the finger goes down', () => {
    expect(dragDecision(0, 10, 'body', true)).toBe('drag');
  });

  it('never takes the body while it is scrolled, so reading never closes the card', () => {
    expect(dragDecision(0, 10, 'body', false)).toBe('release');
  });

  it('gives an upward drag on the body to the scroll', () => {
    expect(dragDecision(0, -10, 'body', true)).toBe('release');
  });

  it('gives a sideways drag to whatever scrolls sideways, even on the handle', () => {
    expect(dragDecision(12, 5, 'body', true)).toBe('release');
    expect(dragDecision(-12, 5, 'handle', true)).toBe('release');
  });
});

describe('the dim layer', () => {
  it('is full with the card at rest and clears as it comes down', () => {
    expect(scrimOpacity(0, 800)).toBe(1);
    expect(scrimOpacity(200, 800)).toBeCloseTo(0.5, 6);
    expect(scrimOpacity(400, 800)).toBe(0);
  });

  it('clears by the time a short card is all the way down', () => {
    expect(scrimOpacity(250, 250)).toBe(0);
  });

  it('stays full while the card is lifted', () => {
    expect(scrimOpacity(-5, 800)).toBe(1);
  });
});
