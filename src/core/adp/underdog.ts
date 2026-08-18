/**
 * Raw Underdog ADP — `DOG` — and the rules that keep it honest.
 *
 * Underdog publishes several numbers about a player and only one of them is an
 * ADP. Their board carries staff rankings; aggregators carry projections,
 * "best ball value" scores and consensus ranks. Every one of those is an
 * ordering of players, every one of them is roughly monotonic with ADP, and
 * every one of them would look entirely plausible printed in a column labelled
 * `DOG`. That is the failure this module exists to prevent: a `DOG 48.2` that
 * is really a positional rank, or a ranking, or last week's number, is worse
 * than no `DOG` at all, because nothing on the screen would say so.
 *
 * So three things are separated and never allowed to merge:
 *
 *  - **What it is.** Only an average draft position counts. `validateRawAdp`
 *    below rejects payloads whose shape says "ranking" rather than "average",
 *    and it rejects them loudly rather than importing them with a caveat.
 *  - **Where it came from.** Provider, fetch time, the snapshot's own effective
 *    time when the source states one, and whether the numbers were still fresh.
 *    A successful fetch of a stale file is a stale number, and it says so.
 *  - **Who it is about.** Names are the last resort. The canonical identity
 *    index resolves the rows; anything ambiguous stays unresolved rather than
 *    being attached to the likelier of two players.
 *
 * ## Sleeper is not Underdog
 *
 * Sleeper ADP stays a separate source with its own snapshot, and nothing in
 * this file can produce one. They are two different markets — Underdog is best
 * ball, half of Sleeper's drafts are not — and the disagreement between them is
 * information the board shows rather than averages away. Copying one into the
 * other would destroy exactly the signal the blend is built on.
 *
 * ## Nothing here runs during a draft
 *
 * The same rule the Sleeper ADP path already follows: a workflow fetches, these
 * functions convert, and the result is imported as a frozen snapshot. The draft
 * board never waits on Underdog, on an aggregator, or on anybody's uptime.
 */

/** Where a DOG number came from. Ordered by preference, as the brief sets it. */
export type DogProvider = 'best_ball_team_builder' | '4for4';

/**
 * What a number *is*, recorded alongside the number.
 *
 * Only `raw_adp` may ever be labelled `DOG`. The other members exist so that a
 * misidentified payload has somewhere honest to be recorded as it is rejected —
 * an error message naming what arrived is worth far more than "invalid".
 */
export type DogSourceType = 'raw_adp' | 'ranking' | 'projection' | 'unknown';

export const DOG_PROVIDER_LABELS: Record<DogProvider, string> = {
  best_ball_team_builder: 'Best Ball Team Builder',
  '4for4': '4for4',
};

/** One player's raw Underdog ADP, exactly as the source stated it. */
export interface DogRow {
  name: string;
  team: string | null;
  position: string | null;
  /** Average draft position as an overall pick number. Never a rank. */
  adp: number;
}

/** A fetched DOG payload, with everything needed to judge whether to trust it. */
export interface DogSnapshot {
  provider: DogProvider;
  sourceType: DogSourceType;
  /** When this app asked. Always known. */
  fetchedAt: string;
  /**
   * When the source says its numbers are effective, if it says.
   *
   * Distinct from `fetchedAt` on purpose: an aggregator that regenerates once a
   * day serves a file at 14:00 whose numbers are from 03:00, and a fetch is not
   * evidence of freshness. Null when the source publishes no such stamp, which
   * is itself a fact worth carrying — see `dogFreshness`.
   */
  snapshotAt: string | null;
  rows: DogRow[];
}

/**
 * How old a DOG snapshot is allowed to be before the board stops calling it
 * fresh.
 *
 * ADP moves on news. Thirty-six hours spans a normal overnight regeneration and
 * a missed one; past a week the number describes a market that has had a
 * preseason game and two injury reports since, and presenting it as current
 * would be the specific dishonesty this module is about.
 */
export const DOG_FRESHNESS = {
  /** Hours after the effective time within which DOG is simply current. */
  freshHours: 36,
  /** Hours past which it is old enough that the board should stop using it. */
  staleHours: 168,
} as const;

export type DogFreshness = 'fresh' | 'aging' | 'stale' | 'unknown';

