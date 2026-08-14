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
 * How many weeks back a bounded parse keeps.
 *
 * Measured rather than picked. A Workers invocation gets 10ms of CPU on the
 * free plan; against a real season file the narrowing scan costs about 1.2ms
 * fixed and the parse about 1.2ms per three hundred rows, and a mid-season week
 * is roughly three hundred rows:
 *
 *     window   rows    parse
 *        2      636     2.4ms
 *        3      932     3.8ms
 *        4     1255     5.2ms
 *      all     2898    12.1ms   <- over budget on its own
 *
 * Three is the practice-trend span and leaves a week of catch-up for a missed
 * tick, at about half the allowance. Widening it buys history the database is
 * already accumulating live; narrowing it buys margin that is not needed.
 *
 * Losing older weeks costs history, never current state: the latest week is
 * always parsed, and a player whose newest report is older already has that row
 * stored from the ingest that saw it.
 */
export const RECENT_WEEKS = 3;

/**
 * Split one CSV line into fields.
 *
 * Two paths, and the fast one is what makes a five-minute cadence affordable.
 * The whole 679KB season file contains **six** quote characters — three lines
 * out of six thousand — so a plain `split(',')` is correct for essentially the
 * entire file, and the careful RFC4180 parser is reserved for the handful of
 * lines that actually need it. Running the careful one over everything cost
 * 154ms, which is fifteen times a Worker's entire CPU allowance.
 */
function splitRow(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  return parseCsv(line)[0] ?? [];
}

/**
 * Find one field without building the fields before it.
 *
 * Used to read the week out of every line during the narrowing pass. The
 * columns before it — season, season_type, game_type, team — never contain a
 * comma or a quote, so counting separators is exact here and costs no
 * allocation.
 */
function fieldAt(line: string, index: number): string {
  let start = 0;
  for (let f = 0; f < index; f++) {
    const next = line.indexOf(',', start);
    if (next === -1) return '';
    start = next + 1;
  }
  const end = line.indexOf(',', start);
  return end === -1 ? line.slice(start) : line.slice(start, end);
}

/**
 * Parse the published CSV.
 *
 * Column names are read from the header rather than assumed by position: this
 * is somebody else's file and a new column inserted in the middle must not
 * silently shift every value by one.
 *
 * ## Why it can stop early
 *
 * `recentWeeks` bounds the work to the most recent weeks in the file, and the
 * reason is a hard limit rather than a preference: a Workers invocation gets
 * **10ms of CPU** on the free plan, and parsing all 6,068 rows of a full season
 * takes about 160ms. Narrowing to the last few weeks first — a scan that reads
 * one field per line and allocates nothing — brings the whole ingest under the
 * ceiling with room to spare.
 *
 * Nothing is lost by it. A player whose latest report is from week 12 already
 * has that row stored from the ingest that saw it; he is not in this file's
 * recent weeks because nothing about him changed. Only the very first ingest of
 * an already-underway season sees a shortened history, and this app starts
 * watching in the preseason, so in practice it accumulates every week live.
 *
 * `weeks` bounds it the other way, to an explicit range, which is what a
 * backfill of a finished season needs: the whole file is far too much for one
 * invocation (a full 22-week parse of the real 2025 file measures ~10.6ms, at
 * the ceiling before a single row is written), so it is walked a couple of
 * weeks at a time across successive ticks. The cheap week scan runs either way,
 * so a narrow range costs little more than the scan itself.
 *
 * Omit both to parse the whole file, which is what a test wants.
 */
export function parseInjuryReport(
  text: string,
  opts: { recentWeeks?: number; weeks?: { from: number; to: number } } = {},
): ParsedInjuryReport {
  const lines = text.split('\n');
  const header = splitRow((lines[0] ?? '').replace(/\r$/, '')).map((h) => h.trim().toLowerCase());
  const at = new Map(COLUMNS.map((c) => [c, header.indexOf(c)]));
  const weekColumn = at.get('week') ?? -1;

  /*
   * One cheap pass to find the latest week and remember each line's, so the
   * expensive parse runs over a few hundred rows instead of six thousand.
   */
  let latestWeek = 0;
  const weekOf = new Int32Array(lines.length);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const week = weekColumn === -1 ? Number.NaN : Number(fieldAt(line, weekColumn));
    weekOf[i] = Number.isFinite(week) ? week : -1;
    if (Number.isFinite(week) && week > latestWeek) latestWeek = week;
  }

  const cutoff =
    opts.recentWeeks == null || !Number.isFinite(opts.recentWeeks)
      ? Number.NEGATIVE_INFINITY
      : latestWeek - opts.recentWeeks + 1;

  /*
   * An explicit range wins over the recent-weeks window. They answer different
   * questions -- "what has changed lately" and "walk me through the season" --
   * and a caller that passed both would otherwise get the intersection, which
   * is neither.
   */
  const from = opts.weeks ? opts.weeks.from : Number.NEGATIVE_INFINITY;
  const to = opts.weeks ? opts.weeks.to : Number.POSITIVE_INFINITY;

  const rows: InjuryReportRow[] = [];
  let skipped = 0;
  let season = '';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    if (opts.weeks ? weekOf[i]! < from || weekOf[i]! > to : weekOf[i]! < cutoff) continue;

    const cells = splitRow(line.replace(/\r$/, ''));
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

/** The validators that decide whether anything needs downloading. */
export interface SourceFingerprint {
  /** The strong validator. Preferred, and it survives the CDN redirect. */
  etag: string | null;
  /** The raw `Last-Modified` header, as sent, for the conditional request. */
  lastModified: string | null;
}

