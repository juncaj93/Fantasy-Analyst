/**
 * Newsletter ingestion orchestration: validate -> process -> persist -> refresh
 * signal cache -> route ambiguity to review.
 *
 * The dedicated inbound address is the production path, so this service is the
 * single gate between "an email arrived" and "evidence exists". Mail from an
 * unexpected sender is recorded and quarantined, never parsed into evidence.
 *
 * Idempotent by construction: a message already seen (by id or by content
 * fingerprint) is skipped, and evidence inserts are deduped independently.
 */

import { contentFingerprint } from '../../core/newsletter/fingerprint.ts';
import {
  processNewsletter,
  qualifies,
  type CoverageReport,
  type EmailMessage,
  type NewsletterProcessResult,
  type NewsletterSourceConfig,
} from '../../core/newsletter/pipeline.ts';
import { DEFAULT_NEWSLETTER_SOURCES, type EmailSource } from '../../core/newsletter/source.ts';
import { nowIso, type Database } from '../db.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { NewsletterRepo, type MessageRecord } from '../repos/newsletter.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';

export type IngestStatus =
  | 'processed'
  | 'duplicate'
  | 'quarantined'
  | 'rejected'
  | 'no_players'
  | 'error';

export interface IngestOutcome {
  messageId: string;
  status: IngestStatus;
  evidenceInserted: number;
  evidencePending: number;
  identityReviews: number;
  playersTouched: number;
  /** One plain-language sentence, safe to show in the UI as-is. */
  detail: string;
  coverage?: CoverageReport;
  result?: NewsletterProcessResult;
}

/** Bodies larger than this are rejected rather than parsed. */
export const MAX_BODY_BYTES = 2_000_000;

function duplicate(messageId: string, detail: string): IngestOutcome {
  return {
    messageId,
    status: 'duplicate',
    evidenceInserted: 0,
    evidencePending: 0,
    identityReviews: 0,
    playersTouched: 0,
    detail,
  };
}

export class NewsletterService {
  private readonly players: PlayerRepo;
  private readonly evidence: EvidenceRepo;
  private readonly messages: NewsletterRepo;
  private readonly settings: SettingsRepo;

  constructor(db: Database) {
    this.players = new PlayerRepo(db);
    this.evidence = new EvidenceRepo(db);
    this.messages = new NewsletterRepo(db);
    this.settings = new SettingsRepo(db);
  }

  async getSources(): Promise<NewsletterSourceConfig[]> {
    return this.settings.get<NewsletterSourceConfig[]>(
      SETTING_KEYS.newsletterSources,
      DEFAULT_NEWSLETTER_SOURCES,
    );
  }

  async setSources(sources: NewsletterSourceConfig[]): Promise<void> {
    await this.settings.set(SETTING_KEYS.newsletterSources, sources);
  }

  /**
   * True once the user has saved a sender of their own.
   *
   * Checked by the absence of a stored value rather than by inspecting the
   * strings, so a real sender that happens to look like the shipped placeholder
   * still counts as configured.
   */
  async isSenderConfigured(): Promise<boolean> {
    const stored = await this.settings.get<NewsletterSourceConfig[] | null>(
      SETTING_KEYS.newsletterSources,
      null,
    );
    if (!stored || stored.length === 0) return false;
    return stored.some((s) => s.enabled !== false && (s.fromPatterns?.length ?? 0) > 0);
  }

