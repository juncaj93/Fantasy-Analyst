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
 *     The sheet used to be the exception, and is now the strongest case for the
 *     rule. It held a non-passive `touchmove` so it could claim a downward drag
 *     on content at its top; then it published the same claim ahead of the
 *     finger as `touch-action`. Both were withdrawn for costing the reader their
 *     scroll, and the third attempt measured why no version of that could work:
 *     the body was a scroll container, so the engine took every vertical touch
 *     on it after a single `pointermove`. The app was not outvoted — it was not
 *     asked.
 *
 *     So the sheet stopped asking, and left this file entirely. A sheet is a
 *     scroller whose two ends are the card in place and the card gone, its
 *     dismissal is a scroll, and there is no sheet gesture here to read. See
 *     `.sheet-scroller` in the stylesheet, and `Sheet` in `components/native`.
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

/* --------------------------------------------------------- sheet dismissal */

/** How much of the push has to be given before a sheet counts it at all. */
export const DISMISS_HOLD = 0.4;

/** …and how much of it makes the distance the whole of the answer. */
export const DISMISS_COMMIT = 0.75;

/**
 * The speed, in px/ms, that settles the band between those two.
 *
 * Where the number came from, measured on the sheet's own layer at 430×932: a
 * crawl peaked at 0.17, an unhurried pull at 0.30, a deliberate one at 0.40, a
 * brisk one at 1.06, a flick at 2.68. It sits below the deliberate pull with
 * room to spare rather than splitting the close pair, because the two mistakes
 * do not cost the same: a dismissal wrongly withheld springs back and can be
 * made again, and a card wrongly thrown away cannot be.
 */
export const DISMISS_VELOCITY = 0.25;

/**
 * Far enough, or fast enough, to let a sheet go.
 *
 * `given` is the fraction of the way to dismissed the push reached; `velocity`
 * is how fast it ever travelled, in px/ms. `measured` is whether a speed was
 * ever readable at all — a movement delivered as a single jump has a distance
 * and no speed, and withholding a dismissal on evidence that was never
 * collected would be a guess rather than a judgement. So an unmeasured push is
 * answered on distance, the way every push was answered before speed was asked.
 *
 * Distinct from {@link completesBack} in one way that matters: a back swipe
 * reads the finger as it lifts, and a sheet reads the layer once it has come to
 * rest — a scroller always decelerates to a stop, so there is no release
 * velocity left to read by then. Hence a peak over the movement rather than a
 * window at the end of it.
 */
export function dismissesSheet(given: number, velocity: number, measured: boolean): boolean {
  if (given >= DISMISS_COMMIT) return true;
  if (given < DISMISS_HOLD) return false;
  return !measured || velocity >= DISMISS_VELOCITY;
}

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

/** How much recent movement a flick is judged on, in milliseconds. */
export const VELOCITY_WINDOW = 120;

/**
 * How many recent positions are kept to judge a flick by.
 *
 * Up here with the window it serves rather than inside the hook that uses it.
 * It once served two: the sheet judged a flick this way too, until the
 * dismissal became a scroll and there stopped being a finger to sample — see
 * {@link dismissesSheet} for what the sheet reads instead, and why a window at
 * the end of a movement cannot tell it anything.
 */
const SAMPLE_LIMIT = 12;

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
  samples: Sample[];
}

/**
 * Whether something between the finger and the layer wants this drag itself.
 *
 * Two things do, and the first is the reason this exists. **A horizontal
 * scroller that has been scrolled off its start is going back, not the screen.**
 * A pushed screen is full-bleed and gives its gutter back as padding, so a
 * segmented control inside one begins twelve points from the glass — well
 * inside the {@link EDGE_ZONE}. A reader who has scrolled the position filter
 * along and swipes right to bring it back was starting a back gesture with the
 * same movement, and got both: the chips slid under the finger while the screen
 * slid off it.
 *
 * What is asked is not *is this a carousel* — which needs geometry and a
 * computed overflow — but *has it somewhere to scroll back to*, which
 * `scrollLeft` answers on its own and answers truthfully at the instant it is
 * read. A carousel already at its start has nothing to take, so the gesture is
 * the screen's, which is what iOS does too.
 *
 * The second is a control where dragging means something else entirely — a text
 * field, where it moves the caret and selects. {@link ownsItsOwnDrag} is the
 * sheet's own test for that, asked here for the same reason.
 */
