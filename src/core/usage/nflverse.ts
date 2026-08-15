/**
 * Per-game usage, as nflverse publishes it.
 *
 * ## Why this file
 *
 * The role-change detector in `core/startsit/decisions.ts` has been complete and
 * tested since the season brief and has never had an input: with no per-game
 * usage connected it answers `insufficient_data`, which is honest and useless.
 * This is the input.
 *
 *     https://github.com/nflverse/nflverse-data/releases/download/stats_player/
 *       stats_player_week_2025.csv
 *
 * A public GitHub release asset, like the injury report: no key, no account, no
 * quota, no terms to age out from under the project. Measured on 2025-08-15
 * against the live 2025 file — 8.3MiB, 19,422 data rows, 150 columns, one row
 * per player per week, weeks 1–22 (REG 1–18, POST 19–22), 6,321 of those rows at
 * the four positions this app carries.
 *
 * ## Why not snap counts
 *
 * `snap_counts_2025.csv` carries `offense_snaps` and `offense_pct`, which are
 * better role signals than targets in the abstract. It was rejected anyway: its
 * only identifier is `pfr_player_id`, an id space this app has never seen. This
 * file's `player_id` is a **GSIS id** (`00-0023459`) — the same space as
 * `gsis_id` in the injury report, which already resolves through
 * `resolveToCanonical` at 98.9%. A second fuzzy matcher for a second id space is
 * precisely what every brief in this project has ruled out, and one good signal
 * on the proven identity path beats a better signal on a new one.
 *
 * ## The trap this file sets, and how it is disarmed
 *
 * **19,394 of 19,422 lines contain a quoted comma**, so this file cannot be
 * split on commas — the exact opposite of the injury file, whose entire 679KiB
 * contains six quote characters and whose `splitRow` fast path is therefore
 * worthless here.
 *
 * `headshot_url` embeds `f_auto,q_auto` inside quotes, and a display name may
 * too (`"Kenneth Murray, Jr."`). A naive `split(',')` yields 151 fields where
 * the header has 150, shifting every column after index 5 — and it is not even
 * uniformly wrong, which is the dangerous part:
 *
 *     naive field count   lines
 *              151        19,377   one quoted comma (the headshot URL)
 *              152            17   two (a name with a comma in it)
 *              150            28   none (team rows with no headshot at all)
 *
 * A fixed `+1` correction would silently corrupt those 45 rows and misread
 * `week` on roughly one line in 500. Silent corruption of a usage series is
 * worse than no usage series at all, so every field is read quote-aware.
 *
 * ## Why that is still affordable
 *
 * A Workers invocation gets **10ms of CPU** on the free plan, and the careful
 * RFC4180 parser measured 154ms on the injury file, which is twelve times
 * smaller than this one. Two properties make the difference:
 *
 *   - **the file is monotonically non-decreasing by week** (verified across all
 *     19,422 rows), so the latest week is at the end and is found by walking
 *     backwards from the last line until the week changes — no full scan;
 *   - **thirteen of 150 columns are wanted**, and two thirds of a week's rows
 *     are at positions this app does not carry, so the walk reads `week` and
 *     `position` together — the same ~90 characters either way — and the full
 *     thirteen-column extraction runs only over the ~350 rows that survive.
 *
 * ## What it actually costs, measured honestly
 *
 * Against the real 2025 file (Node, `scripts/probe-usage-parse.mjs`):
 *
 *     text.split('\n')                                    1.0ms
 *     latest week, as the file stands today (67 rows)      1.6ms
 *     latest week, file truncated to week 18 (1,067 rows)  4.0ms
 *     an explicit earlier week, by seek (1,103 rows)       4.3ms
 *
 * The **second** number is the trap and the third is the truth. Out of season
 * the file's last week is a playoff week of 67 rows, so a parse measured today
 * looks nearly free; a real regular-season week is sixteen times that. Reading
 * the position in the same pass as the week is what took the in-season figure
 * from 10.0ms — dead on the ceiling — to 4.0ms.
 *
 * These are Node numbers for the JavaScript only. They exclude every D1 call,
 * which is I/O on Workers and does not count against the CPU ceiling there
 * however it looks on a laptop; a Node benchmark that folded in synchronous
 * SQLite would overstate the Workers cost badly, and this project has made that
 * mistake once already.
 */

