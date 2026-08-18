/**
 * What a player is worth this week, and what he is worth for the next month.
 *
 * A waiver claim and a trade are not this-Sunday questions, and the number that
 * answers this Sunday is the wrong one to answer them with. A back with a
 * fifteen-point week whose starter returns on Thursday is a one-week rental; a
 * receiver with a nine-point week whose target share has doubled into a soft
 * month is the claim to spend on. Both facts already exist in this app — in the
 * role detector, the schedule outlook, the injury layer, the expected-points
 * read — and none of them were ever combined into a horizon.
 *
 * ## Two numbers, deliberately
 *
 * `thisWeek` is the Start/Sit score, unchanged and unadjusted: it is the number
 * the lineup screen shows and it must stay the same number here, or two screens
 * would disagree about the same player on the same day.
 *
 * `nextFourPerWeek` is that score carried forward through the things that
 * change over a month — the schedule for his role, whether the role itself is
 * moving, whether his production has been running ahead of his opportunity, and
 * whether somebody is coming back to take it. Each adjustment is a separate,
 * bounded, inspectable component in exactly the style of the two engines, so a
 * card can show the arithmetic rather than a verdict.
 *
 * ## The bye is a count, not a discount
 *
 * A bye does not make a player worse; it makes him unavailable for one of the
 * weeks you were counting. So it never touches the per-week value — it reduces
 * `weeksAvailable`, and `nextFourTotal` falls out of the multiplication. That
 * keeps "how good is he" and "how many times do I get him" as two answers,
 * which is what a manager choosing between a bye-week stopgap and a hold
 * actually needs.
 *
 * ## Weather is not in here, and that is the point
 *
 * A forecast is useful for about a week. Beyond {@link RELIABLE_FORECAST_DAYS}
 * it is climatology with a decimal point on it, and a multi-week value that
 * moved on a fifteen-day forecast would be inventing precision out of a website
 * that does not have it. Weather stays in the weekly score, where the forecast
 * horizon is real, and this module says so rather than silently omitting it.
 */

import type { XfpAssessment } from '../xfp/model.ts';
import type { RoleScheduleOutlook } from '../schedule/roleStrength.ts';
import type { RoleAssessment } from '../startsit/decisions.ts';
import type { UsageAssessment } from '../startsit/usageTrend.ts';

/** Days a forecast is worth reading. Past this, weather is not a signal. */
export const RELIABLE_FORECAST_DAYS = 7;

export const MULTI_WEEK = {
  /** Weeks in the horizon. */
  horizon: 4,
  /** The most the role-specific schedule may move a per-week value. */
  maxSchedulePoints: 1,
  /** The most a rising or collapsing role may move it. */
  maxRolePoints: 1.2,
  /**
   * The most the expected-points gap may move it.
   *
   * Small, and smaller than the role component on purpose: `FPOE` is the best
   * available statement that a hot streak was luck, and it is built on league
   * average rates with no red-zone data. It is allowed to lean on a valuation;
   * it is not allowed to run one.
   */
  maxRegressionPoints: 0.9,
  /** The most an imminent return by the man ahead of him may cost. */
  maxReturnPoints: 3,
} as const;

export type ValueVerdict = 'hold' | 'rising_asset' | 'sell_high' | 'one_week_rental' | 'streamer' | 'unknown';

export const VALUE_LABEL: Record<ValueVerdict, string> = {
  hold: 'Worth holding',
  rising_asset: 'Rising asset',
  sell_high: 'Sell high',
  one_week_rental: 'One-week rental',
  streamer: 'Streaming-level',
  unknown: 'Not enough to value',
};

export interface ValueComponent {
  key: string;
  label: string;
  /** Points per week, signed. */
  value: number;
  display: string;
  unknown: boolean;
}

