/**
 * The arithmetic behind an iOS-style long-press drag, separated from the DOM.
 *
 * A reorder gesture is three decisions and a lot of event plumbing. The
 * plumbing has to live in a component; the decisions are what can be wrong, so
 * they live here where they can be checked without a browser:
 *
 *   1. **Has the press become a drag?** Long enough, and still enough. A finger
 *      that moves before the hold has elapsed was scrolling, and stealing that
 *      movement to start a drag is how a list becomes impossible to scroll.
 *   2. **Which index is the finger over?** From the row height and how far it
 *      has travelled, not from hit-testing every row — a list of two hundred
 *      rows would otherwise ask the browser for two hundred rectangles on every
 *      frame of every drag.
 *   3. **How far has each row shifted?** The rows between the origin and the
 *      target slide by exactly one row height, in the direction that opens the
 *      gap. This is what makes the list look like it is rearranging rather than
 *      like one row floating over a static list.
 *
 * Nothing here knows what a player is. It reorders indices.
 */

/**
 * How long a press must be held before it becomes a drag.
 *
 * iOS uses about half a second for its own reorder gestures and the muscle
 * memory is worth matching exactly. Shorter and a scroll that starts with a
 * pause becomes a drag; longer and the control feels broken.
 */
export const LONG_PRESS_MS = 500;

/**
 * How far a finger may drift during the hold and still be a press.
 *
 * Generous, because a thumb resting on a phone is never actually still — this
 * is the tremor tolerance, not a movement allowance. Past it the gesture is a
 * scroll and the timer is abandoned.
 */
export const PRESS_SLOP = 10;

/** What the gesture is, once the press has been evaluated. */
export type PressVerdict = 'holding' | 'drag' | 'scroll';

/**
 * Has this press become a drag yet?
 *
 * `scroll` is final: once a gesture has been given up on it must not be
 * reclaimed, or a slow scroll would turn into a drag halfway down the list.
 */
export function pressVerdict(input: {
  heldMs: number;
  movedPx: number;
  slop?: number;
  holdMs?: number;
}): PressVerdict {
  const slop = input.slop ?? PRESS_SLOP;
  const hold = input.holdMs ?? LONG_PRESS_MS;
  if (input.movedPx > slop) return 'scroll';
  return input.heldMs >= hold ? 'drag' : 'holding';
}

/**
 * Which index the finger is over, given where the drag started.
 *
 * Rounding rather than flooring, so a row swaps when the finger passes its
 * midpoint rather than its top edge — which is what makes the gap appear where
 * the reader expects it rather than half a row late.
 */
export function targetIndex(input: {
  fromIndex: number;
  deltaY: number;
  rowHeight: number;
  count: number;
}): number {
  if (input.rowHeight <= 0 || input.count <= 0) return input.fromIndex;
  const moved = Math.round(input.deltaY / input.rowHeight);
  return clamp(input.fromIndex + moved, 0, input.count - 1);
}

/**
 * How far one row should be drawn from where it normally sits, mid-drag.
 *
 * The dragged row follows the finger exactly. Every row strictly between the
 * origin and the target slides one row height toward the origin, which opens
 * exactly one gap — at the target — and closes exactly one, at the origin.
 * Every other row does not move at all.
 *
 * In pixels, and signed downward, so a caller applies it as a translation
 * without interpreting it.
 */
export function rowOffset(input: {
  index: number;
  fromIndex: number;
  toIndex: number;
  rowHeight: number;
}): number {
  const { index, fromIndex, toIndex, rowHeight } = input;
  if (index === fromIndex) return 0; // the caller draws this one under the finger
  if (fromIndex < toIndex) {
    // Dragging down: the rows it has passed move up to fill the space behind it.
    return index > fromIndex && index <= toIndex ? -rowHeight : 0;
  }
  if (fromIndex > toIndex) {
    // Dragging up: the rows it has passed move down.
    return index >= toIndex && index < fromIndex ? rowHeight : 0;
  }
  return 0;
}

/**
 * The list as it will be, so a caller can render the result before the server
 * has confirmed it.
 *
 * The same move `reorderQueue` will perform, expressed on a plain array — kept
 * separate from it because that function also decides ranks and persistence,
 * and a component that only needs to draw the next frame should not have to
 * think about either.
 */
export function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const out = [...items];
  if (fromIndex < 0 || fromIndex >= out.length) return out;
  const target = clamp(toIndex, 0, out.length - 1);
  const [moved] = out.splice(fromIndex, 1);
  if (moved === undefined) return out;
  out.splice(target, 0, moved);
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
