/**
 * The NFL's own injury reports, as nflverse publishes them.
 *
 * ## Why this source
 *
 * Sleeper says whether a player is Questionable. It does not say what is wrong
 * with him or whether he practised, and those are the two facts that decide
 * what Questionable is worth on a Sunday morning. The brief asked for a free
 * secondary source and named three candidates; this is the one that survived.
 *
 *   - **BALLDONTLIE** — `Player Injuries` is not on the free tier, and the paid
 *     trial wants a card. Rejected on the published terms, not on a guess.
 *   - **Sportradar** — a genuinely rich weekly-injuries endpoint behind a trial
 *     that does not establish sustainable free production access. Rejected.
 *   - **nflverse** — a public GitHub release asset. No key, no account, no
 *     quota, no terms to age out from under the project.
 *
 * ## What was measured before adopting it
 *
 *   - the file exists and parses: `injuries_2025.csv`, 695KB, 6,068 rows,
 *     weeks 1–22, one row per player per week with no duplicate keys;
 *   - the fields are the ones needed: `report_status` (Out/Questionable/
 *     Doubtful), `report_primary_injury` (the body part), `practice_status`,
 *     and `gsis_id` for identity;
 *   - identity maps at **98.9%** for the positions this app carries — 27.5% on
 *     trimmed GSIS and 71.4% on normalized name — with five players unmatched,
 *     each of them a name that is ambiguous in Sleeper's own dictionary and is
 *     therefore declined rather than guessed. (Sleeper publishes a GSIS id for
 *     only about a third of its players, which is why the name path carries
 *     most of the load and why the identifier is still preferred where it
 *     exists.) Two thirds of the file is linemen and linebackers, which this
 *     app does not carry at all and does not try to;
 *   - **the current season is not published yet.** `injuries_2026.csv` is a
 *     404 in August, which is the honest state of an injury report before any
 *     injury reports exist. The ingest reports that as "nothing published yet"
 *     rather than as a failure, and the app runs on Sleeper's designation
 *     alone until it appears.
 *
 * ## The one thing it cannot do
 *
 * There is one row per player per **week**, not per practice day. So the
 * `DNP → LP → FP` within-week sequence is not derivable from this file: what
 * is available is one practice status per week, and therefore a week-over-week
 * comparison. `latestByPlayer` below returns exactly that and calls it what it
 * is. Inventing three days out of one is precisely the kind of confident
 * fabrication this project keeps refusing.
 */

import { parseCsv } from '../adp/import.ts';
import { normalizePractice, type PracticeStatus } from './model.ts';

/**
 * Where the file lives. A release asset, so the URL is stable across seasons
 * and the only thing that changes is the year.
 */
