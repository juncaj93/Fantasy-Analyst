/**
 * The arithmetic behind the navigation gestures.
 *
 * These thresholds are the whole difference between a gesture that feels native
 * and one that hijacks a scroll, and they are pure functions on purpose: the
 * question "is this a swipe or a scroll" can be settled here, exhaustively, in
 * milliseconds, rather than by dragging a finger across a browser in CI.
 *
 * The behaviours being defended, all from the brief:
 *
 *  - a gesture may only begin in a narrow strip at the leading edge;
 *  - horizontal movement must clearly beat vertical;
 *  - when the intent is ambiguous, scrolling wins;
 *  - an incomplete swipe does not navigate.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPLETE_FRACTION,
  COMPLETE_VELOCITY,
  DIRECTION_RATIO,
  EDGE_ZONE,
  ENGAGE_DISTANCE,
  VELOCITY_WINDOW,
  completesBack,
  dimOpacity,
  engageDecision,
  sheetDecision,
  sheetDismisses,
  startsAtEdge,
  velocityOver,
} from '../src/web/gestures.ts';

describe('where a back gesture may start', () => {
  it('accepts a touch inside the leading strip', () => {
    expect(startsAtEdge(0)).toBe(true);
    expect(startsAtEdge(EDGE_ZONE)).toBe(true);
  });

  it('refuses one that started anywhere else', () => {
    expect(startsAtEdge(EDGE_ZONE + 1)).toBe(false);
    expect(startsAtEdge(200)).toBe(false);
    // A player card in the middle of the board is not a back gesture.
    expect(startsAtEdge(195)).toBe(false);
  });

  it('refuses a negative coordinate rather than treating it as the edge', () => {
    expect(startsAtEdge(-5)).toBe(false);
  });
});

describe('what a movement is', () => {
  it('waits while there is not enough of it to tell', () => {
    expect(engageDecision(0, 0)).toBe('wait');
    expect(engageDecision(ENGAGE_DISTANCE - 1, ENGAGE_DISTANCE - 1)).toBe('wait');
  });

  it('is a swipe once horizontal clearly beats vertical', () => {
    expect(engageDecision(40, 4)).toBe('swipe');
    expect(engageDecision(20, 0)).toBe('swipe');
  });

  it('is a scroll whenever the two are close', () => {
    // Exactly the ratio is not "clearly", so it stays a scroll.
    expect(engageDecision(20, 20 / DIRECTION_RATIO)).toBe('scroll');
    expect(engageDecision(30, 30)).toBe('scroll');
    expect(engageDecision(10, 40)).toBe('scroll');
  });

  it('is a scroll when the movement is vertical, however large', () => {
    expect(engageDecision(0, 300)).toBe('scroll');
    expect(engageDecision(-3, 120)).toBe('scroll');
  });

  it('never reads a leftward drag as going back', () => {
    expect(engageDecision(-80, 2)).toBe('scroll');
  });
});

describe('when a swipe completes the navigation', () => {
  const width = 390;

  it('completes on distance alone once it is far enough across', () => {
    expect(completesBack(width * COMPLETE_FRACTION, width, 0)).toBe(true);
    expect(completesBack(width * 0.9, width, 0)).toBe(true);
  });

  it('completes on a flick that did not travel far', () => {
    expect(completesBack(60, width, COMPLETE_VELOCITY)).toBe(true);
  });

  it('does not complete a short, slow drag — it snaps back', () => {
    expect(completesBack(40, width, 0.1)).toBe(false);
    expect(completesBack(width * 0.3, width, 0)).toBe(false);
  });

  it('does not complete a fast flick that barely moved', () => {
    // Velocity alone must not navigate on a twitch.
    expect(completesBack(ENGAGE_DISTANCE, width, 5)).toBe(false);
  });

  it('refuses to decide anything about a layer with no width', () => {
    expect(completesBack(100, 0, 2)).toBe(false);
  });
});

describe('when a sheet is dismissed', () => {
  const height = 400;

  it('dismisses on a long pull', () => {
    expect(sheetDismisses(height * 0.5, height, 0)).toBe(true);
  });

  it('dismisses on a fast flick down', () => {
    expect(sheetDismisses(40, height, 1.2)).toBe(true);
  });

  it('springs back from a small pull', () => {
    expect(sheetDismisses(20, height, 0.05)).toBe(false);
  });
});

/**
 * The rule that decides whether a movement on a sheet is a dismissal.
 *
 * One question now, not two. There used to be a weaker one asked on the very
 * first pixel, because a non-passive `touchmove` listener had to tell WebKit
 * immediately whether to scroll — and a pixel of a thumb landing is not enough
 * to tell an upward flick from a downward pull, so the first swipe of a scroll
 * was regularly refused. The listener is gone and the question with it: content
 * that can scroll keeps its gestures, and this decides the rest.
 */
