/**
 * "Is the app ready for this season?", answered deterministically.
 *
 * Every March somebody has to find out whether the new season works, and the
 * only way to do it today is to open the app and look at things. That is a bad
 * test: it passes when a screen renders, and the failure this check exists to
 * catch is a screen that renders *last season's numbers*. Nothing looks wrong.
 * The ADP is plausible, the injuries are plausible, the outlooks are plausible,
 * and every one of them is a year old.
 *
 * So the check asks each source one question — **do you have anything stamped
 * with the current season?** — and refuses to accept "here is the newest thing
 * I have" as an answer. That refusal is the entire value of the module. It is
 * also why every check reports the season it *found* alongside the season it
 * *wanted*: `2026 (waiting on 2027)` is a diagnosis, `stale` is a shrug.
 *
 * **Degrading gracefully means naming the source.** In March almost nothing is
 * published yet, and that is not a fault — it is the calendar. A check that
 * went red every spring would be ignored by April. So a source that has not
 * published for a season that has not started reports `waiting`, which is a
 * distinct state from `stale` (it published, but for the wrong season) and from
 * `failed` (it was asked and it broke).
 */

import type { SeasonContext } from './context.ts';
import { ROLLOVER_RULES } from './rollover.ts';

export type CheckStatus =
  /** Current-season data is present. */
  | 'ready'
  /** Nothing yet, and nothing is expected yet. The calendar, not a fault. */
  | 'waiting'
  /** Data exists, but it belongs to a previous season. Must not be served. */
  | 'stale'
  /** The source was asked and could not answer. */
  | 'failed'
  /** Not applicable in the current lifecycle state. */
  | 'skipped';

export interface ReadinessCheck {
  /** The source, as the user would name it: `"ADP"`, `"injuries"`. */
  name: string;
  status: CheckStatus;
  /** The season the app needs from this source. */
  wanted: string;
  /** The season this source actually has, when it has one. */
  found: string | null;
  /** One sentence. Names the source and what it is waiting for. */
  detail: string;
  /**
   * Whether this source failing stops the app being usable.
   *
   * Sleeper is; a Vegas provider is not. The distinction keeps the summary
   * honest — an app that cannot reach Sleeper is broken, an app with no props
   * in March is an app in March.
   */
  blocking: boolean;
}

export interface ReadinessReport {
  season: string;
  /** True when nothing blocking is stale or failed. */
  ready: boolean;
  /** The single most important thing standing in the way, or null. */
  waitingOn: string | null;
  checks: ReadinessCheck[];
  /** The carry-forward/reset table, so the policy is visible in the report. */
  policy: { category: string; disposition: string; reason: string }[];
  /** One line for the top of the panel. */
  summary: string;
}

/** What one source reports about itself. */
export interface SourceReadiness {
  name: string;
  /** The most recent season this source holds anything for, if any. */
  season: string | null;
  /** How many rows/records it holds for that season. Zero counts as nothing. */
  records?: number;
  /** Set when the last attempt to read it threw or returned an error. */
  error?: string | null;
  /**
   * Whether this source publishes for a season before that season starts.
   *
   * ADP does — the market prices next season in May. Weekly injury reports do
   * not; they cannot exist before week one. The difference decides whether
   * "nothing for 2027 in June" is `waiting` or a genuine gap, and getting it
   * wrong in either direction produces an alarm nobody trusts.
   */
  publishesBeforeKickoff?: boolean;
  blocking?: boolean;
}

/**
 * Whether the current season has progressed far enough that a source which only
 * publishes in-season should have something.
 *
 * `regular` with a week of 1 or more is the moment. Before that, an in-season
 * source having nothing is the correct state of the world.
 */
function seasonUnderway(context: SeasonContext): boolean {
  const type = (context.seasonType ?? '').toLowerCase();
  if (type === 'post') return true;
  return type === 'regular' && (context.week ?? 0) >= 1;
}

