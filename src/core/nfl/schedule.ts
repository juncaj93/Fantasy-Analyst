/**
 * The season's fixture list, which is the one fact this app kept re-deriving.
 *
 *     https://github.com/nflverse/nflverse-data/releases/download/schedules/
 *       games.csv
 *
 * A public GitHub release asset like the roster, the injury report and the snap
 * counts: no key, no account, no quota, and a conditional GET that costs a round
 * trip and no bytes on the ordinary morning.
 *
 * ## What this is for, and what it is deliberately not for yet
 *
 * Until now the only schedule in this app was the one that fell out of the
 * betting data: `VegasEventsRepo` stores the events a provider was asked about,
 * so "who does Denver play" is answerable exactly as far ahead as somebody has
 * paid to price. That is the right source for *this* week — it is the same row
 * the spread and total come from, so a game and its line can never disagree —
 * and it is no source at all for the two questions the next lane is about:
 *
 *   - **which week is a bye**, which is a hole in a list nobody bought;
 *   - **who a defence plays in December**, which no book has priced in October.
 *
 * Both are properties of a fixture list published in May and unchanged all
 * season, and neither is worth a paid entity. Hence this file.
 *
 * **Nothing on a recommendation read path reads it in this lane.** It is
 * ingested, stored and left alone: the DST projection is anchored on the Vegas
 * line for the week in play, as it should be, because a fixture list knows who
 * is playing and not what the game is worth. Wiring it into streaming and
 * playoff planning is the next lane's job, and having the data land a lane
 * early is what lets that lane be about the model rather than about ingest.
 *
 * ## Two rows per game
 *
 * The file is one row per game, home and away on the same line. It is stored as
 * one row per *team* per week, which is a deliberate denormalisation:
 * essentially every question asked of a schedule is asked from a team's point
 * of view ("who does SEA play in week 14", "which week does SEA rest"), and the
 * alternative is every reader writing the same `home_team = ? OR away_team = ?`
 * disjunction and half of them getting the `home` flag backwards. The primary
 * key `(season, week, team)` then makes the ingest idempotent for free.
 *
 * ## Why `roof` and not weather
 *
 * `roof` is a property of a stadium, is published months ahead, and never
 * changes: it is the difference between a January game in Buffalo and one in
 * Detroit, and it is the only environmental fact in this file that is a
 * *forecast* rather than a *result*. The same rows also carry `temp` and `wind`,
 * and those are **post-game observations** — blank for every unplayed game and
 * filled in afterwards. Reading them as a forecast would produce a weather model
 * that is perfectly accurate about the past and silent about the future, which
 * is the worst of both. This app has no weather source; see the brief's §14.
 */

import { extractFields, headerIndex, int, text } from '../source/csv.ts';

/**
 * Where the file lives. One file for every season, not one per season.
 *
 * The asset in the `schedules` release is called **`games.csv`**, and the name
 * is the whole of a bug this shipped with: it pointed at `schedules.csv` — the
 * name of the release, not of the file in it — which is a 404 with a nine-byte
 * body. A 404 is read as `not_published`, which is a *fact about the calendar*
 * rather than a fault, so the ingest recorded a healthy "nothing to say" every
 * morning, moved `checked_at`, wrote no rows, and never once stored a fixture.
 * The screen then said the schedule was missing and the pipeline said it was
 * fine, and both were reporting exactly what they saw.
 *
 * `tests/schedule.test.ts` pins the file name and not merely the release path,
 * because asserting the part that was right is what let the part that was wrong
 * through.
 */
export const SCHEDULE_URL =
  'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';

/** One team's week, which is how the schedule is stored and read. */
export interface ScheduleTeamWeek {
  season: string;
  week: number;
  team: string;
  /** Null on a bye — the row exists, the opponent does not. */
  opponent: string | null;
  home: boolean;
  /** ISO kickoff, when the file carries both a date and a time. */
  kickoff: string | null;
  /** `dome`, `outdoors`, `closed`, `open`, `retractable`. Null when unstated. */
  roof: string | null;
}

