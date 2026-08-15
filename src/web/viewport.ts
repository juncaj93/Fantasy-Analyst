/**
 * What the on-screen keyboard is doing to the bottom of the page.
 *
 * This exists for one decision: whether the floating toolbar should get out of
 * the way. A fixed element sits at the bottom of the *layout* viewport, and iOS
 * does not shrink the layout viewport for the keyboard — it shrinks the visual
 * one. So a bar that is correctly pinned to the bottom of the page ends up
 * hovering over the field being typed into, or over the button under it, and no
 * amount of CSS about the bottom edge can tell that has happened.
 *
 * `visualViewport` can. The arithmetic is separated from the DOM because the
 * threshold is the part worth testing, and testing it should not require
 * standing up a browser with a soft keyboard in it.
 */

import { useEffect, useState } from 'react';

/**
 * How much of the page has to be covered before this counts as a keyboard.
 *
 * Deliberately far above the noise. Safari's own chrome collapsing and
 * expanding as the page scrolls moves the two viewports relative to each other
 * by a few tens of pixels, and a bar that flicked away every time the URL field
 * shrank would be worse than one that never moved. An iPhone keyboard is never
 * less than about 250px tall, so nothing real lives between the two.
 */
export const KEYBOARD_OCCLUSION = 150;

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
}

/**
 * How many pixels of the layout viewport are hidden below what is on screen.
 *
 * `offsetTop` matters: when the user pinch-zooms or the page is scrolled within
 * the visual viewport, the visible window is not anchored at the top, and
 * subtracting only the height would report an occlusion that is really an
 * offset. Never negative — a visual viewport taller than the layout one is a
 * rounding artefact, not a negative keyboard.
 */
export function occludedHeight(layoutHeight: number, visual: VisualViewportLike | null): number {
  if (!visual) return 0;
  return Math.max(0, Math.round(layoutHeight - (visual.height + visual.offsetTop)));
}

/** Whether that occlusion is large enough to be a keyboard rather than chrome. */
export function keyboardIsOpen(layoutHeight: number, visual: VisualViewportLike | null): boolean {
  return occludedHeight(layoutHeight, visual) >= KEYBOARD_OCCLUSION;
}

/**
 * Live answer to "is the keyboard up", for as long as the component is mounted.
 *
 * Listens rather than polls, and only to the two events the platform fires for
 * this. A browser with no `visualViewport` — every desktop test runner among
 * them — answers false forever, which is the correct answer there: there is no
 * software keyboard to make room for.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const check = () => setOpen(keyboardIsOpen(window.innerHeight, visual));
    check();
    visual.addEventListener('resize', check);
    visual.addEventListener('scroll', check);
    return () => {
      visual.removeEventListener('resize', check);
      visual.removeEventListener('scroll', check);
    };
  }, []);

  return open;
}
