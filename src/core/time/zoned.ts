/**
 * Wall-clock parts of an instant in a named time zone.
 *
 * Cron triggers fire in UTC and a person thinks in Detroit. The two differ by
 * four hours until the first Sunday of November and five after it, so "Wednesday
 * at noon" is 16:00 UTC for most of the season and 17:00 UTC for the rest.
 * A fixed UTC hour is therefore wrong for half the year; asking the platform's
 * own zone database what the wall clock says is wrong for none of it.
 *
 * `Intl` is in every runtime this code runs in (Workers, Node, the browser), and
 * the answer is for the instant given, so the changeover needs no special case.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** 0 is Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const read = new Map<string, string>();
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) read.set(part.type, part.value);
  return {
    year: Number(read.get('year')),
    month: Number(read.get('month')),
    day: Number(read.get('day')),
    weekday: WEEKDAYS.indexOf(read.get('weekday') ?? ''),
    hour: Number(read.get('hour')),
    minute: Number(read.get('minute')),
  };
}

/** `YYYY-MM-DD` for the zone's calendar date. */
export function zonedDate(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
