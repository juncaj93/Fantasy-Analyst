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
 *     The sheet drag stopped being the exception to that. It briefly held a
 *     non-passive `touchmove` listener so it could claim a downward drag on
 *     content sitting at its top, and the claim had to be made on the first
 *     move — before there was enough of the gesture to tell an upward scroll
 *     from a thumb landing. WebKit decides once, so guessing wrong cost the
 *     reader the whole swipe. It then tried to publish the same claim ahead of
 *     the finger, as `touch-action` on the body — and a card that has not
 *     finished arriving cannot say how tall it is going to be, so the claim was
 *     wrong for exactly as long as the reader was waiting for the card. A
 *     scrolling region now declares one thing for its whole life. See
 *     {@link useSheetDrag}.
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
import { pageScrollTop, useAppIsCovered } from './overlay.ts';
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

/* ------------------------------------------------------- pull to refresh */

/** How far the finger has to travel before the page reloads. */
export const PULL_TRIGGER = 68;

/** How far the surface is allowed to follow the finger, however hard it pulls. */
export const PULL_LIMIT = 96;

/**
 * How much of the finger's movement the surface actually takes.
 *
 * Under one, so the sheet of glass gets heavier the further it is pulled. This
 * is the whole difference between a control that feels attached to the finger
 * and one that feels like a `div` with a transform on it — iOS applies the same
 * damping to every scroll view in the system, and a reader who has never
 * thought about it will still notice its absence.
 */
export const PULL_RESISTANCE = 0.55;

/**
 * How far the surface has moved, given how far the finger has.
 *
 * Damped, and then asymptotic: the last stretch before {@link PULL_LIMIT} is
 * compressed rather than clipped, so a hard pull slows to a stop instead of
 * hitting a wall. Never negative — an upward drag is a scroll and belongs to
 * the page.
 */
export function pullDistance(dy: number, limit = PULL_LIMIT, resistance = PULL_RESISTANCE): number {
  if (dy <= 0) return 0;
  const damped = dy * resistance;
  if (damped <= limit * 0.6) return Math.round(damped);
  // Everything past 60% of the limit shares the remaining 40%, tapering out.
  const overshoot = damped - limit * 0.6;
  return Math.round(limit * 0.6 + (limit * 0.4 * overshoot) / (overshoot + limit * 0.4));
}

/** Whether letting go here refreshes. Distance only: a flick must not fire this. */
export function pullReleases(distance: number, trigger = PULL_TRIGGER): boolean {
  return distance >= trigger;
}

/**
 * What the indicator should be saying right now.
 *
 * Four states and no fifth: nothing is happening, the reader is pulling,
 * they have pulled far enough, or a refresh is running. The label lives with
 * the component — this is the state machine, and it is here so it can be
 * tested without a browser.
 */
export type PullState = 'idle' | 'pulling' | 'armed' | 'refreshing';

export function pullState(distance: number, refreshing: boolean, trigger = PULL_TRIGGER): PullState {
  if (refreshing) return 'refreshing';
  if (distance <= 0) return 'idle';
  return pullReleases(distance, trigger) ? 'armed' : 'pulling';
}

/**
 * Whether this movement is a deliberate pull, so far.
 *
 * The mirror of {@link engageDecision}, measured downwards, and it exists
 * because the pull used to ask only "has the finger moved eight pixels, and was
 * any of it downwards" — which is true of almost every gesture on a phone. A
 * swipe across the filter chips with eleven pixels of downward drift in a
 * hundred and eighty of sideways started the page moving; so did the first
 * moments of a diagonal scroll. Neither is somebody asking for a refresh.
 *
 * So the vertical component has to beat the horizontal one by the same ratio
 * the back-swipe asks of its own axis. `wait` is the honest answer under the
 * engage distance: a few pixels in any direction is a thumb resting.
 *
 * `scroll` is returned for an upward drag too, and is final either way — a
 * gesture given up on must not be reclaimed halfway down the screen.
 */
