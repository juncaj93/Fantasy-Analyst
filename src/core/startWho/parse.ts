/**
 * Reading a StartWho "My League" table off the clipboard.
 *
 * What copies out of that page is not a table. It is a vertical stream of five
 * lines per player, of which exactly one carries tabs:
 *
 *   1  `1\t`                              the ordinal rank, with a trailing tab
 *   2  `▸`                                the row's disclosure triangle
 *   3  `Jahmyr Gibbs`                     the name, alone
 *   4  `RB1\tDetroit Lions\t292.0\t`      positional rank, club, points
 *   5  `5/5`                              how many of its inputs agreed
 *
 * The generic reader refuses this, correctly: it requires a delimiter on every
 * line, and this has tabs on two lines in five. Loosening that rule to admit
 * this shape would put every other paste at risk of being read as a table it is
 * not — so this is a separate, explicit adapter, chosen by recognising the
 * shape rather than by weakening the general case.
 *
 * Messy to look at, and completely deterministic: the five-line cycle is
 * regular and the triangle is a reliable record marker. That is what makes a
 * direct parser the right answer here rather than the assistant fallback, which
 * stays wired for the day StartWho changes its layout.
 *
 * Nothing here decides what the numbers *mean*. They are a projection, and the
 * scoring profile they were computed under is not in the clipboard — the
 * importer takes that from the person, because it is the one fact this text
 * cannot supply and the one that makes a snapshot valid or useless.
 */

/** The disclosure triangle StartWho puts on every row. */
const RECORD_MARKER = '▸';

/** `RB1`, `WR34`, `QB2` — a position with its rank fused onto it. */
const POSITION_RANK = /^([A-Z]{1,3})(\d{1,3})$/;

/** `Last updated: Aug 22 at 9:01 AM` */
const LAST_UPDATED = /last updated:\s*(.+)$/i;

export interface StartWhoRow {
  /** 1-based position in the paste, so a reported row can be found again. */
  rowNumber: number;
  /**
   * StartWho's own ordinal rank.
   *
   * Read so it can be stored for audit and *never* used as a ranking input.
   * It is not a points order — Gibbs is rank 1 at 292.0 and Josh Allen is rank
   * 14 at 386.1 — so it is StartWho's own draft-value opinion, and this app has
   * its own.
   */
  sourceRank: number | null;
  playerName: string;
  team: string | null;
  position: string | null;
  positionRank: number | null;
  /** Projected season fantasy points, under whatever profile was configured. */
  points: number;
  /** `5/5`. Kept for provenance; never shown and never scored. */
  sourceCount: string | null;
}

export interface StartWhoSnapshot {
  rows: StartWhoRow[];
  /** Records that could not be read. Reported, never dropped. */
  malformed: { rowNumber: number; reason: string; text: string }[];
  /** `Aug 22 at 9:01 AM`, exactly as the page wrote it, when present. */
  lastUpdated: string | null;
}

export class StartWhoFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartWhoFormatError';
  }
}

/**
 * Is this a StartWho paste?
 *
 * Two things have to hold together: the disclosure triangle appears on its own
 * line more than once, and at least one line looks like the fused
 * position-rank/club/points row. Either alone is too weak — a triangle is just
 * a character, and a tabbed line is any table — and together they do not occur
 * anywhere else this app reads.
 */
export function looksLikeStartWho(text: string): boolean {
  const lines = (text ?? '').split(/\r?\n/).map((l) => l.trim());
  const markers = lines.filter((l) => l === RECORD_MARKER).length;
  const detailRows = lines.filter((l) => {
    const cells = l.split('\t').map((c) => c.trim());
    return cells.length >= 3 && POSITION_RANK.test(cells[0] ?? '');
  }).length;
  return markers >= 2 && detailRows >= 2;
}