/**
 * How much of the payload has to look like an average before it is believed.
 *
 * A ranking is a permutation of 1..N: integers, one of each, dense. An ADP file
 * is averages — 1.4, 2.8, 14.6 — with gaps, duplicates and fractions. These
 * thresholds separate the two, and they are deliberately not tight: a small
 * Underdog file legitimately has plenty of round numbers in it, and the test
 * that matters is whether the payload as a whole behaves like a permutation.
 */
export const RAW_ADP_SHAPE = {
  /** Below this many rows nothing can be judged, so nothing is claimed. */
  minRows: 12,
  /**
   * A payload where at least this share of values are exact integers *and*
   * which covers a dense 1..N run is a ranking, not an average.
   */
  integerShare: 0.95,
  /** How much of 1..N a payload must occupy before "dense" is fair. */
  denseCoverage: 0.9,
  /** An ADP file starts near the top of the draft; a positional rank starts at 1. */
  maxFirstAdp: 6,
} as const;

/** Column names that give the game away before any arithmetic is needed. */
const RANKING_HEADERS = [
  'rank',
  'ranking',
  'overallrank',
  'positionrank',
  'consensusrank',
  'tier',
  'projection',
  'projectedpoints',
  'points',
  'fpts',
  'value',
  'score',
];

const ADP_HEADERS = ['adp', 'averagedraftposition', 'avgpick', 'averagepick', 'adpoverall', 'underdogadp'];

export interface RawAdpVerdict {
  /** True only when this payload may be labelled `DOG`. */
  valid: boolean;
  /** What the payload actually looks like. */
  sourceType: DogSourceType;
  reason: string;
}

/**
 * Is this raw ADP, or is it something that merely sorts like it?
 *
 * Two independent checks, because either one alone is beatable. The header
 * check catches an honest file with an honest column name — most of them. The
 * shape check catches a file whose column is *called* `adp` and whose contents
 * are 1, 2, 3, 4, which is what an aggregator serves when its ADP feed fails
 * and it silently substitutes its own ranking.
 *
 * `headers` is optional because some sources arrive as already-shaped rows with
 * no header row to inspect; the shape check stands on its own.
 */
export function validateRawAdp(rows: DogRow[], headers?: string[]): RawAdpVerdict {
  if (rows.length === 0) {
    return { valid: false, sourceType: 'unknown', reason: 'the payload contained no rows' };
  }

  if (headers && headers.length > 0) {
    const keys = headers.map(headerKey);
    const hasAdp = keys.some((k) => ADP_HEADERS.includes(k));
    if (!hasAdp) {
      const offending = keys.find((k) => RANKING_HEADERS.includes(k));
      return {
        valid: false,
        sourceType: offending && offending.startsWith('proj') ? 'projection' : offending ? 'ranking' : 'unknown',
        reason: offending
          ? `the payload has a "${offending}" column and no ADP column — expert or ranking data cannot be labelled DOG`
          : 'the payload has no average-draft-position column',
      };
    }
  }

  const values = rows.map((r) => r.adp).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length < RAW_ADP_SHAPE.minRows) {
    // Too small to characterise. Believed only when a header said so explicitly;
    // guessing from nine numbers is how a ranking gets in.
    const named = headers?.some((h) => ADP_HEADERS.includes(headerKey(h))) === true;
    return named
      ? { valid: true, sourceType: 'raw_adp', reason: `${values.length} rows, accepted on an explicit ADP column` }
      : {
          valid: false,
          sourceType: 'unknown',
          reason: `only ${values.length} usable rows — too few to confirm these are averages rather than ranks`,
        };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const integers = values.filter((v) => Number.isInteger(v)).length;
  const integerShare = integers / values.length;
  const distinct = new Set(values.map((v) => Math.round(v))).size;
  const span = Math.max(...values);
  const coverage = span > 0 ? distinct / span : 0;

  /*
   * A permutation of 1..N, in all but name.
   *
   * Whole numbers, one of each, and covering nearly the whole range they span.
   * Real ADP fails at least one of the three: averages are fractional, several
   * players share a rounded value, and the deepest player's ADP is well past
   * the number of players in the file.
   */
  if (integerShare >= RAW_ADP_SHAPE.integerShare && coverage >= RAW_ADP_SHAPE.denseCoverage) {
    return {
      valid: false,
      sourceType: 'ranking',
      reason: `values are a dense run of whole numbers (${integers}/${values.length} integers covering ${Math.round(
        coverage * 100,
      )}% of 1-${Math.round(span)}) — this is a ranking, not an average draft position`,
    };
  }

  if (sorted[0]! > RAW_ADP_SHAPE.maxFirstAdp) {
    return {
      valid: false,
      sourceType: 'unknown',
      reason: `the earliest value is ${sorted[0]}, so this is not a full-draft ADP board`,
    };
  }

  return {
    valid: true,
    sourceType: 'raw_adp',
    reason: `${values.length} averages spanning ${round1(sorted[0]!)}-${round1(sorted[sorted.length - 1]!)}`,
  };
}