import { parseCsv } from '../adp/import.ts';
import {
  conditionalGet,
  type ConditionalResponse,
  type FetchLike,
  type SourceFingerprint,
} from '../source/conditional.ts';

export type { FetchLike, SourceFingerprint };
export type { FetchOutcome } from '../source/conditional.ts';

/**
 * Where the file lives. A release asset, so the URL is stable across seasons and
 * the only thing that changes is the year — and, like the injury report, the
 * current season's file is a 404 until the season starts.
 */
export function weeklyStatsUrl(season: string): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
}

/** The four positions this app carries. Kickers remain out of scope. */
export const SKILL_POSITIONS: ReadonlySet<string> = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * The columns read, by name.
 *
 * Read from the header rather than assumed by position: column indices are not
 * stable across seasons, this is somebody else's file, and a column inserted in
 * the middle must not silently shift every value by one.
 */
const COLUMNS = [
  'player_id',
  'player_display_name',
  'position',
  'season',
  'season_type',
  'week',
  'team',
  'attempts',
  'carries',
  'targets',
  'receptions',
  'target_share',
  'wopr',
  /*
   * Everything below here was added for the start/sit intelligence pass, and
   * every one of them is free: the deepest column already read is `wopr` at
   * index 64 and all of these sit at or before it, so `extractFields` scans
   * exactly as far into each line as it did with thirteen columns. Nine more
   * `Number()` calls on the ~350 rows a week that survive the position filter
   * is not a measurable cost against a 10ms allowance.
   */
  'opponent_team',
  'passing_yards',
  'passing_tds',
  'rushing_yards',
  'rushing_tds',
  'receiving_yards',
  'receiving_tds',
  'receiving_air_yards',
  'air_yards_share',
] as const;

type Column = (typeof COLUMNS)[number];

export interface UsageRow {
  /** nflverse's `player_id`, which is a GSIS id. The whole reason for this file. */
  gsisId: string;
  fullName: string;
  position: string;
  season: string;
  /** `REG` or `POST`. Kept because they are not the same population of games. */
  seasonType: string;
  week: number;
  team: string;
  /** Pass attempts. A quarterback's volume, and null when the source left it blank. */
  passAttempts: number | null;
  carries: number | null;
  targets: number | null;
  receptions: number | null;
  /** Share of the team's targets, 0–1. Volume with the team's pace divided out. */
  targetShare: number | null;
  /** Weighted opportunity rating: 1.5 × target share + 0.7 × air-yards share. */
  wopr: number | null;
  /**
   * The defence he faced, as the source spells the team. The half of a matchup
   * nothing here used to keep.
   */
  opponent: string;
  /** Production, so a stored game can be scored without a second source. */
  passYards: number | null;
  passTds: number | null;
  rushYards: number | null;
  rushTds: number | null;
  recYards: number | null;
  recTds: number | null;
  /** Air yards on his targets. Divided by targets this is depth of target. */
  receivingAirYards: number | null;
  /** His share of the team's air yards, 0–1. */
  airYardsShare: number | null;
}

export interface ParsedUsage {
  rows: UsageRow[];
  season: string;
  /** The latest week in the file, which is what "current" means for it. */
  latestWeek: number;
  /** The week actually parsed — the latest one unless a week was asked for. */
  week: number;
  /** Lines belonging to that week, before the position filter. */
  rowsInWeek: number;
  /** Rows in that week dropped for having no identifier or no usable week. */
  skipped: number;
}

/**
 * Read the requested column values out of one line, quote-aware, in one pass.
 *
 * ## The bug this signature exists to prevent
 *
 * The single pass can only move forwards, so it must be given its column
 * indices in ascending order. The prototype was handed `[0, 2, 3, 7, 10, 45,
 * 32, 44]` — the natural order of the fields as a human lists them — matched up
 * to 45, and could then never match 32 or 44 again. `carries` and `receptions`
 * came back as empty strings with no error at all: a usage series that is
 * quietly always zero.
 *
 * So the sort happens **here**, and the results are mapped back into the
 * caller's order. A caller cannot reintroduce the bug by listing its columns in
 * a readable order, which is the only way it was ever going to come back.
 */
