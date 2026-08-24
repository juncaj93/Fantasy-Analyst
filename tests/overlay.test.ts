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
 *  - and the page behind an open sheet had no way to know it was covered, so
 *    the screen's own pull-to-refresh kept competing for the reader's dismissal
 *    gesture — see `usePullToRefresh`, rule 6.
 *
 * The counting, the wrap-around and the modal-open signal are the parts that are
 * easy to get wrong and impossible to see in a screenshot, so they are pure and
 * they are tested here. The rest of `useOverlay` — pinning the body, `inert`,
 * focus restoration — is DOM behaviour and belongs to the browser suite.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { appIsCovered, claimCovered, counted, nextFocusIndex, watchCovered } from '../src/web/overlay.ts';

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

describe('the signal that says the app is covered', () => {
  /* Module state is shared across this file, so every test leaves it empty. */
  const held: Array<() => void> = [];
  const open = () => {
    const release = claimCovered();
    held.push(release);
    return release;
  };
  afterEach(() => {
    while (held.length > 0) held.pop()!();
  });

  it('is quiet until something covers the app', () => {
    expect(appIsCovered()).toBe(false);
  });

  it('is raised by a layer and lowered when it goes', () => {
    const sheet = open();
    expect(appIsCovered()).toBe(true);
    sheet();
    expect(appIsCovered()).toBe(false);
  });

  it('stays raised while a second layer is still up', () => {
    // The odds sheet opens a player's card; the draft board can have a sheet
    // over it. Closing the inner one does not uncover the page.
    const board = open();
    const sheet = open();
    sheet();
    expect(appIsCovered(), 'the page was uncovered with a layer still on it').toBe(true);
    board();
    expect(appIsCovered()).toBe(false);
  });

  it('does not care what order the layers are given up in', () => {
    const board = open();
    const sheet = open();
    board();
    expect(appIsCovered()).toBe(true);
    sheet();
    expect(appIsCovered()).toBe(false);
  });

  it('cannot be left stuck on by a cleanup that runs twice', () => {
    // StrictMode invokes a cleanup twice, and a pull-to-refresh that never came
    // back would be a worse defect than the one this signal exists to fix.
    const first = open();
    const second = open();
    first();
    first();
    expect(appIsCovered()).toBe(true);
    second();
    expect(appIsCovered()).toBe(false);
  });

  it('tells its watchers when the answer changes, and only then', () => {
    let told = 0;
    const stop = watchCovered(() => {
      told += 1;
    });
    const board = open();
    expect(told).toBe(1);
    const sheet = open();
    expect(told, 'a second layer changed nothing for the page underneath').toBe(1);
    sheet();
    expect(told).toBe(1);
    board();
    expect(told).toBe(2);
    stop();
    open()();
    expect(told, 'a watcher that had stopped was still being told').toBe(2);
  });

  it('survives a watcher that stops listening as it is told', () => {
    // Which is what a component unmounting in response to this does.
    const seen: string[] = [];
    const stop = watchCovered(() => {
      seen.push('first');
      stop();
    });
    const alsoStop = watchCovered(() => seen.push('second'));
    open()();
    alsoStop();
    expect(seen).toContain('second');
  });
});