export function pullDecision(dx: number, dy: number): 'wait' | 'pull' | 'scroll' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < ENGAGE_DISTANCE && ay < ENGAGE_DISTANCE) return 'wait';
  if (dy > 0 && ay > ax * DIRECTION_RATIO) return 'pull';
  return 'scroll';
}

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

/**
 * What a movement on a sheet is, once there is enough of it to say.
 *
 * The mirror of {@link engageDecision}, measured downwards, and it is new: the
 * sheet drag used to ask only "has the finger moved eight pixels, and not
 * upwards". That is true of a swipe across a row of chips with nine pixels of
 * downward drift in two hundred of sideways, and true of the first moments of
 * almost every diagonal gesture on a phone — so a sheet could be flicked away
 * by a horizontal swipe that was never about the sheet at all.
 *
 * The vertical component now has to beat the horizontal one by the same ratio
 * the back-swipe asks of its own axis, which is what the interaction contract
 * means by *horizontal gestures must not accidentally dismiss*.
 *
 * `release` is final: a gesture given up on must not be reclaimed halfway down
 * the screen.
 */
export function sheetDecision(dx: number, dy: number): 'wait' | 'drag' | 'release' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < ENGAGE_DISTANCE && ay < ENGAGE_DISTANCE) return 'wait';
  if (dy > 0 && ay > ax * DIRECTION_RATIO) return 'drag';
  return 'release';
}

/** How much recent movement a flick is judged on, in milliseconds. */
export const VELOCITY_WINDOW = 120;

/**
 * How fast the finger was travelling at the end, in pixels per millisecond.
 *
 * Over a window rather than between the last two events, which is what this
 * used to do and what made a flick's fate depend on the phone's event rate: two
 * samples one millisecond apart report an enormous velocity, and two reported
 * in the same millisecond report none at all. A reader who pulls a sheet down
 * and pauses for a moment before letting go is not flicking it, and only a
 * window can tell that from a stall between two coalesced moves.
 *
 * Samples are oldest first. Anything older than {@link VELOCITY_WINDOW} before
 * the last one is not part of this flick.
 */
export function velocityOver(samples: readonly Sample[], window = VELOCITY_WINDOW): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  let first = last;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const sample = samples[i]!;
    if (last.t - sample.t > window) break;
    first = sample;
  }
  const elapsed = last.t - first.t;
  if (elapsed <= 0) return 0;
  return (last.x - first.x) / elapsed;
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

/** One reading of where the finger was, and when. */
export interface Sample {
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
          el.removeEventListener('transitionend', onSettled);
          el.classList.remove('push-layer-settling');
          reset();
          onBack();
        };
        /*
         * This layer's own transform, and nothing else. `transitionend` bubbles,
         * and a pushed screen is full of things that transition — one of them
         * settling mid-flight would otherwise navigate from wherever the layer
         * had got to. The same guard the sheet's own settle carries.
         */
        const onSettled = (event: TransitionEvent) => {
          if (event.target !== el || event.propertyName !== 'transform') return;
          finishNavigation();
        };
        el.addEventListener('transitionend', onSettled);
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

/**
 * The attribute a control inside a sheet uses to say "this drag is mine".
 *
 * The sheet's counterpart to {@link NO_PULL_ATTRIBUTE}, and it exists for the
 * same reason: a control that reorders, scrubs or draws under the finger starts
 * exactly the way a dismissal does, and nothing arbitrates that after the fact.
 * A pointer that goes down inside one of these never starts a sheet drag.
 */
export const NO_SHEET_DRAG_ATTRIBUTE = 'data-no-sheet-drag';

export interface SheetDrag {
  /** Put on the sheet itself — the element that moves. */
  sheetRef: (node: HTMLElement | null) => void;
  /** Put on the sheet's scrolling body — the region a drag never comes from. */
  bodyRef: (node: HTMLElement | null) => void;
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
    onClickCapture: (e: ReactMouseEvent) => void;
  };
  /** True while a finger is actually moving the sheet. */
  dragging: boolean;
}

