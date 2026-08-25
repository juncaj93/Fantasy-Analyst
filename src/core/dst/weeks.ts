/**
 * How a set of weeks is said in words.
 *
 * One function, in a module of its own, and the reason is measured rather than
 * aesthetic. It used to live in `planner.ts`, which is also where the defence
 * *model* lives — and `core/waivers/board.ts` imports it, which put a runtime
 * edge from the render path into the planner. That edge cost nothing while
 * nothing else needed the planner's body; the day Demo Mode began running the
 * real `planDst`, the planner was retained in full and the bundler placed its
 * whole dependency tree — the start/sit engine, the projection, the outlook —
 * in the entry chunk, because a module reachable from the entry belongs to the
 * entry. Twenty-five kilobytes of model, on every page load, for a screen that
 * prints `Weeks 15–17`.
 *
 * So the vocabulary the screens read is separate from the model that decides.
 * This module imports nothing, which is the property that matters: there is no
 * tree behind it to drag anywhere.
 */

/** `Weeks 15–17`, from the league's own list and never from a constant. */
export function weekRange(weeks: number[]): string {
  if (weeks.length === 0) return 'the playoffs';
  if (weeks.length === 1) return `Week ${weeks[0]}`;
  return `Weeks ${weeks[0]}–${weeks.at(-1)}`;
}
