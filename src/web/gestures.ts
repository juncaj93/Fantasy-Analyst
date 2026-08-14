/**
 * Native-feeling navigation gestures, and the rules that keep them out of the
 * browser's way.
 *
 * Three things are being balanced here, in this order:
 *
 *  1. **The browser wins.** In a normal Safari tab the left screen edge is
 *     Safari's own back gesture. An app that fights it produces two conflicting
 *     navigations from one swipe, which is worse than having no gesture at all.
 *     So the interactive edge-swipe is enabled only when the app is running as
 *     a Home Screen app, where Safari's chrome — and its edge gesture — are not
 *     part of the window. In a tab the browser's own gesture is left alone and
 *     the Back control is the answer. See docs/IOS_WEB_APP.md.
 *
 *  2. **Scrolling wins.** Every decision below defaults to "this was a scroll".
 *     A gesture starts only in a narrow strip at the leading edge, only once
 *     horizontal movement clearly beats vertical, and it is abandoned the
 *     moment the browser reports the pointer as cancelled — which is what it
 *     does when it decides the same movement was a scroll. `touch-action:
 *     pan-y` on the layer is what makes that arbitration the browser's rather
 *     than ours: no `preventDefault` is called on any touch region anywhere.
 *
 *  3. **Back is navigation, never undo.** The gesture calls exactly the same
 *     function the Back control calls. It cannot reach a draft pick, a My Guy
 *     level, a filter or anything else that is stored — leaving a detail screen
 *     is the whole of what it does.
 *
 * The arithmetic is separated from the DOM on purpose: the thresholds are the
 * part worth testing, and they can be tested without a browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { isStandalone, watchStandalone } from './standalone.ts';

/* ------------------------------------------------------------- thresholds */

/** How wide the leading-edge strip that can start a back gesture is. */
export const EDGE_ZONE = 28;

/** Movement before the direction question is even asked. */
export const ENGAGE_DISTANCE = 8;

/** How much horizontal has to beat vertical before this counts as a swipe. */
export const DIRECTION_RATIO = 1.4;

/** How far across the screen a swipe must reach to navigate on distance alone. */
export const COMPLETE_FRACTION = 0.32;

/** …or how fast it must be travelling, in px/ms, to navigate on a flick. */
export const COMPLETE_VELOCITY = 0.45;

/** The same two questions for a sheet, measured downwards. */
export const SHEET_DISMISS_FRACTION = 0.28;
export const SHEET_DISMISS_VELOCITY = 0.5;

/** Whether a touch began close enough to the leading edge to mean "back". */
export function startsAtEdge(clientX: number, zone: number = EDGE_ZONE): boolean {
  return clientX >= 0 && clientX <= zone;
}

/**
 * What this movement is, so far.
 *
 * `wait` is the honest answer for anything under the engage distance: a few
 * pixels in any direction is a thumb resting, not an intention. Beyond it the
 * horizontal component has to be clearly larger than the vertical one, which is
 * the rule that makes a diagonal scroll scroll.
 */
export function engageDecision(dx: number, dy: number): 'wait' | 'swipe' | 'scroll' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < ENGAGE_DISTANCE && ay < ENGAGE_DISTANCE) return 'wait';
  if (dx > 0 && ax > ay * DIRECTION_RATIO) return 'swipe';
  return 'scroll';
}

/** Far enough, or fast enough, to complete the navigation. */
export function completesBack(distance: number, width: number, velocity: number): boolean {
  if (width <= 0) return false;
  if (distance >= width * COMPLETE_FRACTION) return true;
  return velocity >= COMPLETE_VELOCITY && distance > ENGAGE_DISTANCE * 2;
}

/** The same judgement for a sheet being pulled down. */
export function sheetDismisses(distance: number, height: number, velocity: number): boolean {
  if (height <= 0) return false;
  if (distance >= height * SHEET_DISMISS_FRACTION) return true;
  return velocity >= SHEET_DISMISS_VELOCITY && distance > ENGAGE_DISTANCE * 2;
}

/** How dark the screen behind a half-completed push should be. */
export function dimOpacity(distance: number, width: number, max = 0.18): number {
  if (width <= 0) return 0;
  const travelled = Math.min(1, Math.max(0, distance / width));
  return Math.round((1 - travelled) * max * 1000) / 1000;
}

/* ------------------------------------------------------------------ hooks */

