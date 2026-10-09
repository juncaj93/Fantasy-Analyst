/**
 * The waiver planner's numbers for the weeks after this one.
 *
 * Two reads, both small, both waiver-only:
 *
 *  - Sleeper's projection for each later week of the window, in this league's
 *    scoring: one settings row a week (`sleeper.aheadPoints.<season>.<week>`),
 *    written by the Waivers refresh and the three-hourly league read.
 *  - A later week's Vegas lines, for the games the odds refresh has already
 *    priced. It reaches nine days ahead (`SLATE_LOOKAHEAD_DAYS`), so this is at
 *    most next week's earliest games. The read is the same keyed props read the
 *    screen already makes, windowed to the time after this week's last kickoff,
 *    and skipped when that window is empty.
 *
 * Nothing here feeds the shared Start/Sit number, Check a trade or trade values.
 */

import { vegasAheadPoints, type AheadNumbers } from '../../core/waivers/aheadWeeks.ts';
import { slateWindow } from '../../core/nfl/slateWindow.ts';
import type { ScoringProfile } from '../../core/sleeper/scoring.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { Database } from '../db.ts';
import { PropsRepo } from '../repos/props.ts';
import { AHEAD_WEEKS, WeekPointsService } from './weekPointsService.ts';

/** This week's games are over this long after the last kickoff. */
const GAME_HOURS = 5;

export async function readWaiverAhead(
  db: Database,
  sleeper: SleeperClient,
  opts: {
    season: string;
    week: number;
    profile: ScoringProfile;
    /** Roster and scanned free agents, with this week's kickoff when known. */
    players: readonly { id: string; position: string | null; kickoff: string | null }[];
    now?: Date;
  },
): Promise<AheadNumbers> {
  const now = opts.now ?? new Date();
  const weeks = Array.from({ length: AHEAD_WEEKS }, (_, i) => opts.week + 1 + i).filter((w) => w <= 18);
  const sleeperRead = new WeekPointsService(db, sleeper).readAhead(opts.season, weeks).catch(() => new Map<number, Map<string, number>>());

  const vegas = new Map<number, Map<string, number>>();
  const valued = opts.players.filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(String(p.position ?? '').toUpperCase()));
  const thisWeek = valued
    .map((p) => (p.kickoff ? Date.parse(p.kickoff) : Number.NaN))
    .filter((t) => Number.isFinite(t) && Math.abs(t - now.getTime()) < 8 * 86_400_000);
  if (thisWeek.length > 0 && weeks.length > 0) {
    const from = new Date(Math.max(...thisWeek) + GAME_HOURS * 3_600_000).toISOString();
    const to = slateWindow(now).to;
    if (from < to) {
      const positionOf = new Map(valued.map((p) => [p.id, p.position]));
      const props = await new PropsRepo(db)
        .latestForPlayers(
          valued.map((p) => p.id),
          { from, to },
        )
        .catch(() => new Map());
      const points = vegasAheadPoints(props, (id) => positionOf.get(id) ?? null, opts.profile);
      if (points.size > 0) vegas.set(weeks[0]!, points);
    }
  }
  return { vegas, sleeper: await sleeperRead };
}
