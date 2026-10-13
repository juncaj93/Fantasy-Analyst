/**
 * The waiver planner's numbers for the weeks after this one: Sleeper's
 * projection for each later week of the window, in this league's scoring.
 *
 * One settings row a week (`sleeper.aheadPoints.<season>.<week>`), written by
 * the three-hourly league read. A later week's Vegas lines are not read: Alex
 * dropped that rung on 13 October 2026 (see `core/waivers/aheadWeeks.ts`).
 *
 * Nothing here feeds the shared Start/Sit number, Check a trade or trade values.
 */

import type { AheadNumbers } from '../../core/waivers/aheadWeeks.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { Database } from '../db.ts';
import { AHEAD_WEEKS, WeekPointsService } from './weekPointsService.ts';

export async function readWaiverAhead(
  db: Database,
  sleeper: SleeperClient,
  opts: { season: string; week: number },
): Promise<AheadNumbers> {
  const weeks = Array.from({ length: AHEAD_WEEKS }, (_, i) => opts.week + 1 + i).filter((w) => w <= 18);
  const sleeperWeeks = await new WeekPointsService(db, sleeper).readAhead(opts.season, weeks).catch(() => new Map<number, Map<string, number>>());
  return { sleeper: sleeperWeeks };
}
