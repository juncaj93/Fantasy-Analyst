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
  DISMISS_COMMIT,
  DISMISS_HOLD,
  DISMISS_RESISTANCE,
  DISMISS_VELOCITY,
  EDGE_ZONE,
  ENGAGE_DISTANCE,
  VELOCITY_WINDOW,
  completesBack,
  dimOpacity,
  dismissesSheet,
  engageDecision,
  resistedTravel,
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

/*
 * The sheet's own arithmetic used to live here — how far down was far enough,
 * how fast was a flick, and whether a movement counted as a dismissal at all.
 *
 * All of it is gone, and not because it was wrong. A sheet is a scroller now
 * and its dismissal is a scroll, so the thresholds are the engine's: how far a
 * flick carries, where it settles, and whether letting go halfway springs back
 * or completes are answered by scroll-snap rather than by three constants and a
 * ratio. There is no arithmetic left to test without a browser, and what there
 * is to check — that the card goes when pushed and stays when the content under
 * the finger was scrolled — is checked with real scrolls in
 * `e2e/sheet-interaction.spec.ts`.
 */

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

/**
 * When a push takes a sheet away.
 *
 * The complaint these hold: a card pulled down slowly and uncertainly to the
 * middle of the screen went away exactly as one thrown there did, because a
 * distance is all a scroll leaves behind once it has stopped. Measured on the
 * layer at 430×932, a two-and-a-half second crawl peaked at 0.17px/ms and a
 * flick at 2.68, and both dismissed.
 */
describe('when a push takes a sheet away', () => {
  it('lets a card go when it was pushed far and fast', () => {
    expect(dismissesSheet(0.55, 1.06, true)).toBe(true);
    expect(dismissesSheet(DISMISS_HOLD, DISMISS_VELOCITY, true)).toBe(true);
  });

  it('brings back a slow crawl that got past the distance anyway', () => {
    // The measured crawl: half the layer, and never above a walking pace.
    expect(dismissesSheet(0.53, 0.17, true)).toBe(false);
    expect(dismissesSheet(0.74, 0.24, true)).toBe(false);
  });

  it('lets a slow push go once it has gone far enough to only be meant', () => {
    // Nothing here may become the only way out: a reader who cannot flick, or
    // would rather place the card, must still be able to finish.
    expect(dismissesSheet(DISMISS_COMMIT, 0, true)).toBe(true);
    expect(dismissesSheet(0.95, 0.01, true)).toBe(true);
  });

  it('brings back a nudge however fast it was', () => {
    expect(dismissesSheet(0.2, 5, true)).toBe(false);
    expect(dismissesSheet(0, 5, true)).toBe(false);
  });

  it('judges an unmeasured push on distance, rather than guessing it was slow', () => {
    // A movement delivered as one jump has a distance and no speed. Withholding
    // a dismissal there would be a guess about evidence never collected.
    expect(dismissesSheet(0.55, 0, false)).toBe(true);
    expect(dismissesSheet(0.2, 0, false)).toBe(false);
  });
});

/**
 * How far the card moves for how far the layer scrolls.
 *
 * The engine moves the layer one pixel per pixel of thumb and cannot be asked
 * not to, so the damping is drawn on top of it. A card that tracks a finger
 * one-for-one all the way off the screen never tells the reader they have done
 * enough — which is the half of "it dismissed when I did not mean it to" that a
 * speed threshold cannot answer.
 */
describe('how far the card moves for how far the layer scrolls', () => {
  it('tracks the scroll exactly until the card is worth committing to', () => {
    expect(resistedTravel(0)).toBe(0);
    expect(resistedTravel(0.2)).toBeCloseTo(0.2, 6);
    expect(resistedTravel(DISMISS_HOLD)).toBeCloseTo(DISMISS_HOLD, 6);
  });

  it('takes only a share of everything past the knee', () => {
    // Half a journey: the knee, plus a damped tenth beyond it.
    expect(resistedTravel(0.5)).toBeCloseTo(DISMISS_HOLD + 0.1 * DISMISS_RESISTANCE, 6);
    expect(resistedTravel(1)).toBeCloseTo(DISMISS_HOLD + (1 - DISMISS_HOLD) * DISMISS_RESISTANCE, 6);
  });

  it('never runs backwards, and never outpaces the scroll', () => {
    let previous = -1;
    for (let given = 0; given <= 1.0001; given += 0.05) {
      const moved = resistedTravel(given);
      expect(moved).toBeGreaterThanOrEqual(previous);
      expect(moved).toBeLessThanOrEqual(given + 1e-9);
      previous = moved;
    }
  });

  it('leaves the card short of gone at the end of the layer, which the exit covers', () => {
    // The whole bargain: past the knee a pull stops buying distance. What the
    // card has not travelled by then is what `leave` has to make up.
    const atEnd = resistedTravel(1);
    expect(atEnd).toBeLessThan(1);
    expect(atEnd).toBeGreaterThan(DISMISS_HOLD);
  });

  it('is the identity when nothing is being damped', () => {
    expect(resistedTravel(0.9, DISMISS_HOLD, 1)).toBeCloseTo(0.9, 6);
  });
});