/**
 * Controls where a drag means something else entirely.
 *
 * Dragging inside a text field moves the caret and selects — it is not a
 * gesture the sheet may take, however downward it is, and Setup's two paste
 * boxes are exactly this case. Asked of the element rather than declared on it,
 * because it is true of every field in every sheet and always will be;
 * {@link NO_SHEET_DRAG_ATTRIBUTE} is for the controls a primitive cannot guess.
 */
function ownsItsOwnDrag(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Whether a control between the finger and the sheet has claimed this drag.
 *
 * Walked once from the target upwards, because the pointer arrives at the sheet
 * having bubbled all the way up it and `e.target` is the only record left of
 * where the finger actually landed.
 */
function dragIsClaimed(target: EventTarget | null, sheet: HTMLElement): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node) {
    if (node instanceof HTMLElement && (node.hasAttribute(NO_SHEET_DRAG_ATTRIBUTE) || ownsItsOwnDrag(node))) {
      return true;
    }
    if (node === sheet) break;
    node = node.parentElement;
  }
  return false;
}

interface SheetGesture {
  pointerId: number;
  startX: number;
  startY: number;
  engaged: boolean;
  samples: Sample[];
}

/** How many recent positions are kept to judge a flick by. */
const SAMPLE_LIMIT = 12;

/**
 * Pull a sheet down to dismiss it.
 *
 * Four rules, in this order, and every one of them is a bug that was reported:
 *
 *  1. **A sheet is dismissed by its chrome. Its body belongs to the browser,
 *     always.** A drag that begins anywhere in the scrolling body is a scroll
 *     and is never taken, whatever that body happens to be holding at the time.
 *     Dismissal lives on the grip, the header, the backdrop, Done and Escape —
 *     none of which scroll, and the first two of which claim their gestures
 *     through `touch-action: none` in the stylesheet.
 *
 *     This rule has been narrowed twice, and the second narrowing is the one
 *     worth writing down because it cost a release each time.
 *
 *     It began as *scrolled* content owning the gesture, so content sitting at
 *     `scrollTop: 0` was fair game for a dismissal — on the grounds that a
 *     downward drag there has nowhere to scroll. WebKit decides whether a touch
 *     sequence may scroll **once**, from the first `touchmove`, so the sheet had
 *     to stake that claim on one or two pixels of movement; one or two pixels of
 *     a thumb landing is noise, and an upward flick that began with a pixel of
 *     downward drift lost its scroll for the whole swipe.
 *
 *     It then became *scrollable* content owning the gesture, asked at
 *     `pointerdown` — which is a question the DOM can answer honestly. But the
 *     answer had to be published to the engine **before** the finger landed, as
 *     `touch-action` on the body: `none` while there was nothing to scroll, so a
 *     short sheet could still be dragged shut from its content. And a card does
 *     not know how tall it is when it opens. A player's card opens on skeletons
 *     and fills in from two requests; for as long as those are in flight the
 *     body honestly reports *nothing to scroll*, takes `touch-action: none`, and
 *     the reader's first flick — the one they start while the card is still
 *     arriving — is refused its scroll for the whole gesture, even though the
 *     content lands halfway through it. Lift, flick again, and it works. *Locks
 *     up, then unlocks.* On a phone that window is the length of two requests;
 *     on a test runner against localhost it is a few milliseconds, which is why
 *     no headless suite ever saw it.
 *
 *     So the body no longer answers the question at all. There is no
 *     measurement left to be stale, no attribute for the engine to read at the
 *     wrong moment, and no state in which a card cannot be scrolled. What that
 *     costs is the fourth way of dismissing a short sheet — dragging its middle
 *     — and it is worth saying plainly that this is a real loss and a
 *     deliberate one: the affordance was only ever available when a guess about
 *     unarrived content happened to be right, and the price of the guess being
 *     wrong was the card.
 *
 *  2. **Nothing calls `preventDefault` on a touch.** A non-passive `touchmove`
 *     on an ancestor of the scroller takes WebKit off its fast scrolling path,
 *     which is the other half of "the interaction feels buggy": every frame of
 *     every scroll waiting on the main thread to be asked. The arbitration is
 *     the browser's, through `touch-action`, exactly as it is for the back
 *     gesture and pull-to-refresh.
 *
 *  3. **A gesture has to be vertical to be a dismissal.** See
 *     {@link sheetDecision}. A sideways swipe with a few pixels of drift used to
 *     throw the sheet away.
 *
 *  4. **A drag is not a tap.** Letting go over Done at the end of a drag that
 *     sprang back used to activate it, so a cancelled gesture closed the sheet
 *     anyway — which reads as the threshold being random rather than as a
 *     misfire. The same click suppression the back gesture has.
 */
