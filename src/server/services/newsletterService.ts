/**
 * Newsletter ingestion orchestration: qualify -> process -> persist -> refresh
 * signal cache -> route ambiguity to review.
 *
 * Idempotent by construction: a message already recorded (by id or by content
 * fingerprint) is skipped, and evidence inserts are deduped independently.
 */

import { contentFingerprint } from '../../core/newsletter/fingerprint.ts';
import {
  processNewsletter,
  qualifies,
  type EmailMessage,
  type NewsletterProcessResult,
  type NewsletterSourceConfig,
} from '../../core/newsletter/pipeline.ts';
import { DEFAULT_NEWSLETTER_SOURCES, type EmailSource } from '../../core/newsletter/source.ts';
import { nowIso, type Database } from '../db.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { NewsletterRepo } from '../repos/newsletter.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';

export interface IngestOutcome {
  messageId: string;
  status: 'processed' | 'duplicate' | 'not_qualified' | 'no_players';
  evidenceInserted: number;
  evidencePending: number;
  identityReviews: number;
  playersTouched: number;
  detail: string;
  result?: NewsletterProcessResult;
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
   * Ingest one message.
   *
   * @param opts.force  bypass the qualification check (operator upload)
   */
  async ingest(message: EmailMessage, opts: { force?: boolean } = {}): Promise<IngestOutcome> {
    const sources = await this.getSources();
    const source = qualifies(message, sources);
    if (!source && !opts.force) {
      return {
        messageId: message.messageId,
        status: 'not_qualified',
        evidenceInserted: 0,
        evidencePending: 0,
        identityReviews: 0,
        playersTouched: 0,
        detail: `sender "${message.from}" does not match a configured newsletter source`,
      };
    }

    const fingerprint = contentFingerprint(message.html ?? message.text ?? '');
    const existing = await this.messages.findProcessed(message.messageId, fingerprint);
    if (existing) {
      return {
        messageId: message.messageId,
        status: 'duplicate',
        evidenceInserted: 0,
        evidencePending: 0,
        identityReviews: 0,
        playersTouched: 0,
        detail:
          existing.messageId === message.messageId
            ? 'message already processed'
            : `identical content already processed as ${existing.messageId}`,
      };
    }

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

    await this.messages.recordMessage({
      messageId: message.messageId,
      sourceId: source?.id ?? 'manual',
      fromAddress: message.from,
      subject: message.subject,
      receivedAt: message.receivedAt,
      fingerprint,
      evidenceCount: result.evidence.length,
      pendingCount: result.stats.pendingReview,
      processedAt: nowIso(),
      status: 'processed',
    });

    return {
      messageId: message.messageId,
      status: result.evidence.length === 0 ? 'no_players' : 'processed',
      evidenceInserted: inserted,
      evidencePending: result.stats.pendingReview,
      identityReviews,
      playersTouched: touched.length,
      detail: `${result.stats.resolved} resolved mention(s) across ${result.blocks} block(s)`,
      result,
    };
  }

  /** Drive a pull-based source (fixtures today, Gmail later). */
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
      detail: `reprocessed; ${inserted} new item(s), existing items and overrides untouched`,
      result,
    };
  }
}