/** Whether the app is running as a Home Screen app right now. */
export function useStandaloneMode(): boolean {
  const [standalone, setStandalone] = useState(() => isStandalone(window));
  useEffect(() => watchStandalone(window, () => setStandalone(isStandalone(window))), []);
  return standalone;
}

/** Whether the reader has asked for less movement. Live, not read once. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

interface Sample {
  x: number;
  t: number;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  engaged: boolean;
  last: Sample;
  previous: Sample;
}

export interface EdgeSwipeBack {
  /** Put on the element that represents the pushed screen. */
  layerRef: (node: HTMLElement | null) => void;
  /** Put on the fixed element that dims whatever is underneath. */
  dimRef: (node: HTMLElement | null) => void;
  /** Spread onto the pushed screen's root element. */
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
    onClickCapture: (e: ReactMouseEvent) => void;
  };
  /** True while a finger is actually moving the screen. */
  dragging: boolean;
}

/**
 * Interactive swipe-from-the-edge to go back.
 *
 * `onBack` is the screen's existing Back action and nothing else — the gesture
 * has no navigation model of its own, which is what guarantees a swipe and a
 * tap on Back cannot ever disagree about where they lead.
 */
export function useEdgeSwipeBack({
  enabled,
  onBack,
}: {
  enabled: boolean;
  onBack: () => void;
}): EdgeSwipeBack {
  const layer = useRef<HTMLElement | null>(null);
  const dim = useRef<HTMLElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const moved = useRef(false);
  const [dragging, setDragging] = useState(false);
  const reduced = useReducedMotion();

  const paint = useCallback((distance: number) => {
    const el = layer.current;
    if (!el) return;
    el.style.transform = distance > 0 ? `translate3d(${distance}px, 0, 0)` : '';
    if (dim.current) {
      dim.current.style.opacity = String(dimOpacity(distance, el.getBoundingClientRect().width || 1));
    }
  }, []);

  /** Put everything back where it was, whether it navigated or not. */
  const reset = useCallback(() => {
    const el = layer.current;
    drag.current = null;
    setDragging(false);
    if (!el) return;
    el.classList.remove('push-layer-dragging');
    el.style.transform = '';
    if (dim.current) dim.current.style.opacity = '';
  }, []);

  useEffect(() => () => reset(), [reset]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!enabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!startsAtEdge(e.clientX)) return;
      const sample = { x: e.clientX, t: e.timeStamp };
      drag.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        engaged: false,
        last: sample,
        previous: sample,
      };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const state = drag.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (!state.engaged) {
        const decision = engageDecision(dx, dy);
        if (decision === 'scroll') {
          drag.current = null;
          return;
        }
        if (decision === 'wait') return;
        state.engaged = true;
        moved.current = true;
        setDragging(true);
        layer.current?.classList.add('push-layer-dragging');
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* capture is an optimisation; the gesture works without it */
        }
      }

      state.previous = state.last;
      state.last = { x: e.clientX, t: e.timeStamp };
      paint(Math.max(0, dx));
    },
    [paint],
  );

  const finish = useCallback(
    (e: ReactPointerEvent, cancelled: boolean) => {
      const state = drag.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const el = layer.current;
      if (!state.engaged || !el) {
        reset();
        return;
      }

      const distance = Math.max(0, e.clientX - state.startX);
      const elapsed = Math.max(1, state.last.t - state.previous.t);
      const velocity = (state.last.x - state.previous.x) / elapsed;
      const width = el.getBoundingClientRect().width || 1;

      if (!cancelled && completesBack(distance, width, velocity)) {
        if (reduced) {
          reset();
          onBack();
          return;
        }
        el.classList.remove('push-layer-dragging');
        el.classList.add('push-layer-settling');
        el.style.transform = `translate3d(${Math.round(width)}px, 0, 0)`;
        if (dim.current) dim.current.style.opacity = '0';
        const finishNavigation = () => {
          el.classList.remove('push-layer-settling');
          reset();
          onBack();
        };
        el.addEventListener('transitionend', finishNavigation, { once: true });
        // A transition that never fires (a hidden tab, a browser that skipped
        // it) must not strand the reader on a screen that has left the frame.
        window.setTimeout(() => {
          if (el.classList.contains('push-layer-settling')) finishNavigation();
        }, 400);
        drag.current = null;
        setDragging(false);
        return;
      }

      // Not far enough, or the browser took the gesture back: spring home.
      el.classList.remove('push-layer-dragging');
      el.classList.add('push-layer-settling');
      el.style.transform = '';
      if (dim.current) dim.current.style.opacity = '';
      window.setTimeout(() => el.classList.remove('push-layer-settling'), 300);
      drag.current = null;
      setDragging(false);
    },
    [onBack, reduced, reset],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent) => finish(e, false), [finish]);
  const onPointerCancel = useCallback((e: ReactPointerEvent) => finish(e, true), [finish]);

  /**
   * A drag must not also be a tap.
   *
   * Without this, letting go over a control at the end of a swipe activates it —
   * which on this app's detail screens could mean flipping a flag on the way
   * out. The gesture is navigation only, and this is the line that keeps it so.
   */
  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!moved.current) return;
    moved.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    layerRef: useCallback((node: HTMLElement | null) => {
      layer.current = node;
    }, []),
    dimRef: useCallback((node: HTMLElement | null) => {
      dim.current = node;
    }, []),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
    dragging,
  };
}

