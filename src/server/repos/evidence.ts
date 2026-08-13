/**
 * Evidence ledger persistence.
 *
 * Invariants enforced here:
 *  - inserts are idempotent on `dedupe_key`
 *  - a row carrying a `user_override` is NEVER modified by reprocessing
 *  - every correction is appended to `user_reviews` so history survives
 */

import { aggregatePlayerSignal } from '../../core/evidence/aggregate.ts';
import type { EvidenceItem, EvidenceOverride, PlayerSignal, ReviewStatus } from '../../core/evidence/types.ts';
import type { ProposedEvidence } from '../../core/newsletter/pipeline.ts';
import { chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';

interface EvidenceRow {
  id: number;
  dedupe_key: string;
  player_id: string;
  source_type: string;
  source_name: string;
  source_message_id: string | null;
  source_date: string;
  excerpt: string;
  context_summary: string | null;
  category: string | null;
  polarity: string;
  magnitude: number;
  confidence: string;
  confidence_score: number;
  rule_id: string | null;
  review_status: string;
  user_override_json: string | null;
  notes_json: string;
  created_at: string;
}

function toItem(row: EvidenceRow): EvidenceItem & { numericId: number } {
  return {
    numericId: row.id,
    id: String(row.id),
    playerId: row.player_id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    sourceMessageId: row.source_message_id,
    sourceDate: row.source_date,
    excerpt: row.excerpt,
    contextSummary: row.context_summary,
    category: row.category,
    polarity: row.polarity as EvidenceItem['polarity'],
    magnitude: row.magnitude,
    confidence: row.confidence,
    confidenceScore: row.confidence_score,
    ruleId: row.rule_id,
    reviewStatus: row.review_status as ReviewStatus,
    userOverride: parseJson<EvidenceOverride | null>(row.user_override_json, null),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  };
}

export class EvidenceRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert proposed evidence, skipping anything already stored.
   * Returns how many rows were new — reprocessing the same newsletter yields 0.
   */
  async insertProposed(items: ProposedEvidence[]): Promise<{ inserted: number; skipped: number }> {
    if (items.length === 0) return { inserted: 0, skipped: 0 };
    const now = nowIso();
    const before = await this.countAll();

    for (const batch of chunk(items, 100)) {
      const statements = batch.map((e) =>
        this.db
          .prepare(
            `INSERT INTO evidence_items (
               dedupe_key, player_id, source_type, source_name, source_message_id, source_date,
               excerpt, context_summary, category, polarity, magnitude, confidence, confidence_score,
               rule_id, review_status, user_override_json, notes_json, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)
             ON CONFLICT(dedupe_key) DO NOTHING`,
          )
          .bind(
            e.dedupeKey,
            e.playerId,
            e.sourceType,
            e.sourceName,
            e.sourceMessageId,
            e.sourceDate,
            e.excerpt,
            e.contextSummary,
            e.category,
            e.polarity,
            e.magnitude,
            e.confidence,
            e.confidenceScore,
            e.ruleId,
            e.reviewStatus,
            toJson(e.notes),
            now,
            now,
          ),
      );
      await this.db.batch(statements);
    }

    const after = await this.countAll();
    const inserted = after - before;
    return { inserted, skipped: items.length - inserted };
  }

  async countAll(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM evidence_items').first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async listForPlayer(playerId: string, limit = 100): Promise<EvidenceItem[]> {
    const rows = await this.db
      .prepare('SELECT * FROM evidence_items WHERE player_id = ? ORDER BY source_date DESC, id DESC LIMIT ?')
      .bind(playerId, limit)
      .all<EvidenceRow>();
    return rows.results.map(toItem);
  }

  async listPending(limit = 50): Promise<EvidenceItem[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM evidence_items
          WHERE review_status = 'pending'
          ORDER BY confidence_score DESC, source_date DESC, id ASC
          LIMIT ?`,
      )
      .bind(limit)
      .all<EvidenceRow>();
    return rows.results.map(toItem);
  }

  async pendingCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM evidence_items WHERE review_status = 'pending'")
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async getById(id: number): Promise<(EvidenceItem & { numericId: number }) | null> {
    const row = await this.db.prepare('SELECT * FROM evidence_items WHERE id = ?').bind(id).first<EvidenceRow>();
    return row ? toItem(row) : null;
  }

  /**
   * Apply a user decision. The override is authoritative: it is stored on the
   * row and replayed by `effectiveEvidence` forever after.
   */
  async applyReview(
    id: number,
    action: 'accept' | 'correct' | 'reject' | 'ignore',
    override: EvidenceOverride | null,
  ): Promise<EvidenceItem | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const status: ReviewStatus =
      action === 'accept' ? 'accepted' : action === 'correct' ? 'corrected' : action === 'reject' ? 'rejected' : 'ignored';

    const mergedOverride =
      action === 'correct'
        ? { ...(existing.userOverride ?? {}), ...(override ?? {}) }
        : existing.userOverride;

    const now = nowIso();
    await this.db
      .prepare(
        `UPDATE evidence_items
            SET review_status = ?, user_override_json = ?, player_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        status,
        mergedOverride ? toJson(mergedOverride) : null,
        mergedOverride?.playerId ?? existing.playerId,
        now,
        id,
      )
      .run();

    await this.db
      .prepare(
        `INSERT INTO user_reviews (evidence_item_id, action, previous_value_json, new_value_json, changed_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(
        id,
        action,
        toJson({
          polarity: existing.polarity,
          magnitude: existing.magnitude,
          category: existing.category,
          playerId: existing.playerId,
          reviewStatus: existing.reviewStatus,
        }),
        toJson({ reviewStatus: status, override: mergedOverride }),
        now,
      )
      .run();

    return this.getById(id);
  }

  /** Recompute and persist the derived signal cache for one player. */
  async refreshSignal(playerId: string, opts: { now?: string; seasonStart?: string | null } = {}): Promise<PlayerSignal> {
    const items = await this.listForPlayer(playerId, 1000);
    const signal = aggregatePlayerSignal(playerId, items, opts);
    await this.db
      .prepare(
        `INSERT INTO player_signal_cache (
           player_id, raw_positive, raw_negative, raw_net, raw_items,
           recent7_net, recent21_net, recent21_items, season_net,
           pending_count, mixed_count, category_breakdown_json, last_evidence_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(player_id) DO UPDATE SET
           raw_positive = excluded.raw_positive,
           raw_negative = excluded.raw_negative,
           raw_net = excluded.raw_net,
           raw_items = excluded.raw_items,
           recent7_net = excluded.recent7_net,
           recent21_net = excluded.recent21_net,
           recent21_items = excluded.recent21_items,
           season_net = excluded.season_net,
           pending_count = excluded.pending_count,
           mixed_count = excluded.mixed_count,
           category_breakdown_json = excluded.category_breakdown_json,
           last_evidence_at = excluded.last_evidence_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        playerId,
        signal.raw.positive,
        signal.raw.negative,
        signal.raw.net,
        signal.raw.items,
        signal.last7.net,
        signal.last21.net,
        signal.last21.items,
        signal.seasonToDate.net,
        signal.pendingCount,
        signal.mixedCount,
        toJson(signal.categoryBreakdown),
        signal.lastEvidenceAt,
        signal.updatedAt,
      )
      .run();
    return signal;
  }

  /** Rebuild the cache for every player that has evidence. */
  async refreshAllSignals(opts: { now?: string; seasonStart?: string | null } = {}): Promise<number> {
    const rows = await this.db
      .prepare('SELECT DISTINCT player_id FROM evidence_items')
      .all<{ player_id: string }>();
    for (const row of rows.results) await this.refreshSignal(row.player_id, opts);
    return rows.results.length;
  }

  /** Read the derived cache for a set of players. */
  async getSignals(playerIds: string[]): Promise<Map<string, PlayerSignal>> {
    const out = new Map<string, PlayerSignal>();
    if (playerIds.length === 0) return out;
    for (const batch of chunk(playerIds, 200)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT * FROM player_signal_cache WHERE player_id IN (${placeholders})`)
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const r of rows.results) {
        out.set(String(r['player_id']), {
          playerId: String(r['player_id']),
          raw: {
            positive: Number(r['raw_positive'] ?? 0),
            negative: Number(r['raw_negative'] ?? 0),
            net: Number(r['raw_net'] ?? 0),
            items: Number(r['raw_items'] ?? 0),
          },
          last7: { positive: 0, negative: 0, net: Number(r['recent7_net'] ?? 0), items: 0 },
          last21: {
            positive: 0,
            negative: 0,
            net: Number(r['recent21_net'] ?? 0),
            items: Number(r['recent21_items'] ?? 0),
          },
          seasonToDate: { positive: 0, negative: 0, net: Number(r['season_net'] ?? 0), items: 0 },
          categoryBreakdown: parseJson(r['category_breakdown_json'], {}),
          pendingCount: Number(r['pending_count'] ?? 0),
          mixedCount: Number(r['mixed_count'] ?? 0),
          lastEvidenceAt: (r['last_evidence_at'] as string | null) ?? null,
          updatedAt: String(r['updated_at'] ?? ''),
        });
      }
    }
    return out;
  }
}
