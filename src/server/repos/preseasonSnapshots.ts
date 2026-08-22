/**
 * Storing a hand-imported preseason snapshot.
 *
 * Same two tables as everything else, under `scope = 'season'`: the pipeline
 * that already separates a season total from Sunday's line is the pipeline this
 * belongs in, and a parallel set of tables would be a second place for the two
 * horizons to get confused.
 *
 * What makes an imported snapshot different from a fetched one is its identity.
 * A fetch is identified by when it ran; an import is identified by **what was
 * captured and when it was captured** — so re-pasting a corrected copy of the
 * same capture must revise that snapshot rather than stack a second one beside
 * it, while a genuinely later capture must be kept alongside the first. Both of
 * those fall out of keying on (season, source, capturedAt).
 */

import type { ResolvedSnapshotRow } from '../../core/seasonImport/import.ts';
import type { SnapshotLine } from '../../core/seasonImport/gapFill.ts';
import type { SeasonMarketKey } from '../../core/vegas/types.ts';
import { chunk, parseJson, toJson, type Database } from '../db.ts';

/** The season identity doubles as the event id, matching the fetched path. */
const eventIdFor = (season: string) => `season:${season}`;

/** `manual:` is what makes "a person pasted this" queryable forever after. */
export const importProviderFor = (source: string) => `manual:${source.trim().toLowerCase()}`;

export interface PreseasonSnapshotMeta {
  id: number;
  season: string;
  source: string;
  capturedAt: string;
  importedAt: string;
  label: string;
  rows: number;
  players: number;
  unresolved: number;
}

export interface SaveSnapshotInput {
  season: string;
  source: string;
  capturedAt: string;
  /** What the person actually pasted, kept verbatim for audit. */
  raw: string;
  format: string;
  importedAt: string;
}