export interface ParsedSchedule {
  rows: ScheduleTeamWeek[];
  /** Games read, before the split into two rows each. */
  games: number;
  /** Rows the file had that could not be turned into a fixture, and why. */
  skipped: number;
  seasons: string[];
}

const EMPTY: ParsedSchedule = { rows: [], games: 0, skipped: 0, seasons: [] };

/**
 * The columns read, by name.
 *
 * By name rather than by position for the reason `csv.ts` gives at length:
 * these are somebody else's files and nflverse has inserted a column mid-file
 * more than once. `game_type` is read so a caller can tell a regular-season
 * week from a playoff round without re-deriving it from the week number, which
 * differs by season as the league adds games.
 */
const COLUMNS = [
  'season',
  'game_type',
  'week',
  'gameday',
  'gametime',
  'away_team',
  'home_team',
  'roof',
] as const;

/**
 * Read the fixture list.
 *
 * Pure, deterministic and allocation-conscious: the file holds every season
 * nflverse has ever published — roughly 7,000 games — and a Worker parsing all
 * of it to store one season would be paying for twenty years of history it will
 * never read. `opts.season` filters in the same pass as the week, before any of
 * the other columns are materialised, which is the trick the roster parser uses
 * to keep a whole-file scan inside the CPU allowance.
 */
export function parseSchedule(csv: string, opts: { season?: string } = {}): ParsedSchedule {
  const lines = csv.split('\n');
  if (lines.length < 2) return EMPTY;

  const at = headerIndex(lines[0] ?? '');
  const seasonColumn = at.get('season') ?? -1;
  if (seasonColumn === -1) return EMPTY;
  const wanted = COLUMNS.map((c) => at.get(c) ?? -1);
  // Without these four a row is not a fixture, whatever else it carries.
  if (wanted[0] === -1 || wanted[2] === -1 || wanted[5] === -1 || wanted[6] === -1) return EMPTY;

  const rows: ScheduleTeamWeek[] = [];
  const seasons = new Set<string>();
  let games = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0 || line === '\r') continue;

    if (opts.season != null) {
      const [rawSeason = ''] = extractFields(line, [seasonColumn]);
      if (rawSeason.trim() !== opts.season) continue;
    }

    const cells = extractFields(line, wanted);
    const season = text(cells[0]);
    const week = int(cells[2]);
    const away = normaliseTeam(cells[5]);
    const home = normaliseTeam(cells[6]);

    /*
     * A row missing any of the four is skipped rather than half-stored.
     *
     * The file carries scheduled-but-unassigned games in some seasons — a
     * playoff slot whose participants are not known yet reads with empty team
     * columns — and storing one would create a fixture against nobody that a
     * bye derivation would then have to learn to ignore.
     */
    if (!season || week == null || !away || !home) {
      skipped++;
      continue;
    }

    seasons.add(season);
    games++;
    const kickoff = toIsoKickoff(text(cells[3]), text(cells[4]));
    const roof = text(cells[7]);

    rows.push({ season, week, team: home, opponent: away, home: true, kickoff, roof });
    rows.push({ season, week, team: away, opponent: home, home: false, kickoff, roof });
  }

  return { rows, games, skipped, seasons: [...seasons].sort() };
}

/**
 * The teams a season's schedule covers, and the weeks each of them plays.
 *
 * The half of a bye derivation that belongs to the parser: which weeks a team
 * has a fixture in. Which weeks it *does not* is a question about a season's
 * length, and a season's length is a fact the caller has and this file does not
 * — the league has changed it twice in twenty years and will again. So this
 * returns what is in the data and {@link byeWeeks} turns it into an absence
 * against a range the caller states.
 */