export function extractFields(line: string, indices: readonly number[]): string[] {
  /*
   * A column the header does not have is asked for as -1, and is dropped here
   * rather than searched for.
   *
   * It cannot simply be sorted with the rest: -1 sorts first, never matches a
   * field index, and — because the scan only moves forwards — the cursor would
   * wait for it forever and return an empty string for *every* column. One
   * absent column would silently empty the whole row, which is precisely the
   * class of failure the sort above exists to prevent.
   */
  const order = indices
    .map((column, position) => ({ column, position }))
    .filter((entry) => entry.column >= 0)
    .sort((a, b) => a.column - b.column);
  const out: string[] = new Array(indices.length).fill('');

  let want = 0;
  let field = 0;
  let start = 0;
  let quoted = false;
  const end = line.length;

  for (let i = 0; i <= end && want < order.length; i++) {
    // Past the last character, the end of the line terminates the final field.
    const ch = i === end ? ',' : line[i]!;
    if (quoted) {
      // A doubled quote inside a quoted field closes and reopens, which lands
      // in the same state — correct for finding delimiters, and the escape is
      // undone in `unquote` where the value is actually built.
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch !== ',') continue;

    // `while` rather than `if`: a caller may ask for the same column twice.
    while (want < order.length && order[want]!.column === field) {
      out[order[want]!.position] = unquote(line.slice(start, i));
      want++;
    }
    field++;
    start = i + 1;
  }

  return out;
}

/** A field may or may not be quoted, so strip only what is actually there. */
function unquote(raw: string): string {
  // CRLF would leave a stray carriage return on the last field. This file ships
  // LF today; costing one character test to survive the day it does not.
  const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value;
}

/**
 * Parse one week of usage out of the published season file.
 *
 * Bounded twice over, and both bounds are the CPU ceiling rather than taste:
 * to a single week, and within it to the four positions this app carries.
 *
 * ## Which week, and how it is found
 *
 * By default the latest one, found by walking **backwards** from the last line
 * and stopping at the first row of a different week. That relies on the file
 * being ordered by week, which was verified across all 19,422 rows of the 2025
 * file — but only at the end of it, so a file that is unsorted in the middle
 * still yields a correct latest week.
 *
 * Passing `week` asks for an older one, which is what filling a gap needs. A
 * full scan is not an option there: reading one field from every line of the
 * 2025 file measures **25.6ms**, two and a half times a Worker's entire CPU
 * allowance, because the week sits behind a quoted URL and cannot be found by
 * counting commas. So that path binary-searches the block instead — about
 * fifteen reads — and then walks outward from both ends while the week still
 * matches. The assumption is only that one week's rows are *contiguous*, which
 * is weaker than the file being sorted throughout, and the walk outward is what
 * keeps a mis-ordered middle from silently truncating the week.
 */
