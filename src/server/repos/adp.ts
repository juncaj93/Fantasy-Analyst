/**
 * ADP snapshot persistence. Snapshots are immutable once written: re-importing
 * the identical file returns the existing snapshot instead of duplicating it.
 */

import type { AdpImportResult } from '../../core/adp/import.ts';
import type { DogProvider, DogSourceType } from '../../core/adp/underdog.ts';
import { nowIso, toJson, chunk, type Database } from '../db.ts';

/** The `source` every Sleeper-market snapshot is filed under. */
export const SLEEPER_SOURCE = 'sleeper';

/**
 * The `source` every raw Underdog snapshot is filed under.
 *
 * One constant, used by the importer, the board and the tests alike, because
 * the single worst outcome available here is a Sleeper snapshot filed as DOG
 * or the reverse — and a string literal repeated in four files is exactly how
 * that happens.
 */
export const UNDERDOG_SOURCE = 'underdog';

export interface AdpSnapshotMeta {
  id: number;
  source: string;
  label: string;
  capturedAt: string;
  importedAt: string;
  rawFileHash: string;
  rowCount: number;
  matchedCount: number;
  unmatchedCount: number;
  /** Which provider served it. Null for snapshots imported by hand. */
  provider: DogProvider | string | null;
  /**
   * What kind of number this is. Only `raw_adp` may be shown as DOG.
   *
   * Stored rather than assumed, so that a payload which turned out to be a
   * ranking is recorded as one instead of being silently discarded — the row
   * is the evidence that the rejection happened.
   */
  sourceType: DogSourceType | string;
  /** When the source says the numbers are effective, if it says. */
  snapshotAt: string | null;
  /** When this app fetched them, which is a different question. */
  fetchedAt: string | null;
  /** Why this snapshot is less trustworthy than usual. Null is good. */
  degradedReason: string | null;
}

/** Everything about a snapshot's origin that the importer can be told. */
export interface AdpProvenance {
  provider?: string | null;
  sourceType?: string | null;
  snapshotAt?: string | null;
  fetchedAt?: string | null;
  degradedReason?: string | null;
}

export interface AdpValue {
  playerId: string | null;
  sourcePlayerName: string;
  adp: number | null;
  rank: number | null;
  matchStatus: string;
}

export class AdpRepo {
  constructor(private readonly db: Database) {}

  async findByHash(source: string, hash: string): Promise<AdpSnapshotMeta | null> {
    const row = await this.db
      .prepare('SELECT * FROM adp_snapshots WHERE source = ? AND raw_file_hash = ?')
      .bind(source, hash)
      .first<Record<string, unknown>>();
    return row ? toMeta(row) : null;
  }

  async list(): Promise<AdpSnapshotMeta[]> {
    const rows = await this.db
      .prepare('SELECT * FROM adp_snapshots ORDER BY captured_at DESC, id DESC')
      .all<Record<string, unknown>>();
    return rows.results.map(toMeta);
  }

  async get(id: number): Promise<AdpSnapshotMeta | null> {
    const row = await this.db.prepare('SELECT * FROM adp_snapshots WHERE id = ?').bind(id).first<Record<string, unknown>>();
    return row ? toMeta(row) : null;
  }

  /**
   * The newest snapshot of any source.
   *
   * Kept as-is for every existing caller, but note what it means now that two
   * markets exist: "newest of anything", which is the Sleeper board only
   * because Sleeper is the only source most databases hold. Anything that
   * needs a specific market must say so — see `latestForSource`.
   */
  async latest(): Promise<AdpSnapshotMeta | null> {
    const row = await this.db
      .prepare('SELECT * FROM adp_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1')
      .first<Record<string, unknown>>();
    return row ? toMeta(row) : null;
  }

