/**
 * Reading a preseason season-long market snapshot, whatever shape it arrived in.
 *
 * SportsGameOdds publishes no season-long markets — established twice against
 * its live catalogue — so the draft's season baseline comes from a person
 * copying a table once or twice a preseason. That means this module's input is
 * a clipboard, and a clipboard is not a file format.
 *
 * Three shapes are accepted, and which one arrived is *detected*, never asked:
 *
 *   - **canonical** — the `PRESEASON_VEGAS_V1` block, pipe-separated, which the
 *     ChatGPT normalisation fallback returns;
 *   - **delimited** — CSV from a download, or the TSV a browser table copy
 *     produces, or a pipe table pasted out of somewhere;
 *   - anything else is **unknown**, and unknown fails loudly.
 *
 * The last of those is the point. A parser that guesses at an unrecognised
 * shape produces rows that look plausible and are wrong, and a wrong season
 * line is worse than no season line — the whole feature exists to stop the
 * board inventing confidence. So the failure names what it could not do.
 */

import { parseCsv } from '../adp/import.ts';

/** How the input was read. Reported to the user, not just used internally. */
export type SnapshotFormat = 'canonical' | 'csv' | 'tsv' | 'pipe' | 'unknown';

/** One row as it appeared in the input, before any meaning is attached. */
export interface RawSnapshotRow {
  /** 1-based, counting only content lines, so a reported row can be found. */
  rowNumber: number;
  player: string;
  team: string | null;
  position: string | null;
  /** The market exactly as written; normalisation happens later. */
  market: string;
  line: string;
  overPrice: string | null;
  underPrice: string | null;
}

export interface ParsedSnapshot {
  format: SnapshotFormat;
  rows: RawSnapshotRow[];
  /** Rows that could not even be read as rows. Never silently dropped. */
  malformed: { rowNumber: number; reason: string; text: string }[];
  /** Provenance the canonical block carried in its own META line, if any. */
  meta: { season?: string; source?: string; capturedAt?: string };
  /**
   * The header labels exactly as the source wrote them.
   *
   * Kept because the headers are evidence in their own right: a table with a
   * `Projections` column and a `Comps` column is a projection model's output
   * whatever its rows say, and that has to be answerable even when the rows
   * were never readable in the first place.
   */
  columns: string[];
}

export class SnapshotFormatError extends Error {
  constructor(
    message: string,
    readonly format: SnapshotFormat,
    /** Headers seen, so a caller can say *why* the shape was wrong. */
    readonly columns: string[] = [],
  ) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

const BEGIN = 'PRESEASON_VEGAS_V1';
const END = 'END_PRESEASON_VEGAS';

/** Column names this reader understands, in every spelling seen so far. */
const HEADER_ALIASES: Record<string, keyof RawSnapshotRow> = {
  player: 'player',
  playername: 'player',
  player_name: 'player',
  name: 'player',
  fullname: 'player',
  full_name: 'player',
  team: 'team',
  teamabbr: 'team',
  team_abbr: 'team',
  nflteam: 'team',
  pos: 'position',
  position: 'position',
  market: 'market',
  stat: 'market',
  prop: 'market',
  line: 'line',
  total: 'line',
  ou: 'line',
  overunder: 'line',
  over_under: 'line',
  over: 'overPrice',
  overprice: 'overPrice',
  over_price: 'overPrice',
  overodds: 'overPrice',
  under: 'underPrice',
  underprice: 'underPrice',
  under_price: 'underPrice',
  underodds: 'underPrice',
};

function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s.]+/g, '').replace(/-/g, '_');
}

function clean(v: string | undefined): string {
  return (v ?? '').trim();
}

function orNull(v: string | undefined): string | null {
  const t = clean(v);
  return t === '' || t === '-' || t === '—' ? null : t;
}

/**
 * Which delimiter is this, decided on the body rather than the first line.
 *
 * A header can contain a comma inside a quoted label and a body row can carry a
 * name like "Smith, Jr.", so a single line is not evidence. The delimiter that
 * appears with the most *consistent* count across lines is the real one: a
 * genuine separator appears the same number of times in every row, and a comma
 * inside a name does not.
 */