export function parseWeeklyUsage(
  text: string,
  opts: { week?: number; positions?: ReadonlySet<string> } = {},
): ParsedUsage {
  const positions = opts.positions ?? SKILL_POSITIONS;
  const lines = text.split('\n');
  const header = (parseCsv(lines[0] ?? '')[0] ?? []).map((h) => h.trim().toLowerCase());

  const at = new Map<Column, number>(COLUMNS.map((c) => [c, header.indexOf(c)]));
  const weekColumn = at.get('week') ?? -1;
  const wanted = COLUMNS.map((c) => at.get(c) ?? -1);
  const empty: ParsedUsage = { rows: [], season: '', latestWeek: 0, week: 0, rowsInWeek: 0, skipped: 0 };
  if (weekColumn === -1) return empty;

  /*
   * `week` sits at index 7, *after* the quoted `headshot_url` at index 5, so
   * even this one field cannot be found by counting commas. The extractor is
   * used for it too, and stops as soon as it has what it was asked for — about
   * ninety characters of a four-hundred-character line.
   */
  const weekAt = (index: number): number => {
    const raw = extractFields(lines[index]!, [weekColumn])[0] ?? '';
    const week = Number(raw);
    return Number.isFinite(week) && raw !== '' ? week : Number.NaN;
  };

  /*
   * Week and position together, because the position is the filter that pays
   * for everything else.
   *
   * Two thirds of a week's rows are linemen, linebackers and defensive backs
   * this app does not carry. Reading `position` (index 3) in the same pass that
   * reads `week` (index 7) costs nothing extra — the scan has to reach index 7
   * either way — and it means the full thirteen-column extraction runs over the
   * ~350 rows that matter rather than the ~1,070 in the week. Measured on the
   * 2025 file truncated to week 18, the worst in-season case: 10.0ms before
   * this, 3.3ms after it, against a 10ms allowance.
   */
  const positionColumn = at.get('position') ?? -1;
  const weekAndPositionAt = (index: number): { week: number; position: string } => {
    const [rawWeek = '', rawPosition = ''] = extractFields(lines[index]!, [weekColumn, positionColumn]);
    const week = Number(rawWeek);
    return {
      week: Number.isFinite(week) && rawWeek !== '' ? week : Number.NaN,
      position: rawPosition.trim().toUpperCase(),
    };
  };

  let last = lines.length - 1;
  while (last > 0 && lines[last]!.length === 0) last--;
  if (last < 1) return empty;

  const latestWeek = weekAt(last);
  if (!Number.isFinite(latestWeek)) return empty;

  const target = opts.week ?? latestWeek;
  // Only the lines of the target week that are also at a position this app
  // carries. Everything downstream of here is the expensive pass.
  const selected: number[] = [];
  let rowsInWeek = 0;

  if (opts.week == null) {
    // Backwards from the end, stopping at the first row of an earlier week.
    for (let i = last; i >= 1; i--) {
      if (lines[i]!.length === 0) continue;
      const { week, position } = weekAndPositionAt(i);
      if (week !== target) break;
      rowsInWeek++;
      if (positions.has(position)) selected.push(i);
    }
    selected.reverse();
  } else {
    // Find any line of the target week, then take the whole contiguous block
    // around it. `found` is -1 when the week is not in the file at all, which
    // is a legitimate answer rather than a fault: a backfill can ask for a week
    // in which nobody played.
    const found = seekWeek(lines, last, target, weekAt);
    if (found !== -1) {
      // Outward from there in both directions, reading each line once.
      for (let i = found; i >= 1; i--) {
        if (lines[i]!.length === 0) continue;
        const { week, position } = weekAndPositionAt(i);
        if (week !== target) break;
        rowsInWeek++;
        if (positions.has(position)) selected.push(i);
      }
      for (let i = found + 1; i <= last; i++) {
        if (lines[i]!.length === 0) continue;
        const { week, position } = weekAndPositionAt(i);
        if (week !== target) break;
        rowsInWeek++;
        if (positions.has(position)) selected.push(i);
      }
      selected.sort((a, b) => a - b);
    }
  }

  const rows: UsageRow[] = [];
  let skipped = 0;
  let season = '';

  for (const index of selected) {
    const cells = extractFields(lines[index]!, wanted);
    const cell = (column: Column): string => {
      const position = COLUMNS.indexOf(column);
      return at.get(column) === -1 ? '' : (cells[position] ?? '').trim();
    };

    const position = cell('position').toUpperCase();
    const gsisId = cell('player_id');
    const week = Number(cell('week'));
    if (!gsisId || !Number.isFinite(week)) {
      // A team-aggregate row carries no player id. Counted rather than ignored,
      // because a file that suddenly loses its identifiers must be visible.
      skipped++;
      continue;
    }

    season ||= cell('season');
    rows.push({
      gsisId,
      fullName: cell('player_display_name'),
      position,
      season: cell('season'),
      seasonType: cell('season_type').toUpperCase() || 'REG',
      week,
      team: cell('team').toUpperCase(),
      passAttempts: numberOrNull(cell('attempts')),
      carries: numberOrNull(cell('carries')),
      targets: numberOrNull(cell('targets')),
      receptions: numberOrNull(cell('receptions')),
      targetShare: numberOrNull(cell('target_share')),
      wopr: numberOrNull(cell('wopr')),
      opponent: cell('opponent_team').toUpperCase(),
      passYards: numberOrNull(cell('passing_yards')),
      passTds: numberOrNull(cell('passing_tds')),
      rushYards: numberOrNull(cell('rushing_yards')),
      rushTds: numberOrNull(cell('rushing_tds')),
      recYards: numberOrNull(cell('receiving_yards')),
      recTds: numberOrNull(cell('receiving_tds')),
      receivingAirYards: numberOrNull(cell('receiving_air_yards')),
      airYardsShare: numberOrNull(cell('air_yards_share')),
    });
  }

  return { rows, season, latestWeek, week: target, rowsInWeek, skipped };
}

