/**
 * The three D1 reads the DST planner needs, and nothing else.
 *
 * The assembly itself moved to `core/dst/assemble.ts` — it is arithmetic over
 * rows rather than a fact about a database, and Demo Mode has to run the same
 * one. What is left here is the part that genuinely belongs to a deployment:
 * which repositories answer which question.
 *
 * ## What it costs, and why that is the shape it is
 *
 * Three D1 reads on top of what the waiver scan already loads, all bounded and
 * none of them a fetch:
 *
 *   1. **the coming week's fixtures** — thirty-two rows, and the reason the
 *      defence model finally has a home-field term;
 *   2. **the planner's teams over the planner's weeks** — the rostered defences
 *      and the bounded free-agent pool, across the next few weeks and the
 *      league's own playoff weeks. About a hundred rows;
 *   3. **the implied total each offence has been priced at this season** —
 *      aggregated in SQL, at most one row per team.
 *
 * No provider is called, no cron is added and nothing is backfilled. The Vegas
 * budget is untouched: every number here comes out of rows some earlier refresh
 * already paid for.
 */

import { NflScheduleRepo } from '../repos/nflSchedule.ts';
import { VegasEventsRepo } from '../repos/vegasEvents.ts';
import {
  assembleDstPlan,
  seasonStartIso,
  type DstPlanRequest,
  type DstPlanSources,
} from '../../core/dst/assemble.ts';
import type { DstPlan } from '../../core/dst/planner.ts';
import type { TeamForm } from '../../core/dst/outlook.ts';
import type { ScheduleTeamWeek } from '../../core/nfl/schedule.ts';
import type { Database } from '../db.ts';

export type { DstPlanRequest } from '../../core/dst/assemble.ts';

/** The deployment's answer to the planner's three questions. */
export function dstPlanSourcesFrom(db: Database): DstPlanSources {
  const schedule = new NflScheduleRepo(db);
  return {
    fixturesForWeek: (season, week): Promise<ScheduleTeamWeek[]> => schedule.forWeek(season, week),
    scheduleForTeams: (season, teams, range): Promise<ScheduleTeamWeek[]> =>
      schedule.forTeams(season, teams, range),
    impliedTotals: (season, now): Promise<Map<string, TeamForm>> =>
      new VegasEventsRepo(db).impliedTotalsByTeam(seasonStartIso(season), now.toISOString()),
  };
}

/**
 * Build the plan, or return null when a defence is not a question in this
 * league.
 *
 * Kept as a function of a database so every existing caller and test is
 * untouched; the work is `assembleDstPlan`'s.
 */
export function buildDstPlan(db: Database, request: DstPlanRequest): Promise<DstPlan | null> {
  return assembleDstPlan(dstPlanSourcesFrom(db), request);
}

/*
 * `playoffContextFor` moved to `core/league/planning.ts`.
 *
 * It reads a league's own settings and its own record and never touched a
 * defence, a schedule or a database — and Demo Mode needs the same reader, so
 * leaving it beside a repository import would have meant a second copy of a
 * rule the league publishes. Re-exported here so every existing caller keeps
 * the import it has.
 */
export { playoffContextFor } from '../../core/league/planning.ts';
