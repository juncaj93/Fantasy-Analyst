/**
 * What every layer that covers the app has to get right, owned in one place.
 *
 * A sheet, the draft board and anything else that rises over the page are four
 * separate problems wearing one coat, and every one of them had been solved
 * again — slightly differently — at each call site:
 *
 *  1. **The page behind holds still.** Not `overflow: hidden` on the body,
 *     which iOS Safari has never honoured: the document there keeps scrolling
 *     under a "locked" page, which is the reason a drag on a sheet moved the
 *     list behind it instead of the sheet. Pinning the body and putting the
 *     offset back is the technique that actually works on the target browser.
 *
 *  2. **Locks nest.** Two layers can be open at once — the odds sheet opens a
 *     player's card; the draft board can have a sheet over it — and each one
 *     used to save and restore the body's style independently. Closing them out
 *     of order restored a *locked* page and left the app unscrollable with
 *     nothing on screen to blame. A single counter cannot get that wrong.
 *
 *  3. **Escape closes the top one, and only the top one.** Every layer listened
 *     on `document` for its own Escape, so one key closed the whole stack.
 *
 *  4. **Focus goes in, stays in, and comes back.** The known A-01 gap: the
 *     sheet announced itself as `aria-modal` and then left focus on the row
 *     behind it, let Tab walk out into a page the reader could not see, and
 *     dropped focus on the document when it closed. All three are fixed here,
 *     for every layer, rather than in each of the nine that need it.
 *
 * Nothing in this file knows what a layer contains. It knows only that
 * something is covering the app, and what that obliges the app to do.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

/* --------------------------------------------------------- the scroll lock */

/**
 * A claim on something global, held by however many layers want it.
 *
 * The shape of rule 2, on its own, so that it can be tested without a document:
 * `apply` runs when the first claim is made and its undo runs when the last one
 * is given up, whatever order they are given up in. A release is idempotent
 * — calling it twice must not release somebody else's claim, which is exactly
 * what a double-invoked cleanup would otherwise do.
 */
export function counted(apply: () => () => void): () => () => void {
  let held = 0;
  let undo: (() => void) | null = null;
  return () => {
    held += 1;
    if (held === 1) undo = apply();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      held -= 1;
      if (held === 0) {
        undo?.();
        undo = null;
      }
    };
  };
}

/**
 * Pin the document where it is, and hand back the undo.
 *
 * `position: fixed` with a negative `top`, rather than `overflow: hidden`. The
 * second is what this app had and what most of the web has; it works in
 * Chromium and does nothing whatsoever in iOS Safari, where the document
 * continues to scroll and rubber-band under a modal surface. Offsetting a
 * pinned body is the only technique both engines agree on.
 *
 * `overflow: hidden` is set as well — harmless where the pin already did the
 * work, and the honest declaration of intent for anything reading the style.
 */
/**
 * Where the reader was when the page was pinned, or `null` when it is not.
 *
 * The one thing a pinned page cannot be asked directly. `position: fixed` means
 * `window.scrollY` reports zero however far down the list the reader actually
 * is, and a screen that records "where to come back to" while a sheet is open
 * therefore records the top of the page — which is what it did, and why Back
 * from a player's page landed at the top of the list it was opened from.
 */
let pinnedAt: number | null = null;

/**
 * Where the reader is on the page, pinned or not.
 *
 * Anything that records a scroll offset to return to should ask this rather
 * than the window, because it may well be running inside a layer that has the
 * page held still. Everything else — a page that is definitely not covered —
 * gets the same answer either way.
 */
export function pageScrollTop(): number {
  return pinnedAt ?? window.scrollY;
}

function applyLock(): () => void {
  const body = document.body;
  const y = window.scrollY;
  const previous = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
  };

  pinnedAt = y;
  body.style.position = 'fixed';
  body.style.top = `${-y}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';
  body.style.overflow = 'hidden';

  return () => {
    pinnedAt = null;
    body.style.position = previous.position;
    body.style.top = previous.top;
    body.style.left = previous.left;
    body.style.right = previous.right;
    body.style.width = previous.width;
    body.style.overflow = previous.overflow;
    // Exactly where the reader was, rather than wherever un-pinning drops them.
    window.scrollTo(0, y);
  };
}

/**
 * Hold the page still until the returned function is called.
 *
 * Nested by construction: the second layer to ask does not re-lock, and the
 * first to let go does not unlock. The bug this replaced was two layers each
 * saving and restoring the body's own style, where closing them out of order
 * restored a *locked* page and left the app unscrollable with nothing on screen
 * to blame it on.
 */
export const lockPageScroll = counted(applyLock);

/* ------------------------------------------------------ the inert backdrop */

/**
 * Take the app out of the reading order while something modal is over it.
 *
 * `inert` is what removes it from tab order, from hit testing and from the
 * accessibility tree in one attribute; `aria-hidden` is the same claim for the
 * browsers that predate it. Both, because the app's target is iOS Safari and
 * the reader may be several versions behind.
 *
 * The layers themselves are portalled to `document.body`, so they are siblings
 * of `#root` rather than inside it — which is what makes this possible at all.
 */