/**
 * Any line belonging to `target`, or -1.
 *
 * A binary search, because the alternative — reading the week from all 19,422
 * lines — costs 25.6ms against a 10ms allowance. It leans on the file being
 * ordered by week, which was verified across every row of the 2025 file; the
 * caller then walks outward from whatever this finds, so the ordering only has
 * to hold well enough to land *inside* the block rather than perfectly.
 */
function seekWeek(
  lines: string[],
  last: number,
  target: number,
  weekAt: (index: number) => number,
): number {
  let lo = 1;
  let hi = last;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // A blank or unreadable line decides nothing; step past it rather than
    // letting a NaN comparison silently pick a direction.
    let probe = mid;
    while (probe <= hi && (lines[probe]!.length === 0 || !Number.isFinite(weekAt(probe)))) probe++;
    if (probe > hi) {
      hi = mid - 1;
      continue;
    }
    const week = weekAt(probe);
    if (week === target) return probe;
    if (week < target) lo = probe + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * A blank is not a zero.
 *
 * The rate columns are blank for a player who had no opportunity at all, and
 * reading that as 0.0 would put a real number into a per-game series that
 * nobody measured. Null travels all the way to the read path, which drops the
 * game from that metric rather than inventing a value for it.
 */
function numberOrNull(raw: string): number | null {
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export interface UsageFetch {
  outcome: ConditionalResponse['outcome'];
  usage: ParsedUsage | null;
  fingerprint: SourceFingerprint;
  publishedAt: string | null;
  note: string | null;
}

/**
 * Ask for the season's weekly stats, and only actually receive them if the file
 * changed. See `core/source/conditional.ts` for why one request covers both
 * cases, and why a 404 is reported rather than raised.
 */
export async function fetchWeeklyUsage(
  season: string,
  opts: {
    fetch?: FetchLike;
    fingerprint?: SourceFingerprint | null;
    week?: number;
  } = {},
): Promise<UsageFetch> {
  const response = await conditionalGet(weeklyStatsUrl(season), {
    fetch: opts.fetch,
    fingerprint: opts.fingerprint,
    describe: `${season} weekly player stats`,
  });

  if (response.outcome !== 'ok' || response.text == null) {
    return {
      outcome: response.outcome,
      usage: null,
      fingerprint: response.fingerprint,
      publishedAt: response.publishedAt,
      note: response.note,
    };
  }

  const usage = parseWeeklyUsage(response.text, { week: opts.week });
  /*
   * A file that parsed to nothing is a failure, not an update.
   *
   * Storing this fingerprint would mark the emptiness as "seen", and every
   * later check would 304 against it and leave the app permanently convinced it
   * was up to date with nothing. The old validators are kept instead.
   */
  if (usage.latestWeek === 0 || (opts.week == null && usage.rowsInWeek === 0)) {
    return {
      outcome: 'failed',
      usage: null,
      fingerprint: opts.fingerprint ?? { etag: null, lastModified: null },
      publishedAt: null,
      note: `nflverse returned no ${season} weekly stats rows`,
    };
  }

  return {
    outcome: 'ok',
    usage,
    fingerprint: response.fingerprint,
    publishedAt: response.publishedAt,
    note: null,
  };
}
