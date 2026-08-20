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
  type ProposedEvidence,
} from '../../core/newsletter/pipeline.ts';
import { DEFAULT_NEWSLETTER_SOURCES, type EmailSource } from '../../core/newsletter/source.ts';
import { importTally, type TallyImportResult } from '../../core/newsletter/tally.ts';
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

/** A stored item the current rules would classify differently. */
export interface ReprocessDisagreement {
  playerId: string;
  excerpt: string;
  storedPolarity: string;
  storedMagnitude: number;
  newPolarity: string;
  newMagnitude: number;
  ruleId: string | null;
}

export interface ReprocessPreview {
  messageId: string;
  /** Items the current rules find that are not stored yet. */
  wouldAdd: number;
  alreadyStored: number;
  /**
   * Stored items that came from a body that could not be read, and that the
   * repaired parse replaces. Zero unless the email needed decoding repairs.
   */
  wouldRetire: ReprocessDisagreement[];
  /** Decoding repairs the stored body needs before it can be read at all. */
  repairs: string[];
  /** Stored items the rules now disagree with. Reprocessing will NOT change these. */
  stale: ReprocessDisagreement[];
  /** Disagreements on items a user has corrected. These are never touched. */
  protectedByUser: ReprocessDisagreement[];
  playersAffected: number;
  tallyDelta: { playerId: string; net: number }[];
  coverage: CoverageReport;
  detail: string;
}

function describePreview(
  added: number,
  stale: number,
  protectedCount: number,
  retired: number,
  repaired: boolean,
): string {
  const parts: string[] = [];
  if (repaired) {
    parts.push('This email was stored before it could be decoded properly; re-reading it repairs the text first.');
  }
  parts.push(added === 0 ? 'Nothing new would be added.' : `${added} new item(s) would be added.`);
  if (retired > 0) {
    parts.push(`${retired} item(s) read from the unreadable text would be retired, so nothing is counted twice.`);
  }
  if (stale > 0) {
    parts.push(
      `${stale} stored item(s) are now read differently by the rules, but reprocessing leaves them as they are.`,
    );
  }
  if (protectedCount > 0) {
    parts.push(`${protectedCount} item(s) you corrected are protected and stay as you set them.`);
  }
  return parts.join(' ');
}

export interface TallyImportOutcome {
  rowsParsed: number;
  matched: number;
  inserted: number;
  alreadyPresent: number;
  /** Unresolved names queued for a human decision. */
  identityReviews: number;
  ambiguous: TallyImportResult['ambiguous'];
  unmatched: TallyImportResult['unmatched'];
  conflicts: string[];
  /**
   * Rows from an earlier import of this same document that the current one
   * replaces — chiefly the ±1 stand-ins the identity-repair path wrote before
   * magnitude was carried. Retired so the score is counted once, at its real
   * size.
   */
  superseded: { playerId: string; excerpt: string; polarity: string; magnitude: number }[];
  /** Superseded-looking rows left alone because the user had ruled on them. */
  keptForUserOverride: { playerId: string; excerpt: string }[];
  detail: string;
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
      // Keep the body only for mail we actually accepted and parsed, so
      // improved rules can be re-run over it later. Quarantined mail came from
      // a sender the user never named; recording that it arrived is useful,
      // storing its contents is not.
      bodyHtml: fields.status === 'processed' ? message.html ?? null : null,
      bodyText: fields.status === 'processed' ? message.text ?? null : null,
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
   * Import a hand-maintained tally as backfilled evidence.
   *
   * Used once, for issues that were read before the app existed. Everything
   * goes through the same ledger and the same review queue as parsed mail, so
   * a backfilled item can be corrected or rejected exactly like any other.
   */
  async importTallyDocument(
    markdown: string,
    opts: { sourceName?: string; sourceDate?: string; sourceMessageId?: string } = {},
  ): Promise<TallyImportOutcome> {
    const index = await this.players.buildIndex();
    const result = importTally(markdown, index, opts);
    const { inserted, skipped } = await this.evidence.insertProposed(result.evidence);
    // Rows that did not resolve stay actionable in the app rather than existing
    // only in this response.
    const identityReviews = await this.messages.insertIdentityReviews(result.identityReviews);

    // The document owns its message id, so whatever else still carries that id
    // came from an earlier import of the same file and has now been replaced.
    // Without this the run would double count: a name the user has since
    // confirmed resolves on its own this time, so the fixed importer writes the
    // real "+11" row while the old ±1 stand-in for the same row is still there.
    const { superseded, keptForUserOverride } = await this.evidence.supersedeStaleImports(
      result.sourceMessageId,
      result.evidence.map((e) => e.dedupeKey),
      'superseded-by-tally-reimport',
    );

    const seasonStart = await this.settings.get<string | null>(SETTING_KEYS.seasonStart, null);
    const touched = new Set([
      ...result.evidence.map((e) => e.playerId),
      ...superseded.map((e) => e.playerId),
    ]);
    for (const playerId of touched) {
      await this.evidence.refreshSignal(playerId, { seasonStart });
    }

    const detail =
      `${result.detail} ${inserted} new item(s) stored${skipped ? `, ${skipped} already present` : ''}.` +
      (identityReviews ? ` ${identityReviews} name(s) are waiting in Review.` : '') +
      (superseded.length
        ? ` ${superseded.length} item(s) from an earlier import of this document were replaced.`
        : '') +
      (keptForUserOverride.length
        ? ` ${keptForUserOverride.length} item(s) you had corrected were left exactly as you set them.`
        : '');

    return {
      rowsParsed: result.rowsParsed,
      matched: result.matched,
      inserted,
      alreadyPresent: skipped,
      identityReviews,
      ambiguous: result.ambiguous,
      unmatched: result.unmatched,
      conflicts: result.conflicts,
      superseded: superseded.map((e) => ({
        playerId: e.playerId,
        excerpt: e.excerpt,
        polarity: e.polarity,
        magnitude: e.magnitude,
      })),
      keptForUserOverride: keptForUserOverride.map((e) => ({ playerId: e.playerId, excerpt: e.excerpt })),
      detail,
    };
  }