export function sniffDelimiter(text: string): { delimiter: string; format: SnapshotFormat } | null {
  const lines = contentLines(text).slice(0, 25);
  if (lines.length === 0) return null;

  const candidates: { delimiter: string; format: SnapshotFormat }[] = [
    { delimiter: '\t', format: 'tsv' },
    { delimiter: '|', format: 'pipe' },
    { delimiter: ',', format: 'csv' },
  ];

  let best: { delimiter: string; format: SnapshotFormat; score: number } | null = null;
  for (const c of candidates) {
    const counts = lines.map((l) => l.split(c.delimiter).length - 1);
    const min = Math.min(...counts);
    if (min < 1) continue; // not present on every line, so not the separator
    const consistent = counts.filter((n) => n === counts[0]).length / counts.length;
    // Prefer the delimiter that splits into the most columns *and* does so the
    // same way on every line. Tab wins ties by candidate order, which is right:
    // a clipboard table is tab-separated far more often than anything else.
    const score = consistent * 100 + min;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best ? { delimiter: best.delimiter, format: best.format } : null;
}

/** Lines with content, with code fences and blank lines removed. */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^```/.test(l));
}

/**
 * Read the canonical block, ignoring whatever surrounds it.
 *
 * The fallback path is "paste what the assistant replied", and an assistant
 * reply is prose with a block in it. Only what lies between the markers is
 * imported — deliberately, because prose that happens to contain numbers is
 * exactly the thing that must not become a market line.
 */
function parseCanonical(text: string): ParsedSnapshot {
  const lines = contentLines(text);
  const start = lines.findIndex((l) => l.toUpperCase().startsWith(BEGIN));
  const endAt = lines.findIndex((l) => l.toUpperCase().startsWith(END));
  const body = lines.slice(start + 1, endAt === -1 ? undefined : endAt);

  const meta: ParsedSnapshot['meta'] = {};
  const rows: RawSnapshotRow[] = [];
  const malformed: ParsedSnapshot['malformed'] = [];

  body.forEach((line, i) => {
    const rowNumber = i + 1;
    if (/^META\b/i.test(line)) {
      for (const part of line.split('|').slice(1)) {
        const [k, ...rest] = part.split('=');
        const key = clean(k).toLowerCase();
        const value = clean(rest.join('='));
        if (!value) continue;
        if (key === 'season') meta.season = value;
        else if (key === 'source') meta.source = value;
        else if (key === 'captured' || key === 'capturedat') meta.capturedAt = value;
      }
      return;
    }

    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) {
      malformed.push({
        rowNumber,
        reason: `expected at least 5 fields (player | team | position | market | line), found ${cells.length}`,
        text: line,
      });
      return;
    }
    const player = clean(cells[0]);
    if (!player) {
      malformed.push({ rowNumber, reason: 'no player name', text: line });
      return;
    }
    rows.push({
      rowNumber,
      player,
      team: orNull(cells[1]),
      position: orNull(cells[2]),
      market: clean(cells[3]),
      line: clean(cells[4]),
      overPrice: orNull(cells[5]),
      underPrice: orNull(cells[6]),
    });
  });

  return { format: 'canonical', rows, malformed, meta, columns: [] };
}

/** Read a delimited table by its header row. */
function parseDelimited(text: string, delimiter: string, format: SnapshotFormat): ParsedSnapshot {
  const grid = parseCsv(text, delimiter)
    .map((cells) => cells.map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c !== ''));
  if (grid.length < 2) {
    throw new SnapshotFormatError(
      'the pasted table has no rows under its header — copy the table including its header row',
      format,
      grid[0] ?? [],
    );
  }

  const labels = grid[0]!;
  const headers = labels.map((h) => HEADER_ALIASES[headerKey(h)] ?? null);
  const missing: string[] = [];
  if (!headers.includes('player')) missing.push('a player-name column');
  if (!headers.includes('market')) missing.push('a market column');
  if (!headers.includes('line')) missing.push('a line column');
  if (missing.length > 0) {
    throw new SnapshotFormatError(
      `could not find ${missing.join(', ')} in the header row: ${labels.join(delimiter === '\t' ? ' | ' : delimiter)}`,
      format,
      labels,
    );
  }

  const rows: RawSnapshotRow[] = [];
  const malformed: ParsedSnapshot['malformed'] = [];

  grid.slice(1).forEach((cells, i) => {
    const rowNumber = i + 1;
    const get = (field: keyof RawSnapshotRow): string | undefined => {
      const at = headers.indexOf(field);
      return at === -1 ? undefined : cells[at];
    };
    const player = clean(get('player'));
    if (!player) {
      malformed.push({ rowNumber, reason: 'no player name', text: cells.join(' ') });
      return;
    }
    rows.push({
      rowNumber,
      player,
      team: orNull(get('team')),
      position: orNull(get('position')),
      market: clean(get('market')),
      line: clean(get('line')),
      overPrice: orNull(get('overPrice')),
      underPrice: orNull(get('underPrice')),
    });
  });

  return { format, rows, malformed, meta: {}, columns: labels };
}

/**
 * Read a pasted snapshot, detecting which of the accepted shapes it is.
 *
 * Throws `SnapshotFormatError` when it cannot tell — never a best guess. The
 * message is written for the person holding the clipboard, because they are the
 * only one who can fix it, and "unknown format" on its own tells them nothing.
 */
export function parseSnapshot(text: string): ParsedSnapshot {
  const input = (text ?? '').replace(/^﻿/, '');
  if (input.trim() === '') {
    throw new SnapshotFormatError('nothing was pasted', 'unknown');
  }

  if (input.toUpperCase().includes(BEGIN)) return parseCanonical(input);

  const sniffed = sniffDelimiter(input);
  if (!sniffed) {
    throw new SnapshotFormatError(
      'this does not look like a table: no commas, tabs or pipes separate the columns. ' +
        'Copy the table again including its header row, or use "Copy for ChatGPT" and paste the ' +
        `${BEGIN} block it returns.`,
      'unknown',
    );
  }
  return parseDelimited(input, sniffed.delimiter, sniffed.format);
}

/**
 * The block a person pastes into the assistant thread.
 *
 * Carries the provenance with the data so the reply can carry it back, which is
 * what stops a snapshot arriving with no idea what it is or when it was taken.
 */
export function buildSourceBlock(input: {
  season: string;
  source: string;
  capturedAt: string;
  raw: string;
}): string {
  return [
    'PRESEASON_VEGAS_SOURCE_V1',
    `Season: ${input.season}`,
    `Source: ${input.source}`,
    `Captured: ${input.capturedAt}`,
    '',
    input.raw.trim(),
    '',
    'END_PRESEASON_VEGAS_SOURCE',
  ].join('\n');
}