export function weeksByTeam(rows: readonly ScheduleTeamWeek[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const row of rows) {
    const weeks = out.get(row.team) ?? new Set<number>();
    weeks.add(row.week);
    out.set(row.team, weeks);
  }
  return out;
}

/**
 * The weeks in `[from, to]` a team has no fixture in.
 *
 * Derived rather than stored, because a bye is the absence of a row and storing
 * an absence means storing it correctly for every team in every season — one
 * missed ingest and a team has thirteen byes. Reading it from what is there
 * cannot drift from what is there.
 */
export function byeWeeks(
  rows: readonly ScheduleTeamWeek[],
  team: string,
  range: { from: number; to: number },
): number[] {
  const played = weeksByTeam(rows).get(team.toUpperCase()) ?? new Set<number>();
  const out: number[] = [];
  for (let week = range.from; week <= range.to; week++) if (!played.has(week)) out.push(week);
  return out;
}

/**
 * Which teams are at home in a set of fixtures.
 *
 * A derivation rather than a read, and it lives here for the same reason
 * {@link byeWeeks} does: the fixture list is the only source in this app that
 * knows which side is the home one. `vegas_events.home_team` means "a team we
 * asked about", which is a different fact wearing the same word — reading it as
 * home field is the vocabulary trap that had every stored spread in this app
 * pointing the wrong way until it was found.
 *
 * A bye contributes nothing: a team with no fixture is neither at home nor on
 * the road, and an entry saying otherwise would put a road penalty on a defence
 * that is not playing.
 */
export function homeByTeam(fixtures: readonly ScheduleTeamWeek[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const row of fixtures) {
    if (!row.opponent) continue;
    out.set(row.team.toUpperCase(), row.home);
  }
  return out;
}

function normaliseTeam(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase();
  return value.length === 0 ? null : value;
}

/**
 * `gameday` + `gametime` as one ISO instant, or null.
 *
 * The file publishes `2026-09-13` and `13:00` in **US Eastern**, with no offset
 * on either. Eastern is what the NFL schedules in and what every kickoff time
 * in the file means, so the conversion is a fixed pair of offsets rather than a
 * timezone database: −04:00 while daylight time is in effect and −05:00 after
 * it ends, and the changeover is the first Sunday in November, which every
 * season crosses in the middle of.
 *
 * Getting this wrong by an hour would matter in exactly one place — the lock
 * state that decides whether a lineup can still be changed — which is why this
 * lane deliberately does not feed that: locks continue to come from the Vegas
 * event's own kickoff, which arrives with an offset on it. This value is stored
 * for ordering and for the next lane's planning, and a null is returned rather
 * than a guess whenever either half is missing.
 */
export function toIsoKickoff(gameday: string | null, gametime: string | null): string | null {
  if (!gameday || !gametime) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameday.trim());
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(gametime.trim());
  if (!day || !time) return null;

  const offset = easternOffsetHours(Number(day[1]), Number(day[2]), Number(day[3]));
  const at = Date.UTC(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
    Number(time[1]) + offset,
    Number(time[2]),
    Number(time[3] ?? 0),
  );
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Hours to add to an Eastern wall-clock time to reach UTC: 4 in summer, 5 in
 * winter.
 *
 * US daylight time runs from the second Sunday in March to the first Sunday in
 * November. An NFL season starts in September and ends in February, so it
 * crosses the November boundary and nothing else — the March rule is here for
 * completeness rather than because a game has ever fallen near it.
 */
function easternOffsetHours(year: number, month: number, day: number): number {
  const start = nthSunday(year, 3, 2);
  const end = nthSunday(year, 11, 1);
  const asNumber = month * 100 + day;
  return asNumber >= start && asNumber < end ? 4 : 5;
}

/** The nth Sunday of a month, as `month * 100 + day`. */
function nthSunday(year: number, month: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstWeekday) % 7);
  return month * 100 + firstSunday + (n - 1) * 7;
}