/**
 * Grade one source against the current season.
 *
 * The whole ladder, in the order that keeps the diagnosis specific: an error is
 * an error whatever the data says; current-season data is ready however sparse;
 * previous-season data is stale, *not* a fallback; and nothing at all is either
 * waiting or a gap, depending on whether it is reasonable to have nothing.
 */
export function gradeSource(source: SourceReadiness, context: SeasonContext): ReadinessCheck {
  const wanted = context.season;
  const blocking = source.blocking ?? false;
  const found = source.season ?? null;
  const has = found != null && (source.records ?? 1) > 0;

  if (source.error) {
    return {
      name: source.name,
      status: 'failed',
      wanted,
      found,
      detail: `${source.name} could not be read: ${source.error}`,
      blocking,
    };
  }

  if (has && found === wanted) {
    return {
      name: source.name,
      status: 'ready',
      wanted,
      found,
      detail: `${source.name} has ${wanted} data`,
      blocking,
    };
  }

  /*
   * Data, but from the wrong season.
   *
   * The critical invariant of §5 lives in this branch. There is a real
   * temptation to call this "ready with old data" and let the app carry on —
   * the numbers are right there, they parse, they render. They are also a year
   * out of date, and serving them is worse than serving nothing, because
   * nothing is visibly nothing.
   */
  if (has) {
    const expectedYet = source.publishesBeforeKickoff || seasonUnderway(context);
    return {
      name: source.name,
      status: expectedYet ? 'stale' : 'waiting',
      wanted,
      found,
      detail: expectedYet
        ? `${source.name} still has only ${found} data — ${wanted} has not been published, and ${found} is not being used as ${wanted}`
        : `${source.name} has ${found} data and is waiting for ${wanted}`,
      blocking,
    };
  }

  const expectedYet = source.publishesBeforeKickoff || seasonUnderway(context);
  return {
    name: source.name,
    status: expectedYet ? 'stale' : 'waiting',
    wanted,
    found: null,
    detail: expectedYet
      ? `${source.name} has nothing for ${wanted} and should have by now`
      : `${source.name} has not published ${wanted} yet`,
    blocking,
  };
}

/**
 * The full report.
 *
 * `ready` is about blocking sources only, and deliberately tolerant of
 * `waiting`: an app in March with no injury reports is working correctly, and a
 * check that said otherwise would be wrong eleven months a year.
 */
export function buildReadinessReport(sources: readonly SourceReadiness[], context: SeasonContext): ReadinessReport {
  const checks = sources.map((s) => gradeSource(s, context));

  /*
   * The season itself is a source, and the first one worth checking.
   *
   * If `/state/nfl` has not been read, every other check below is grading
   * sources against a season nobody confirmed — and the calendar fallback is
   * exactly wrong for the six weeks either side of the March boundary. So this
   * is prepended rather than left implicit, and it blocks.
   */
  checks.unshift({
    name: 'Sleeper season state',
    status: context.assumed ? 'stale' : context.stateStale ? 'stale' : 'ready',
    wanted: context.season,
    found: context.assumed ? null : context.season,
    detail: context.reason,
    blocking: true,
  });

  const broken = checks.filter((c) => c.blocking && (c.status === 'stale' || c.status === 'failed'));
  const ready = broken.length === 0;

  /*
   * What to name as the thing being waited on.
   *
   * A blocking problem outranks a non-blocking one, and among equals the first
   * in the caller's order wins — callers pass sources roughly in order of how
   * much the app depends on them, and "waiting on Sleeper" is more useful than
   * "waiting on Vegas props" when both are true.
   */
  const waiting = broken[0] ?? checks.find((c) => c.status === 'waiting' || c.status === 'stale' || c.status === 'failed') ?? null;

  return {
    season: context.season,
    ready,
    waitingOn: waiting ? waiting.name : null,
    checks,
    policy: ROLLOVER_RULES.map((r) => ({ category: r.category, disposition: r.disposition, reason: r.reason })),
    summary: ready
      ? waiting
        ? `Ready for ${context.season}; still waiting on ${waiting.name}.`
        : `Ready for ${context.season}.`
      : `Not ready for ${context.season}: ${broken.map((c) => c.name).join(', ')}.`,
  };
}
