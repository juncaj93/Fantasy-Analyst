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
 * ## A bye is a zero, never a number (review finding W1, 4 November 2026)
 *
 * His bye week has no game, so it carries 0 and the source `bye`, before any
 * rung above is read. Until then the week kept whatever the ladder found: a
 * rostered receiver on bye in week 9 showed his week 8 projection (4.89) as
 * "this week's number" in weeks 9, 10 and 11, and Jordan Love's week 11 bye
 * showed 18.00. The lineup math already multiplied that number by a zero, so
 * the tiers were right, but every reader of the number (the sheets, the
 * free agent's week list, the audit) was shown a game that does not exist.
 *
 * And when this week's figure is itself an earlier week's projection (the
 * `recent_week` rung of `tradeValue/rate.ts`), the week says so: `fromWeek`
 * is that week, so a sheet can say "week 8 projection" instead of "this week".
 *
 * Waiver planner only. The shared Start/Sit number, Check a trade and trade
 * values read none of this.
 */

/** `season`: a week after the near window, valued at his rest-of-season rate (round 6). */
export type WeekSource = 'this_week' | 'sleeper' | 'current' | 'bye' | 'season';

export const WEEK_SOURCE_LABEL: Record<WeekSource, string> = {
  this_week: 'this week’s number',
  sleeper: 'Sleeper projection',
  current: 'this week’s number (nothing posted for that week)',
  bye: 'bye: no game',
  season: 'season value',
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
  /** Set when the number is an earlier week's projection standing in: that week. */
  fromWeek?: number;
}

/** One player's number for each window week. */
export function weekNumbers(args: {
  playerId: string;
  /** This week's Start/Sit figure, or null when he has none. */
  rate: number | null;
  weeks: readonly number[];
  currentWeek: number;
  ahead: AheadNumbers | null | undefined;
  /** His club's bye week, when known. That week is 0 with the source `bye`. */
  byeWeek?: number | null;
  /** The week his `rate` was projected for, when it is an earlier week's projection standing in. */
  rateWeek?: number | null;
}): WeekNumber[] {
  const from = args.rateWeek != null && args.rateWeek < args.currentWeek ? { fromWeek: args.rateWeek } : {};
  return args.weeks.map((week): WeekNumber => {
    if (args.byeWeek != null && week === args.byeWeek) return { week, points: 0, source: 'bye' };
    if (week <= args.currentWeek || !args.ahead) return { week, points: args.rate, source: 'this_week', ...(args.rate != null ? from : {}) };
    /* A player with no number this week stays unvalued: a later week does not rescue a guess. */
    if (args.rate == null) return { week, points: null, source: 'current' };
    const sleeper = args.ahead.sleeper.get(week)?.get(args.playerId);
    if (sleeper != null && Number.isFinite(sleeper) && sleeper >= AHEAD_FLOOR) return { week, points: round2(sleeper), source: 'sleeper' };
    return { week, points: args.rate, source: 'current', ...from };
  });
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
