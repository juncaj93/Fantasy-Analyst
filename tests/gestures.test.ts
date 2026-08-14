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
  completesBack,
  dimOpacity,
  engageDecision,
  sheetDismisses,
  startsAtEdge,
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
