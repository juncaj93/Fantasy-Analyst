/**
 * A pasted snapshot, turned into rows this app can stand behind.
 *
 * Pure: it reads text and a player index and returns what *would* be stored. It
 * writes nothing, which is what lets the same function serve the preview and
 * the apply — the preview is not an approximation of the import, it is the
 * import with the write left off. Two code paths that could disagree about what
 * a file contains is precisely how a preview stops being worth reading.
 *
 * Three rules run through everything here:
 *
 *   - **Nothing is invented.** A missing price stays null; it never becomes
 *     zero, and a row with no line is refused rather than defaulted.
 *   - **Nothing is silently dropped.** A row that cannot be read, whose market
 *     is not supported, or whose player does not resolve is *reported*, and the
 *     unresolved ones are still stored so they can be repaired later.
 *   - **Identity failure is not absence.** A name that does not resolve means
 *     "we do not know who this is", which is a different fact from "this player
 *     has no market" and must never be flattened into it.
 */

import { normalizePosition, normalizeTeam, resolvePlayer, type MatchCandidate, type PlayerIndex } from '../identity/index.ts';
import type { SeasonMarketKey } from '../vegas/types.ts';
import { lookupSeasonMarket, looksLikeWeeklyMagnitude } from './markets.ts';
import { parseSnapshot, type RawSnapshotRow, type SnapshotFormat } from './parse.ts';

/** One row that survived validation, with its identity decision attached. */
export interface ResolvedSnapshotRow {
  rowNumber: number;
  sourcePlayerName: string;
  sourceTeam: string | null;
  sourcePosition: string | null;
  market: SeasonMarketKey;
  line: number;
  /** American odds. Null when the source did not publish them. Never zero. */
  overPrice: number | null;
  underPrice: number | null;
  /** Null when the name did not resolve to exactly one player. */
  playerId: string | null;
  matchStatus: 'matched' | 'ambiguous' | 'unmatched';
  matchMethod: string | null;
  /** Ranked alternatives, for the Review queue. Only when not matched. */
  candidates: MatchCandidate[];
}

export interface RejectedRow {
  rowNumber: number;
  reason: string;
  text: string;
}

export interface SnapshotImportInput {
  season: string;
  source: string;
  /** The date the numbers were captured, not the date they were pasted. */
  capturedAt: string;
}

