/**
 * The app's week: the one every in-season screen shows (Alex's decision,
 * 11 November 2026).
 *
 * Sleeper keeps reporting the week just played until it moves on by itself,
 * which in 2026 was after Wednesday evening. Until then Team, Matchup, Compare,
 * Waivers and Trades showed the finished week next to the coming week's
 * betting lines: last week's byes (Coleman and Lemon read "Bye" on Wednesday
 * 11 November because Denver and Philadelphia rested in week 10), last week's
 * numbers, last week's head-to-head.
 *
 * The rule: the app moves to the next week once the last game of Sleeper's
 * week is final, and never before 3:00 AM Eastern on the Tuesday after it.
 *
 *  - "Final" is {@link FINAL_AFTER_KICKOFF_HOURS} after the week's last
 *    kickoff, from the stored NFL schedule. No game has run past four hours.
 *  - A week whose last game is on a Tuesday (a postponement) rolls when that
 *    game is final, which is later than Tuesday 3 AM.
 *  - No schedule for the week, or a week that is not the regular season,
 *    keeps Sleeper's week: the app never guesses forward.
 *  - Once Sleeper itself moves on, its week is the answer again.
 *
 * Sleeper's own week is untouched: the stored state, and every call that asks
 * Sleeper about its current week (league sync, transactions, settling a
 * finished matchup), keep Sleeper's number. This is the week the screens show.
 */

/** Hours after the last kickoff when the week counts as final. */
export const FINAL_AFTER_KICKOFF_HOURS = 4.5;

/** The earliest the app moves on: this hour, Eastern, on the Tuesday after the week. */
export const ROLLOVER_HOUR_EASTERN = 3;

/** The last regular-season week. The app does not roll past it. */
export const LAST_REGULAR_WEEK = 18;

export interface AppWeekInput {
  /** Sleeper's week, from the stored `/state/nfl`. */
  sleeperWeek: number | null | undefined;
  /** Sleeper's season type: only `regular` rolls. */
  seasonType: string | null | undefined;
  /** The last kickoff of Sleeper's week, from the stored schedule (ISO), or null when unknown. */
  lastKickoff: string | null | undefined;
  now: Date | number;
}

/** The app's week. Sleeper's week, or the next one once the rule above says so. */
export function appWeek(input: AppWeekInput): number | null {
  const week = Number(input.sleeperWeek);
  if (!Number.isInteger(week) || week < 1) return input.sleeperWeek ?? null;
  const rollAt = rolloverAt(input);
  if (rollAt == null) return week;
  const now = typeof input.now === 'number' ? input.now : input.now.getTime();
  return now >= rollAt ? week + 1 : week;
}

/** When the app moves past Sleeper's week (epoch ms), or null when it will not. */
export function rolloverAt(input: Omit<AppWeekInput, 'now'>): number | null {
  const week = Number(input.sleeperWeek);
  if (!Number.isInteger(week) || week < 1 || week >= LAST_REGULAR_WEEK) return null;
  if ((input.seasonType ?? '').trim().toLowerCase() !== 'regular') return null;
  const kickoff = input.lastKickoff ? Date.parse(input.lastKickoff) : Number.NaN;
  if (!Number.isFinite(kickoff)) return null;
  const final = kickoff + FINAL_AFTER_KICKOFF_HOURS * 3_600_000;
  return Math.max(final, tuesdayAfter(kickoff));
}

/** 3:00 AM Eastern on the first Tuesday on or after the day of `kickoff` (Eastern). */
function tuesdayAfter(kickoff: number): number {
  const { year, month, day, weekday } = easternDate(kickoff);
  const ahead = (2 - weekday + 7) % 7; // 0 Sunday ... 2 Tuesday
  const date = new Date(Date.UTC(year, month - 1, day + ahead));
  return easternInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), ROLLOVER_HOUR_EASTERN);
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function easternDate(at: number): { year: number; month: number; day: number; weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    hour: Number(get('hour')) % 24,
  };
}

/** The instant of `hour`:00 Eastern on a calendar date, standard or daylight time. */
function easternInstant(year: number, month: number, day: number, hour: number): number {
  for (const offset of [5, 4]) {
    const at = Date.UTC(year, month - 1, day, hour + offset);
    const e = easternDate(at);
    if (e.day === day && e.hour === hour) return at;
  }
  return Date.UTC(year, month - 1, day, hour + 5);
}