function backgroundRoot(): HTMLElement | null {
  return document.getElementById('root');
}

/**
 * Counted separately from the scroll lock, because a non-modal layer holds the
 * page still without taking the page away.
 */
export const hideBackground = counted(() => {
  const root = backgroundRoot();
  root?.setAttribute('inert', '');
  root?.setAttribute('aria-hidden', 'true');
  return () => {
    // Re-read: the root cannot go away under a running app, but reading it
    // twice costs nothing and assuming it cannot is how a null gets thrown.
    const node = backgroundRoot();
    node?.removeAttribute('inert');
    node?.removeAttribute('aria-hidden');
  };
});

/* -------------------------------------------------------------- the stack */

/** The layers currently up, oldest first. Identity only — no contents. */
const stack: symbol[] = [];

/** Whether this layer is the one a key press belongs to. */
export function isTopLayer(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/**
 * How far above the page this layer sits, in z-index.
 *
 * Layers share one scale so a sheet opened *from* another layer lands above it
 * — including above the draft board, which is a full-screen layer with a much
 * higher base than a sheet's. The step is large enough that a layer's own
 * internal ordering (a backdrop under its surface) can never reach the next
 * one's.
 */
export const LAYER_STEP = 100;

/* --------------------------------------------------------------- focusable */

/**
 * What Tab can reach.
 *
 * Deliberately conservative: everything here is focusable in every engine, and
 * anything exotic that is missed simply keeps the focus it already had rather
 * than escaping the layer.
 */
const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable *and* actually on screen — a hidden control is not a stop. */
export function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('inert') || el.closest('[inert]') !== null) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // `offsetParent` is null for `display: none` — and for `position: fixed`,
    // which several of these controls are, hence the second question.
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

/**
 * Where Tab goes next, given where it is now.
 *
 * Pure, and separated from the DOM for the same reason the gesture thresholds
 * are: the wrap-around at each end is the part that is easy to get wrong and
 * impossible to see in a screenshot.
 *
 * Returns the index to move to, or `null` to leave the browser alone. Focus
 * that has escaped the layer entirely — which is what a background click or a
 * removed control leaves behind — is pulled back to whichever end the reader
 * was heading for.
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return null;
}

/* ------------------------------------------------------------------- hook */

export interface OverlayOptions {
  /** The element that owns focus and holds the trap. */
  container: RefObject<HTMLElement | null>;
  /** What Escape, and the layer's own controls, call. */
  onDismiss: () => void;
}

export interface Overlay {
  /**
   * This layer's lift above the base z-index of its kind, in pixels of stacking
   * order. Put on the layer and on its backdrop.
   */
  lift: number;
}

/**
 * Everything a covering layer owes the app, for as long as it is mounted.
 *
 * Deliberately one hook rather than four, because the four are ordered with
 * respect to each other and separate effects are not. Focus is captured before
 * the background goes inert — a control inside an `inert` subtree cannot be
 * focused, so an invoker recorded afterwards can never be returned to — and the
 * background is made reachable again before focus is handed back to it.
 *
 * **Every layer in this app is modal, and there is no option to say otherwise.**
 * Both of them — the sheet and the draft board — cover what they open over and
 * declare `aria-modal="true"`, and a reader who can Tab into a list they cannot
 * see has been lied to. A genuinely non-modal surface (a toast, a popover
 * anchored to a control, an inspector beside the thing it inspects) would want
 * the stack and the Escape and neither the trap nor the `inert`, and should say
 * so by asking for it here rather than by growing a flag nothing sets.
 */
export function useOverlay({ container, onDismiss }: OverlayOptions): Overlay {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const id = Symbol('overlay');
    stack.push(id);
    setLift((stack.length - 1) * LAYER_STEP);

    /* The control that opened this, remembered before anything can move focus. */
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const unlock = lockPageScroll();
    const reveal = hideBackground();

    /*
     * Focus enters the layer itself, not its first control.
     *
     * A dialog that focuses its first button is read out as that button; a
     * dialog that takes focus on its own container is read out as the dialog,
     * with its label, and the reader arrives knowing what has opened. The
     * container carries `tabindex="-1"` for exactly this — programmatically
     * focusable, never a Tab stop.
     */
    const node = container.current;
    node?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopLayer(id)) return;
      if (e.key === 'Escape') {
        dismiss.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const box = container.current;
      if (!box) return;
      const stops = focusableWithin(box);
      if (stops.length === 0) {
        // Nothing to move to, so nothing may move: keeping focus on the dialog
        // is the only answer that does not put it back on the hidden page.
        e.preventDefault();
        box.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      const current = active instanceof HTMLElement ? stops.indexOf(active) : -1;
      const next = nextFocusIndex(stops.length, current, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      stops[next]?.focus();
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      // Order matters: the page has to be reachable again before focus is
      // handed back to something on it.
      reveal();
      unlock();
      if (invoker && invoker.isConnected) invoker.focus({ preventScroll: true });
    };
    // Deliberately once per mount: everything above is a claim on the document
    // that belongs to this layer's whole lifetime, and re-running it would push
    // a second entry onto the stack for a layer that is already on it.
  }, [container]);

  return { lift };
}
