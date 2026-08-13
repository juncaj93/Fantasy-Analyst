/**
 * Underdog ADP snapshot import.
 *
 * Deliberately NOT a live scraper. The user exports/downloads a same-day ADP
 * snapshot (CSV or JSON), imports it, and the snapshot is frozen for the draft.
 *
 * Original source values are always preserved alongside the resolved canonical
 * player id; rows that cannot be resolved unambiguously are surfaced for review
 * rather than dropped or guessed.
 */

import { PlayerIndex, resolvePlayer } from '../identity/index.ts';
import { normalizePosition, normalizeTeam } from '../identity/normalize.ts';
import type { MatchResult } from '../identity/types.ts';

export interface AdpImportRow {
  /** 1-based row number in the source file, for error reporting. */
  rowNumber: number;
  sourceName: string;
  sourceTeam: string | null;
  sourcePosition: string | null;
  adp: number | null;
  rank: number | null;
  raw: Record<string, string>;
  match: MatchResult;
  playerId: string | null;
}

export interface AdpImportResult {
  source: string;
  label: string;
  capturedAt: string;
  fileHash: string;
  rows: AdpImportRow[];
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  /** Rows dropped because they had no usable name or ADP. */
  skipped: { rowNumber: number; reason: string }[];
}

export interface AdpImportOptions {
  source?: string;
  label?: string;
  /** ISO timestamp the snapshot was captured (defaults to import time). */
  capturedAt?: string;
  now?: string;
}

const NAME_KEYS = ['name', 'player', 'playername', 'fullname', 'player_name', 'full_name', 'playerfullname'];
const ADP_KEYS = ['adp', 'averagepick', 'average_pick', 'avgpick', 'avg_pick', 'adpoverall', 'overallpick'];
const RANK_KEYS = ['rank', 'overallrank', 'overall_rank', 'adprank', 'positionrank_overall', 'projectedrank'];
const TEAM_KEYS = ['team', 'teamname', 'nflteam', 'teamabbr', 'team_abbr', 'proteam'];
const POS_KEYS = ['position', 'pos', 'slotname', 'positionname', 'player_position'];
const FIRST_KEYS = ['firstname', 'first_name'];
const LAST_KEYS = ['lastname', 'last_name'];

/** RFC4180-ish CSV parser: quoted fields, escaped quotes, CRLF, embedded commas. */
export function parseCsv(text: string): string[][] {
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

function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function pick(obj: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function toNumber(v: string | null): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Alternative spellings to try when the exported name does not resolve.
 * Currently only the "Last, First" convention some exports use.
 */
export function alternateNameForms(name: string): string[] {
  const parts = name.split(',');
  if (parts.length !== 2) return [];
  const [last, first] = parts.map((p) => p.trim());
  if (!last || !first) return [];
  return [`${first} ${last}`];
}

/** Stable FNV-1a 64-bit hex hash. Used for snapshot idempotency. */
export function fileHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Convert raw file text (CSV or JSON) into uniform string-keyed records. */
export function parseAdpFile(text: string): Record<string, string>[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)['players'])
        ? ((parsed as Record<string, unknown>)['players'] as unknown[])
        : Array.isArray((parsed as Record<string, unknown>)['data'])
          ? ((parsed as Record<string, unknown>)['data'] as unknown[])
          : Array.isArray((parsed as Record<string, unknown>)['rows'])
            ? ((parsed as Record<string, unknown>)['rows'] as unknown[])
            : [];
    return list.map((item) => flattenRecord(item as Record<string, unknown>));
  }

  const rows = parseCsv(trimmed);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map(headerKey);
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) rec[h] = (cells[i] ?? '').trim();
    });
    return rec;
  });
}

function flattenRecord(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = headerKey(prefix ? `${prefix}_${k}` : k);
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenRecord(v as Record<string, unknown>, k));
      continue;
    }
    if (Array.isArray(v)) continue;
    out[key] = String(v);
  }
  return out;
}

/**
 * Import an ADP file and resolve every row against the canonical player index.
 *
 * Rows are never discarded for being unmatched: they are retained with
 * `playerId: null` and an attached `MatchResult` so the review queue can fix
 * them without a re-import.
 */
export function importAdpSnapshot(
  text: string,
  index: PlayerIndex,
  opts: AdpImportOptions = {},
): AdpImportResult {
  const now = opts.now ?? new Date().toISOString();
  const records = parseAdpFile(text);
  const rows: AdpImportRow[] = [];
  const skipped: { rowNumber: number; reason: string }[] = [];

  records.forEach((rec, i) => {
    const rowNumber = i + 1;
    let name = pick(rec, NAME_KEYS);
    if (!name) {
      const first = pick(rec, FIRST_KEYS);
      const last = pick(rec, LAST_KEYS);
      if (first && last) name = `${first} ${last}`;
    }
    if (!name) {
      skipped.push({ rowNumber, reason: 'no player name column' });
      return;
    }
    const adp = toNumber(pick(rec, ADP_KEYS));
    const rank = toNumber(pick(rec, RANK_KEYS));
    if (adp == null && rank == null) {
      skipped.push({ rowNumber, reason: 'no adp or rank value' });
      return;
    }
    const sourceTeam = pick(rec, TEAM_KEYS);
    const sourcePosition = pick(rec, POS_KEYS);

    // Try each plausible spelling of the exported name, strongest first, and
    // keep the first confident match. Falls back to the primary form's result
    // so an unresolved row still reports a useful reason.
    let match = resolvePlayer(
      {
        name,
        team: sourceTeam ? normalizeTeam(sourceTeam) : null,
        position: sourcePosition ? normalizePosition(sourcePosition) : null,
      },
      index,
    );
    if (match.status !== 'matched') {
      for (const alternate of alternateNameForms(name)) {
        const retry = resolvePlayer(
          {
            name: alternate,
            team: sourceTeam ? normalizeTeam(sourceTeam) : null,
            position: sourcePosition ? normalizePosition(sourcePosition) : null,
          },
          index,
        );
        if (retry.status === 'matched') {
          match = retry;
          break;
        }
      }
    }

    rows.push({
      rowNumber,
      sourceName: name,
      sourceTeam,
      sourcePosition,
      adp,
      rank,
      raw: rec,
      match,
      playerId: match.status === 'matched' ? match.playerId : null,
    });
  });

  return {
    source: opts.source ?? 'underdog',
    label: opts.label ?? `ADP ${now.slice(0, 10)}`,
    capturedAt: opts.capturedAt ?? now,
    fileHash: fileHash(text),
    rows,
    matchedCount: rows.filter((r) => r.match.status === 'matched').length,
    ambiguousCount: rows.filter((r) => r.match.status === 'ambiguous').length,
    unmatchedCount: rows.filter((r) => r.match.status === 'unmatched').length,
    skipped,
  };
}