  /**
   * Rebuild the original email from the message log.
   *
   * Returns null when the body was not retained — messages stored before
   * bodies were kept, and anything that was quarantined rather than processed.
   */
  async storedMessage(messageId: string): Promise<EmailMessage | null> {
    const record = await this.messages.seen(messageId);
    if (!record) return null;
    if (!record.bodyHtml && !record.bodyText) return null;
    return {
      messageId: record.messageId,
      from: record.fromAddress,
      subject: record.subject,
      receivedAt: record.receivedAt,
      html: record.bodyHtml ?? null,
      text: record.bodyText ?? null,
    };
  }

  /**
   * Work out what reprocessing a stored message would do, without doing it.
   *
   * This exists because reprocessing is insert-only: it adds evidence the rules
   * now find and never touches what is already stored. That is the right
   * behaviour — a user's correction must survive a rule change — but it means
   * an improved rule can silently disagree with a stored row and leave it
   * alone. Tuning rules blind to that is guesswork, so the preview reports it
   * explicitly as `stale` rather than hiding it among the skips.
   *
   * Writes nothing.
   */
  async previewReprocess(message: EmailMessage): Promise<ReprocessPreview> {
    const index = await this.players.buildIndex();
    const result = processNewsletter(message, index);
    const existing = await this.evidence.listByDedupeKeys(result.evidence.map((e) => e.dedupeKey));

    const added: ProposedEvidence[] = [];
    const unchanged: ProposedEvidence[] = [];
    const stale: ReprocessDisagreement[] = [];
    const protectedByUser: ReprocessDisagreement[] = [];

    for (const proposed of result.evidence) {
      const stored = existing.get(proposed.dedupeKey);
      if (!stored) {
        added.push(proposed);
        continue;
      }
      const differs =
        stored.polarity !== proposed.polarity ||
        stored.magnitude !== proposed.magnitude ||
        stored.category !== proposed.category;
      if (!differs) {
        unchanged.push(proposed);
        continue;
      }
      const disagreement: ReprocessDisagreement = {
        playerId: proposed.playerId,
        excerpt: proposed.excerpt,
        storedPolarity: stored.polarity,
        storedMagnitude: stored.magnitude,
        newPolarity: proposed.polarity,
        newMagnitude: proposed.magnitude,
        ruleId: proposed.ruleId,
      };
      // A user decision outranks any rule, so this one is not even a candidate
      // for change — it is reported so the disagreement stays visible.
      if (stored.userOverride) protectedByUser.push(disagreement);
      else stale.push(disagreement);
    }

    // Only genuinely new items would move a tally, so that is all the delta
    // counts. Promising more than reprocessing delivers would be a lie.
    const tallyDelta = new Map<string, number>();
    for (const e of added) {
      if (e.reviewStatus !== 'auto_applied') continue;
      const signed = e.polarity === 'positive' ? e.magnitude : e.polarity === 'negative' ? -e.magnitude : 0;
      tallyDelta.set(e.playerId, (tallyDelta.get(e.playerId) ?? 0) + signed);
    }

    // What the repair would retire. Only a message whose body could not be read
    // has anything here: its stored rows were derived from garbage, so the
    // repaired parse replaces rather than joins them.
    const repairs = result.coverage.repairs;
    const keep = new Set(result.evidence.map((e) => e.dedupeKey));
    const wouldRetire: ReprocessDisagreement[] = repairs.length
      ? (await this.evidence.listLiveBySourceMessage(message.messageId))
          .filter((row) => !keep.has(row.dedupeKey) && !row.userOverride)
          .map((row) => ({
            playerId: row.playerId,
            excerpt: row.excerpt,
            storedPolarity: row.polarity,
            storedMagnitude: row.magnitude,
            newPolarity: 'retired',
            newMagnitude: 0,
            ruleId: row.ruleId,
          }))
      : [];

    return {
      messageId: message.messageId,
      wouldAdd: added.length,
      alreadyStored: unchanged.length,
      wouldRetire,
      repairs,
      stale,
      protectedByUser,
      playersAffected: new Set(added.map((e) => e.playerId)).size,
      tallyDelta: [...tallyDelta.entries()]
        .filter(([, net]) => net !== 0)
        .map(([playerId, net]) => ({ playerId, net }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
      coverage: result.coverage,
      detail: describePreview(
        added.length,
        stale.length,
        protectedByUser.length,
        wouldRetire.length,
        repairs.length > 0,
      ),
    };
  }

  /**
   * Re-run the classifier over a stored message.
   *
   * Normally insert-only: existing rows are never updated, only new dedupe keys
   * are inserted, so a user's correction survives any rule change.
   *
   * The one exception is a message whose stored body could not be read — an
   * email kept before its MIME was decoded correctly. There, insert-only would
   * double count. The rows already stored were derived from fragments of
   * undecoded text; the repaired parse produces the same news spelled properly,
   * which is a different excerpt and therefore a different dedupe key. Both
   * would then sit in the ledger describing one event. So when — and only
   * when — a repair was needed, the rows this message owns that the repaired
   * parse does not reproduce are retired, exactly as a tally re-import retires
   * the revision it replaces. Rows the user has ruled on are still never
   * touched, and a signal the repaired parse finds again keeps its own row
   * rather than gaining a second one.
   */
  async reprocess(message: EmailMessage): Promise<IngestOutcome> {
    const index = await this.players.buildIndex();
    const result = processNewsletter(message, index);
    const { inserted } = await this.evidence.insertProposed(result.evidence);

    let superseded: { playerId: string }[] = [];
    let keptForUserOverride: { playerId: string }[] = [];
    if (result.coverage.repairs.length > 0) {
      const outcome = await this.evidence.supersedeStaleImports(
        message.messageId,
        result.evidence.map((e) => e.dedupeKey),
        'superseded-by-decoding-repair',
      );
      superseded = outcome.superseded;
      keptForUserOverride = outcome.keptForUserOverride;
    }

    const seasonStart = await this.settings.get<string | null>(SETTING_KEYS.seasonStart, null);
    const touched = new Set([
      ...result.evidence.map((e) => e.playerId),
      ...superseded.map((e) => e.playerId),
    ]);
    for (const playerId of touched) {
      await this.evidence.refreshSignal(playerId, { seasonStart });
    }

    const detail =
      (result.coverage.repairs.length
        ? 'The stored email had to be decoded before it could be read. '
        : '') +
      `Reprocessed: ${inserted} new item(s).` +
      (superseded.length
        ? ` ${superseded.length} item(s) read from the unreadable text were retired, so nothing is counted twice.`
        : '') +
      (keptForUserOverride.length
        ? ` ${keptForUserOverride.length} item(s) you had corrected were left exactly as you set them.`
        : ' Your existing corrections were left untouched.');

    return {
      messageId: message.messageId,
      status: 'processed',
      evidenceInserted: inserted,
      evidencePending: result.stats.pendingReview,
      identityReviews: 0,
      playersTouched: touched.size,
      detail,
      coverage: result.coverage,
      result,
    };
  }
}
