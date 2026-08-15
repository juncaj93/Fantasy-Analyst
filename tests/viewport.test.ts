/**
 * When the floating toolbar should get out of the way.
 *
 * The rule is one subtraction and one threshold, and both are worth pinning
 * down here rather than in a browser: the failure mode is not "it looks wrong",
 * it is "the bar flickers away every time Safari's URL field collapses", and
 * that is a question about a number.
 */

import { describe, expect, it } from 'vitest';
import { KEYBOARD_OCCLUSION, keyboardIsOpen, occludedHeight } from '../src/web/viewport.ts';

describe('how much of the page is hidden', () => {
  it('is nothing when the visual viewport fills the layout one', () => {
    expect(occludedHeight(844, { height: 844, offsetTop: 0 })).toBe(0);
  });

  it('is the keyboard when the visual viewport shrinks', () => {
    expect(occludedHeight(844, { height: 508, offsetTop: 0 })).toBe(336);
  });

  /*
   * A visual viewport that is not anchored at the top — a pinch-zoomed page,
   * or one scrolled within the visual viewport — is an offset and not an
   * occlusion. Subtracting only the height would report several hundred pixels
   * of "keyboard" for a user who had merely zoomed in.
   */
  it('counts an offset viewport as offset, not as keyboard', () => {
    expect(occludedHeight(844, { height: 400, offsetTop: 444 })).toBe(0);
  });

  it('never goes negative', () => {
    expect(occludedHeight(844, { height: 900, offsetTop: 0 })).toBe(0);
  });

  it('answers zero where there is no visual viewport to ask', () => {
    expect(occludedHeight(844, null)).toBe(0);
  });
});

describe('is that a keyboard', () => {
  it('says no to a browser that never reports one', () => {
    expect(keyboardIsOpen(844, null)).toBe(false);
  });

  /*
   * The case this threshold exists for. Safari's chrome collapsing and
   * expanding moves the two viewports relative to each other by a few tens of
   * pixels on every scroll; a bar that hid for that would be worse than one
   * that never moved.
   */
  it('says no to browser chrome coming and going', () => {
    expect(keyboardIsOpen(844, { height: 844 - 60, offsetTop: 0 })).toBe(false);
    expect(keyboardIsOpen(844, { height: 844 - (KEYBOARD_OCCLUSION - 1), offsetTop: 0 })).toBe(false);
  });

  it('says yes to something the size of an iPhone keyboard', () => {
    expect(keyboardIsOpen(844, { height: 844 - 336, offsetTop: 0 })).toBe(true);
    expect(keyboardIsOpen(844, { height: 844 - KEYBOARD_OCCLUSION, offsetTop: 0 })).toBe(true);
  });

  /* The threshold has to sit above browser chrome and below any real keyboard. */
  it('is set between the two things it has to tell apart', () => {
    expect(KEYBOARD_OCCLUSION).toBeGreaterThan(100);
    expect(KEYBOARD_OCCLUSION).toBeLessThan(250);
  });
});