/**
 * How current a snapshot is, measured against the time it claims for itself.
 *
 * `unknown` when the source published no effective time and the fetch is old
 * enough that the fetch time no longer stands in for one. The distinction
 * matters: "we do not know how old this is" and "this is current" must never
 * render the same way.
 */
export function dogFreshness(
  snapshot: Pick<DogSnapshot, 'fetchedAt' | 'snapshotAt'>,
  now: Date | string = new Date(),
): { state: DogFreshness; ageHours: number | null; basis: 'snapshot' | 'fetch' | 'none'; note: string } {
  const at = typeof now === 'string' ? Date.parse(now) : now.getTime();
  const effective = snapshot.snapshotAt ? Date.parse(snapshot.snapshotAt) : Number.NaN;
  const fetched = Date.parse(snapshot.fetchedAt);
  const basis: 'snapshot' | 'fetch' | 'none' = Number.isFinite(effective)
    ? 'snapshot'
    : Number.isFinite(fetched)
      ? 'fetch'
      : 'none';

  if (basis === 'none' || !Number.isFinite(at)) {
    return { state: 'unknown', ageHours: null, basis: 'none', note: 'no usable timestamp on this snapshot' };
  }

  const from = basis === 'snapshot' ? effective : fetched;
  const ageHours = round1(Math.max(0, (at - from) / 3_600_000));
  const label = basis === 'snapshot' ? 'as published' : 'since it was fetched';

  if (ageHours <= DOG_FRESHNESS.freshHours) {
    return { state: 'fresh', ageHours, basis, note: `${ageHours}h old ${label}` };
  }
  if (ageHours <= DOG_FRESHNESS.staleHours) {
    return { state: 'aging', ageHours, basis, note: `${ageHours}h old ${label} — past the ${DOG_FRESHNESS.freshHours}h window` };
  }
  return { state: 'stale', ageHours, basis, note: `${ageHours}h old ${label} — too old to treat as the current market` };
}

/** True for the states the board is willing to use as a live market input. */
export function dogIsUsable(state: DogFreshness): boolean {
  return state === 'fresh' || state === 'aging';
}

// ------------------------------------------------------------------ the HTML

/** One `<table>` reduced to a header row and its body rows, as plain text. */
export interface HtmlTable {
  headers: string[];
  rows: string[][];
}

/**
 * Column names that must never be mistaken for an average draft position.
 *
 * The Big Board carries `Round`, `Overall` and often a projection beside the
 * `ADP` column, and every one of them sorts exactly like ADP. `Overall` is the
 * dangerous one: it is a dense 1..500 run, so a board imported from it would
 * look like a plausible board and be a ranking. Named here so the column is
 * chosen by meaning rather than by position or by luck.
 */
const NOT_ADP_COLUMNS = [
  'overall',
  'overallrank',
  'round',
  'rank',
  'ranking',
  'tier',
  'bye',
  'byeweek',
  'points',
  'projectedpoints',
  'projection',
  'proj',
  'fpts',
  'ppg',
  'value',
  'score',
  'adpdiff',
  'vsadp',
];

/** Header keys that do name an average draft position. */
const ADP_COLUMNS = ['adp', 'underdogadp', 'udadp', 'averagedraftposition', 'avgadp', 'adpoverall', 'avgpick'];

const NAME_COLUMNS = ['player', 'playername', 'name', 'fullname'];

/**
 * Every `<table>` on the page, as text.
 *
 * A deliberately small reader rather than a DOM: this runs in CI and in the
 * worker's test environment, neither of which has one, and the shape being read
 * is a plain table. It is tolerant about markup — cells carry links, spans and
 * images — and makes no attempt at nested tables, which the callers do not need
 * and which would silently produce a wrong answer if guessed at.
 */