export function useSheetDrag({ onDismiss }: { onDismiss: () => void }): SheetDrag {
  const sheet = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLElement | null>(null);
  const drag = useRef<SheetGesture | null>(null);
  const moved = useRef(false);
  const settleTimer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const reduced = useReducedMotion();

  /** Everything back where it was, whether it dismissed or not. */
  const reset = useCallback(() => {
    drag.current = null;
    moved.current = false;
    setDragging(false);
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    const el = sheet.current;
    if (!el) return;
    el.classList.remove('sheet-dragging', 'sheet-settling');
    el.style.transform = '';
  }, []);

  /* A sheet taken away mid-gesture must not leave a transform behind it. */
  useEffect(() => () => reset(), [reset]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const el = sheet.current;
    if (!el) return;
    /*
     * A second finger is a pinch, a zoom or a stray thumb — never a dismissal.
     * Whatever the first one had started is given up rather than fought over.
     */
    if (drag.current) {
      reset();
      return;
    }
    moved.current = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (dragIsClaimed(e.target, el)) return;
    /*
     * Rule 1. The body is the browser's, whatever it is holding — see the note
     * on this hook for why "it has nothing to scroll *yet*" is not the safe
     * case it looks like, and what asking it cost twice.
     */
    const scrolling = body.current;
    if (scrolling && e.target instanceof Node && scrolling.contains(e.target)) return;

    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      engaged: false,
      samples: [{ x: e.clientY, t: e.timeStamp }],
    };
  }, [reset]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;

    if (!state.engaged) {
      const decision = sheetDecision(dx, dy);
      if (decision === 'release') {
        drag.current = null;
        return;
      }
      if (decision === 'wait') return;

      state.engaged = true;
      moved.current = true;
      setDragging(true);
      sheet.current?.classList.add('sheet-dragging');
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation; the gesture works without it */
      }
    }

    state.samples.push({ x: e.clientY, t: e.timeStamp });
    if (state.samples.length > SAMPLE_LIMIT) state.samples.shift();
    /*
     * One to one, and deliberately undamped. A sheet being pulled down is the
     * one gesture on iOS that tracks the finger exactly — the resistance curve
     * belongs to pull-to-refresh, where the surface is being stretched past
     * where it can go. Upward is clamped rather than rubber-banded: a sheet at
     * rest is already at its top.
     */
    const el = sheet.current;
    if (el) el.style.transform = dy > 0 ? `translate3d(0, ${dy}px, 0)` : '';
  }, []);

  const finish = useCallback(
    (e: ReactPointerEvent, cancelled: boolean) => {
      const state = drag.current;
      const el = sheet.current;
      drag.current = null;
      if (!state || !el || !state.engaged) {
        setDragging(false);
        return;
      }
      setDragging(false);

      state.samples.push({ x: e.clientY, t: e.timeStamp });
      const distance = Math.max(0, e.clientY - state.startY);
      const velocity = velocityOver(state.samples);
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
          if (settleTimer.current !== null) {
            window.clearTimeout(settleTimer.current);
            settleTimer.current = null;
          }
          el.removeEventListener('transitionend', onSettled);
          el.classList.remove('sheet-settling');
          el.style.transform = '';
          onDismiss();
        };
        /*
         * This sheet's own transform, and nothing else.
         *
         * `transitionend` bubbles, and a sheet is full of things that
         * transition — a chip settling out of its pressed state during the
         * animation would otherwise end the animation, and the sheet would
         * vanish from wherever it had got to.
         */
        const onSettled = (event: TransitionEvent) => {
          if (event.target !== el || event.propertyName !== 'transform') return;
          close();
        };
        el.addEventListener('transitionend', onSettled);
        /*
         * A transition that never fires — a backgrounded tab, an engine that
         * skipped it — must not strand the reader behind a sheet that has left
         * the frame and cannot be tapped through.
         */
        settleTimer.current = window.setTimeout(() => {
          if (el.classList.contains('sheet-settling')) close();
        }, 400);
        return;
      }

      // Not far enough, or the browser took the gesture back: spring home.
      el.classList.add('sheet-settling');
      el.style.transform = '';
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        el.classList.remove('sheet-settling');
      }, 300);
    },
    [onDismiss, reduced],
  );

  /**
   * A drag must not also be a tap.
   *
   * Rule 4. Without this, letting go over Done at the end of a drag that sprang
   * back closed the sheet anyway, and a reader who had just decided *not* to
   * dismiss it watched it go — which is worse than a gesture that does nothing,
   * because it looks like the app disagreeing with them.
   */
  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!moved.current) return;
    moved.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    sheetRef: useCallback((node: HTMLElement | null) => {
      sheet.current = node;
    }, []),
    /*
     * Where the body is, and nothing else about it.
     *
     * This used to measure it — on attach, on every `scroll`, and through a
     * `ResizeObserver` on the box and on its content — and publish the answer
     * as `data-scrollable`, which the stylesheet turned into `touch-action`.
     * All of that is gone with rule 1. The body's permission is a constant now,
     * so there is nothing to keep up to date and nothing that can be stale at
     * the one instant the engine reads it.
     */
    bodyRef: useCallback((node: HTMLElement | null) => {
      body.current = node;
    }, []),
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: useCallback((e: ReactPointerEvent) => finish(e, false), [finish]),
      onPointerCancel: useCallback((e: ReactPointerEvent) => finish(e, true), [finish]),
      onClickCapture,
    },
    dragging,
  };
}

