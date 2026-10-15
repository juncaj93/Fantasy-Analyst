/**
 * Swipe a sheet down to dismiss it. One implementation, used by every sheet.
 *
 * **Ported from Hungry** (`juncaj93/Hungry`, `src/ui/sheet.js`), whose sheet
 * the owner describes as working "damn near perfectly" on his iPhone. The
 * approach and the numbers are Hungry's; the visuals are this app's.
 *
 * The approach, which replaced a sheet whose dismissal was a native scroll of a
 * screen-tall invisible layer:
 *
 *  - **Raw touch events, with one non-passive `touchmove`.** The card follows
 *    the finger 1:1 by `transform`, counted from where the finger first
 *    touched, written once per frame and never through React. `preventDefault`
 *    is called only once this drag has been claimed, which is what keeps it
 *    from costing anyone their scroll.
 *  - **Where a drag may start.** The grip and the header always. The body only
 *    when everything between the finger and the card is scrolled to its top
 *    and the first clear movement is downward. A body scrolled off its top
 *    hands over once the finger has brought it back to the top, if the browser
 *    still lets the page have the touch; anything else is the browser's.
 *  - **Decided when the hand lifts**, from where the finger is and how fast it
 *    was going, with no timers and no waiting for momentum.
 *
 * The arithmetic is separated from the DOM so it can be tested without a
 * browser.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { ownsItsOwnDrag, velocityOver, type Sample } from './gestures.ts';

/* ------------------------------------------------------------- thresholds */

/** Movement before a touch is asked what it is. Hungry: 4px. */
export const INTENT_SLOP = 4;

/** Release past this share of the card's height dismisses it. Hungry: 0.28. */
export const DISMISS_FRACTION = 0.28;

/** …or past this many pixels, whichever is less, so a tall card is not a trek. Hungry: 140. */
export const DISMISS_MAX = 140;

/** Finger travel that clears the dim layer completely. Hungry: 400. */
export const SCRIM_SPAN = 400;

/**
 * A release this fast, in px/ms downward, dismisses short of the distance line.
 *
 * Not in Hungry, which decides on distance alone; added for the flick the
 * brief asks for. Measured readings kept in `gestures.ts` put an unhurried pull
 * at 0.30 and a brisk one at 1.06, so 0.5 catches a flick and lets a careful
 * drag be careful.
 */
export const FLICK_VELOCITY = 0.5;

/** …but only once the card has really moved, so a fast nudge stays a nudge. */
export const FLICK_MIN = 16;

/** The most an upward drag can lift the card above where it rests. */
export const LIFT_MAX = 6;

/** How long the card takes to leave, from wherever it is. Hungry: 240ms. */
export const CLOSE_MS = 240;

/** How long it takes to come back when the push was not enough. */
export const SPRING_MS = 240;

/**
 * How much recent movement a flick is judged on, in ms.
 *
 * Short, so a slow drag that ends with a pause reads as still at the lift.
 */
export const FLICK_WINDOW = 100;

/* ---------------------------------------------------------------- the math */

/** How far the finger has to bring the card down before letting go dismisses it. */
export function dismissDistance(sheetHeight: number): number {
  return Math.min(DISMISS_MAX, Math.max(0, sheetHeight) * DISMISS_FRACTION);
}

/**
 * Where the card is drawn, in px below its resting place, for this much finger.
 *
 * Downward: 1:1, all the way. Hungry damps past 160px, and on a phone that read
 * as the card sliding away from a slow finger: measured, a 260px drag left the
 * card 66px behind. Upward: a rubber band that approaches {@link LIFT_MAX} and
 * never reaches it, so the card can say "this is as high as I go" without ever
 * leaving the bottom edge.
 */
export function sheetOffset(dy: number): number {
  if (dy >= 0) return dy;
  const up = -dy;
  return -(LIFT_MAX * up) / (up + LIFT_MAX * 4);
}

/**
 * Whether letting go here closes the card.
 *
 * `travel` is how far the finger brought it down; `velocity` is how fast the
 * finger was going at the lift, in px/ms, positive downward.
 *
 * A clear upward flick keeps the card even past the line, the way iOS lets a
 * reader throw a card back up after deciding against closing it.
 */
export function shouldDismiss(travel: number, velocity: number, sheetHeight: number): boolean {
  if (velocity <= -FLICK_VELOCITY) return false;
  if (travel >= dismissDistance(sheetHeight)) return true;
  return travel >= FLICK_MIN && velocity >= FLICK_VELOCITY;
}