export function parseHtmlTables(html: string): HtmlTable[] {
  const tables: HtmlTable[] = [];
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const body = match[1] ?? '';
    const rows: string[][] = [];
    let headers: string[] | null = null;

    for (const rowMatch of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = rowMatch[1] ?? '';
      const cells: string[] = [];
      let isHeaderRow = false;
      for (const cellMatch of rowHtml.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
        if ((cellMatch[1] ?? '').toLowerCase() === 'th') isHeaderRow = true;
        cells.push(cellText(cellMatch[2] ?? ''));
      }
      if (cells.length === 0) continue;
      // The first `<th>` row is the header; failing that, the first row at all.
      // A `<th>` row further down is a repeated header or a section break, and
      // is dropped rather than read as a player.
      if (isHeaderRow) {
        if (!headers) headers = cells;
        continue;
      }
      if (!headers && rows.length === 0) {
        headers = cells;
        continue;
      }
      rows.push(cells);
    }

    if (headers) tables.push({ headers, rows });
  }
  return tables;
}

/**
 * The table that actually carries the board, chosen by what its columns mean.
 *
 * A page has more than one table on it — navigation, a summary, a footer — and
 * position is not a safe way to pick between them. A table qualifies only when
 * it has both a player-name column and a column that names an ADP; among those
 * the longest wins, because the Big Board is the long one.
 *
 * Returns null rather than guessing. Every caller turns that into an error
 * naming the headers it did see, which is the difference between "the page
 * changed" and "the parser is broken".
 */
export function findAdpTable(
  tables: HtmlTable[],
  adpNames: string[] = ADP_COLUMNS,
): { table: HtmlTable; nameAt: number; adpAt: number; teamAt: number; posAt: number } | null {
  let best: { table: HtmlTable; nameAt: number; adpAt: number; teamAt: number; posAt: number } | null = null;

  for (const table of tables) {
    const keys = table.headers.map(headerKey);
    const nameAt = keys.findIndex((k) => NAME_COLUMNS.includes(k));
    const adpAt = keys.findIndex((k) => adpNames.includes(k) && !NOT_ADP_COLUMNS.includes(k));
    if (nameAt < 0 || adpAt < 0) continue;
    if (!best || table.rows.length > best.table.rows.length) {
      best = {
        table,
        nameAt,
        adpAt,
        teamAt: keys.findIndex((k) => ['team', 'tm', 'nflteam'].includes(k)),
        posAt: keys.findIndex((k) => ['position', 'pos'].includes(k)),
      };
    }
  }
  return best;
}

/** Every header on the page, for an error message that can be acted on. */
function describeTables(tables: HtmlTable[]): string {
  if (tables.length === 0) return 'no <table> elements at all';
  return tables.map((t, i) => `table ${i + 1} [${t.headers.join(' | ')}] (${t.rows.length} rows)`).join('; ');
}

/**
 * The date the page says its numbers are from.
 *
 * Worth the trouble: without it the fetch time is the only timestamp there is,
 * and a board regenerated overnight and read at noon would look nine hours
 * fresher than it is. Only a date is published, so this resolves to midnight
 * UTC — which errs towards calling a board older than it is, the safe
 * direction for a freshness check.
 *
 * Null when the page says nothing, which is honest and is what
 * `dogFreshness` is built to handle.
 */
export function lastUpdatedFromHtml(html: string): string | null {
  const text = cellText(html);
  const match = text.match(/last\s*updated\s*[:\-–]?\s*([A-Za-z0-9,/\s.-]{6,40})/i);
  if (!match) return null;
  return parseLooseDate(match[1] ?? '');
}

/**
 * `August 17, 2026`, `2026-08-17`, `8/17/2026` — the three spellings a page
 * like this uses, and nothing else. A permissive `Date.parse` would accept
 * fragments of the surrounding sentence and turn them into a confident
 * timestamp, which is worse than returning null.
 */
export function parseLooseDate(raw: string): string | null {
  const text = raw.trim();

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) return isoDate(Number(slash[3]), Number(slash[1]), Number(slash[2]));

  const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const named = text.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith((named[1] ?? '').toLowerCase().slice(0, 3)));
    if (month >= 0) return isoDate(Number(named[3]), month + 1, Number(named[2]));
  }
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const at = Date.UTC(year, month - 1, day);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** A cell's visible text: tags removed, entities decoded, whitespace collapsed. */
function cellText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rows out of a chosen table, keeping only what carries a name and an ADP. */
function rowsFromTable(found: NonNullable<ReturnType<typeof findAdpTable>>): DogRow[] {
  const rows: DogRow[] = [];
  for (const cells of found.table.rows) {
    const name = (cells[found.nameAt] ?? '').trim();
    const adp = num(cells[found.adpAt]);
    if (!name || adp == null || !(adp > 0)) continue;
    rows.push({
      name,
      team: found.teamAt >= 0 ? (cells[found.teamAt] ?? '').trim() || null : null,
      position: found.posAt >= 0 ? (cells[found.posAt] ?? '').trim() || null : null,
      adp,
    });
  }
  return rows;
}