  /**
   * The newest snapshot of one named market.
   *
   * The whole reason the board can hold Sleeper and Underdog at once without
   * either becoming the other: two calls, two sources, two answers, and no
   * point at which "the latest ADP" is ambiguous.
   */
  async latestForSource(source: string): Promise<AdpSnapshotMeta | null> {
    const row = await this.db
      .prepare('SELECT * FROM adp_snapshots WHERE source = ? ORDER BY captured_at DESC, id DESC LIMIT 1')
      .bind(source)
      .first<Record<string, unknown>>();
    return row ? toMeta(row) : null;
  }

  /**
   * Persist an import result. Idempotent on (source, file hash).
   *
   * Idempotency is what makes re-ingesting DOG safe: the nightly workflow can
   * run twice, or be re-run by hand, and the second run returns the snapshot
   * the first one wrote rather than a duplicate with the same numbers in it.
   * The file hash is the identity, so an unchanged Underdog board is the same
   * snapshot however many times it is fetched.
   */
  async save(
    result: AdpImportResult,
    provenance: AdpProvenance = {},
  ): Promise<{ snapshot: AdpSnapshotMeta; created: boolean }> {
    const existing = await this.findByHash(result.source, result.fileHash);
    if (existing) return { snapshot: existing, created: false };

    await this.db
      .prepare(
        `INSERT INTO adp_snapshots (
           source, label, captured_at, imported_at, raw_file_hash, row_count, matched_count, unmatched_count,
           provider, source_type, snapshot_at, fetched_at, degraded_reason
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        result.source,
        result.label,
        result.capturedAt,
        nowIso(),
        result.fileHash,
        result.rows.length,
        result.matchedCount,
        result.ambiguousCount + result.unmatchedCount,
        provenance.provider ?? null,
        provenance.sourceType ?? 'raw_adp',
        provenance.snapshotAt ?? null,
        provenance.fetchedAt ?? null,
        provenance.degradedReason ?? null,
      )
      .run();

    const snapshot = await this.findByHash(result.source, result.fileHash);
    if (!snapshot) throw new Error('failed to persist ADP snapshot');

    for (const batch of chunk(result.rows, 100)) {
      await this.db.batch(
        batch.map((row) =>
          this.db
            .prepare(
              `INSERT INTO adp_rows (
                 snapshot_id, player_id, source_name, source_player_name, source_team, source_position,
                 adp, rank, match_status, match_method, match_reason, raw_json
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              snapshot.id,
              row.playerId,
              result.source,
              row.sourceName,
              row.sourceTeam,
              row.sourcePosition,
              row.adp,
              row.rank,
              row.match.status,
              row.match.method,
              row.match.reason,
              toJson(row.raw),
            ),
        ),
      );
    }
    return { snapshot, created: true };
  }

  /** ADP values for a snapshot, keyed by canonical player id. */
  async valuesByPlayer(snapshotId: number): Promise<Map<string, AdpValue>> {
    const rows = await this.db
      .prepare('SELECT player_id, source_player_name, adp, rank, match_status FROM adp_rows WHERE snapshot_id = ? AND player_id IS NOT NULL')
      .bind(snapshotId)
      .all<Record<string, unknown>>();
    const out = new Map<string, AdpValue>();
    for (const r of rows.results) {
      const pid = String(r['player_id']);
      out.set(pid, {
        playerId: pid,
        sourcePlayerName: String(r['source_player_name'] ?? ''),
        adp: r['adp'] == null ? null : Number(r['adp']),
        rank: r['rank'] == null ? null : Number(r['rank']),
        matchStatus: String(r['match_status'] ?? 'unmatched'),
      });
    }
    return out;
  }

  /** Rows that need human attention (ambiguous or unmatched). */
  async unresolvedRows(snapshotId: number, limit = 100): Promise<
    { id: number; sourcePlayerName: string; sourceTeam: string | null; sourcePosition: string | null; adp: number | null; matchStatus: string; reason: string }[]
  > {
    const rows = await this.db
      .prepare(
        `SELECT id, source_player_name, source_team, source_position, adp, match_status, match_reason
           FROM adp_rows WHERE snapshot_id = ? AND player_id IS NULL ORDER BY adp ASC LIMIT ?`,
      )
      .bind(snapshotId, limit)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      id: Number(r['id']),
      sourcePlayerName: String(r['source_player_name'] ?? ''),
      sourceTeam: (r['source_team'] as string | null) ?? null,
      sourcePosition: (r['source_position'] as string | null) ?? null,
      adp: r['adp'] == null ? null : Number(r['adp']),
      matchStatus: String(r['match_status'] ?? ''),
      reason: String(r['match_reason'] ?? ''),
    }));
  }

  /**
   * Re-resolve the rows of an existing snapshot that never found a player.
   *
   * Importing the same file twice is otherwise a no-op, which is right for the
   * data but wrong for the matching: between the two imports the matcher may
   * have learned something — a new alias, a name form it now understands — and
   * a row that found nothing should get the benefit of it without waiting for
   * the source file to change.
   *
   * Only rows still holding no player are touched, so a resolution the user
   * made by hand is never overwritten.
   */
  async reconcile(snapshotId: number, result: AdpImportResult): Promise<number> {
    const pending = await this.db
      .prepare('SELECT id, source_player_name FROM adp_rows WHERE snapshot_id = ? AND player_id IS NULL')
      .bind(snapshotId)
      .all<Record<string, unknown>>();
    if (pending.results.length === 0) return 0;

    const nowMatched = new Map<string, { playerId: string; method: string | null; reason: string }>();
    for (const row of result.rows) {
      if (row.playerId) {
        nowMatched.set(row.sourceName, {
          playerId: row.playerId,
          method: row.match.method,
          reason: row.match.reason,
        });
      }
    }

    const updates = pending.results
      .map((r) => ({ id: Number(r['id']), hit: nowMatched.get(String(r['source_player_name'] ?? '')) }))
      .filter((u): u is { id: number; hit: { playerId: string; method: string | null; reason: string } } => !!u.hit);
    if (updates.length === 0) return 0;

    for (const batch of chunk(updates, 100)) {
      await this.db.batch(
        batch.map((u) =>
          this.db
            .prepare(
              "UPDATE adp_rows SET player_id = ?, match_status = 'matched', match_method = ?, match_reason = ? WHERE id = ?",
            )
            .bind(u.hit.playerId, u.hit.method, u.hit.reason, u.id),
        ),
      );
    }

    await this.db
      .prepare(
        `UPDATE adp_snapshots
            SET matched_count = matched_count + ?, unmatched_count = MAX(0, unmatched_count - ?)
          WHERE id = ?`,
      )
      .bind(updates.length, updates.length, snapshotId)
      .run();

    return updates.length;
  }

  /** Attach a canonical player to a previously unresolved row (user action). */
  async resolveRow(rowId: number, playerId: string): Promise<void> {
    await this.db
      .prepare("UPDATE adp_rows SET player_id = ?, match_status = 'matched', match_method = 'user' WHERE id = ?")
      .bind(playerId, rowId)
      .run();
  }
}

function toMeta(row: Record<string, unknown>): AdpSnapshotMeta {
  return {
    id: Number(row['id']),
    source: String(row['source']),
    label: String(row['label']),
    capturedAt: String(row['captured_at']),
    importedAt: String(row['imported_at']),
    rawFileHash: String(row['raw_file_hash']),
    rowCount: Number(row['row_count'] ?? 0),
    matchedCount: Number(row['matched_count'] ?? 0),
    unmatchedCount: Number(row['unmatched_count'] ?? 0),
    provider: (row['provider'] as string | null) ?? null,
    sourceType: String(row['source_type'] ?? 'raw_adp'),
    snapshotAt: (row['snapshot_at'] as string | null) ?? null,
    fetchedAt: (row['fetched_at'] as string | null) ?? null,
    degradedReason: (row['degraded_reason'] as string | null) ?? null,
  };
}
