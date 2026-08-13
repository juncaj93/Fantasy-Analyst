/** Newsletter message log + identity review queue. */

import type { IdentityReviewItem } from '../../core/newsletter/pipeline.ts';
import { stableHash } from '../../core/newsletter/fingerprint.ts';
import { nowIso, parseJson, toJson, type Database } from '../db.ts';

export interface MessageRecord {
  messageId: string;
  sourceId: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  fingerprint: string;
  evidenceCount: number;
  pendingCount: number;
  processedAt: string;
  status: string;
}

export interface IdentityReviewRecord {
  id: number;
  sourceMessageId: string;
  sourceDate: string;
  excerpt: string;
  matchedText: string;
  reason: string;
  candidates: { playerId: string; name: string; team: string; position: string; detail: string }[];
  proposedPolarity: string | null;
  proposedCategory: string | null;
  status: string;
}

export class NewsletterRepo {
  constructor(private readonly db: Database) {}

  /** Has this message (or identical content) already been processed? */
  async findProcessed(messageId: string, fingerprint: string): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM newsletter_messages WHERE message_id = ? OR fingerprint = ? LIMIT 1')
      .bind(messageId, fingerprint)
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
  }

  async recordMessage(record: MessageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO newsletter_messages (
           message_id, source_id, from_address, subject, received_at, fingerprint,
           evidence_count, pending_count, processed_at, status
         ) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(message_id) DO UPDATE SET
           evidence_count = excluded.evidence_count,
           pending_count = excluded.pending_count,
           processed_at = excluded.processed_at,
           status = excluded.status`,
      )
      .bind(
        record.messageId,
        record.sourceId,
        record.fromAddress,
        record.subject,
        record.receivedAt,
        record.fingerprint,
        record.evidenceCount,
        record.pendingCount,
        record.processedAt,
        record.status,
      )
      .run();
  }

  async listMessages(limit = 25): Promise<MessageRecord[]> {
    const rows = await this.db
      .prepare('SELECT * FROM newsletter_messages ORDER BY received_at DESC LIMIT ?')
      .bind(limit)
      .all<Record<string, unknown>>();
    return rows.results.map(toMessage);
  }

  async lastProcessedAt(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT MAX(received_at) AS latest FROM newsletter_messages')
      .first<{ latest: string | null }>();
    return row?.latest ?? null;
  }

  /** Insert identity-ambiguity items, deduped on content. */
  async insertIdentityReviews(items: IdentityReviewItem[]): Promise<number> {
    if (items.length === 0) return 0;
    const now = nowIso();
    let inserted = 0;
    for (const item of items) {
      const key = stableHash([item.sourceMessageId, item.matchedText, item.excerpt].join('|'));
      const res = await this.db
        .prepare(
          `INSERT INTO identity_reviews (
             dedupe_key, source_message_id, source_date, excerpt, matched_text, reason,
             candidates_json, proposed_polarity, proposed_category, status, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)
           ON CONFLICT(dedupe_key) DO NOTHING`,
        )
        .bind(
          key,
          item.sourceMessageId,
          item.sourceDate,
          item.excerpt,
          item.matchedText,
          item.reason,
          toJson(item.candidates),
          item.proposedPolarity,
          item.proposedCategory,
          now,
        )
        .run();
      if ((res.meta?.changes ?? 0) > 0) inserted++;
    }
    return inserted;
  }

  async listIdentityReviews(limit = 50): Promise<IdentityReviewRecord[]> {
    const rows = await this.db
      .prepare("SELECT * FROM identity_reviews WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      id: Number(r['id']),
      sourceMessageId: String(r['source_message_id']),
      sourceDate: String(r['source_date']),
      excerpt: String(r['excerpt']),
      matchedText: String(r['matched_text']),
      reason: String(r['reason']),
      candidates: parseJson(r['candidates_json'], []),
      proposedPolarity: (r['proposed_polarity'] as string | null) ?? null,
      proposedCategory: (r['proposed_category'] as string | null) ?? null,
      status: String(r['status']),
    }));
  }

  async pendingIdentityCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM identity_reviews WHERE status = 'pending'")
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async resolveIdentityReview(id: number, playerId: string | null, status: 'resolved' | 'dismissed'): Promise<void> {
    await this.db
      .prepare('UPDATE identity_reviews SET status = ?, resolved_player_id = ? WHERE id = ?')
      .bind(status, playerId, id)
      .run();
    await this.db
      .prepare(
        `INSERT INTO user_reviews (identity_review_id, action, previous_value_json, new_value_json, changed_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(id, status, toJson({ status: 'pending' }), toJson({ status, playerId }), nowIso())
      .run();
  }
}

function toMessage(row: Record<string, unknown>): MessageRecord {
  return {
    messageId: String(row['message_id']),
    sourceId: String(row['source_id']),
    fromAddress: String(row['from_address']),
    subject: String(row['subject']),
    receivedAt: String(row['received_at']),
    fingerprint: String(row['fingerprint']),
    evidenceCount: Number(row['evidence_count'] ?? 0),
    pendingCount: Number(row['pending_count'] ?? 0),
    processedAt: String(row['processed_at']),
    status: String(row['status']),
  };
}
