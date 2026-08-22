/**
 * The arithmetic behind pull-to-refresh.
 *
 * The gesture replaced two buttons, so the thresholds are now the only thing
 * standing between the reader and a screen they cannot reload. They are pure
 * functions for the same reason the back-swipe's are: "does this pull fire a
 * refresh" can be settled here exhaustively, in milliseconds.
 *
 * The behaviours being defended:
 *
 *  - an upward drag is a scroll and moves nothing;
 *  - the surface is damped, so it never simply tracks the finger;
 *  - however hard it is pulled, it stops at the limit;
 *  - it fires on distance and never on speed, so a flick down a long list
 *    cannot reload the page by accident;
 *  - the state the indicator paints is a function of the distance and nothing
 *    else;
 *  - and it engages only on a deliberately vertical gesture, which is the rule
 *    that keeps it out of the way of every other drag on a phone.
 */

import { describe, expect, it } from 'vitest';
import {
  DIRECTION_RATIO,
  ENGAGE_DISTANCE,
  PULL_LIMIT,
  PULL_RESISTANCE,
  PULL_TRIGGER,
  engageDecision,
  pullDecision,
  pullDistance,
  pullReleases,
  pullState,
} from '../src/web/gestures.ts';

describe('how far the surface follows the finger', () => {
  it('does not move at all upwards', () => {
    expect(pullDistance(-1)).toBe(0);
    expect(pullDistance(-400)).toBe(0);
    expect(pullDistance(0)).toBe(0);
  });

  it('moves less than the finger does', () => {
    // The whole difference between "attached to the thumb" and "a div with a
    // transform on it" is that this number is under one.
    expect(PULL_RESISTANCE).toBeLessThan(1);
    expect(pullDistance(40)).toBe(Math.round(40 * PULL_RESISTANCE));
    expect(pullDistance(40)).toBeLessThan(40);
  });

  it('never passes the limit, however hard it is pulled', () => {
    for (const dy of [200, 500, 2000, 100_000]) {
      expect(pullDistance(dy)).toBeLessThanOrEqual(PULL_LIMIT);
    }
  });

  it('tapers rather than stopping dead', () => {
    // Two hard pulls of different strengths must still be different distances:
    // a surface that hits a wall reads as broken rather than as resistant.
    expect(pullDistance(300)).toBeGreaterThan(pullDistance(200));
    expect(pullDistance(200)).toBeGreaterThan(pullDistance(150));
  });

  it('is monotonic — pulling further never moves the surface back', () => {
    let previous = 0;
    for (let dy = 0; dy <= 400; dy += 7) {
      const distance = pullDistance(dy);
      expect(distance).toBeGreaterThanOrEqual(previous);
      previous = distance;
    }
  });
});

describe('when letting go refreshes', () => {
  it('fires at the trigger and not before it', () => {
    expect(pullReleases(PULL_TRIGGER)).toBe(true);
    expect(pullReleases(PULL_TRIGGER - 1)).toBe(false);
    expect(pullReleases(0)).toBe(false);
  });

  /**
   * A flick is not a refresh.
   *
   * The back gesture completes on distance *or* velocity, because a fast swipe
   * from the edge is unambiguous. This one deliberately does not: the same
   * quick downward flick is how a reader gets back to the top of a long list,
   * and reloading the screen underneath them would be the app inventing an
   * intention out of a scroll.
   */
  it('takes no interest in how fast the finger was moving', () => {
    expect(pullReleases(PULL_TRIGGER - 1)).toBe(false);
    // The signature has nowhere to put a velocity, which is the point: one
    // required argument, the distance, and a threshold with a default.
    expect(pullReleases.length).toBe(1);
  });

  it('is reachable by an ordinary pull', () => {
    // Pulling a thumb's length down the screen must actually get there — a
    // trigger past the damped limit would be a gesture that can never fire.
    expect(PULL_TRIGGER).toBeLessThan(PULL_LIMIT);
    expect(pullReleases(pullDistance(180))).toBe(true);
  });
});

