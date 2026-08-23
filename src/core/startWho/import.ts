/**
 * A StartWho paste, turned into rows this app can stand behind.
 *
 * Pure, and the same function serves the preview and the apply — the preview is
 * the import with the write left off, so it cannot disagree with what actually
 * lands.
 *
 * What this produces is a **market-derived preseason projection**: a season
 * fantasy-points estimate StartWho computed from betting-market inputs under a
 * particular scoring profile. It is deliberately not stored as, named as, or
 * mixed with a raw sportsbook line. The raw season-prop importer and its
 * projection-vs-market guard are a separate path and stay that way — a number
 * somebody's model produced from market inputs is a different claim from a
 * number a book is taking bets on, and the app only gets to keep both if it
 * never lets one wear the other's name.
 */

import { normalizePosition, resolvePlayer, type MatchCandidate, type PlayerIndex } from '../identity/index.ts';
import { nflTeamCode } from '../nfl/teams.ts';
import {
  describeScoring,
  grossScoringMismatch,
  scoringKey,
  type ProjectionScoring,
} from './scoring.ts';
import { captureDateFrom, parseStartWho, type StartWhoRow } from './parse.ts';

export interface ProjectionRow {
  rowNumber: number;
  sourcePlayerName: string;
  sourceTeam: string | null;
  /** The club as this app names it, when the source's spelling resolved. */
  teamCode: string | null;
  position: string | null;
  points: number;
  /** StartWho's own ordinal. Stored for audit; never a ranking input. */
  sourceRank: number | null;
  positionRank: number | null;
  /** `5/5`. Kept internally; never shown and never scored. */
  sourceCount: string | null;
  playerId: string | null;
  matchStatus: 'matched' | 'ambiguous' | 'unmatched';
  matchMethod: string | null;
  candidates: MatchCandidate[];
}

export interface ProjectionImportInput {
  season: string;
  /** The declared scoring profile. Authoritative — see `scoring.ts`. */
  scoring: ProjectionScoring;
  /** Overrides the date read from the paste, when the reader supplies one. */
  capturedAt?: string | null;
}

export interface ProjectionImport {
  source: 'StartWho';
  season: string;
  capturedAt: string;
  /** Whether the date came from the paste or from the person. */
  capturedFrom: 'paste' | 'declared';
  /** `Aug 22 at 9:01 AM`, verbatim, when the paste carried it. */
  lastUpdated: string | null;
  scoring: ProjectionScoring;
  scoringKey: string;
  scoringLabel: string;
  rows: ProjectionRow[];
  rejected: { rowNumber: number; reason: string; text: string }[];
  counts: {
    parsed: number;
    accepted: number;
    rejected: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
  };
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveRow(row: StartWhoRow, index: PlayerIndex) {
  const teamCode = nflTeamCode(row.team);
  const position = row.position ? normalizePosition(row.position) : null;
  let match = resolvePlayer({ name: row.playerName, team: teamCode || null, position }, index);
  if (match.status !== 'matched' && (teamCode || position)) {
    // A club that moved on since the capture should not turn a findable player
    // into an unknown one.
    const byName = resolvePlayer({ name: row.playerName }, index);
    if (byName.status === 'matched') match = byName;
  }
  return { match, teamCode: teamCode || null, position };
}

/**
 * Read, validate and resolve a StartWho paste. Writes nothing.
 *
 * Throws only when the text is not a StartWho table at all. Everything else is
 * a reported row: one unreadable record in a hundred and fifty should not cost
 * somebody the other hundred and forty-nine.
 */
export function buildProjectionImport(
  text: string,
  index: PlayerIndex,
  input: ProjectionImportInput,
): ProjectionImport {
  const season = (input.season ?? '').trim();
  if (!season) throw new Error('which season these projections are for is required');

  const parsed = parseStartWho(text);

  /*
   * The paste's own timestamp is preferred over anything typed.
   *
   * StartWho stamps the table with when it last recomputed, which is the date
   * that actually describes the numbers. Retyping it is a chance to get it
   * wrong, and the value of storing a capture date at all is knowing how old
   * the projection is.
   */
  const fromPaste = captureDateFrom(parsed.lastUpdated, season);
  const declared = (input.capturedAt ?? '').trim();
  const capturedAt = fromPaste ?? declared;
  if (!ISO_DATE.test(capturedAt)) {
    throw new Error(
      parsed.lastUpdated
        ? `could not read a capture date from "${parsed.lastUpdated}" — supply one as a calendar date like 2026-08-22`
        : 'the paste carries no "Last updated" line, so a capture date is required',
    );
  }

  const rows: ProjectionRow[] = [];
  const rejected = parsed.malformed.map((m) => ({
    rowNumber: m.rowNumber,
    reason: m.reason,
    text: m.text,
  }));

  for (const raw of parsed.rows) {
    if (!Number.isFinite(raw.points) || raw.points <= 0) {
      rejected.push({
        rowNumber: raw.rowNumber,
        reason: `"${raw.points}" is not a season points projection`,
        text: `${raw.playerName} ${raw.team ?? ''}`.trim(),
      });
      continue;
    }
    const { match, teamCode, position } = resolveRow(raw, index);
    rows.push({
      rowNumber: raw.rowNumber,
      sourcePlayerName: raw.playerName,
      sourceTeam: raw.team,
      teamCode,
      position,
      points: raw.points,
      sourceRank: raw.sourceRank,
      positionRank: raw.positionRank,
      sourceCount: raw.sourceCount,
      playerId: match.status === 'matched' ? match.playerId : null,
      matchStatus: match.status,
      matchMethod: match.method,
      candidates: match.status === 'matched' ? [] : match.candidates,
    });
  }

  const warnings: string[] = [];
  const mismatch = grossScoringMismatch(input.scoring, rows);
  if (mismatch) warnings.push(mismatch);

  const unresolvedTeams = [...new Set(rows.filter((r) => r.sourceTeam && !r.teamCode).map((r) => r.sourceTeam!))];
  if (unresolvedTeams.length > 0) {
    warnings.push(`could not place ${unresolvedTeams.length} club name(s): ${unresolvedTeams.join(', ')}`);
  }

  return {
    source: 'StartWho',
    season,
    capturedAt,
    capturedFrom: fromPaste ? 'paste' : 'declared',
    lastUpdated: parsed.lastUpdated,
    scoring: input.scoring,
    scoringKey: scoringKey(input.scoring),
    scoringLabel: describeScoring(input.scoring),
    rows,
    rejected,
    counts: {
      parsed: parsed.rows.length + parsed.malformed.length,
      accepted: rows.length,
      rejected: rejected.length,
      matched: rows.filter((r) => r.matchStatus === 'matched').length,
      ambiguous: rows.filter((r) => r.matchStatus === 'ambiguous').length,
      unmatched: rows.filter((r) => r.matchStatus === 'unmatched').length,
    },
    warnings,
  };
}