export function injuryReportUrl(season: string): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`;
}

export interface InjuryReportRow {
  season: string;
  week: number;
  team: string;
  /** nflverse's identifier, trimmed. Empty when the source left it blank. */
  gsisId: string | null;
  fullName: string;
  position: string;
  /** `Questionable`, `Out`, `Doubtful`, or empty for a practice-only report. */
  reportStatus: string | null;
  /** `Knee`, `Hamstring` — as written. Never expanded into a sentence. */
  primaryInjury: string | null;
  secondaryInjury: string | null;
  practiceStatus: PracticeStatus;
  practiceRaw: string | null;
}

export interface ParsedInjuryReport {
  rows: InjuryReportRow[];
  season: string;
  /** The latest week present, which is what "current" means for this file. */
  latestWeek: number;
  skipped: number;
}

const COLUMNS = [
  'season',
  'week',
  'team',
  'gsis_id',
  'position',
  'full_name',
  'report_primary_injury',
  'report_secondary_injury',
  'report_status',
  'practice_status',
] as const;

/**
 * Parse the published CSV.
 *
 * Column names are read from the header rather than assumed by position: this
 * is somebody else's file and a new column inserted in the middle must not
 * silently shift every value by one.
 */
export function parseInjuryReport(text: string): ParsedInjuryReport {
  const table = parseCsv(text);
  const header = table[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const at = new Map(COLUMNS.map((c) => [c, header.indexOf(c)]));

  const rows: InjuryReportRow[] = [];
  let skipped = 0;
  let latestWeek = 0;
  let season = '';

  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const cell = (column: (typeof COLUMNS)[number]): string => {
      const index = at.get(column) ?? -1;
      return index === -1 ? '' : (cells[index] ?? '').trim();
    };

    const fullName = cell('full_name');
    const week = Number(cell('week'));
    if (!fullName || !Number.isFinite(week)) {
      skipped++;
      continue;
    }

    season ||= cell('season');
    latestWeek = Math.max(latestWeek, week);
    const practiceRaw = cell('practice_status');
    rows.push({
      season: cell('season'),
      week,
      team: cell('team').toUpperCase(),
      // Trimmed here as well as on the Sleeper side, because an identifier that
      // is only equal after both ends agree to trim it is not an identifier.
      gsisId: cell('gsis_id') || null,
      fullName,
      position: cell('position').toUpperCase(),
      reportStatus: cell('report_status') || null,
      primaryInjury: cell('report_primary_injury') || null,
      secondaryInjury: cell('report_secondary_injury') || null,
      practiceStatus: normalizePractice(practiceRaw),
      practiceRaw: practiceRaw || null,
    });
  }

  return { rows, season, latestWeek, skipped };
}

/**
 * The most recent report for each player, plus the weeks behind it.
 *
 * "Most recent" is by week, and the weeks are kept because one practice status
 * is a state and several are a direction. See the header: those weeks are
 * weeks, not the three days of one week's practice report.
 */
export function latestByPlayer(
  report: ParsedInjuryReport,
  opts: { weeksOfHistory?: number } = {},
): Map<string, { latest: InjuryReportRow; practiceByWeek: PracticeStatus[] }> {
  const history = Math.max(1, opts.weeksOfHistory ?? 3);
  const byPlayer = new Map<string, InjuryReportRow[]>();
  for (const row of report.rows) {
    const key = playerKey(row);
    const list = byPlayer.get(key);
    if (list) list.push(row);
    else byPlayer.set(key, [row]);
  }

  const out = new Map<string, { latest: InjuryReportRow; practiceByWeek: PracticeStatus[] }>();
  for (const [key, all] of byPlayer) {
    const ordered = [...all].sort((a, b) => a.week - b.week);
    const latest = ordered.at(-1)!;
    const recent = ordered.slice(-history);
    /*
     * Only consecutive weeks up to the latest count as a run.
     *
     * A player who was limited in week 3, missed weeks 4 and 5 from the report
     * entirely, then practised fully in week 6 has not "improved from limited
     * to full" — there is a hole in the middle and the shape is unknown.
     */
    const consecutive: PracticeStatus[] = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const expected = latest.week - (recent.length - 1 - i);
      if (recent[i]!.week !== expected) break;
      consecutive.unshift(recent[i]!.practiceStatus);
    }
    out.set(key, { latest, practiceByWeek: consecutive });
  }
  return out;
}

/** GSIS where there is one, name and team where there is not. */
export function playerKey(row: InjuryReportRow): string {
  return row.gsisId ? `gsis:${row.gsisId}` : `name:${normalizeForMatch(row.fullName)}|${row.team}`;
}

/** The same normalization the identity layer uses, kept minimal on purpose. */
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface InjuryReportFetch {
  report: ParsedInjuryReport | null;
  /**
   * When the file was last published, from the response's `Last-Modified`.
   * There is no per-row timestamp in this data, so this is the only freshness
   * it has, and it is the freshness of the whole file.
   */
  publishedAt: string | null;
  /** Why there is nothing, when there is nothing. Never an exception. */
  note: string | null;
}

/**
 * Fetch one season's report.
 *
 * A 404 is the expected answer before a season starts and is reported as such
 * — the difference between "the source is down" and "there are no injury
 * reports yet in August" is the difference between an alarm and a fact.
 */
export async function fetchInjuryReport(
  season: string,
  opts: { fetch?: FetchLike } = {},
): Promise<InjuryReportFetch> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const res = await doFetch(injuryReportUrl(season), { headers: { accept: 'text/csv' } });

  if (res.status === 404) {
    return {
      report: null,
      publishedAt: null,
      note: `nflverse has not published ${season} injury reports yet`,
    };
  }
  if (!res.ok) {
    return { report: null, publishedAt: null, note: `nflverse injuries ${res.status}` };
  }

  const lastModified = res.headers.get('last-modified');
  const report = parseInjuryReport(await res.text());
  if (report.rows.length === 0) {
    return { report: null, publishedAt: null, note: `nflverse returned no ${season} rows` };
  }
  return {
    report,
    publishedAt: lastModified ? new Date(lastModified).toISOString() : null,
    note: null,
  };
}