/** How dark the dim layer is with the card this far down. 1 is fully dim. */
export function scrimOpacity(offset: number, sheetHeight: number): number {
  const span = Math.max(1, Math.min(SCRIM_SPAN, sheetHeight));
  return Math.max(0, Math.min(1, 1 - Math.max(0, offset) / span));
}

/** Where on the card a touch landed. */
export type DragZone = 'handle' | 'body';

/**
 * What a movement is, so far.
 *
 * `wait` under the slop. `release` hands the gesture to the browser for good:
 * mostly sideways (a carousel, a slider), or on the body when the content is
 * not at its top or the finger went up (both are a scroll). `drag` is ours.
 */
export function dragDecision(
  dx: number,
  dy: number,
  zone: DragZone,
  atTop: boolean,
): 'wait' | 'drag' | 'release' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < INTENT_SLOP && ay < INTENT_SLOP) return 'wait';
  if (ax > ay) return 'release';
  if (zone === 'handle') return 'drag';
  if (!atTop || dy < 0) return 'release';
  return 'drag';
}

/* -------------------------------------------------------------------- DOM */

/** Put on the grip and the header: a drag there always moves the card. */
export const HANDLE_ATTRIBUTE = 'data-sheet-handle';

/** Whether anything between the finger and the card is scrolled off its top. */
function scrolledAbove(target: Element | null, card: HTMLElement): boolean {
  for (let node = target; node && node !== card; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
  }
  return false;
}

/** Where the card is drawn right now, mid-animation included. */
function drawnOffset(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/^matrix(3d)?\((.+)\)$/);
  if (!m) return 0;
  const parts = m[2]!.split(',').map(Number);
  const y = m[1] ? parts[13] : parts[5];
  return Number.isFinite(y) ? y! : 0;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Drag {
  startX: number;
  startY: number;
  zone: DragZone;
  atTop: boolean;
  /**
   * A body drag that began as a scroll, waiting for the content to reach its
   * top so the card can take over from wherever the finger is then.
   */
  awaitingTop: boolean;
  /** Where the card was drawn when the drag engaged, so a springing card can be caught. */
  base: number;
  engaged: boolean;
  /** Finger travel counted from `startY`. */
  dy: number;
  /** Where the finger last was, for the reading taken at the lift. */
  lastY: number;
  /** The card's height, read once at the touch so a move never forces a layout. */
  height: number;
  samples: Sample[];
}

const SAMPLE_LIMIT = 12;

/**
 * Attach the gesture to a sheet.
 *
 * `onClosed` runs once the card has left the screen; the caller unmounts it
 * there. `dismiss` is the same exit for Done, a tap outside and Escape, so a
 * card leaves the same way however it was asked to.
 */