// ------------------------------------------------------------- the providers

/**
 * Best Ball Team Builder — the primary source.
 *
 * It publishes the board two ways and this reads either: an HTML page whose
 * Big Board is a plain `<table>`, or JSON from one of their endpoints. The
 * shape is sniffed rather than configured, so the source changing from one to
 * the other is a thing this survives instead of a thing that silently empties
 * the DOG column.
 *
 * Deliberately tolerant about layout and strict about meaning: a row is kept
 * only when it carries a name and a positive, finite ADP under a heading that
 * actually names an ADP. `Round`, `Overall` and a projected-points column all
 * sort like ADP and none of them is one — `Overall` especially, being a dense
 * 1..500 run that would import as a perfectly plausible ranking.
 */
export function parseBestBallTeamBuilder(text: string): {
  rows: DogRow[];
  snapshotAt: string | null;
  keys: string[];
  headers?: string[];
} {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return parseBestBallTeamBuilderHtml(text);
  const parsed = JSON.parse(text) as unknown;
  const envelope = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null) as Record<
    string,
    unknown
  > | null;
  const list = Array.isArray(parsed)
    ? parsed
    : ((envelope?.['players'] ?? envelope?.['rows'] ?? envelope?.['data'] ?? envelope?.['adp']) as unknown);

  if (!Array.isArray(list)) {
    throw new Error('Best Ball Team Builder payload had no player array');
  }

  const snapshotAt =
    str(envelope?.['updatedAt']) ??
    str(envelope?.['updated_at']) ??
    str(envelope?.['snapshotAt']) ??
    str(envelope?.['asOf']) ??
    str(envelope?.['as_of']) ??
    null;

  const keys = new Set<string>();
  const rows: DogRow[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = flatten(entry as Record<string, unknown>);
    for (const key of Object.keys(rec)) keys.add(key);

    const name =
      str(rec['fullname']) ??
      str(rec['name']) ??
      str(rec['playername']) ??
      joinName(str(rec['firstname']), str(rec['lastname']));
    const adp = num(rec['adp']) ?? num(rec['underdogadp']) ?? num(rec['averagedraftposition']) ?? num(rec['avgpick']);
    if (!name || adp == null || !(adp > 0)) continue;

    rows.push({
      name,
      team: str(rec['team']) ?? str(rec['teamid']) ?? str(rec['nflteam']) ?? null,
      position: str(rec['position']) ?? str(rec['pos']) ?? null,
      adp,
    });
  }

  return { rows, snapshotAt, keys: [...keys] };
}

/**
 * The same source, served as a page rather than as JSON.
 *
 * The Big Board is a `<table>` with `Player | Position | Team | Round |
 * Overall | ADP | …`, and the whole job here is taking the `ADP` column and
 * nothing adjacent to it.
 *
 * The failure mode this is written against is not a crash. It is the page
 * changing — a redesign, a paywall, a React rewrite that ships an empty shell —
 * and the parser finding *something* table-shaped and importing it. So the
 * board must be identifiable by its column meanings or this throws, naming
 * every header it did find so the message says which of the two happened.
 */
export function parseBestBallTeamBuilderHtml(html: string): {
  rows: DogRow[];
  snapshotAt: string | null;
  keys: string[];
  headers: string[];
} {
  const tables = parseHtmlTables(html);
  const found = findAdpTable(tables);
  if (!found) {
    throw new Error(
      `Best Ball Team Builder page has no Big Board table with a player and an ADP column (found: ${describeTables(
        tables,
      )}) — refusing to import whatever else is on the page`,
    );
  }

  const rows = rowsFromTable(found);
  if (rows.length === 0) {
    throw new Error(
      `Best Ball Team Builder ADP column "${found.table.headers[found.adpAt]}" held no usable numbers across ${
        found.table.rows.length
      } rows`,
    );
  }

  return {
    rows,
    snapshotAt: lastUpdatedFromHtml(html),
    keys: found.table.headers,
    // Only the two columns actually read. `validateRawAdp` uses these to catch
    // a board whose ADP column has quietly become a rank, and handing it the
    // whole header row would let a stray `ADP` elsewhere on the page vouch for
    // a column that is not the one imported.
    headers: [found.table.headers[found.nameAt]!, found.table.headers[found.adpAt]!],
  };
}