function swipeIsClaimed(target: EventTarget | null, layer: HTMLElement | null): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node) {
    if (node.scrollLeft > 0) return true;
    if (node instanceof HTMLElement && ownsItsOwnDrag(node)) return true;
    if (node === layer) break;
    node = node.parentElement;
  }
  return false;
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
 *
 * Four things beyond the thresholds, each of them a defect first:
 *
 *  - **A covered screen does not own the gesture at all.** The same rule
 *    `usePullToRefresh` keeps as its rule 6, by the same signal, and it is here
 *    for the same reason: React portals move a layer's *elements* to the end of
 *    the document and leave its *events* propagating up the component tree, and
 *    Review renders the scoring key inside its own pushed screen. So a finger on
 *    that card arrived here as though it had landed on the screen behind it, and
 *    a sideways drag on an open sheet — not a dismissal, correctly, since a
 *    dismissal must be downward — navigated the screen out from under it. The
 *    reader was left holding a card over the wrong page. `useAppIsCovered` is
 *    the layer announcing itself, so nothing screen-specific has to opt in and
 *    no sheet added later can reintroduce this.
 *  - **A horizontal scroller with somewhere to go back to keeps the gesture.**
 *    See {@link swipeIsClaimed}.
 *  - **A flick is judged over the window**, like the sheet's, rather than
 *    between the last two moves — which made it a function of the phone's event
 *    rate. See {@link velocityOver}.
 *  - **A drag that is abandoned does not eat the next tap.** The click
 *    suppression is armed at `pointerdown` and cleared there too; it used to be
 *    cleared only by the click it swallowed, and a sprung-back swipe on a touch
 *    screen produces no click to clear it with.
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
  /** Whether a layer is over the app right now — read in this render. */
  const covered = useAppIsCovered();
  /** What the gesture is actually allowed to do, from both halves of that. */
  const live = enabled && !covered;

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

  /*
   * A gesture in flight when the gesture is taken away.
   *
   * A sheet can open under a finger that is already swiping — a row tapped near
   * the leading edge is exactly that — and the screen must not carry on sliding
   * behind it. Dropping the drag alone would leave the layer held wherever it
   * had reached, so `reset` puts it back as well.
   */
  useEffect(() => {
    if (live) return;
    reset();
  }, [live, reset]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      /*
       * The suppression the *last* gesture may have left armed, cleared before
       * anything is asked about this one.
       *
       * `moved` exists to stop a drag also landing as a tap, and it was cleared
       * only by the click it suppressed — so a swipe that engaged and sprang
       * back, which produces no click at all on a touch screen, left it raised.
       * The reader's next tap on the pushed screen was then eaten by a gesture
       * they had already abandoned: one dead tap after every partial swipe.
       *
       * **Above every refusal below, and that is the whole of it.** The tap that
       * has to clear the flag is by definition not the one that set it: it lands
       * wherever the reader is going next, which is almost never the few points
       * of edge that can begin a swipe. Cleared after those guards, this fixes
       * only the case where the dead tap happens to fall in the strip — which is
       * to say, hardly ever, and never the one that was reported.
       */
      moved.current = false;
      if (!live) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!startsAtEdge(e.clientX)) return;
      /*
       * Asked only of a touch that landed in the strip, which is a few pixels
       * of a screen and correspondingly rare — so the walk costs nothing on the
       * taps and scrolls that make up the rest of a reader's day.
       */
      if (swipeIsClaimed(e.target, layer.current)) return;
      drag.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        engaged: false,
        samples: [{ x: e.clientX, t: e.timeStamp }],
      };
    },
    [live],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const state = drag.current;
      if (!state || state.pointerId !== e.pointerId) return;
      /*
       * And again here, because a layer can open between two moves and the
       * effect above lands a render later — by which time this has already
       * dragged the screen out from under the sheet by a frame's worth of
       * finger. The same third place `usePullToRefresh` checks it.
       */
      if (covered) {
        reset();
        return;
      }
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

      state.samples.push({ x: e.clientX, t: e.timeStamp });
      if (state.samples.length > SAMPLE_LIMIT) state.samples.shift();
      paint(Math.max(0, dx));
    },
    [covered, paint, reset],
  );

  const finish = useCallback(
    (e: ReactPointerEvent, cancelled: boolean) => {
      const state = drag.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const el = layer.current;
      // And the last place a covered screen could still navigate: a layer that
      // opened after the finger did leaves a swipe engaged, and letting go of it
      // would take the page out from under the sheet that had just opened.
      if (covered || !state.engaged || !el) {
        reset();
        return;
      }

      const distance = Math.max(0, e.clientX - state.startX);
      /*
       * Over the window, not between the last two events.
       *
       * The same correction {@link velocityOver} was written for and the sheet
       * has had since; this was left measuring the gap between whichever two
       * moves happened to arrive last, so a flick's fate depended on the phone's
       * event rate — two samples a millisecond apart report an enormous
       * velocity, two in the same millisecond report none — and a reader who
       * drew the screen most of the way across and paused before letting go was
       * read as flicking it.
       */
      state.samples.push({ x: e.clientX, t: e.timeStamp });
      const velocity = velocityOver(state.samples);
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
    [covered, onBack, reduced, reset],
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
 * Controls where a drag means something else entirely.
 *
 * Dragging inside a text field moves the caret and selects — it is not a
 * gesture a navigation may take, however sideways it is, and Setup's two paste
 * boxes are exactly this case. Asked of the element rather than declared on it,
 * because it is true of every field in every screen and always will be.
 *
 * The sheet used to ask this too, of a drag that might have dismissed a card.
 * It no longer has a drag to ask about: a sheet is a scroller now, and a field
 * inside one keeps its own gestures the way a field anywhere else does, with
 * nobody arbitrating. {@link swipeIsClaimed} is the last caller.
 */
function ownsItsOwnDrag(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
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
