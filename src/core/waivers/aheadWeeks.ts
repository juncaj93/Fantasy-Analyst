/**
 * A number for each week of the waiver window, not one number for all three.
 *
 * The tier planner used to value every player on one points-a-game figure,
 * this week's Start/Sit number, and multiply it by whether he plays each week.
 * So a bye fill for week 6 was ranked on week 5's matchups: on 9 October 2026
 * Jordan Love was valued on his week-5 Vegas read (18.9) while Sleeper had him
 * at 23.0 and 23.6 for weeks 6 and 7, the two weeks the move was for.
 *
 * The ladder, per window week:
 *
 *  - **this week**: the Start/Sit number exactly as it was (Vegas first, then
 *    Sleeper's published week, then the earlier-week stand-in). Untouched.
 *  - **a later week**:
 *     1. `sleeper`: Sleeper's projection for that week, scored in this
 *        league's rules (`sleeper.aheadPoints.<season>.<week>`).
 *     2. `current`: this week's figure, as before, when there is none.
 *
 * A later week's Vegas lines were a rung too, for one release (waiver@11).
 * Alex dropped it on 13 October 2026: the odds refresh rarely has a complete
 * market for next week's games, it found none in the live run, and the props
 * read it needed was among the day's heaviest. One source for later weeks.
 *
 * Availability (byes, injuries) still multiplies whichever number is used, as
 * it did. A later-week projection under one point is a zero for a game he is
 * not expected to play, not a read of him, and is passed over for the current
 * figure so the injury model keeps the one say on availability.
 *
 * Waiver planner only. The shared Start/Sit number, Check a trade and trade
 * values read none of this.
 */

export type WeekSource = 'this_week' | 'sleeper' | 'current';

export const WEEK_SOURCE_LABEL: Record<WeekSource, string> = {
  this_week: 'this week’s number',
  sleeper: 'Sleeper projection',
  current: 'this week’s number (nothing posted for that week)',
};

/** Below this a later week's projection is a zero for a game he will not play. */
const AHEAD_FLOOR = 1;

export interface AheadNumbers {
  /** Week to player id to points, Sleeper's projection in this league's scoring. */
  sleeper: ReadonlyMap<number, ReadonlyMap<string, number>>;
}

export interface WeekNumber {
  week: number;
  /** Points for that game before availability. Null only when there is no number at all. */
  points: number | null;
  source: WeekSource;
}

/** One player's number for each window week. */
export function weekNumbers(args: {
  playerId: string;
  /** This week's Start/Sit figure, or null when he has none. */
  rate: number | null;
  weeks: readonly number[];
  currentWeek: number;
  ahead: AheadNumbers | null | undefined;
}): WeekNumber[] {
  return args.weeks.map((week) => {
    if (week <= args.currentWeek || !args.ahead) return { week, points: args.rate, source: 'this_week' as const };
    /* A player with no number this week stays unvalued: a later week does not rescue a guess. */
    if (args.rate == null) return { week, points: null, source: 'current' as const };
    const sleeper = args.ahead.sleeper.get(week)?.get(args.playerId);
    if (sleeper != null && Number.isFinite(sleeper) && sleeper >= AHEAD_FLOOR) return { week, points: round2(sleeper), source: 'sleeper' as const };
    return { week, points: args.rate, source: 'current' as const };
  });
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