/**
 * 4for4's Underdog ADP export — validation, and the fallback when the primary
 * is unreachable.
 *
 * It is a CSV, and the column that matters is the one naming Underdog. 4for4
 * publish several ADP columns side by side (their own consensus, Underdog,
 * others) and picking the wrong one produces a `DOG` that is not Underdog's at
 * all — so the Underdog column is required, by name, and its absence is an
 * error rather than a reason to fall back to whichever column is left.
 */
export function parseFour4Underdog(text: string): { rows: DogRow[]; headers: string[] } {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('<') || /<table\b/i.test(trimmed)) return parseFour4UnderdogHtml(text);
  return parseFour4UnderdogCsv(text);
}

/**
 * 4for4's Underdog ADP page.
 *
 * Same rule as the CSV, with one addition the CSV cannot have: a page carries
 * its own context. On an export named `4for4-adp.csv` a bare `ADP` column is
 * ambiguous and is refused. On a page whose title and headings say Underdog,
 * and which offers exactly one ADP column, that column is Underdog's — and
 * refusing it would mean the fallback could never work at all.
 *
 * The concession is narrow on purpose. Two ADP columns and the Underdog-named
 * one is required, as ever; no mention of Underdog on the page and nothing is
 * accepted. Which rule admitted the column is returned so the provenance can
 * say so rather than implying a header that was not there.
 */
export function parseFour4UnderdogHtml(html: string): { rows: DogRow[]; headers: string[] } {
  const tables = parseHtmlTables(html);

  // First choice, always: a column that names Underdog itself.
  const named = findAdpTable(
    tables,
    tables.flatMap((t) => t.headers.map(headerKey).filter((k) => k.includes('underdog') || k.startsWith('udadp'))),
  );
  if (named) {
    const rows = rowsFromTable(named);
    if (rows.length > 0) {
      return { rows, headers: [named.table.headers[named.nameAt]!, named.table.headers[named.adpAt]!] };
    }
  }

  const mentionsUnderdog = /underdog/i.test(cellText(html));
  if (!mentionsUnderdog) {
    throw new Error(
      `4for4 page names no Underdog ADP column and the page itself does not mention Underdog (found: ${describeTables(
        tables,
      )}) — refusing to label another source DOG`,
    );
  }

  const bare = findAdpTable(tables);
  if (!bare) {
    throw new Error(
      `4for4 page has no table with a player and an ADP column (found: ${describeTables(tables)}) — refusing to import whatever else is on the page`,
    );
  }

  // One ADP column, or the concession does not apply: with two, the unnamed one
  // could be their consensus and this is exactly the substitution to prevent.
  const adpColumns = bare.table.headers.map(headerKey).filter((k) => ADP_COLUMNS.includes(k));
  if (adpColumns.length !== 1) {
    throw new Error(
      `4for4 page carries ${adpColumns.length} ADP columns (${bare.table.headers.join(
        ' | ',
      )}) and none names Underdog — refusing to guess which one is Underdog's`,
    );
  }

  const rows = rowsFromTable(bare);
  if (rows.length === 0) {
    throw new Error(`4for4 ADP column "${bare.table.headers[bare.adpAt]}" held no usable numbers`);
  }
  return { rows, headers: [bare.table.headers[bare.nameAt]!, bare.table.headers[bare.adpAt]!] };
}

