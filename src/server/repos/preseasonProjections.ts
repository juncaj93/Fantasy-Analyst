/**
 * Storing a hand-imported preseason projection snapshot.
 *
 * Its own tables, not the market ones. See migration 0027 for why: a season
 * points estimate a model derived from market inputs is a different claim from
 * a line a book is taking bets on, and keeping both honest means never storing
 * them anywhere a query could confuse them.
 *
 * Identity is (season, source, captured date, scoring profile). The profile
 * belongs in the key rather than beside it because a snapshot is only valid for
 * the rules it was computed under — see `core/startWho/scoring.ts`.
 */

import type { ProjectionRow } from '../../core/startWho/import.ts';
import type { ProjectionScoring } from '../../core/startWho/scoring.ts';
import { chunk, MAX_BOUND_PARAMS, parseJson, toJson, type Database } from '../db.ts';

export interface ProjectionSnapshotMeta {
  id: number;
  season: string;
  source: string;
  capturedAt: string;
  scoringKey: string;
  scoringLabel: string;
  scoring: ProjectionScoring | null;
  importedAt: string;
  label: string;
  lastUpdated: string | null;
  rows: number;
  players: number;
  unresolved: number;
}

export interface SaveProjectionInput {
  season: string;
  source: string;
  capturedAt: string;
  scoring: ProjectionScoring;
  scoringKey: string;
  scoringLabel: string;
  lastUpdated: string | null;
  raw: string;
  importedAt: string;
}

