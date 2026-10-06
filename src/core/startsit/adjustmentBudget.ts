/**
 * How far everything except the betting market may move a start/sit score.
 *
 * ## The rule
 *
 *     final score = Vegas
 *                 + clamp( sum of the secondary adjustments,
 *                          -10% of Vegas, +10% of Vegas )
 *
 * Reported 6 October 2026 from a Compare sheet: Rhamondre Stevenson, Vegas
 * 8.55, and the non-market pieces summed to about -2.2, roughly -26% of the
 * market number. Two news lines were -2.45 of that. The brief for this module
 * is that the market is about 90% of the answer and everything else is a nudge
 * that can break a near-tie and cannot flip a clear gap.
 *
 * ## What is inside the budget
 *
 * Matchup by role, weather, game script, recent news, lifetime news, role
 * trend, touchdown dependency, explosive role, opportunity and the uncertainty
 * penalty. Each has its own small cap first, then the whole group is held to
 * the total.
 *
 * ## What is not
 *
 * - **The market itself** is the base and is never touched here.
 * - **Availability** (`status`) is a gate or a probability-style discount, not
 *   a nudge. An Out player is not 10% worse, he is not playing. It is outside
 *   the budget and passes through unchanged.
 * - **`replacement_risk`** is the lineup's charge for who covers a risky
 *   starter. It is the same question as availability and is added after this
 *   runs, so it is outside too.
 *
 * ## How the caps are applied
 *
 * In order: each factor to its own cap, the two news lines to their shared cap,
 * then the whole group to the total. Every step scales proportionally rather
 * than cutting one line flat, so the budget can never change which factor was
 * doing the talking or flip a sign, only how loudly it talks. Values are cut
 * toward zero to the cent, so a rounded value can never sit above its cap.
 */

/** The shares of the base, as fractions. Named here and nowhere else. */
export const ADJUSTMENT_BUDGET = {
  /** Everything secondary, together. */
  total: 0.1,
  /** Recent plus lifetime news, together. */
  news: 0.03,
  /** Lifetime news alone. It is a long, stale tally; it gets the least. */
  lifetimeNews: 0.01,
  /** Any other single factor. */
  single: 0.03,
} as const;

/** Keys inside the budget. Anything not listed passes through untouched. */
export const BUDGETED_KEYS: readonly string[] = [
  'news_recent',
  'news_raw',
  'uncertainty',
  'usage_level',
  'role_trend',
  'td_dependency',
  'game_script',
  'weather',
  'matchup_role',
  'explosiveness',
];

const NEWS_KEYS = ['news_recent', 'news_raw'] as const;

const cents = (v: number): number => Math.trunc(v * 100 + (v < 0 ? -1e-9 : 1e-9)) / 100;

const clampTo = (v: number, limit: number): number => Math.max(-limit, Math.min(limit, v));

/** Scale a group in place so its signed sum is within `limit`. */
function scaleGroup(values: Map<string, number>, keys: readonly string[], limit: number): void {
  const present = keys.filter((k) => values.has(k));
  const total = present.reduce((a, k) => a + (values.get(k) ?? 0), 0);
  if (Math.abs(total) <= limit || total === 0) return;
  const scale = limit / Math.abs(total);
  for (const k of present) values.set(k, (values.get(k) ?? 0) * scale);
}

export interface BudgetEntry {
  key: string;
  value: number;
}

/**
 * The budgeted value of every secondary entry, by key.
 *
 * Pure. `base` is the market number the entries are measured against; a base
 * of zero or less leaves nothing to nudge, so every secondary value is zero.
 * Entries outside {@link BUDGETED_KEYS} are not returned.
 */
export function budgetAdjustments(entries: readonly BudgetEntry[], base: number): Map<string, number> {
  const room = Math.max(0, base);
  const values = new Map<string, number>();
  for (const entry of entries) {
    if (!BUDGETED_KEYS.includes(entry.key)) continue;
    const own = entry.key === 'news_raw' ? ADJUSTMENT_BUDGET.lifetimeNews : ADJUSTMENT_BUDGET.single;
    values.set(entry.key, clampTo(entry.value, room * own));
  }
  scaleGroup(values, NEWS_KEYS, room * ADJUSTMENT_BUDGET.news);
  scaleGroup(values, BUDGETED_KEYS, room * ADJUSTMENT_BUDGET.total);
  for (const [key, value] of values) values.set(key, cents(value));
  return values;
}

/** The largest the secondary group may sum to, either sign, for a base. */
export function totalBudget(base: number): number {
  return Math.max(0, base) * ADJUSTMENT_BUDGET.total;
}

/** The shape of a component this module needs. */
export interface BudgetableComponent {
  key: string;
  value: number;
  unknown: boolean;
  /** Set when the budget changed `value`: what it was before. */
  preBudgetValue?: number;
}

/**
 * Apply the budget to a finished list of components, in place.
 *
 * Unknown components are skipped, so a signal nobody has measured cannot
 * absorb or release any of the room. A component the budget changes keeps its
 * old value in `preBudgetValue`, which is what lets `decisionPoints` re-measure
 * it against a different base (a published week) without losing it.
 */
export function applyAdjustmentBudget(components: BudgetableComponent[], base: number): void {
  const live = components.filter((c) => !c.unknown);
  const result = budgetAdjustments(
    live.map((c) => ({ key: c.key, value: c.value })),
    base,
  );
  for (const component of live) {
    const next = result.get(component.key);
    if (next === undefined || next === component.value) continue;
    component.preBudgetValue = component.value;
    component.value = next;
  }
}