/** "Win With Odds · Aug 27" — what a card says when it cites this snapshot. */
export function captureLabel(source: string, capturedAt: string): string {
  const at = new Date(`${capturedAt}T00:00:00Z`);
  const when = Number.isNaN(at.getTime())
    ? capturedAt
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${source} · ${when}`;
}

export class PreseasonSnapshotsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Write one capture and its rows.
   *
   * Idempotent on (season, source, capturedAt). The second import of the same
   * capture updates the snapshot's raw payload and **replaces** its rows — a
   * corrected paste should leave no trace of the version it corrected, or the
   * board would still be reading the mistake.
   */
  async save(input: SaveSnapshotInput, rows: ResolvedSnapshotRow[]): Promise<number> {
    const provider = importProviderFor(input.source);
    const eventId = eventIdFor(input.season);
    const label = captureLabel(input.source, input.capturedAt);
    const payload = toJson({
      source: input.source,
      capturedAt: input.capturedAt,
      importedAt: input.importedAt,
      format: input.format,
      raw: input.raw,
    });

    const existing = await this.db
      .prepare(
        `SELECT id FROM prop_snapshots
          WHERE scope = 'season' AND season = ? AND capture_source = ? AND captured_at = ?`,
      )
      .bind(input.season, input.source, input.capturedAt)
      .first<{ id: number }>();

    let snapshotId: number;
    if (existing) {
      snapshotId = Number(existing.id);
      await this.db
        .prepare(
          `UPDATE prop_snapshots
              SET raw_json = ?, fetched_at = ?, capture_label = ?, provider = ?
            WHERE id = ?`,
        )
        .bind(payload, input.importedAt, label, provider, snapshotId)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO prop_snapshots
             (provider, event_id, game_start, fetched_at, raw_json, scope, season,
              capture_source, captured_at, capture_label)
           VALUES (?,?,?,?,?,'season',?,?,?,?)`,
        )
        .bind(
          provider,
          eventId,
          '',
          input.importedAt,
          payload,
          input.season,
          input.source,
          input.capturedAt,
          label,
        )
        .run();
      const row = await this.db
        .prepare(
          `SELECT id FROM prop_snapshots
            WHERE scope = 'season' AND season = ? AND capture_source = ? AND captured_at = ?`,
        )
        .bind(input.season, input.source, input.capturedAt)
        .first<{ id: number }>();
      if (!row) throw new Error('the preseason snapshot could not be stored');
      snapshotId = Number(row.id);
    }

    await this.db.prepare('DELETE FROM player_props WHERE snapshot_id = ?').bind(snapshotId).run();

    for (const batch of chunk(rows, 100)) {
      await this.db.batch(
        batch.map((r) =>
          this.db
            .prepare(
              `INSERT INTO player_props (
                 snapshot_id, player_id, source_player_name, market, line, over_price, under_price,
                 book_count, books_json, consensus_method, implied_probability, raw_json, scope
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'season')`,
            )
            .bind(
              snapshotId,
              // Null on purpose when the name did not resolve: the row is kept
              // so it can be repaired, and it contributes to nothing until it
              // is. An unresolved name is not a player without a market.
              r.playerId,
              r.sourcePlayerName,
              r.market,
              r.line,
              r.overPrice,
              r.underPrice,
              1,
              toJson([input.source]),
              // One source, said as one source. A single book is never dressed
              // up as a consensus, whatever else is in the table.
              'single',
              null,
              toJson({
                team: r.sourceTeam,
                position: r.sourcePosition,
                matchStatus: r.matchStatus,
                matchMethod: r.matchMethod,
                rowNumber: r.rowNumber,
              }),
            ),
        ),
      );
    }
    return snapshotId;
  }

  /** Every capture held for a season, newest first. */
  async list(season: string): Promise<PreseasonSnapshotMeta[]> {
    const rows = await this.db
      .prepare(
        `SELECT s.id, s.season, s.capture_source, s.captured_at, s.fetched_at, s.capture_label, s.raw_json,
                COUNT(p.id) AS rows_stored,
                COUNT(DISTINCT p.player_id) AS players,
                SUM(CASE WHEN p.player_id IS NULL THEN 1 ELSE 0 END) AS unresolved
           FROM prop_snapshots s
           LEFT JOIN player_props p ON p.snapshot_id = s.id AND p.scope = 'season'
          WHERE s.scope = 'season' AND s.season = ? AND s.capture_source IS NOT NULL
          GROUP BY s.id
          ORDER BY s.captured_at DESC, s.id DESC`,
      )
      .bind(season)
      .all<Record<string, unknown>>();

    return rows.results.map((r) => {
      const raw = parseJson<{ importedAt?: string }>(r['raw_json'], {});
      return {
        id: Number(r['id']),
        season: String(r['season']),
        source: String(r['capture_source']),
        capturedAt: String(r['captured_at']),
        importedAt: raw?.importedAt ?? String(r['fetched_at']),
        label: String(r['capture_label'] ?? ''),
        rows: Number(r['rows_stored'] ?? 0),
        players: Number(r['players'] ?? 0),
        unresolved: Number(r['unresolved'] ?? 0),
      };
    });
  }

  /**
   * Every resolved line across every capture of a season.
   *
   * Deliberately not "the latest snapshot's lines": choosing between captures
   * is the gap-fill's job and it makes that choice per player and per market.
   * Doing it here with a `LIMIT 1` on the newest snapshot is the shortcut that
   * silently deletes the coverage a broader earlier capture had.
   *
   * Unresolved rows are excluded because they have no player to attach to —
   * they remain in the table, and in the Review queue, until somebody says who
   * they are.
   */
  async lines(season: string): Promise<SnapshotLine[]> {
    const rows = await this.db
      .prepare(
        `SELECT p.player_id, p.market, p.line, p.over_price, p.under_price,
                s.capture_source, s.captured_at, s.id AS snapshot_id
           FROM player_props p
           JOIN prop_snapshots s ON s.id = p.snapshot_id
          WHERE s.scope = 'season' AND s.season = ? AND s.capture_source IS NOT NULL
            AND p.scope = 'season' AND p.player_id IS NOT NULL AND p.line IS NOT NULL`,
      )
      .bind(season)
      .all<Record<string, unknown>>();

    return rows.results.map((r) => ({
      playerId: String(r['player_id']),
      market: String(r['market']) as SeasonMarketKey,
      line: Number(r['line']),
      overPrice: r['over_price'] == null ? null : Number(r['over_price']),
      underPrice: r['under_price'] == null ? null : Number(r['under_price']),
      source: String(r['capture_source']),
      capturedAt: String(r['captured_at']),
      snapshotId: Number(r['snapshot_id']),
    }));
  }

  /** Remove one capture entirely — the only way a bad import is undone. */
  async remove(snapshotId: number): Promise<void> {
    await this.db.prepare('DELETE FROM player_props WHERE snapshot_id = ?').bind(snapshotId).run();
    await this.db
      .prepare("DELETE FROM prop_snapshots WHERE id = ? AND scope = 'season' AND capture_source IS NOT NULL")
      .bind(snapshotId)
      .run();
  }
}
