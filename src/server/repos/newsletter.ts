/** Newsletter message log + identity review queue. */

import type { IdentityReviewItem } from '../../core/newsletter/pipeline.ts';
import { stableHash } from '../../core/newsletter/fingerprint.ts';
import { nowIso, parseJson, toJson, type Database } from '../db.ts';

/** Every email the dedicated address receives, processed or not. */
export interface MessageRecord {
  messageId: string;
  sourceId: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  fingerprint: string;
  evidenceCount: number;
  pendingCount: number;
  autoAppliedCount: number;
  identityReviewCount: number;
  processedAt: string;
  /** processed | quarantined | rejected | error | ignored */
  status: string;
  /** Why a message was not processed. */
  rejectReason: string | null;
  /** Plain-language outcome shown in Settings. */
  detail: string | null;
  coverage: Record<string, unknown> | null;
  /**
   * The email itself, kept only for processed messages so improved rules can be
   * re-run against issues already in the ledger. Never retained for
   * quarantined mail.
   */
  bodyHtml?: string | null;
  bodyText?: string | null;
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
  /** What this item would have been worth had the name resolved. */
  proposedMagnitude: number;
  status: string;
}

export class NewsletterRepo {
  constructor(private readonly db: Database) {}

  /**
   * Has this exact content already been PROCESSED?
   *
   * Deliberately scoped to processed messages: a quarantined or failed message
   * must never fingerprint-block a later legitimate delivery of the same
   * newsletter (otherwise one spoofed email could silence the real one).
   */
  async findProcessedByFingerprint(fingerprint: string): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM newsletter_messages WHERE fingerprint = ? AND status = 'processed' LIMIT 1")
      .bind(fingerprint)
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
  }

  async recordMessage(record: MessageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO newsletter_messages (
           message_id, source_id, from_address, subject, received_at, fingerprint,
           evidence_count, pending_count, auto_applied_count, identity_review_count,
           coverage_json, reject_reason, detail, processed_at, status,
           body_html, body_text
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(message_id) DO UPDATE SET
           evidence_count = excluded.evidence_count,
           pending_count = excluded.pending_count,
           auto_applied_count = excluded.auto_applied_count,
           identity_review_count = excluded.identity_review_count,
           coverage_json = excluded.coverage_json,
           reject_reason = excluded.reject_reason,
           detail = excluded.detail,
           processed_at = excluded.processed_at,
           status = excluded.status,
           body_html = excluded.body_html,
           body_text = excluded.body_text`,
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
        record.autoAppliedCount,
        record.identityReviewCount,
        toJson(record.coverage ?? {}),
        record.rejectReason,
        record.detail,
        record.processedAt,
        record.status,
        record.bodyHtml ?? null,
        record.bodyText ?? null,
      )
      .run();
  }

  /** Most recent inbound email of any status. */
  async lastReceived(): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM newsletter_messages ORDER BY received_at DESC, rowid DESC LIMIT 1')
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
  }

  /** Most recent successfully processed newsletter. */
  async lastProcessed(): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM newsletter_messages WHERE status = 'processed' ORDER BY received_at DESC, rowid DESC LIMIT 1")
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
  }

  /** Most recent failure, so Settings can surface it in plain language. */
  async lastFailure(): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM newsletter_messages WHERE status IN ('error','rejected') ORDER BY received_at DESC, rowid DESC LIMIT 1")
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
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

  /** Has this message id already been seen, in any status? */
  async seen(messageId: string): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM newsletter_messages WHERE message_id = ?')
      .bind(messageId)
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
  }

  /**
   * Insert identity-ambiguity items, deduped on content.
   *
   * A row that already exists is left alone with one exception: while it is
   * still `pending`, its proposed magnitude is refreshed. That is what lets a
   * re-import correct a review recorded before magnitude was carried at all —
   * without it, "JSN +11" would stay stuck at the ±1 stand-in the old path
   * wrote. Resolved rows are history and are never rewritten.
   */
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
             candidates_json, proposed_polarity, proposed_category, proposed_magnitude, status, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)
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
          item.proposedMagnitude,
          now,
        )
        .run();
      if ((res.meta?.changes ?? 0) > 0) {
        inserted++;
        continue;
      }
      await this.db
        .prepare(
          `UPDATE identity_reviews
              SET proposed_magnitude = ?, proposed_polarity = ?
            WHERE dedupe_key = ? AND status = 'pending'`,
        )
        .bind(item.proposedMagnitude, item.proposedPolarity, key)
        .run();
    }
    return inserted;
  }

  async listIdentityReviews(limit = 50): Promise<IdentityReviewRecord[]> {
    const rows = await this.db
      .prepare("SELECT * FROM identity_reviews WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<Record<string, unknown>>();
    return rows.results.map(toIdentityReview);
  }

  async pendingIdentityCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM identity_reviews WHERE status = 'pending'")
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /**
   * Names that were resolved to a player, for checking the evidence landed.
   *
   * Resolving used to record the decision alone — status and player id — and
   * create no evidence, so the player's tally never moved. Anything resolved
   * before that was fixed is still missing, and nothing in the app says so.
   */
  async listResolvedIdentityReviews(limit = 500): Promise<(IdentityReviewRecord & { resolvedPlayerId: string })[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM identity_reviews
          WHERE status = 'resolved' AND resolved_player_id IS NOT NULL
          ORDER BY id ASC LIMIT ?`,
      )
      .bind(limit)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      ...toIdentityReview(r),
      resolvedPlayerId: String(r['resolved_player_id']),
    }));
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

function toIdentityReview(r: Record<string, unknown>): IdentityReviewRecord {
  return {
    id: Number(r['id']),
    sourceMessageId: String(r['source_message_id']),
    sourceDate: String(r['source_date']),
    excerpt: String(r['excerpt']),
    matchedText: String(r['matched_text']),
    reason: String(r['reason']),
    candidates: parseJson(r['candidates_json'], []),
    proposedPolarity: (r['proposed_polarity'] as string | null) ?? null,
    proposedCategory: (r['proposed_category'] as string | null) ?? null,
    proposedMagnitude: Number(r['proposed_magnitude'] ?? 1),
    status: String(r['status']),
  };
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
    autoAppliedCount: Number(row['auto_applied_count'] ?? 0),
    identityReviewCount: Number(row['identity_review_count'] ?? 0),
    processedAt: String(row['processed_at']),
    status: String(row['status']),
    rejectReason: (row['reject_reason'] as string | null) ?? null,
    detail: (row['detail'] as string | null) ?? null,
    coverage: parseJson<Record<string, unknown>>(row['coverage_json'], {}),
    bodyHtml: (row['body_html'] as string | null) ?? null,
    bodyText: (row['body_text'] as string | null) ?? null,
  };
}
