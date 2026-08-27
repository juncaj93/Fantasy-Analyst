/**
 * The annual readiness check, wired to the actual stores.
 *
 * `core/season/readiness.ts` grades a list of sources; this is what goes round
 * the database and builds that list. Deliberately read-only and deliberately
 * cheap — one indexed read per source, no fetches — because the point is to be
 * runnable at any moment, including from a phone in March, without costing
 * anything on a free tier.
 *
 * ## ADP, specifically
 *
 * `adp_snapshots` now stamps its own `season` at import time (see
 * `AdpRepo.save` and migration 0035) instead of leaving this check to guess
 * one from `captured_at`. That guess used to be the entire point of failure
 * §2 describes: a snapshot captured in August 2026 sorts as "newest" straight
 * through the 2027 preseason if nobody has imported this year's board yet, and
 * nothing on screen would say the numbers are a year old, because the numbers
 * still look like ADP and rank like ADP. Reading the stamped season instead of
 * inferring one from a timestamp is what lets this check catch that.
 *
 * That is the whole reason this check exists rather than "open the app and see
 * if it looks right". It looks right.
 */

import type { SeasonContext } from '../../core/season/context.ts';
import { buildReadinessReport, type ReadinessReport, type SourceReadiness } from '../../core/season/readiness.ts';
import { findSuccessorLeague, type LeagueLike, type SuccessionResult } from '../../core/season/rollover.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { InjuryRepo } from '../repos/injury.ts';
import { LeagueRepo } from '../repos/league.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import { UsageRepo } from '../repos/usage.ts';
import { currentSeasonContext } from './seasonService.ts';

export interface RolloverReport extends ReadinessReport {
  /** Whether the selected league is for the season the NFL is actually in. */
  league: {
    selected: { id: string; name: string; season: string } | null;
    /** Set when the selected league is from a previous season. */
    succession: SuccessionResult | null;
  };
}

/**
 * Gather every source's season and grade it.
 *
 * Ordered by how much the app depends on the source, because the report names
 * the *first* problem as the thing being waited on and "waiting on Sleeper" is
 * a more useful sentence than "waiting on Vegas props" when both are true.
 */
export async function buildRolloverReport(db: Database, now = new Date()): Promise<RolloverReport> {
  const context = await currentSeasonContext(db, now);
  const leagues = new LeagueRepo(db);

  const injuries = new InjuryRepo(db);
  const usage = new UsageRepo(db);

  /*
   * Two questions per ingest source, not one.
   *
   * `coverage(currentSeason)` answers "have you got this season?" and
   * `latestRun()` answers "what have you got instead?". Asking only the first
   * gives a report that says `nothing` where it should say `2026 (waiting on
   * 2027)`, and the difference between those two sentences is the difference
   * between a diagnosis and a shrug.
   */
  const adp = new AdpRepo(db);
  const [allLeagues, adpCurrent, adpNewest, injuryCurrent, injuryRun, usageCurrent, usageRun, marketSnapshot] = await Promise.all([
    leagues.listLeagues(),
    adp.latest(context.season).catch(() => null),
    // The fallback for "what have you got instead?" — see `held` below. Not
    // scoped to the current season on purpose: this is the one place that
    // deliberately wants the newest snapshot of *any* season, so a stale
    // prior-season import can be named rather than reported as nothing.
    adp.list().then((s) => s[0] ?? null).catch(() => null),
    injuries.coverage(context.season).catch(() => ({ players: 0, latestWeek: null })),
    injuries.latestRun().catch(() => null),
    usage.coverage(context.season).catch(() => ({ players: 0, weeks: 0, latestWeek: null, rows: 0 })),
    usage.latestRun().catch(() => null),
    new SeasonMarketsRepo(db).latestSnapshot(context.season).catch(() => null),
  ]);

  const selected = allLeagues.find((l) => l.isSelected) ?? null;

  const sources: SourceReadiness[] = [
    {
      name: 'Sleeper league',
      season: selected?.season ?? null,
      records: selected ? 1 : 0,
      // A league for the new season exists the moment the commissioner makes
      // it, which is well before kickoff — so having none in August is a gap,
      // not the calendar.
      publishesBeforeKickoff: true,
      blocking: true,
    },
    {
      name: 'ADP',
      ...held(context.season, adpCurrent?.matchedCount ?? 0, adpNewest?.season ?? null),
      // The market prices next season from May onward.
      publishesBeforeKickoff: true,
      blocking: true,
    },
    {
      name: 'injury reports',
      ...held(context.season, injuryCurrent.players, injuryRun?.season ?? null),
      // Weekly reports cannot exist before week one. Nothing in August is
      // correct, not a fault, and an alarm here every preseason is an alarm
      // nobody reads in November.
      publishesBeforeKickoff: false,
      blocking: false,
      error: injuryRun?.outcome === 'failed' ? (injuryRun.note ?? 'the last ingest failed') : null,
    },
    {
      name: 'weekly usage',
      ...held(context.season, usageCurrent.players, usageRun?.season ?? null),
      publishesBeforeKickoff: false,
      blocking: false,
      error: usageRun?.outcome === 'failed' ? (usageRun.note ?? 'the last ingest failed') : null,
    },
    {
      name: 'season markets',
      season: marketSnapshot ? marketSnapshot.season : null,
      records: marketSnapshot ? 1 : 0,
      publishesBeforeKickoff: true,
      blocking: false,
    },
  ];

  const report = buildReadinessReport(sources, context);

  return {
    ...report,
    league: {
      selected: selected ? { id: selected.id, name: selected.name, season: selected.season } : null,
      succession: successionFor(selected, allLeagues, context),
    },
  };
}

/**
 * Which league to move to, when the selected one is from a season that has passed.
 *
 * Null when there is nothing to decide — no league selected, or the selected
 * league is already the current season's. Computing it unconditionally would
 * put a "switch league?" prompt in front of somebody in week 9.
 */
function successionFor(
  selected: { id: string; name: string; season: string; totalRosters: number } | null,
  all: readonly { id: string; name: string; season: string; totalRosters: number }[],
  context: SeasonContext,
): SuccessionResult | null {
  if (!selected) return null;
  if (selected.season === context.season) return null;

  const asLeague = (l: typeof selected): LeagueLike => ({
    id: l.id,
    name: l.name,
    season: l.season,
    totalRosters: l.totalRosters,
  });

  return findSuccessorLeague(
    asLeague(selected),
    all.filter((l) => l.season === context.season).map(asLeague),
  );
}

/**
 * What a source actually holds, as the grader wants it.
 *
 * Current-season rows win outright. Failing that the last run's season is
 * reported, which is what turns "nothing" into "2026, waiting on 2027" — and
 * `records: 1` is a token, not a count: the grader only asks whether there is
 * *anything*, and the honest count for a season we did not query is unknown.
 */
function held(
  season: string,
  currentRecords: number,
  lastRunSeason: string | null,
): { season: string | null; records: number } {
  if (currentRecords > 0) return { season, records: currentRecords };
  if (lastRunSeason && lastRunSeason !== season) return { season: lastRunSeason, records: 1 };
  return { season: null, records: 0 };
}