function parseFour4UnderdogCsv(csv: string): { rows: DogRow[]; headers: string[] } {
  const table = parseSimpleCsv(csv);
  if (table.length < 2) throw new Error('4for4 export had no rows');
  const headers = table[0]!.map((h) => h.trim());
  const keys = headers.map(headerKey);

  const nameAt = keys.findIndex((k) => ['name', 'player', 'playername', 'fullname'].includes(k));
  /*
   * The Underdog column, named as such.
   *
   * `underdogadp`, `udadp`, `underdog` — all name it. A bare `adp` column does
   * not: on a 4for4 export that is their own consensus, and importing it under
   * the DOG label would be exactly the substitution the brief forbids.
   */
  const adpAt = keys.findIndex((k) => k.includes('underdog') || k.startsWith('udadp') || k === 'ud');
  if (nameAt < 0) throw new Error('4for4 export had no player-name column');
  if (adpAt < 0) {
    throw new Error(
      `4for4 export has no Underdog ADP column (saw: ${headers.join(', ')}) — refusing to label another source DOG`,
    );
  }

  const teamAt = keys.findIndex((k) => ['team', 'nflteam', 'tm'].includes(k));
  const posAt = keys.findIndex((k) => ['position', 'pos'].includes(k));

  const rows: DogRow[] = [];
  for (const cells of table.slice(1)) {
    const name = (cells[nameAt] ?? '').trim();
    const adp = num(cells[adpAt]);
    if (!name || adp == null || !(adp > 0)) continue;
    rows.push({
      name,
      team: teamAt >= 0 ? (cells[teamAt] ?? '').trim() || null : null,
      position: posAt >= 0 ? (cells[posAt] ?? '').trim() || null : null,
      adp,
    });
  }
  return { rows, headers: [headers[nameAt]!, headers[adpAt]!] };
}

/**
 * Turn a validated snapshot into the JSON the existing ADP importer accepts.
 *
 * Identical in shape to what the Sleeper path produces, so DOG rides the same
 * matcher, the same unresolved-row review queue and the same idempotency — one
 * ingestion path, two markets. `rank` is derived from the ADP ordering rather
 * than carried, because a rank taken from a source row is a second ordering
 * that can disagree with the first.
 */
export function toAdpImportFile(rows: DogRow[]): string {
  const ordered = [...rows]
    .filter((r) => Number.isFinite(r.adp) && r.adp > 0)
    .sort((a, b) => a.adp - b.adp || a.name.localeCompare(b.name))
    .map((row, i) => ({
      name: row.name,
      team: row.team ?? '',
      position: row.position ?? '',
      adp: row.adp,
      rank: i + 1,
    }));
  return JSON.stringify(ordered, null, 2);
}

/**
 * Which source answered, given what was reachable.
 *
 * The hierarchy is the brief's: the primary, then 4for4 as validation and
 * fallback, and never Sleeper. Written as a function over already-fetched
 * candidates rather than as a fetch loop so the *policy* can be tested without
 * a network — which is the half of this that has to be right.
 */
export function chooseDogSource(
  candidates: { snapshot: DogSnapshot; verdict: RawAdpVerdict }[],
  now: Date | string = new Date(),
): { chosen: DogSnapshot | null; freshness: ReturnType<typeof dogFreshness> | null; rejected: string[] } {
  const order: DogProvider[] = ['best_ball_team_builder', '4for4'];
  const rejected: string[] = [];

  for (const provider of order) {
    const candidate = candidates.find((c) => c.snapshot.provider === provider);
    if (!candidate) continue;
    if (!candidate.verdict.valid) {
      rejected.push(`${DOG_PROVIDER_LABELS[provider]}: ${candidate.verdict.reason}`);
      continue;
    }
    const freshness = dogFreshness(candidate.snapshot, now);
    if (!dogIsUsable(freshness.state)) {
      rejected.push(`${DOG_PROVIDER_LABELS[provider]}: ${freshness.note}`);
      continue;
    }
    return { chosen: candidate.snapshot, freshness, rejected };
  }

  return { chosen: null, freshness: null, rejected };
}

// ------------------------------------------------------------------ plumbing

/** Header names, reduced to a comparable key. Shared with the ADP importer. */
function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * One level of nesting flattened onto the row, keys normalised.
 *
 * These payloads put the player under `player: {...}` about half the time. A
 * nested key never overwrites a top-level one: the outer object is the row, and
 * the inner one is detail about it.
 */
function flatten(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        const k = headerKey(inner);
        if (!(k in out)) out[k] = innerValue;
      }
      continue;
    }
    out[headerKey(key)] = value;
  }
  // Top level wins over anything nested that shares its name.
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) continue;
    out[headerKey(key)] = value;
  }
  return out;
}

function joinName(first: string | null, last: string | null): string | null {
  const name = `${first ?? ''} ${last ?? ''}`.trim();
  return name || null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Enough CSV for an export: quoted fields, escaped quotes, CRLF. */
function parseSimpleCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