/** "StartWho · Aug 22" — how a card cites this snapshot. */
export function projectionLabel(source: string, capturedAt: string): string {
  const at = new Date(`${capturedAt}T00:00:00Z`);
  const when = Number.isNaN(at.getTime())
    ? capturedAt
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${source} · ${when}`;
}

export class PreseasonProjectionsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Write one capture and its rows.
   *
   * Idempotent on the four-part identity. A second import of the same capture
   * updates the snapshot and replaces its rows outright — a corrected paste
   * should leave no trace of the version it corrected, or the board would still
   * be reading the mistake.
   */
  async save(input: SaveProjectionInput, rows: ProjectionRow[]): Promise<number> {
    const label = projectionLabel(input.source, input.capturedAt);

    const existing = await this.db
      .prepare(
        `SELECT id FROM preseason_projection_snapshots
          WHERE season = ? AND source = ? AND captured_at = ? AND scoring_key = ?`,
      )
      .bind(input.season, input.source, input.capturedAt, input.scoringKey)
      .first<{ id: number }>();

    let snapshotId: number;
    if (existing) {
      snapshotId = Number(existing.id);
      await this.db
        .prepare(
          `UPDATE preseason_projection_snapshots
              SET scoring_json = ?, scoring_label = ?, imported_at = ?, capture_label = ?,
                  last_updated = ?, raw_input = ?
            WHERE id = ?`,
        )
        .bind(
          toJson(input.scoring),
          input.scoringLabel,
          input.importedAt,
          label,
          input.lastUpdated,
          input.raw,
          snapshotId,
        )
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO preseason_projection_snapshots
             (season, source, captured_at, scoring_key, scoring_json, scoring_label,
              imported_at, capture_label, last_updated, raw_input)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          input.season,
          input.source,
          input.capturedAt,
          input.scoringKey,
          toJson(input.scoring),
          input.scoringLabel,
          input.importedAt,
          label,
          input.lastUpdated,
          input.raw,
        )
        .run();
      const row = await this.db
        .prepare(
          `SELECT id FROM preseason_projection_snapshots
            WHERE season = ? AND source = ? AND captured_at = ? AND scoring_key = ?`,
        )
        .bind(input.season, input.source, input.capturedAt, input.scoringKey)
        .first<{ id: number }>();
      if (!row) throw new Error('the projection snapshot could not be stored');
      snapshotId = Number(row.id);
    }

    await this.db.prepare('DELETE FROM preseason_projections WHERE snapshot_id = ?').bind(snapshotId).run();

    for (const batch of chunk(rows, 100)) {
      await this.db.batch(
        batch.map((r) =>
          this.db
            .prepare(
              `INSERT INTO preseason_projections (
                 snapshot_id, player_id, source_player_name, source_team, team_code, position,
                 points, source_rank, position_rank, source_count, raw_json
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              snapshotId,
              r.playerId,
              r.sourcePlayerName,
              r.sourceTeam,
              r.teamCode,
              r.position,
              r.points,
              r.sourceRank,
              r.positionRank,
              r.sourceCount,
              toJson({ matchStatus: r.matchStatus, matchMethod: r.matchMethod, rowNumber: r.rowNumber }),
            ),
        ),
      );
    }
    return snapshotId;
  }

  /** Every capture held for a season, newest first. */
  async list(season: string): Promise<ProjectionSnapshotMeta[]> {
    const rows = await this.db
      .prepare(
        `SELECT s.*, COUNT(p.id) AS rows_stored,
                COUNT(p.player_id) AS players,
                SUM(CASE WHEN p.player_id IS NULL THEN 1 ELSE 0 END) AS unresolved
           FROM preseason_projection_snapshots s
           LEFT JOIN preseason_projections p ON p.snapshot_id = s.id
          WHERE s.season = ?
          GROUP BY s.id
          ORDER BY s.captured_at DESC, s.id DESC`,
      )
      .bind(season)
      .all<Record<string, unknown>>();

    return rows.results.map((r) => ({
      id: Number(r['id']),
      season: String(r['season']),
      source: String(r['source']),
      capturedAt: String(r['captured_at']),
      scoringKey: String(r['scoring_key']),
      scoringLabel: String(r['scoring_label']),
      scoring: parseJson<ProjectionScoring | null>(r['scoring_json'], null),
      importedAt: String(r['imported_at']),
      label: String(r['capture_label']),
      lastUpdated: r['last_updated'] == null ? null : String(r['last_updated']),
      rows: Number(r['rows_stored'] ?? 0),
      players: Number(r['players'] ?? 0),
      unresolved: Number(r['unresolved'] ?? 0),
    }));
  }

  /**
   * The newest capture for a season under one scoring profile.
   *
   * Scoped by profile rather than by season alone, because a snapshot taken
   * under other rules is not a worse answer for this league — it is not an
   * answer at all, and reading it would be the exact cross-league misuse the
   * identity key exists to prevent.
   */
  async latest(season: string, scoringKey: string): Promise<ProjectionSnapshotMeta | null> {
    const all = await this.list(season);
    return all.find((s) => s.scoringKey === scoringKey) ?? null;
  }

  /** Projected points by player id, from one snapshot. */
  async pointsForSnapshot(snapshotId: number, playerIds?: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (playerIds && playerIds.length === 0) return out;

    if (!playerIds) {
      const rows = await this.db
        .prepare(
          `SELECT player_id, points FROM preseason_projections
            WHERE snapshot_id = ? AND player_id IS NOT NULL`,
        )
        .bind(snapshotId)
        .all<Record<string, unknown>>();
      for (const r of rows.results) out.set(String(r['player_id']), Number(r['points']));
      return out;
    }

    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS - 1)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT player_id, points FROM preseason_projections
            WHERE snapshot_id = ? AND player_id IN (${placeholders})`,
        )
        .bind(snapshotId, ...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) out.set(String(r['player_id']), Number(r['points']));
    }
    return out;
  }

  /** Remove one capture entirely — the only way a bad import is undone. */
  async remove(snapshotId: number): Promise<void> {
    await this.db.prepare('DELETE FROM preseason_projections WHERE snapshot_id = ?').bind(snapshotId).run();
    await this.db.prepare('DELETE FROM preseason_projection_snapshots WHERE id = ?').bind(snapshotId).run();
  }
}