export interface ReturningStarter {
  name: string;
  /** The week he is expected back. Null when nobody will say. */
  expectedWeek: number | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface MultiWeekInput {
  playerId: string;
  name: string;
  position: string;
  currentWeek: number;
  /** The Start/Sit score, exactly as the lineup screen has it. */
  thisWeekScore: number | null;
  usage?: UsageAssessment | null;
  role?: RoleAssessment | null;
  schedule?: RoleScheduleOutlook | null;
  xfp?: XfpAssessment | null;
  /** The player's bye. Null when the schedule is not loaded. */
  byeWeek?: number | null;
  /** The starter whose absence created this opportunity, if there is one. */
  returningStarter?: ReturningStarter | null;
  horizon?: number;
}

export interface MultiWeekValue {
  playerId: string;
  name: string;
  thisWeek: number | null;
  /** Per week over the horizon, in the same fantasy points. */
  nextFourPerWeek: number | null;
  /** Per-week value times the weeks he is actually available. */
  nextFourTotal: number | null;
  weeksAvailable: number;
  horizon: number;
  components: ValueComponent[];
  roleStability: { state: 'stable' | 'rising' | 'declining' | 'volatile' | 'unknown'; detail: string };
  verdict: ValueVerdict;
  label: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export function valueOverWeeks(input: MultiWeekInput): MultiWeekValue {
  const horizon = input.horizon ?? MULTI_WEEK.horizon;
  const components: ValueComponent[] = [];
  const notes: string[] = [];

  const schedule = scheduleComponent(input.schedule ?? null);
  components.push(schedule);
  const role = roleComponent(input.role ?? null);
  components.push(role);
  const regression = regressionComponent(input.xfp ?? null);
  components.push(regression);
  const returning = returnComponent(input.returningStarter ?? null, input.currentWeek, horizon);
  components.push(returning);

  const base = input.thisWeekScore;
  const adjustment = components.filter((c) => !c.unknown).reduce((a, c) => a + c.value, 0);
  const perWeek = base == null ? null : round2(base + adjustment);

  /*
   * How many of the next four weeks he is actually there for.
   *
   * The bye is the only thing that removes a week here. An injury that has
   * already happened is in the score; an injury that has not is not something
   * this module is willing to guess at.
   */
  const byeInWindow =
    input.byeWeek != null && input.byeWeek > input.currentWeek && input.byeWeek <= input.currentWeek + horizon;
  const weeksAvailable = horizon - (byeInWindow ? 1 : 0);
  if (byeInWindow) notes.push(`bye in week ${input.byeWeek} — ${weeksAvailable} of the next ${horizon} weeks`);
  if (input.byeWeek == null) notes.push('bye week unknown');

  notes.push(`weather is not in this number: a forecast is worth about ${RELIABLE_FORECAST_DAYS} days, and this is a ${horizon}-week horizon`);
  if (input.schedule?.notes?.length) notes.push(...input.schedule.notes);

  const stability = roleStability(input.usage ?? null, input.role ?? null);
  const known = components.filter((c) => !c.unknown).length;
  const confidence: 'high' | 'medium' | 'low' =
    base == null ? 'low' : known >= 3 ? 'high' : known >= 2 ? 'medium' : 'low';

  return {
    playerId: input.playerId,
    name: input.name,
    thisWeek: base,
    nextFourPerWeek: perWeek,
    nextFourTotal: perWeek == null ? null : round2(perWeek * weeksAvailable),
    weeksAvailable,
    horizon,
    components,
    roleStability: stability,
    verdict: verdictOf(base, perWeek, input, stability),
    label: VALUE_LABEL[verdictOf(base, perWeek, input, stability)],
    confidence,
    notes,
  };
}

/**
 * The month ahead, scaled from the matchup component's own units.
 *
 * The schedule outlook is already in fantasy points — it is the mean of the
 * same per-week matchup component the lineup card shows — so the only work here
 * is bounding it. Scaled by how much of the window could actually be rated, so
 * a one-week opinion does not speak with a four-week voice.
 */
function scheduleComponent(outlook: RoleScheduleOutlook | null): ValueComponent {
  if (!outlook || outlook.averagePoints == null || outlook.rated === 0) {
    return { key: 'schedule', label: 'Schedule for his role', value: 0, display: 'unknown', unknown: true };
  }
  const coverage = outlook.total === 0 ? 0 : outlook.rated / Math.max(1, outlook.total - outlook.byes);
  const value = clamp(outlook.averagePoints * coverage, -MULTI_WEEK.maxSchedulePoints, MULTI_WEEK.maxSchedulePoints);
  return {
    key: 'schedule',
    label: 'Schedule for his role',
    value: round2(value),
    display: outlook.display,
    unknown: false,
  };
}

/** A role that is moving is the strongest multi-week signal there is. */
function roleComponent(role: RoleAssessment | null): ValueComponent {
  if (!role || role.trend === 'insufficient_data') {
    return { key: 'role_trend', label: 'Role trend', value: 0, display: 'insufficient data', unknown: true };
  }
  const scale: Record<string, number> = {
    rising_high: 1,
    rising_moderate: 0.55,
    stable: 0,
    falling_moderate: -0.55,
    falling_high: -1,
    // One big afternoon inside an otherwise flat role is precisely the thing a
    // month-long valuation must not buy. The detector already separated it from
    // a rise; this is where that separation is worth something.
    spike: 0,
  };
  const factor = scale[role.trend] ?? 0;
  return {
    key: 'role_trend',
    label: 'Role trend',
    value: round2(factor * MULTI_WEEK.maxRolePoints),
    display: role.label,
    unknown: false,
  };
}

/**
 * Production that has been running ahead of opportunity, priced as the debt it
 * is.
 *
 * Only the two readings that are actually about the future move a valuation.
 * `td_regression_risk` is the sell signal and `role_healthy_despite_box_score`
 * is the buy signal; `production_outrunning_opportunity` is a milder version of
 * the first and `usage_stronger_than_results` is a bad player with a bad box
 * score, which is not a discount, it is agreement.
 */
function regressionComponent(xfp: XfpAssessment | null): ValueComponent {
  if (!xfp || xfp.interpretation === 'insufficient_data') {
    return { key: 'xfp_gap', label: 'Opportunity vs production', value: 0, display: 'unknown', unknown: true };
  }
  const factor: Record<string, number> = {
    td_regression_risk: -1,
    production_outrunning_opportunity: -0.5,
    role_healthy_despite_box_score: 1,
    usage_stronger_than_results: 0,
    matched: 0,
  };
  return {
    key: 'xfp_gap',
    label: 'Opportunity vs production',
    value: round2((factor[xfp.interpretation] ?? 0) * MULTI_WEEK.maxRegressionPoints),
    display: xfp.label,
    unknown: false,
  };
}

/**
 * The man ahead of him, and when he is due back.
 *
 * Priced by how much of the horizon is left after he returns, so a starter due
 * back next week takes most of the value and one due back in the last week of
 * the window takes almost none. An unknown return date is not treated as "never
 * returns" — it is a bounded discount with the uncertainty said out loud,
 * because "he is on IR and nobody has given a date" is genuinely worth less
 * than "he is out for the season".
 */
function returnComponent(
  returning: ReturningStarter | null,
  currentWeek: number,
  horizon: number,
): ValueComponent {
  if (!returning) {
    return { key: 'starter_return', label: 'Starter returning', value: 0, display: 'nobody to return', unknown: true };
  }
  if (returning.expectedWeek == null) {
    return {
      key: 'starter_return',
      label: 'Starter returning',
      value: round2(-MULTI_WEEK.maxReturnPoints * 0.3),
      display: `${returning.name} is out with no return date`,
      unknown: false,
    };
  }
  const weeksLost = Math.max(0, Math.min(horizon, currentWeek + horizon - returning.expectedWeek));
  if (weeksLost === 0) {
    return {
      key: 'starter_return',
      label: 'Starter returning',
      value: 0,
      display: `${returning.name} is not back inside this window`,
      unknown: false,
    };
  }
  const trust = { high: 1, medium: 0.75, low: 0.5 }[returning.confidence];
  return {
    key: 'starter_return',
    label: 'Starter returning',
    value: round2(-MULTI_WEEK.maxReturnPoints * (weeksLost / horizon) * trust),
    display: `${returning.name} expected back in week ${returning.expectedWeek} — ${weeksLost} of ${horizon} weeks`,
    unknown: false,
  };
}

/**
 * How much the role can be relied on to still be there.
 *
 * Volume and trend together: a big role that is falling is not stable, and a
 * small role that is rising is not stable either — it is *improving*, which is
 * worth saying differently because it is worth a different transaction.
 */
function roleStability(
  usage: UsageAssessment | null,
  role: RoleAssessment | null,
): { state: 'stable' | 'rising' | 'declining' | 'volatile' | 'unknown'; detail: string } {
  if (!usage || usage.unknown || !role || role.trend === 'insufficient_data') {
    return { state: 'unknown', detail: 'not enough per-game usage to say whether the role is settled' };
  }
  if (role.trend === 'rising_high' || role.trend === 'rising_moderate') {
    return { state: 'rising', detail: `${role.label} — the role is still being built` };
  }
  if (role.trend === 'falling_high' || role.trend === 'falling_moderate') {
    return { state: 'declining', detail: `${role.label} — the role is being taken away` };
  }
  if (usage.score >= 0.2) return { state: 'stable', detail: `${usage.display}, and steady` };
  return { state: 'volatile', detail: `${usage.display} — a small role is a fragile one` };
}

function verdictOf(
  thisWeek: number | null,
  perWeek: number | null,
  input: MultiWeekInput,
  stability: { state: string },
): ValueVerdict {
  if (thisWeek == null || perWeek == null) return 'unknown';
  const returning = input.returningStarter;
  const horizon = input.horizon ?? MULTI_WEEK.horizon;
  if (returning && returning.expectedWeek != null && returning.expectedWeek <= input.currentWeek + 1) {
    return 'one_week_rental';
  }
  if (input.xfp?.interpretation === 'td_regression_risk' && perWeek < thisWeek) return 'sell_high';
  if (stability.state === 'rising' && perWeek >= thisWeek) return 'rising_asset';
  if (perWeek < thisWeek - MULTI_WEEK.maxReturnPoints * (1 / horizon)) return 'one_week_rental';
  if (stability.state === 'volatile') return 'streamer';
  return 'hold';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
