/**
 * What tapping the destination you are already on does.
 *
 * iOS gives the current tab the one job it has nothing else to do: take the
 * screen back towards its resting state. The important word is *towards*. A tab
 * tap undoes **one thing** — the innermost, most transient thing the screen is
 * holding — and a reader who taps it three times walks back out through three
 * layers in the order they built them. Unwinding everything at once is a
 * different gesture: it throws away a filter somebody set deliberately in the
 * same motion that closes a card they opened by accident, and it makes the
 * second tap do nothing, which teaches people the control is unreliable.
 *
 * So each screen declares its rungs, innermost first, and this runs the first
 * one that applies. When none does, the screen is already home and the tap
 * means "take me to the top", which is the convention every iOS list has.
 *
 * **Nothing here may touch what the reader owns.** A heart, a queue mark, a
 * tally, a stored preference: those are data, not view state, and this is a
 * gesture people make by accident. A rung that discards work is a bug however
 * convenient it looks.
 */

/** One step back out: whether it applies, and what undoing it does. */
export interface ResetRung {
  /** True when there is something here to undo. */
  when: boolean;
  /** Undo it. Runs at most once per tap, and only for the first true rung. */
  undo: () => void;
}

/**
 * Walk back one rung, or go to the top.
 *
 * Returns which rung fired, or `null` for "already home" — useful to a test,
 * and to a caller that wants to do something else when there was nothing left.
 */
export function unwindOne(rungs: ResetRung[]): number | null {
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]!;
    if (!rung.when) continue;
    rung.undo();
    return i;
  }
  scrollToTop();
  return null;
}

/**
 * The top of the page, without a smooth scroll.
 *
 * `behavior: 'auto'` on purpose: a tab tap is a navigation, and animating a
 * long list back to the top makes the reader watch a scroll they asked to skip.
 * It also respects a reduced-motion preference by never being motion at all.
 */
export function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: 'auto' });
}