export interface SheetDrag {
  sheetRef: (node: HTMLElement | null) => void;
  bodyRef: (node: HTMLElement | null) => void;
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
  };
}

/**
 * Pull a sheet down to dismiss it.
 *
 * The one rule that makes this coexist with a scrolling sheet: a downward drag
 * belongs to the content until the content is at its top. Only then does the
 * sheet start to move, which is the behaviour every native sheet has and the
 * reason it never feels like a fight.
 */
export function useSheetDrag({ onDismiss }: { onDismiss: () => void }): SheetDrag {
  const sheet = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLElement | null>(null);
  const drag = useRef<{ pointerId: number; startY: number; engaged: boolean; last: Sample; previous: Sample } | null>(
    null,
  );
  const reduced = useReducedMotion();

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Scrolled content owns the gesture until it is back at the top.
    if ((body.current?.scrollTop ?? 0) > 0) return;
    const sample = { x: e.clientY, t: e.timeStamp };
    drag.current = { pointerId: e.pointerId, startY: e.clientY, engaged: false, last: sample, previous: sample };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const dy = e.clientY - state.startY;
    if (!state.engaged) {
      if (Math.abs(dy) < ENGAGE_DISTANCE) return;
      if (dy < 0 || (body.current?.scrollTop ?? 0) > 0) {
        drag.current = null;
        return;
      }
      state.engaged = true;
      sheet.current?.classList.add('sheet-dragging');
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* optional */
      }
    }
    state.previous = state.last;
    state.last = { x: e.clientY, t: e.timeStamp };
    if (sheet.current) sheet.current.style.transform = `translate3d(0, ${Math.max(0, dy)}px, 0)`;
  }, []);

  const finish = useCallback(
    (e: ReactPointerEvent, cancelled: boolean) => {
      const state = drag.current;
      const el = sheet.current;
      drag.current = null;
      if (!state || !el || !state.engaged) return;

      const distance = Math.max(0, e.clientY - state.startY);
      const elapsed = Math.max(1, state.last.t - state.previous.t);
      const velocity = (state.last.x - state.previous.x) / elapsed;
      const height = el.getBoundingClientRect().height || 1;

      el.classList.remove('sheet-dragging');
      if (!cancelled && sheetDismisses(distance, height, velocity)) {
        if (reduced) {
          el.style.transform = '';
          onDismiss();
          return;
        }
        el.classList.add('sheet-settling');
        el.style.transform = `translate3d(0, ${Math.round(height)}px, 0)`;
        const close = () => {
          el.classList.remove('sheet-settling');
          el.style.transform = '';
          onDismiss();
        };
        el.addEventListener('transitionend', close, { once: true });
        window.setTimeout(() => {
          if (el.classList.contains('sheet-settling')) close();
        }, 400);
        return;
      }

      el.classList.add('sheet-settling');
      el.style.transform = '';
      window.setTimeout(() => el.classList.remove('sheet-settling'), 300);
    },
    [onDismiss, reduced],
  );

  return {
    sheetRef: useCallback((node: HTMLElement | null) => {
      sheet.current = node;
    }, []),
    bodyRef: useCallback((node: HTMLElement | null) => {
      body.current = node;
    }, []),
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: useCallback((e: ReactPointerEvent) => finish(e, false), [finish]),
      onPointerCancel: useCallback((e: ReactPointerEvent) => finish(e, true), [finish]),
    },
  };
}
