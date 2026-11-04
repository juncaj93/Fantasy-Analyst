/**
 * The closest trade ideas, when none is fair to both sides (review T1,
 * November 2026). For the probe only: a board may honestly be empty, and
 * "empty" has to come with the deals that came nearest and what stopped each.
 *
 * Two passes, both bounded. The search's own rejections carry the numbers
 * they were turned away on (`Rejection.measure`), so the cheap pass orders
 * them by how far each sits from the search's gates; the few nearest are then
 * run through Check a trade by the caller, and {@link rankClosest} orders
 * those on the fair-to-both rule itself.
 *
 * Pure.
 */

import { FAIR_TO_BOTH, gainBars, wholePercent } from './fairToBoth.ts';
import type { Rejection } from './bilateral.ts';
import type { SeasonCheck } from './seasonCheck.ts';

/** Packages sent to the season check for this list. Each is about a millisecond of CPU. */
export const CLOSEST_CHECKED = 24;
/** Shown. */
export const CLOSEST_SHOWN = 5;

/** Reasons a package can be near: it reached the value or lineup gates. */
const NEAR_REASONS: ReadonlySet<Rejection['reason']> = new Set([
  'value_gap_outside_range',
  'user_benefit_negligible',
  'harms_counterparty',
  'costs_scarce_player',
  'no_weak_spot',
  'no_counterparty_logic',
]);

/**
 * How far a rejected package sat from the search's gates, smallest first.
 * The value gap past its band, in tenths, plus each side's weekly shortfall.
 */
export function nearOrder(rejection: Rejection, perWeek: { user: number; partner: number }): number {
  const m = rejection.measure ?? {};
  const gap = m.gap ?? 0;
  const over = Math.max(0, gap - FAIR_TO_BOTH.userEdgeMax) + Math.max(0, -gap - FAIR_TO_BOTH.partnerEdgeMax);
  const user = m.userGain == null ? 0.5 : Math.max(0, perWeek.user - m.userGain) / Math.max(0.1, perWeek.user);
  const partner = m.partnerGain == null ? 0.5 : Math.max(0, -perWeek.partner - m.partnerGain) / Math.max(0.1, perWeek.partner);
  return over * 10 + user + partner;
}

/** The rejected packages worth a season check, nearest first. One per package. */
export function nearestRejections(
  rejections: readonly Rejection[],
  perWeek: { user: number; partner: number },
  limit = CLOSEST_CHECKED,
): Rejection[] {
  const seen = new Set<string>();
  return rejections
    .filter((r) => NEAR_REASONS.has(r.reason) && r.give.length > 0 && r.get.length > 0)
    .map((r) => ({ r, order: nearOrder(r, perWeek) }))
    .sort((a, b) => a.order - b.order)
    .filter(({ r }) => {
      const key = `${r.partnerKey}:${[...r.give].sort().join('+')}>${[...r.get].sort().join('+')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ r }) => r);
}

export interface ClosestIdea {
  partner: string;
  give: string[];
  get: string[];
  /** Rest-of-season gains, playoff weeks at their weight. */
  you: number | null;
  them: number | null;
  /** Alex's value edge, whole percent, positive his way. */
  edgePercent: number | null;
  /** The fair-to-both rule it breaks, or null when it passes that rule. */
  blockedBy: SeasonCheck['unfair'] | 'not_checked' | null;
  /** What the search said, for one that passes the season rule but was turned away earlier. */
  searchReason: string;
  /** The bars it was held to. */
  bars: { user: number; partner: number };
}

/**
 * The season-checked packages, nearest to fair first: how far Alex's edge is
 * outside the band, plus each side's shortfall against its bar, as shares.
 */
export function rankClosest(
  checked: readonly { partner: string; give: string[]; get: string[]; check: SeasonCheck | undefined; searchReason: string }[],
  weightedWeeks: number | null,
  shown = CLOSEST_SHOWN,
): ClosestIdea[] {
  const bars = gainBars(weightedWeeks);
  const distance = (c: SeasonCheck | undefined): number => {
    if (!c || c.status !== 'ok' || c.you == null || c.them == null || c.edge == null) return Number.POSITIVE_INFINITY;
    const edge = wholePercent(c.edge) / 100;
    const over = Math.max(0, edge - FAIR_TO_BOTH.userEdgeMax) + Math.max(0, -edge - FAIR_TO_BOTH.partnerEdgeMax);
    return over * 10 + Math.max(0, bars.user - c.you) / bars.user + Math.max(0, bars.partner - c.them) / bars.partner;
  };
  return [...checked]
    .sort((a, b) => distance(a.check) - distance(b.check))
    .slice(0, shown)
    .map((x) => ({
      partner: x.partner,
      give: x.give,
      get: x.get,
      you: x.check?.you ?? null,
      them: x.check?.them ?? null,
      edgePercent: x.check?.edge == null ? null : wholePercent(x.check.edge),
      blockedBy: x.check?.status === 'ok' ? (x.check.unfair ?? null) : 'not_checked',
      searchReason: x.searchReason,
      bars,
    }));
}