describe('what a movement on a sheet is', () => {
  it('waits while there is not enough of it to tell', () => {
    expect(sheetDecision(0, 0)).toBe('wait');
    expect(sheetDecision(ENGAGE_DISTANCE - 1, ENGAGE_DISTANCE - 1)).toBe('wait');
  });

  it('is a drag once downward clearly beats sideways', () => {
    expect(sheetDecision(4, 40)).toBe('drag');
    expect(sheetDecision(0, 20)).toBe('drag');
  });

  it('releases a sideways swipe that happened to drift downwards', () => {
    // The reported bug: a swipe across a row of chips threw the sheet away.
    expect(sheetDecision(180, 9)).toBe('release');
    expect(sheetDecision(-180, 9)).toBe('release');
    expect(sheetDecision(20, 20 / DIRECTION_RATIO)).toBe('release');
  });

  it('never reads an upward drag as a dismissal, however large', () => {
    expect(sheetDecision(0, -300)).toBe('release');
    expect(sheetDecision(2, -40)).toBe('release');
  });
});

describe('how fast the finger was going', () => {
  it('is nothing at all when there is only one reading', () => {
    expect(velocityOver([])).toBe(0);
    expect(velocityOver([{ x: 10, t: 0 }])).toBe(0);
  });

  it('measures a flick across the window rather than between two events', () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 30, t: 30 },
      { x: 60, t: 60 },
    ];
    expect(velocityOver(samples)).toBeCloseTo(1);
  });

  it('ignores movement older than the window', () => {
    // A slow drag, a long pause, then a short push: the pause is not a flick,
    // and the old sample must not be allowed to average it into one.
    const samples = [
      { x: 0, t: 0 },
      { x: 200, t: VELOCITY_WINDOW + 100 },
      { x: 210, t: VELOCITY_WINDOW + 110 },
    ];
    expect(velocityOver(samples)).toBeCloseTo(1);
  });

  it('reports a stall as a stall rather than as an enormous number', () => {
    // Two readings in the same millisecond used to divide by one and report a
    // flick, which is how a sheet dismissed itself from a twitch.
    expect(velocityOver([{ x: 0, t: 5 }, { x: 40, t: 5 }])).toBe(0);
  });

  it('is negative for movement back up, so a reversed drag cannot dismiss', () => {
    expect(
      velocityOver([
        { x: 100, t: 0 },
        { x: 40, t: 60 },
      ]),
    ).toBeLessThan(0);
  });
});

describe('the screen behind a half-completed push', () => {
  it('is darkest at the start and clear at the end', () => {
    expect(dimOpacity(0, 390)).toBeGreaterThan(dimOpacity(195, 390));
    expect(dimOpacity(390, 390)).toBe(0);
  });

  it('never goes past its own ceiling, whatever it is handed', () => {
    expect(dimOpacity(-100, 390)).toBeLessThanOrEqual(0.18);
    expect(dimOpacity(10_000, 390)).toBe(0);
    expect(dimOpacity(50, 0)).toBe(0);
  });
});