export interface PullToRefresh {
  /** Spread onto the element that wraps the screen's scrolling content. */
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
  };
  /** How far the surface has been pulled, in pixels. */
  distance: number;
  state: PullState;
  /** The same refresh the gesture runs, for the non-touch fallback control. */
  refresh: () => void;
}

/**
 * The attribute a control uses to say "this drag is mine".
 *
 * Put on the queue's grip. A pointer that goes down on it, or on anything
 * inside it, never starts a pull — see rule 2 below.
 */
export const NO_PULL_ATTRIBUTE = 'data-no-pull';

/**
 * Whether a pointer landing on the pull surface may begin a pull.
 *
 * The five refusals below are the whole of the gesture's arbitration, and they
 * are here — pure, and away from the pointer bookkeeping — because arbitration
 * is the part that is worth stating once and testing exhaustively. Every one of
 * them was a defect before it was a rule.
 */
export function pullBegins({
  enabled,
  covered,
  refreshing,
  atTop,
  claimed,
}: {
  /** What the screen itself says — see rule 2's second half. */
  enabled: boolean;
  /** Whether a layer is over the app — rule 6. */
  covered: boolean;
  /** Whether a refresh is already running — rule 3. */
  refreshing: boolean;
  /** Whether the surface under the gesture is at its top — rule 1. */
  atTop: boolean;
  /** Whether the pointer went down inside a control that owns its drag — rule 2. */
  claimed: boolean;
}): boolean {
  return enabled && !covered && !refreshing && atTop && !claimed;
}