/**
 * Which gestures are allowed to become a pull at all.
 *
 * This is the arithmetic behind the defect Alex reported: a drag meant to
 * reorder a queued player was also pulling the board down and reloading it on
 * release. The component half of that fix is the grip declaring the drag its
 * own; this is the half that stops the gesture being claimed by every *other*
 * near-vertical movement on a phone.
 *
 * The rule the old code had was "eight pixels of movement, any of it downwards",
 * which is true of a diagonal scroll, of a swipe across the filter chips, and of
 * the first moments of a reorder. What replaces it is the rule the back-swipe
 * has always used, measured on the other axis.
 */
describe('what counts as a deliberate pull', () => {
  it('says nothing until the finger has actually moved', () => {
    expect(pullDecision(0, 0)).toBe('wait');
    expect(pullDecision(3, 3)).toBe('wait');
    expect(pullDecision(0, ENGAGE_DISTANCE - 1)).toBe('wait');
  });

  it('takes a straight pull down', () => {
    expect(pullDecision(0, ENGAGE_DISTANCE)).toBe('pull');
    expect(pullDecision(0, 200)).toBe('pull');
    // A little sideways drift is a thumb, not an intention to swipe.
    expect(pullDecision(4, 60)).toBe('pull');
  });

  /**
   * An upward drag is a scroll and always was.
   *
   * Judged once it has moved far enough to be judged — a single pixel up is
   * `wait` rather than `scroll`, which is the same answer the back-swipe gives
   * and the right one: nothing has happened yet.
   */
  it('never takes an upward one', () => {
    expect(pullDecision(0, -1)).toBe('wait');
    for (const dy of [-ENGAGE_DISTANCE, -20, -400]) expect(pullDecision(0, dy)).toBe('scroll');
    expect(pullDecision(40, -40)).toBe('scroll');
  });

  /**
   * The case that made the board move under a sideways swipe.
   *
   * A hundred and eighty pixels across with eleven of drift down used to arm
   * the refresh, because eleven is more than eight and eleven is downwards.
   * Measured against the horizontal it is obviously a swipe.
   */
  it('refuses a gesture that is mostly sideways', () => {
    expect(pullDecision(180, 11)).toBe('scroll');
    expect(pullDecision(-180, 11)).toBe('scroll');
    expect(pullDecision(40, 20)).toBe('scroll');
  });

  it('asks for the same margin the back-swipe asks of its own axis', () => {
    const dy = 40;
    // Just inside the ratio is a pull; just outside it is not.
    expect(pullDecision(Math.floor(dy / DIRECTION_RATIO) - 1, dy)).toBe('pull');
    expect(pullDecision(Math.ceil(dy / DIRECTION_RATIO) + 1, dy)).toBe('scroll');
  });

  /**
   * The two decisions cannot both be yes.
   *
   * A back-swipe and a pull are the same event stream read on two axes, and a
   * movement that satisfied both would be a gesture the app has two answers
   * for. The ratio is above one on both sides, so the wedge where each says yes
   * cannot overlap — asserted over the whole grid rather than argued about.
   */
  it('never agrees with the back-swipe about the same movement', () => {
    for (let dx = -120; dx <= 120; dx += 3) {
      for (let dy = -120; dy <= 120; dy += 3) {
        const both = pullDecision(dx, dy) === 'pull' && engageDecision(dx, dy) === 'swipe';
        expect(both, `(${dx}, ${dy}) is both a pull and a back-swipe`).toBe(false);
      }
    }
  });
});

describe('what the indicator is saying', () => {
  it('is idle until the finger moves', () => {
    expect(pullState(0, false)).toBe('idle');
  });

  it('is pulling below the trigger and armed at it', () => {
    expect(pullState(1, false)).toBe('pulling');
    expect(pullState(PULL_TRIGGER - 1, false)).toBe('pulling');
    expect(pullState(PULL_TRIGGER, false)).toBe('armed');
  });

  /** A running refresh outranks everything the finger is doing. */
  it('reports refreshing whatever the distance', () => {
    expect(pullState(0, true)).toBe('refreshing');
    expect(pullState(PULL_TRIGGER, true)).toBe('refreshing');
    expect(pullState(PULL_LIMIT, true)).toBe('refreshing');
  });
});