export type FetchOutcome =
  /** The source changed (or we had no fingerprint): `report` is populated. */
  | 'ok'
  /** 304. Nothing to do, and nothing was downloaded. The common answer. */
  | 'not_modified'
  /** 404 — a season that has not started. A fact about the calendar. */
  | 'not_published'
  /** Anything else. Last-good data stays exactly where it is. */
  | 'failed';

export interface InjuryReportFetch {
  outcome: FetchOutcome;
  report: ParsedInjuryReport | null;
  /**
   * The validators this response reported, to be stored for the next check.
   *
   * On a 304 these come back unchanged from what was sent, which is what makes
   * the check idempotent: storing them again is a no-op.
   */
  fingerprint: SourceFingerprint;
  /**
   * When the file was last published, from `Last-Modified`, as an ISO string.
   * There is no per-row timestamp in this data, so this is the only freshness
   * it has, and it belongs to the whole file rather than to any player.
   */
  publishedAt: string | null;
  /** Why there is nothing, when there is nothing. Never an exception. */
  note: string | null;
}

/**
 * Ask for the season's report, but only actually receive it if it changed.
 *
 * ## Why one conditional GET rather than HEAD-then-GET
 *
 * Measured against the live endpoint (`scripts/probe-nflverse-conditional.mjs`):
 *
 *   - `HEAD` answers 200 with both `ETag` and `Last-Modified`;
 *   - both validators are **stable across calls**, even though the release
 *     asset 302s to a signed CDN URL whose query string — expiry, signature,
 *     JWT — is different every single time. Fingerprinting the redirect target
 *     would have reported a change on every tick;
 *   - `If-None-Match` returns **304 with no body**;
 *   - a deliberately stale validator returns **200 with the whole file**.
 *
 * That last pair is the point. One request covers both cases: the ordinary
 * five-minute tick costs a round trip and no bytes, and the tick where
 * something actually changed already has the file in hand. A HEAD first would
 * make the common path no cheaper and the interesting path twice as slow.
 *
 * A 404 is the expected answer before a season starts and is reported as such —
 * the difference between "the source is down" and "there are no injury reports
 * yet in August" is the difference between an alarm and a fact.
 */
export async function fetchInjuryReport(
  season: string,
  opts: {
    fetch?: FetchLike;
    fingerprint?: SourceFingerprint | null;
    recentWeeks?: number;
    weeks?: { from: number; to: number };
  } = {},
): Promise<InjuryReportFetch> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const known = opts.fingerprint;

  const headers: Record<string, string> = { accept: 'text/csv' };
  /*
   * Only one conditional header, and ETag wins where both exist.
   *
   * Sending both lets a server that honours only the weaker one answer 200 to a
   * request the stronger one would have settled, which quietly turns every
   * check back into a download.
   */
  if (known?.etag) headers['if-none-match'] = known.etag;
  else if (known?.lastModified) headers['if-modified-since'] = known.lastModified;

  let res: Response;
  try {
    res = await doFetch(injuryReportUrl(season), { headers });
  } catch (err) {
    return {
      outcome: 'failed',
      report: null,
      fingerprint: { etag: known?.etag ?? null, lastModified: known?.lastModified ?? null },
      publishedAt: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }

  // 304: the body was never sent. Keep the fingerprint we asked with — the
  // response is not obliged to repeat it.
  if (res.status === 304) {
    return {
      outcome: 'not_modified',
      report: null,
      fingerprint: {
        etag: res.headers.get('etag') ?? known?.etag ?? null,
        lastModified: res.headers.get('last-modified') ?? known?.lastModified ?? null,
      },
      publishedAt: toIso(known?.lastModified ?? null),
      note: null,
    };
  }

  if (res.status === 404) {
    return {
      outcome: 'not_published',
      report: null,
      fingerprint: { etag: null, lastModified: null },
      publishedAt: null,
      note: `nflverse has not published ${season} injury reports yet`,
    };
  }

  if (!res.ok) {
    // The old fingerprint is kept deliberately: a 503 is not evidence that the
    // file changed, and forgetting what we knew would force a needless download
    // on the next tick.
    return {
      outcome: 'failed',
      report: null,
      fingerprint: { etag: known?.etag ?? null, lastModified: known?.lastModified ?? null },
      publishedAt: null,
      note: `nflverse injuries ${res.status}`,
    };
  }

  const fingerprint: SourceFingerprint = {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
  const report = parseInjuryReport(await res.text(), { recentWeeks: opts.recentWeeks, weeks: opts.weeks });
  /*
   * An empty *range* is not an empty file.
   *
   * A backfill asking for week 1 of a season where nobody was hurt in week 1
   * gets no rows, and that is the correct answer rather than a fault. The
   * emptiness that matters is a file with no rows in it at all, which
   * `latestWeek` reports as 0 because the week scan never saw a number — so
   * that, not the size of the slice, is what the guard tests when a range was
   * asked for.
   */
  const emptyFile = opts.weeks ? report.latestWeek === 0 : report.rows.length === 0;
  if (emptyFile) {
    /*
     * An empty file is a failure, not an update.
     *
     * Storing this fingerprint would mark the emptiness as "seen" and the next
     * tick would 304 against it forever, leaving the app permanently convinced
     * it was up to date with nothing.
     */
    return {
      outcome: 'failed',
      report: null,
      fingerprint: { etag: known?.etag ?? null, lastModified: known?.lastModified ?? null },
      publishedAt: null,
      note: `nflverse returned no ${season} rows`,
    };
  }

  return {
    outcome: 'ok',
    report,
    fingerprint,
    publishedAt: toIso(fingerprint.lastModified),
    note: null,
  };
}

function toIso(httpDate: string | null): string | null {
  if (!httpDate) return null;
  const at = Date.parse(httpDate);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
