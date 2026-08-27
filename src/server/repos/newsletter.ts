/** Newsletter message log + identity review queue. */

import type { IdentityReviewItem } from '../../core/newsletter/pipeline.ts';
import { stableHash } from '../../core/newsletter/fingerprint.ts';
import { nowIso, parseJson, toJson, type Database } from '../db.ts';

/**
 * Where one newsletter stands in the reviewed-tally workflow.
 *
 * `awaiting` is the only one that means work: the issue is stored and readable,
 * and nobody has approved a tally for it yet. `not_applicable` covers everything
 * a person could not tally even if they wanted to — mail that was quarantined or
 * rejected, and issues stored before bodies were retained, which cannot be
 * copied for ChatGPT at all.
 */
export type TallyState = 'awaiting' | 'applied' | 'not_applicable';

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
  /**
   * Whether this issue is still waiting for its approved ChatGPT tally.
   *
   * Durable, not derived. Setup asks it on every load to decide whether to show
   * an attention dot and the two workflow controls, and the answer has to
   * survive a reload, a different phone and a Worker restart — none of which a
   * value inferred from the shape of the evidence ledger would.
   */
  tallyState: TallyState;
  /** When the approved tally was applied. Null while one is still awaited. */
  talliedAt: string | null;
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
           body_html, body_text, tally_state, tallied_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        // `tally_state` and `tallied_at` are deliberately absent from the
        // update: re-recording a message must never walk an approved tally back
        // to awaiting. Where the workflow stands is owned by `markTallied` and
        // by the migration's one-time backfill, not by a re-delivery.
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
        record.tallyState,
        record.talliedAt,
      )
      .run();
  }

  // ------------------------------------------------------ the tally workflow

  /**
   * The newsletter the workflow is currently about, or null when there is none.
   *
   * **Oldest first, one at a time.** Issues are read in the order they arrive
   * and a running tally is cumulative, so working the backlog newest-first
   * would score a week before the week it follows. Nothing here ever combines
   * two issues: `pendingTallyCount` says how many are behind this one, and each
   * is copied, scored and approved on its own.
   */
  async nextAwaitingTally(): Promise<MessageRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM newsletter_messages
          WHERE tally_state = 'awaiting'
          ORDER BY received_at ASC, rowid ASC LIMIT 1`,
      )
      .first<Record<string, unknown>>();
    return row ? toMessage(row) : null;
  }

  /** How many issues are waiting for an approved tally. */
  async awaitingTallyCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM newsletter_messages WHERE tally_state = 'awaiting'")
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /**
   * Record that an approved tally has been applied to this newsletter.
   *
   * Idempotent, and one-directional: a message already `applied` keeps its
   * original `tallied_at`, so re-pasting a revised tally does not rewrite when
   * the issue was first completed.
   */
  async markTallied(messageId: string, at: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE newsletter_messages
            SET tally_state = 'applied', tallied_at = COALESCE(tallied_at, ?)
          WHERE message_id = ?`,
      )
      .bind(at, messageId)
      .run();
  }

  /**
   * Has this exact tally already been applied to this newsletter?
   *
   * The durable, server-side half of exactly-once. The ledger's own dedupe keys
   * already stop a repeated paste from counting twice; this is what lets the
   * server *recognise* the repeat and answer with what the first apply did,
   * rather than truthfully but uselessly reporting that nothing was applied.
   *
   * `standing` is the distinction that matters. A tally that has been applied
   * and then corrected by a later one is on the record but is no longer what
   * this newsletter says, so pasting it again is a revision back to it rather
   * than a repeat of it — and has to be allowed to run.
   */
  async findTallyApplication(
    messageId: string,
    payloadHash: string,
  ): Promise<{
    appliedAt: string;
    standing: boolean;
    /** False while the apply that claimed this row has not reported back. */
    completed: boolean;
    outcome: Record<string, unknown>;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT applied_at, sequence, outcome_json,
                (SELECT MAX(sequence) FROM newsletter_tally_applications WHERE message_id = ?) AS newest
           FROM newsletter_tally_applications
          WHERE message_id = ? AND payload_hash = ?`,
      )
      .bind(messageId, messageId, payloadHash)
      .first<{ applied_at: string; sequence: number; outcome_json: string; newest: number }>();
    if (!row) return null;
    const outcome = parseJson<Record<string, unknown>>(row.outcome_json, {});
    return {
      appliedAt: row.applied_at,
      standing: Number(row.sequence) === Number(row.newest),
      completed: Object.keys(outcome).length > 0,
      outcome,
    };
  }

  /**
   * Claim this (newsletter, exact tally) pair for one application.
   *
   * Returns false only for a **replay**: this tally is the one already standing
   * for this newsletter, so applying it again is a repeat rather than a change.
   * That is the double tap, the reload, the retry after a timeout and the second
   * paste of the same block — and the insert is the atomic decision, so two
   * requests racing on a fresh payload cannot both conclude they are first.
   *
   * The distinction that matters, and the reason this is not a permanent lock
   * on the pair: pasting tally A, then a corrected tally B, then A again is
   * three real decisions. The third is a revision back to the first, it has to
   * bring back what B retired, and a lock keyed on the pair alone would refuse
   * it as "already applied" while the ledger still showed B. So a pair is a
   * replay only while it is the newest application on record; behind a newer
   * one it is a revision, and running it makes it the newest in turn.
   *
   * A claim whose apply never reported back is treated as unfinished rather
   * than as a replay. Refusing it would be the worse failure of the two: an
   * apply that died half-way would have taken the claim with it, and the retry
   * — the one thing a person would obviously try — would be told the tally was
   * already applied while the ledger held none of it. Letting it run again
   * costs nothing, because every write underneath is keyed and idempotent.
   */
  async claimTallyApplication(messageId: string, payloadHash: string, at: string): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO newsletter_tally_applications (message_id, payload_hash, applied_at, sequence, outcome_json)
         VALUES (
           ?, ?, ?,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM newsletter_tally_applications WHERE message_id = ?),
           '{}'
         )
         ON CONFLICT(message_id, payload_hash) DO NOTHING`,
      )
      .bind(messageId, payloadHash, at, messageId)
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) return true;

    const existing = await this.findTallyApplication(messageId, payloadHash);
    if (!existing) return false;
    if (existing.standing && existing.completed) return false;

    await this.db
      .prepare(
        `UPDATE newsletter_tally_applications
            SET applied_at = ?,
                sequence = CASE
                  WHEN ? THEN sequence
                  ELSE (SELECT MAX(sequence) + 1 FROM newsletter_tally_applications WHERE message_id = ?)
                END
          WHERE message_id = ? AND payload_hash = ?`,
      )
      .bind(at, existing.standing ? 1 : 0, messageId, messageId, payloadHash)
      .run();
    return true;
  }

  /** Store what the winning application did, so a replay can answer with it. */
  async recordTallyOutcome(
    messageId: string,
    payloadHash: string,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE newsletter_tally_applications SET outcome_json = ? WHERE message_id = ? AND payload_hash = ?',
      )
      .bind(toJson(outcome), messageId, payloadHash)
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
    tallyState: ((row['tally_state'] as string | null) ?? 'not_applicable') as TallyState,
    talliedAt: (row['tallied_at'] as string | null) ?? null,
  };
}