function toPoints(raw: string): number | null {
  const text = raw.replace(/[\s,]/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read a StartWho paste into rows.
 *
 * Records are cut on the triangle rather than by counting lines in fives: a
 * blank line, a missing source count or a wrapped name would put a fixed stride
 * permanently out of phase, and every row after it would be quietly wrong. The
 * marker resynchronises on every record, so one odd row costs one row.
 */
export function parseStartWho(text: string): StartWhoSnapshot {
  const all = (text ?? '').replace(/^﻿/, '').split(/\r?\n/);

  let lastUpdated: string | null = null;
  for (const line of all) {
    const hit = line.match(LAST_UPDATED);
    if (hit?.[1]) lastUpdated = hit[1].trim();
  }

  const lines = all.map((l) => l.trim()).filter((l) => l !== '');
  const markerAt: number[] = [];
  lines.forEach((l, i) => {
    if (l === RECORD_MARKER) markerAt.push(i);
  });

  if (markerAt.length === 0) {
    throw new StartWhoFormatError(
      'this does not look like a StartWho table — copy the whole My League list, including the row markers',
    );
  }

  const rows: StartWhoRow[] = [];
  const malformed: StartWhoSnapshot['malformed'] = [];

  markerAt.forEach((at, index) => {
    const rowNumber = index + 1;
    // The record runs from this marker to the next one; the rank sits on the
    // line before it.
    const end = index + 1 < markerAt.length ? markerAt[index + 1]! - 1 : lines.length;
    const body = lines.slice(at + 1, end);
    const rankLine = at > 0 ? lines[at - 1] ?? '' : '';

    const playerName = (body[0] ?? '').trim();
    if (!playerName) {
      malformed.push({ rowNumber, reason: 'no player name after the row marker', text: body.join(' / ') });
      return;
    }

    // The detail line is found by shape, not by position: a record with an
    // extra line in it should still be read rather than refused.
    const detail = body
      .slice(1)
      .map((l) => l.split('\t').map((c) => c.trim()))
      .find((cells) => cells.length >= 3 && POSITION_RANK.test(cells[0] ?? ''));

    if (!detail) {
      malformed.push({
        rowNumber,
        reason: `no position/club/points line for "${playerName}"`,
        text: body.join(' / '),
      });
      return;
    }

    const posRank = (detail[0] ?? '').match(POSITION_RANK);
    const points = toPoints(detail[2] ?? '');
    if (points == null) {
      malformed.push({
        rowNumber,
        reason: `"${detail[2] ?? ''}" is not a points value for "${playerName}"`,
        text: detail.join(' | '),
      });
      return;
    }

    // The source count is the bare `n/m` line, wherever it sits in the record.
    const sourceCount = body.find((l) => /^\d+\s*\/\s*\d+$/.test(l))?.replace(/\s/g, '') ?? null;
    const rank = Number((rankLine.match(/^(\d{1,4})\b/) ?? [])[1]);

    rows.push({
      rowNumber,
      sourceRank: Number.isFinite(rank) && rank > 0 ? rank : null,
      playerName,
      team: (detail[1] ?? '').trim() || null,
      position: posRank?.[1] ?? null,
      positionRank: posRank?.[2] ? Number(posRank[2]) : null,
      points,
      sourceCount,
    });
  });

  if (rows.length === 0 && malformed.length === 0) {
    throw new StartWhoFormatError('no player rows were found in the paste');
  }

  return { rows, malformed, lastUpdated };
}

/**
 * `Aug 22 at 9:01 AM` -> `2026-08-22`, in the season's own year.
 *
 * StartWho writes no year, so one is supplied. Returns null rather than a guess
 * when the text cannot be read — a capture date that is silently wrong is worse
 * than one the person is asked for, because the whole point of storing it is to
 * know how old the numbers are.
 */
export function captureDateFrom(lastUpdated: string | null, season: string): string | null {
  if (!lastUpdated) return null;
  const hit = lastUpdated.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\b/);
  if (!hit) return null;
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const month = months[hit[1]!.slice(0, 3).toLowerCase()];
  const day = Number(hit[2]);
  const year = Number(season);
  if (!month || !Number.isFinite(day) || day < 1 || day > 31 || !Number.isFinite(year)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