/**
 * Pull down from the top of a screen to reload it.
 *
 * The one gesture an iPhone user tries without being told, and the reason both
 * of this screen's refresh buttons could be deleted. Five rules make it behave
 * like the system's own rather than like a `div` that moves:
 *
 *  1. **The page owns the gesture until the page is at its top.** A drag that
 *     starts anywhere below `scrollTop: 0` is a scroll and is never taken; a
 *     drag that starts at the top and is not clearly, deliberately downwards is
 *     a scroll too, and is handed back the moment the direction is clear — see
 *     {@link pullDecision}. This is the same rule the sheet drag uses, for the
 *     same reason: a gesture that competes with scrolling loses, and takes the
 *     reader's patience with it.
 *
 *  2. **A control that owns its own drag wins outright.** The queue's rows
 *     reorder by long-pressing a grip and dragging, and both gestures start the
 *     same way: a finger going down near the top of the screen and moving down.
 *     The reader was getting both — the list slid under the finger while the row
 *     was being carried, and letting go reloaded the board out from under the
 *     reorder. Nothing arbitrates that after the fact, so the grip says so
 *     before it starts: a pointer that goes down inside a
 *     `{@link NO_PULL_ATTRIBUTE}` element is not a pull and never becomes one.
 *
 *     `enabled` is the second half of the same rule and covers the gap the
 *     first cannot: a press may drift far enough to arm a pull (eight pixels)
 *     while still counting as a press (ten), and the long press then fires with
 *     the surface already moving. A screen that knows a drag has started takes
 *     the gesture back by disabling this, and anything in flight is dropped.
 *
 *  3. **One refresh at a time.** A ref, checked before anything is started,
 *     rather than the state that paints the spinner — state lands a render
 *     later, and the second pull happens in between. A pull during a refresh
 *     moves nothing and requests nothing; the spinner already on screen is the
 *     honest answer to "is it working".
 *
 *  4. **It reuses the screen's own reload.** `onRefresh` is whatever the screen
 *     already does, so there is exactly one refresh path in the app and this
 *     cannot drift from it. Nothing here polls, schedules or retries.
 *
 *  5. **Nothing calls `preventDefault`.** `overscroll-behavior` in the
 *     stylesheet is what stops the browser bouncing the whole document under
 *     the gesture; the arbitration stays the browser's.
 *
 *  6. **A covered page does not own the gesture at all.** The screen behind an
 *     open sheet is pinned, `inert`, and not the thing the reader is touching;
 *     a downward drag while a layer is up belongs to that layer, and dismissing
 *     a sheet must never also reload what is behind it.
 *
 *     This is not merely tidy. React portals move a layer's *elements* to the
 *     end of the document and leave its *events* propagating up the component
 *     tree, and every screen with this gesture renders its sheets inside the
 *     wrapper the gesture is attached to — so a finger on an open sheet was
 *     arriving here as if it had landed on the list behind it. On a real iPhone
 *     that read as a sheet which would not be swiped away: the reader pulled,
 *     and the page underneath tried to refresh instead. Players was the only
 *     screen where it worked, and only because Players has no pull-to-refresh
 *     for the sheet's events to reach.
 *
 *     `scrollTop` below was the first attempt at this and is not enough on its
 *     own: it reports where the reader was pinned, which is zero — the top —
 *     whenever the sheet was opened without scrolling first. The signal has to
 *     be the layer's own, so it comes from `useOverlay`, which is what being a
 *     layer means. Nothing screen-specific is involved and nothing has to
 *     remember to opt in.
 */
