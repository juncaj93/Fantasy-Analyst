/**
 * What a layer covering the app owes it, and the two pieces of that which can
 * be settled without a browser.
 *
 * Both were real bugs rather than hypotheticals:
 *
 *  - two layers each saved and restored the body's own style, so closing them
 *    out of order restored a *locked* page and left the app unscrollable with
 *    nothing on screen to blame;
 *  - the sheet claimed `aria-modal` and then let Tab walk straight out of it
 *    into a list the reader could not see.
 *
 * The counting and the wrap-around are the parts that are easy to get wrong and
 * impossible to see in a screenshot, so they are pure and they are tested here.
 * The rest of `useOverlay` — pinning the body, `inert`, focus restoration — is
 * DOM behaviour and belongs to the browser suite.
 */

import { describe, expect, it } from 'vitest';
import { counted, nextFocusIndex } from '../src/web/overlay.ts';

describe('a claim held by however many layers want it', () => {
  /** A claim that records what happened to it, in order. */
  const spy = () => {
    const log: string[] = [];
    const claim = counted(() => {
      log.push('apply');
      return () => log.push('undo');
    });
    return { log, claim };
  };

  it('applies once, however many layers ask', () => {
    const { log, claim } = spy();
    claim();
    claim();
    claim();
    expect(log).toEqual(['apply']);
  });

  it('undoes only when the last layer lets go', () => {
    const { log, claim } = spy();
    const first = claim();
    const second = claim();
    first();
    expect(log, 'the page was released while a layer was still up').toEqual(['apply']);
    second();
    expect(log).toEqual(['apply', 'undo']);
  });

  it('does not care what order they are given up in', () => {
    // The reported failure: the draft board closed while a sheet over it was
    // still open, and the sheet's own restore then put the *locked* page back.
    const { log, claim } = spy();
    const board = claim();
    const sheet = claim();
    board();
    sheet();
    expect(log).toEqual(['apply', 'undo']);
  });

  it('ignores a release that has already been made', () => {
    // StrictMode invokes a cleanup twice. A second release that decremented
    // again would unlock a page another layer is still using.
    const { log, claim } = spy();
    const first = claim();
    const second = claim();
    first();
    first();
    expect(log).toEqual(['apply']);
    second();
    expect(log).toEqual(['apply', 'undo']);
  });

  it('applies again after a full release, rather than staying spent', () => {
    const { log, claim } = spy();
    claim()();
    claim()();
    expect(log).toEqual(['apply', 'undo', 'apply', 'undo']);
  });
});

describe('where Tab goes inside a dialog', () => {
  it('leaves the browser alone in the middle of the run', () => {
    expect(nextFocusIndex(4, 1, false)).toBeNull();
    expect(nextFocusIndex(4, 2, true)).toBeNull();
  });

  it('wraps forwards off the end and backwards off the start', () => {
    expect(nextFocusIndex(4, 3, false)).toBe(0);
    expect(nextFocusIndex(4, 0, true)).toBe(3);
  });

  it('pulls escaped focus back to the end the reader was heading for', () => {
    // -1 is focus on the dialog itself, or on something that has since gone.
    expect(nextFocusIndex(4, -1, false)).toBe(0);
    expect(nextFocusIndex(4, -1, true)).toBe(3);
  });

  it('has nowhere to send Tab in a dialog with no controls', () => {
    expect(nextFocusIndex(0, -1, false)).toBeNull();
    expect(nextFocusIndex(0, 0, true)).toBeNull();
  });

  it('keeps a single control focused rather than cycling off it', () => {
    // One stop: forwards off the end and backwards off the start are the same
    // place, and that place is where focus already is.
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });
});