export function useSheetDrag({
  card,
  scrim,
  onClosed,
}: {
  card: RefObject<HTMLElement | null>;
  scrim: RefObject<HTMLElement | null>;
  onClosed: () => void;
}): { dismiss: () => void } {
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const closing = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  /** Send the card off the bottom from wherever it is drawn, and fade the dim with it. */
  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const el = card.current;
    const back = scrim.current;
    if (!el || prefersReducedMotion()) {
      closedRef.current();
      return;
    }
    const from = drawnOffset(el);
    el.classList.add('sheet-held', 'sheet-moving');
    el.style.transition = 'none';
    el.style.transform = `translate3d(0, ${from}px, 0)`;
    // Commit the starting point, so the transition runs from here and not from rest.
    void el.offsetHeight;
    const ease = `${CLOSE_MS}ms var(--ease-sheet-out)`;
    el.style.transition = `transform ${ease}`;
    el.style.transform = 'translate3d(0, 100%, 0)';
    if (back) {
      back.style.transition = `opacity ${ease}`;
      back.style.opacity = '0';
    }
    // A timer, not `transitionend`: the card unmounts on time whatever the
    // browser does with the transition.
    timer.current = window.setTimeout(() => closedRef.current(), CLOSE_MS);
  }, [card, scrim]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const el = card.current;
    if (!el) return;
    let drag: Drag | null = null;
    /** The offset waiting for the next frame, and the frame that will draw it. */
    let pending: number | null = null;
    let frame = 0;
    let settle: number | undefined;

    /** The card and the dim, from one number. Only ever called in a frame. */
    const draw = (offset: number, height: number) => {
      el.style.transform = `translate3d(0, ${offset}px, 0)`;
      const back = scrim.current;
      if (back) back.style.opacity = String(scrimOpacity(offset, height));
    };

    const flush = () => {
      frame = 0;
      if (pending == null || !drag?.engaged) return;
      draw(pending, drag.height);
      pending = null;
    };

    /** Drop a frame still waiting to draw, so nothing paints over the release. */
    const cancelFrame = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
    };

    /** Clear what the spring left behind once it has finished, unless a new drag caught it. */
    const settled = () => {
      if (closing.current || drag?.engaged) return;
      el.classList.remove('sheet-moving');
      el.style.transition = '';
      el.style.transform = '';
      const back = scrim.current;
      if (back) {
        back.style.transition = '';
        back.style.opacity = '';
      }
    };

    const springBack = () => {
      const back = scrim.current;
      if (prefersReducedMotion()) {
        settled();
        return;
      }
      const ease = `${SPRING_MS}ms var(--ease-sheet-back)`;
      el.style.transition = `transform ${ease}`;
      el.style.transform = 'translate3d(0, 0, 0)';
      if (back) {
        back.style.transition = `opacity ${ease}`;
        back.style.opacity = '1';
      }
      // A timer rather than `transitionend`, which never fires for a card let
      // go exactly where it rests.
      settle = window.setTimeout(settled, SPRING_MS + 20);
    };

    /** Take the drag: no transition while a finger is down, and the card caught where it is. */
    const engage = (state: Drag) => {
      state.engaged = true;
      state.base = drawnOffset(el);
      window.clearTimeout(settle);
      el.classList.add('sheet-held', 'sheet-moving');
      el.style.transition = 'none';
      const back = scrim.current;
      if (back) back.style.transition = 'none';
    };

    const onStart = (e: TouchEvent) => {
      // A second finger mid-drag changes nothing; the last one off decides.
      if (drag?.engaged) return;
      drag = null;
      if (closing.current || e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      const target = e.target instanceof Element ? e.target : null;
      const zone: DragZone = target?.closest(`[${HANDLE_ATTRIBUTE}]`) ? 'handle' : 'body';
      if (zone === 'body' && target instanceof HTMLElement && ownsItsOwnDrag(target)) return;
      drag = {
        startX: touch.clientX,
        startY: touch.clientY,
        zone,
        atTop: !scrolledAbove(target, el),
        awaitingTop: false,
        base: 0,
        engaged: false,
        dy: 0,
        lastY: touch.clientY,
        height: el.getBoundingClientRect().height || 1,
        samples: [],
      };
    };

    const onMove = (e: TouchEvent) => {
      const state = drag;
      if (!state || closing.current) return;
      const touch = e.touches[0];
      if (!touch) return;
      if (state.awaitingTop) {
        // The content is still the finger's to scroll until it is at its top.
        const target = e.target instanceof Element ? e.target : null;
        if (touch.clientY <= state.lastY || scrolledAbove(target, el)) {
          state.lastY = touch.clientY;
          return;
        }
        // At the top and still moving down. Only if the browser still lets the
        // page have this touch: once it is scrolling natively it will not stop,
        // and two things moving the card at once is the bounce.
        if (!e.cancelable) {
          drag = null;
          return;
        }
        state.awaitingTop = false;
        state.startY = touch.clientY;
        engage(state);
      } else if (!state.engaged) {
        const dx = touch.clientX - state.startX;
        const dy = touch.clientY - state.startY;
        const decision = dragDecision(dx, dy, state.zone, state.atTop);
        if (decision === 'wait') return;
        if (decision === 'release') {
          // A downward scroll of content off its top may yet reach the top.
          if (state.zone === 'body' && !state.atTop && dy > 0 && Math.abs(dy) >= Math.abs(dx)) {
            state.awaitingTop = true;
            state.lastY = touch.clientY;
            return;
          }
          drag = null;
          return;
        }
        engage(state);
      }
      if (e.cancelable) e.preventDefault();
      state.dy = touch.clientY - state.startY;
      state.lastY = touch.clientY;
      state.samples.push({ x: touch.clientY, t: performance.now() });
      if (state.samples.length > SAMPLE_LIMIT) state.samples.shift();
      // Counted from where the finger first touched, so the card never trails
      // it by the slop. Drawn in the next frame, once, however many moves land.
      pending = sheetOffset(state.base + state.dy);
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const onEnd = (e: TouchEvent) => {
      const state = drag;
      if (!state || e.touches.length > 0) return;
      drag = null;
      if (!state.engaged || closing.current) return;
      cancelFrame();
      const travel = state.base + state.dy;
      // The finger at the lift, so a drag that paused before letting go reads as still.
      state.samples.push({ x: state.lastY, t: performance.now() });
      const velocity = velocityOver(state.samples, FLICK_WINDOW);
      if (e.type !== 'touchcancel' && shouldDismiss(travel, velocity, state.height)) dismiss();
      else springBack();
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      window.clearTimeout(settle);
      cancelFrame();
    };
  }, [card, scrim, dismiss]);

  return { dismiss };
}
