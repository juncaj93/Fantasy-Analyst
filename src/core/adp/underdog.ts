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

// ------------------------------------------------------------- the providers

/**
 * Best Ball Team Builder — the primary source.
 *
 * It publishes its board as JSON: either a bare array of player objects or an
 * envelope with the array under a `players`, `rows` or `data` key. The keys
 * vary between their endpoints, so every plausible spelling of the four fields
 * this app needs is accepted and anything else is ignored.
 *
 * Deliberately tolerant about layout and strict about meaning: a row is kept
 * only when it carries a name and a positive, finite ADP under a key that
 * actually names an ADP. A row whose only number is a rank is dropped here and
 * would be rejected by `validateRawAdp` anyway.
 */
export function parseBestBallTeamBuilder(text: string): { rows: DogRow[]; snapshotAt: string | null; keys: string[] } {
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
 * 4for4's Underdog ADP export — validation, and the fallback when the primary
 * is unreachable.
 *
 * It is a CSV, and the column that matters is the one naming Underdog. 4for4
 * publish several ADP columns side by side (their own consensus, Underdog,
 * others) and picking the wrong one produces a `DOG` that is not Underdog's at
 * all — so the Underdog column is required, by name, and its absence is an
 * error rather than a reason to fall back to whichever column is left.
 */
export function parseFour4Underdog(csv: string): { rows: DogRow[]; headers: string[] } {
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
