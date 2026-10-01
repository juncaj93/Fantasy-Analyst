/**
 * What the last seven days of news may do to a waiver call: a nudge, never a verdict.
 *
 * ## Where this sits
 *
 * A waiver call is made on the projection (Vegas lines where a player is fully
 * priced, Sleeper's published number otherwise). That stays the primary basis,
 * and `yardstick.ts` still decides who clears the bar. The 7-day research tally
 * (`signal.last7`, good news minus bad news from the newsletters, not fantasy
 * points) is a secondary adjustment on the *order*:
 *
 *  - on the drop side, it moves a rostered player a little up or down the cut
 *    order, so of two similar bench players the one with the worse week goes
 *    first;
 *  - on the pickup side, it moves a free agent a little up or down the order of
 *    the claims, so of two similar adds the one with the better week goes first.
 *
 * Neither side can be admitted, excluded or protected by it: it is added to the
 * ordering number only, never to a projection, a gap or a bar.
 *
 * ## Three guards against reading too much into a week
 *
 * 1. **Thin weeks say nothing.** Fewer than {@link RECENT_FORM.minItems} counted
 *    items in the window is no signal at all. One note is an anecdote.
 * 2. **Small samples are shrunk toward zero**, in the open, the same way the
 *    bidding profile shrinks a thin record toward the room
 *    (`core/managers/biddingProfile.ts`): {@link RECENT_FORM.priorItems} imaginary
 *    neutral items are added to the real ones, so two items carry half the
 *    weight and ten carry five sixths. The count is on the card's sheet.
 * 3. **The month outranks the week.** When the 30-day tally has at least
 *    {@link RECENT_FORM.settledItems} items and points the other way, the week is
 *    halved: a quiet week for a player the month is behind is not a trend.
 *
 * Then a hard ceiling of {@link RECENT_FORM.maxPoints} points a side, which keeps
 * the largest possible swing between two players (0.8) under the gap a claim has
 * to clear on Sleeper's projection (1.0). It can reorder near-ties and nothing
 * more.
 */

import type { PlayerSignal } from '../evidence/types.ts';

export const RECENT_FORM = {
  /** Counted items in the 7-day window before it speaks at all. */
  minItems: 2,
  /** Imaginary neutral items blended into the real ones. */
  priorItems: 2,
  /** The net that counts as fully up or fully down. Matches `NEWS_SATURATION.last7`. */
  saturation: 3,
  /** The most the week can move one player's place in an order, in points. */
  maxPoints: 0.4,
  /** The week's share that survives when a settled month points the other way. */
  againstMonth: 0.5,
  /** Counted items in the 30-day window for it to count as settled. */
  settledItems: 3,
  /** Smaller than this is not worth naming, and counts as nothing. */
  visiblePoints: 0.1,
} as const;

export type RecentDirection = 'up' | 'down';

export interface RecentForm {
  /**
   * Signed ordering points, positive for a good week. A good week moves a free
   * agent earlier in the claims and a rostered player later in the cut order;
   * a bad week does the reverse. Zero when the week is thin or flat.
   */
  points: number;
  direction: RecentDirection | null;
  /** The raw 7-day figures, kept so the sheet can show its working. */
  net7: number;
  items7: number;
  /** `items / (items + prior)`: how much of the week's own record counted. */
  weight: number;
  /** The month pointed the other way and halved the week. */
  againstMonth: boolean;
}

const SILENT: RecentForm = { points: 0, direction: null, net7: 0, items7: 0, weight: 0, againstMonth: false };

/** One player's week, read off the tally the Players screen already shows. */
export function recentFormOf(
  signal: Pick<PlayerSignal, 'last7' | 'last30' | 'last7Count'> | null | undefined,
): RecentForm {
  if (!signal) return SILENT;
  const { net } = signal.last7;
  /* The stored-summary read reports `last7.items` as zero on purpose; `last7Count` is the real figure. */
  const items = signal.last7Count ?? signal.last7.items;
  if (!Number.isFinite(net) || items < RECENT_FORM.minItems) return { ...SILENT, net7: net ?? 0, items7: items ?? 0 };

  const weight = items / (items + RECENT_FORM.priorItems);
  const fraction = Math.max(-1, Math.min(1, (net * weight) / RECENT_FORM.saturation));

  const month = signal.last30;
  const againstMonth =
    month.items >= RECENT_FORM.settledItems && month.net !== 0 && net !== 0 && Math.sign(month.net) !== Math.sign(net);
  const points = round2(RECENT_FORM.maxPoints * fraction * (againstMonth ? RECENT_FORM.againstMonth : 1));
  const direction: RecentDirection | null =
    Math.abs(points) < RECENT_FORM.visiblePoints ? null : points > 0 ? 'up' : 'down';

  return {
    points: direction == null ? 0 : points,
    direction,
    net7: net,
    items7: items,
    weight: round2(weight),
    againstMonth,
  };
}

/** `trending up this week`, the phrase the cards and the plan share. */
export function recentFormPhrase(direction: RecentDirection): string {
  return direction === 'up' ? 'trending up this week' : 'trending down this week';
}

/** The sheet's sentence about a free agent, with the arithmetic in it. */
export function recentFormLine(form: RecentForm): string | null {
  if (form.direction == null) return null;
  const net = `${form.net7 > 0 ? '+' : form.net7 < 0 ? '−' : ''}${Math.abs(form.net7)}`;
  const size = Math.abs(form.points).toFixed(2);
  const month = form.againstMonth ? ', halved because the 30-day tally points the other way' : '';
  return form.direction === 'up'
    ? `Research tally ${net} over ${form.items7} items this week, so he is ${recentFormPhrase('up')}. That moved him up ${size} pts in the order and nothing more${month}.`
    : `Research tally ${net} over ${form.items7} items this week, so he is ${recentFormPhrase('down')}. That moved him down ${size} pts in the order and nothing more${month}.`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