export interface SnapshotImport {
  format: SnapshotFormat;
  season: string;
  source: string;
  capturedAt: string;
  rows: ResolvedSnapshotRow[];
  rejected: RejectedRow[];
  /** Markets present in the input, as internal keys. */
  markets: SeasonMarketKey[];
  counts: {
    parsed: number;
    accepted: number;
    rejected: number;
    uniquePlayers: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
  };
  /**
   * Things worth saying out loud that are not errors.
   *
   * Chiefly: lines too small to be a season. A weekly table pasted into the
   * season importer parses perfectly and is completely wrong, and no per-row
   * validation can catch it — only the shape of the whole snapshot can.
   */
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** American odds: "+120", "-110", "120". Anything else is not a price. */
function toPrice(raw: string | null): { ok: true; value: number | null } | { ok: false; reason: string } {
  if (raw == null) return { ok: true, value: null };
  const text = raw.replace(/\s+/g, '');
  if (text === '') return { ok: true, value: null };
  if (!/^[+-]?\d{2,5}$/.test(text)) return { ok: false, reason: `"${raw}" is not an American price` };
  const n = Number(text);
  // Zero is not a price anybody quotes, and treating it as one would put a
  // meaningless number where "the source did not say" belongs.
  if (!Number.isFinite(n) || n === 0) return { ok: true, value: null };
  return { ok: true, value: n };
}

/** A line: a finite number, with thousands separators tolerated. */
function toLine(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
  const text = (raw ?? '').replace(/[\s,]/g, '').replace(/^o\/?u/i, '');
  if (text === '') return { ok: false, reason: 'no line on this row' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, reason: `"${raw}" is not a number` };
  if (n <= 0) return { ok: false, reason: `a line of ${raw} is not a season total` };
  return { ok: true, value: n };
}

function resolveRow(row: RawSnapshotRow, index: PlayerIndex) {
  // Name plus team plus position first, because that is what separates two
  // players with one name — the single most valuable thing a source can carry
  // beyond the name itself.
  const query = {
    name: row.player,
    team: row.team ? normalizeTeam(row.team) : null,
    position: row.position ? normalizePosition(row.position) : null,
  };
  let match = resolvePlayer(query, index);
  if (match.status !== 'matched' && (query.team || query.position)) {
    // Fall back to the bare name: a source whose team column is stale after a
    // trade should not turn a findable player into an unknown one.
    const byName = resolvePlayer({ name: row.player }, index);
    if (byName.status === 'matched') match = byName;
  }
  return match;
}

/**
 * Read, validate and resolve a pasted snapshot. Writes nothing.
 *
 * Throws only when the input cannot be read as a table at all — every other
 * problem is a reported row, because one bad line in two hundred should not
 * cost somebody the other hundred and ninety-nine.
 */
export function buildSnapshotImport(
  text: string,
  index: PlayerIndex,
  input: SnapshotImportInput,
): SnapshotImport {
  const parsed = parseSnapshot(text);

  // The block's own META wins over the form when the form was left empty: the
  // assistant reply carries the provenance it was given, and retyping it is a
  // chance to get it wrong.
  const season = (input.season || parsed.meta.season || '').trim();
  const source = (input.source || parsed.meta.source || '').trim();
  const capturedAt = (input.capturedAt || parsed.meta.capturedAt || '').trim();

  if (!season) throw new Error('which season these lines settle on is required');
  if (!source) throw new Error('where these lines came from is required');
  if (!ISO_DATE.test(capturedAt)) {
    throw new Error(`the capture date must be a calendar date like 2026-08-27, not "${capturedAt}"`);
  }

  const rows: ResolvedSnapshotRow[] = [];
  const rejected: RejectedRow[] = parsed.malformed.map((m) => ({
    rowNumber: m.rowNumber,
    reason: m.reason,
    text: m.text,
  }));

  for (const raw of parsed.rows) {
    const asText = [raw.player, raw.team, raw.position, raw.market, raw.line].filter(Boolean).join(' | ');

    const market = lookupSeasonMarket(raw.market);
    if (!market.ok) {
      rejected.push({ rowNumber: raw.rowNumber, reason: market.reason, text: asText });
      continue;
    }
    const line = toLine(raw.line);
    if (!line.ok) {
      rejected.push({ rowNumber: raw.rowNumber, reason: line.reason, text: asText });
      continue;
    }
    const over = toPrice(raw.overPrice);
    if (!over.ok) {
      rejected.push({ rowNumber: raw.rowNumber, reason: over.reason, text: asText });
      continue;
    }
    const under = toPrice(raw.underPrice);
    if (!under.ok) {
      rejected.push({ rowNumber: raw.rowNumber, reason: under.reason, text: asText });
      continue;
    }

    const match = resolveRow(raw, index);
    rows.push({
      rowNumber: raw.rowNumber,
      sourcePlayerName: raw.player,
      sourceTeam: raw.team,
      sourcePosition: raw.position,
      market: market.market,
      line: line.value,
      overPrice: over.value,
      underPrice: under.value,
      playerId: match.status === 'matched' ? match.playerId : null,
      matchStatus: match.status,
      matchMethod: match.method,
      candidates: match.status === 'matched' ? [] : match.candidates,
    });
  }

  const markets = [...new Set(rows.map((r) => r.market))];
  const uniquePlayers = new Set(rows.map((r) => r.playerId ?? `name:${r.sourcePlayerName.toLowerCase()}`)).size;

  const warnings: string[] = [];
  const weekly = rows.filter((r) => looksLikeWeeklyMagnitude(r.market, r.line));
  if (rows.length > 0 && weekly.length > rows.length / 2) {
    warnings.push(
      `${weekly.length} of ${rows.length} lines are smaller than a whole season usually is ` +
        `(for example ${weekly[0]!.sourcePlayerName} at ${weekly[0]!.line}). ` +
        'If this is a weekly prop table it belongs to the game-day pipeline, not here.',
    );
  }

  return {
    format: parsed.format,
    season,
    source,
    capturedAt,
    rows,
    rejected,
    markets,
    counts: {
      parsed: parsed.rows.length + parsed.malformed.length,
      accepted: rows.length,
      rejected: rejected.length,
      uniquePlayers,
      matched: rows.filter((r) => r.matchStatus === 'matched').length,
      ambiguous: rows.filter((r) => r.matchStatus === 'ambiguous').length,
      unmatched: rows.filter((r) => r.matchStatus === 'unmatched').length,
    },
    warnings,
  };
}