  /**
   * Ingest one message.
   *
   * Every inbound email is logged whatever happens, so Settings can always
   * answer "did anything arrive?" — but only qualifying mail reaches the parser.
   *
   * @param opts.force  bypass the sender check (operator upload from Settings)
   */
  async ingest(message: EmailMessage, opts: { force?: boolean } = {}): Promise<IngestOutcome> {
    const body = message.html ?? message.text ?? '';
    const fingerprint = contentFingerprint(body);

    // --- already seen? -------------------------------------------------------
    // Same delivery (any outcome) is never handled twice...
    const sameMessage = await this.messages.seen(message.messageId);
    if (sameMessage) {
      return duplicate(message.messageId, 'This email was already handled — nothing was duplicated.');
    }
    // ...and identical content is skipped only if it was actually processed, so
    // a quarantined lookalike cannot block the real newsletter.
    const sameContent = await this.messages.findProcessedByFingerprint(fingerprint);
    if (sameContent) {
      return duplicate(
        message.messageId,
        `The same newsletter was already read on ${sameContent.receivedAt.slice(0, 10)} — nothing was duplicated.`,
      );
    }

    // --- sender validation ---------------------------------------------------
    const sources = await this.getSources();
    const source = qualifies(message, sources);
    if (!source && !opts.force) {
      const reason = `Unexpected sender "${message.from || 'unknown'}"`;
      await this.log(message, fingerprint, {
        status: 'quarantined',
        sourceId: 'unknown',
        rejectReason: reason,
        detail: 'Ignored: this address only accepts your configured newsletter sender.',
      });
      return {
        messageId: message.messageId,
        status: 'quarantined',
        evidenceInserted: 0,
        evidencePending: 0,
        identityReviews: 0,
        playersTouched: 0,
        detail: `${reason} — ignored, and nothing was added to your player tallies.`,
      };
    }

    // --- size guard ----------------------------------------------------------
    if (body.length > MAX_BODY_BYTES) {
      await this.log(message, fingerprint, {
        status: 'rejected',
        sourceId: source?.id ?? 'manual',
        rejectReason: `Body of ${body.length} bytes exceeds the ${MAX_BODY_BYTES} byte limit`,
        detail: 'Ignored: the email was unusually large.',
      });
      return {
        messageId: message.messageId,
        status: 'rejected',
        evidenceInserted: 0,
        evidencePending: 0,
        identityReviews: 0,
        playersTouched: 0,
        detail: 'That email was too large to process safely, so it was ignored.',
      };
    }

    // --- process -------------------------------------------------------------
    try {
      const index = await this.players.buildIndex();
      const result = processNewsletter(message, index, {
        sourceName: source?.label ?? message.from,
      });

      const { inserted } = await this.evidence.insertProposed(result.evidence);
      const identityReviews = await this.messages.insertIdentityReviews(result.identityReview);

      const touched = [...new Set(result.evidence.map((e) => e.playerId))];
      const seasonStart = await this.settings.get<string | null>(SETTING_KEYS.seasonStart, null);
      for (const playerId of touched) {
        await this.evidence.refreshSignal(playerId, { seasonStart });
      }

      const autoApplied = result.evidence.filter((e) => e.reviewStatus === 'auto_applied').length;
      const detail =
        result.evidence.length === 0
          ? 'Processed, but no player news was found in this issue.'
          : `Found news on ${touched.length} player${touched.length === 1 ? '' : 's'}: ` +
            `${autoApplied} applied automatically, ${result.stats.pendingReview} waiting for your review.`;

      await this.log(message, fingerprint, {
        status: 'processed',
        sourceId: source?.id ?? 'manual',
        evidenceCount: result.evidence.length,
        pendingCount: result.stats.pendingReview,
        autoAppliedCount: autoApplied,
        identityReviewCount: identityReviews,
        coverage: result.coverage as unknown as Record<string, unknown>,
        detail,
      });

      return {
        messageId: message.messageId,
        status: result.evidence.length === 0 ? 'no_players' : 'processed',
        evidenceInserted: inserted,
        evidencePending: result.stats.pendingReview,
        identityReviews,
        playersTouched: touched.length,
        detail,
        coverage: result.coverage,
        result,
      };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      await this.log(message, fingerprint, {
        status: 'error',
        sourceId: source?.id ?? 'manual',
        rejectReason: messageText,
        detail: 'This newsletter could not be read. Nothing was changed.',
      });
      return {
        messageId: message.messageId,
        status: 'error',
        evidenceInserted: 0,
        evidencePending: 0,
        identityReviews: 0,
        playersTouched: 0,
        detail: `This newsletter could not be read (${messageText}). Nothing was changed.`,
      };
    }
  }

  private async log(
    message: EmailMessage,
    fingerprint: string,
    fields: Partial<MessageRecord> & { status: string; sourceId: string },
  ): Promise<void> {
    await this.messages.recordMessage({
      messageId: message.messageId,
      sourceId: fields.sourceId,
      fromAddress: message.from ?? '',
      subject: message.subject ?? '',
      receivedAt: message.receivedAt,
      fingerprint,
      evidenceCount: fields.evidenceCount ?? 0,
      pendingCount: fields.pendingCount ?? 0,
      autoAppliedCount: fields.autoAppliedCount ?? 0,
      identityReviewCount: fields.identityReviewCount ?? 0,
      processedAt: nowIso(),
      status: fields.status,
      rejectReason: fields.rejectReason ?? null,
      detail: fields.detail ?? null,
      coverage: fields.coverage ?? null,
    });
  }

  /** Drive a pull-based source. The inbound address is push, so this is unused in production. */
  async ingestFromSource(source: EmailSource, opts: { limit?: number } = {}): Promise<IngestOutcome[]> {
    if (!source.isConfigured()) return [];
    const since = await this.messages.lastProcessedAt();
    const messages = await source.fetchNew({ since, limit: opts.limit ?? 10 });
    const outcomes: IngestOutcome[] = [];
    for (const message of messages) {
      outcomes.push(await this.ingest(message));
    }
    return outcomes;
  }

  /**
   * Re-run the classifier over a stored message.
   * User overrides are preserved: existing rows are never updated, only new
   * dedupe keys are inserted.
   */
  async reprocess(message: EmailMessage): Promise<IngestOutcome> {
    const index = await this.players.buildIndex();
    const result = processNewsletter(message, index);
    const { inserted } = await this.evidence.insertProposed(result.evidence);
    const seasonStart = await this.settings.get<string | null>(SETTING_KEYS.seasonStart, null);
    for (const playerId of [...new Set(result.evidence.map((e) => e.playerId))]) {
      await this.evidence.refreshSignal(playerId, { seasonStart });
    }
    return {
      messageId: message.messageId,
      status: 'processed',
      evidenceInserted: inserted,
      evidencePending: result.stats.pendingReview,
      identityReviews: 0,
      playersTouched: new Set(result.evidence.map((e) => e.playerId)).size,
      detail: `Reprocessed: ${inserted} new item(s). Your existing corrections were left untouched.`,
      coverage: result.coverage,
      result,
    };
  }
}
