/**
 * How many of a position a roster wants before another one needs a real case.
 *
 * Opened by a live board, week 3 of 2026, that offered four tight ends in a
 * row to a roster already holding two. Each one cleared the bench bar on its
 * own, because the bar was the weakest flex-eligible man on the bench — a
 * running back — and nothing asked whether a third tight end did anything for
 * a lineup that has one tight-end slot. Every tight end on the wire beat the
 * same running back, so every tight end was a recommendation.
 *
 * The policy is one table and one rule, not a special case per position.
 *
 * **The table** says which positions are *slot* positions — worth holding up
 * to the number of slots they fill and not beyond — and which are *depth*
 * positions, where a roster happily carries as many as are worth carrying.
 * It is the league manager's preference, written down:
 *
 *   - QB, TE, K and DEF are slot positions. A second one is a hedge that only
 *     pays in a bye week or an injury, and he has to be a standout to be worth
 *     a bench spot a back or a receiver could have.
 *   - RB and WR are depth positions. No cap, and a mild lean toward backs when
 *     two adds are otherwise level — see {@link DEPTH_LEAN}.
 *
 * **The cap** is read off the league's own shape rather than typed in: the
 * dedicated slots the position fills, plus one for each flex that takes a
 * quarterback in a superflex league. The one date-driven exception is the
 * defence, which gets a second slot in the weeks right before the playoffs,
 * when carrying a playoff matchup is the point — see
 * {@link PLAYOFF_PREP_LEAD_WEEKS}. That is the only special case, and it is
 * a special case because the thing it models is a date.
 *
 * **The rule**, applied by `core/startsit/waivers.ts`: an add that would take a
 * position past its cap is not measured against the weakest man on the bench.
 * It is measured against the weakest man *at his own position*, and it has to
 * clear the starter-upgrade bar to count — a real upgrade, not a spare body.
 * And the board carries at most one over-cap suggestion per position: the best
 * one, if any clears.
 */

import type { RosterShape } from '../sleeper/scoring.ts';

/** Whether a position is filled to a count, or carried for depth. */
export type DepthKind = 'slot' | 'depth';

/**
 * The manager's positional preferences, as a table.
 *
 * A position missing from the table is treated as `depth`: the old behaviour,
 * and the safe one for anything this app does not yet reason about (IDP).
 */
export const POSITION_DEPTH: Readonly<Record<string, DepthKind>> = {
  QB: 'slot',
  TE: 'slot',
  K: 'slot',
  DEF: 'slot',
  RB: 'depth',
  WR: 'depth',
};

/**
 * A small preference for backs when two adds are otherwise level, in points.
 *
 * A quarter of a point on the ordering only. It never admits anybody and it
 * never outweighs a real gap: a receiver a full point better still ranks above
 * the back. It exists because the manager leans back-heavy when the value is
 * close, and a tie broken alphabetically is not a preference anybody holds.
 */
export const DEPTH_LEAN: Readonly<Record<string, number>> = {
  RB: 0.25,
};

/**
 * How many weeks before the playoffs a second defence becomes allowed.
 *
 * One, so in a league whose playoffs open in week 15 the window opens in week
 * 14 — the manager's own "roughly week 14 onward". Before that a second
 * defence is a roster spot spent on a week that may never be played.
 */
export const PLAYOFF_PREP_LEAD_WEEKS = 1;

export interface DepthContext {
  shape: RosterShape;
  week: number;
  /** The league's own playoff weeks, never an assumed 15–17. Empty if unknown. */
  playoffWeeks: readonly number[];
}

/** Whether the defence is in its playoff-prep window this week. */
export function inPlayoffPrep(ctx: Pick<DepthContext, 'week' | 'playoffWeeks'>): boolean {
  const start = Math.min(...ctx.playoffWeeks);
  if (!Number.isFinite(start)) return false;
  return ctx.week >= start - PLAYOFF_PREP_LEAD_WEEKS;
}

/**
 * How many of this position the roster wants, or null for no cap.
 *
 * Null for a depth position. For a slot position it is the dedicated starting
 * slots, plus any flex that accepts him when that flex is the superflex kind —
 * an ordinary FLEX takes a tight end too, but a tight end in the flex is a
 * choice the roster makes, not a slot it must fill.
 */
export function depthCap(position: string, ctx: DepthContext): number | null {
  const kind = POSITION_DEPTH[position] ?? 'depth';
  if (kind === 'depth') return null;
  const dedicated = ctx.shape.starters[position] ?? 0;
  const superflex = position === 'QB' ? ctx.shape.flex.filter((f) => f.positions.includes('QB')).length : 0;
  const prep = position === 'DEF' && inPlayoffPrep(ctx) ? 1 : 0;
  /*
   * At least one: a slot position the league never starts is still a position
   * a roster may hold one of, and a cap of zero would read every one as
   * surplus.
   */
  return Math.max(1, dedicated + superflex + prep);
}

/** The ordering lean for a position, in points. Zero for most. */
export function depthLean(position: string): number {
  return DEPTH_LEAN[position] ?? 0;
}