export function usePullToRefresh({
  onRefresh,
  enabled = true,
  scrollTop = pageScrollTop,
}: {
  onRefresh: () => Promise<unknown> | unknown;
  enabled?: boolean;
  /**
   * How far the surface under this gesture is scrolled. Injected for tests.
   *
   * Defaults to the overlay's reading rather than the window's, which are the
   * same number except while a layer has the page pinned — where the window
   * reports zero however far down the reader actually is.
   *
   * This was once also the guard against arming a refresh under an open sheet,
   * and it was the wrong instrument for it: a sheet opened from the top of a
   * list pins the page at zero, so the reading is "at the top" and honestly so.
   * Rule 6 is that guard now; this is back to answering only what it is asked.
   */
  scrollTop?: () => number;
}): PullToRefresh {
  const drag = useRef<{ pointerId: number; startX: number; startY: number; engaged: boolean } | null>(null);
  const running = useRef(false);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /*
   * Rule 6, read in the render the handlers are made in.
   *
   * Not a prop, deliberately. Every screen with this gesture would have had to
   * pass the same thing, every screen that opens a sheet would have had to know
   * it had one open, and the one screen that forgot would have the defect back.
   * The layer already announces itself; the page just has to listen.
   */
  const covered = useAppIsCovered();
  /** What the gesture is actually allowed to do, from both halves of that. */
  const live = enabled && !covered;

  /*
   * A gesture in flight when the gesture is taken back.
   *
   * Rule 2's second half, and rule 6's: a sheet can open under a finger that is
   * already pulling — a row tapped at the top of a list is exactly that — and
   * the pull must not carry on behind it. Dropping the drag alone would leave
   * the surface held open at whatever it had reached, so the distance goes with
   * it: the list springs back to where it belongs and the layer is the only
   * thing moving. A refresh already *running* is left alone — it has been
   * requested, and cancelling a request nobody asked to cancel is worse than
   * letting it finish.
   */
  useEffect(() => {
    if (live) return;
    drag.current = null;
    setDistance((current) => (current === 0 ? current : 0));
  }, [live]);

  const run = useCallback(() => {
    // The guard is the ref, not `refreshing`: two pulls inside one render would
    // both see the old state and both fire.
    if (running.current) return;
    running.current = true;
    setRefreshing(true);
    void (async () => {
      try {
        await onRefresh();
      } finally {
        running.current = false;
        setRefreshing(false);
        setDistance(0);
      }
    })();
  }, [onRefresh]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      /*
       * A control that has claimed this drag keeps it. Asked of the *target*
       * rather than of the surface, because the surface is the whole screen and
       * this event has bubbled all the way up it — by the time it arrives here
       * the only record of where the finger actually landed is `e.target`.
       */
      const target = e.target;
      const claimed = target instanceof Element && target.closest(`[${NO_PULL_ATTRIBUTE}]`) !== null;
      if (!pullBegins({ enabled, covered, refreshing: running.current, atTop: scrollTop() <= 0, claimed })) return;
      drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, engaged: false };
    },
    [enabled, covered, scrollTop],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const state = drag.current;
      if (!state || state.pointerId !== e.pointerId) return;
      // Rule 6 again, because a layer can open between two moves and the effect
      // above lands a render later — by which time this has already stretched
      // the page under the sheet by a frame's worth of finger.
      if (covered) {
        drag.current = null;
        setDistance(0);
        return;
      }
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (!state.engaged) {
        const decision = pullDecision(dx, dy);
        if (decision === 'wait') return;
        // Not a deliberate pull — upwards, or mostly sideways — or the reader
        // has scrolled away from the top in the meantime: this was a scroll all
        // along, and that verdict is final.
        if (decision === 'scroll' || scrollTop() > 0) {
          drag.current = null;
          setDistance(0);
          return;
        }
        state.engaged = true;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* capture is an optimisation; the gesture works without it */
        }
      }

      setDistance(pullDistance(dy));
    },
    [covered, scrollTop],
  );

  const finish = useCallback(
    (e: ReactPointerEvent, cancelled: boolean) => {
      const state = drag.current;
      drag.current = null;
      // And rule 6 a third time, at the last place it could still fire one: a
      // layer that opened after the finger did leaves a pull engaged, and
      // letting go of it would reload the page under the sheet.
      if (covered || !state || state.pointerId !== e.pointerId || !state.engaged) {
        setDistance(0);
        return;
      }
      const travelled = pullDistance(e.clientY - state.startY);
      if (!cancelled && pullReleases(travelled)) {
        // Held open at the trigger height while the request runs, which is what
        // makes the spinner look like it is doing something rather than
        // snapping back and leaving the reader wondering whether it fired.
        setDistance(PULL_TRIGGER);
        run();
        return;
      }
      setDistance(0);
    },
    [covered, run],
  );

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: useCallback((e: ReactPointerEvent) => finish(e, false), [finish]),
      onPointerCancel: useCallback((e: ReactPointerEvent) => finish(e, true), [finish]),
    },
    distance,
    state: pullState(distance, refreshing),
    refresh: run,
  };
}
