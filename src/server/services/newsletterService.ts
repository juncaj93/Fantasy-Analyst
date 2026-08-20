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

import type { EvidenceItem } from '../../core/evidence/types.ts';
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
import {
  AI_TALLY_RULE_ID,
  buildNewsletterSource,
  importAiTally,
  type AiTallyImportResult,
} from '../../core/newsletter/aiTally.ts';
import { extractBlocks } from '../../core/newsletter/html.ts';
import { recoverBody } from '../../core/newsletter/mime.ts';
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

export interface AiTallyPreviewRow {
  name: string;
  playerId: string;
  playerName: string;
  score: number;
  reason: string;
  dedupeKey: string;
  /** Already in the ledger from an earlier paste of this same row. */
  alreadyImported: boolean;
  /** Held back because the same player was scored twice in one block. */
  contested: boolean;
  /**
   * The parser's own rows for this player in this newsletter, and what applying
   * the tally does to each.
   *
   * An imported tally is the semantic reading of the issue, so the parser's
   * reading of the same player must not count beside it. Neither is deleted.
   */
  parserRows: ParserRowDisposition[];
}

/** One parser row this import displaces, and how. */
export interface ParserRowDisposition {
  id: string;
  ruleId: string | null;
  excerpt: string;
  polarity: string;
  magnitude: number;
  /**
   * `superseded` — it points the same way, so it is the same assessment and is
   * retired. `needs_review` — it points the other way, so whether it was ever
   * the same claim is a real question; it stops counting and waits for a human
   * rather than being counted or discarded by default. `protected` — the user
   * has ruled on it, and nothing an import does may touch that.
   */
  disposition: 'superseded' | 'needs_review' | 'protected';
}

export interface AiTallyPreview {
  messageId: string;
  protocolOk: boolean;
  error: string | null;
  rowsParsed: number;
  /** Rows ready to apply. */
  ready: AiTallyPreviewRow[];
  /** Rows already in the ledger; applying again changes nothing. */
  duplicates: AiTallyPreviewRow[];
  /** Rows held for a human: a contested score, or a name that did not resolve. */
  pending: AiTallyPreviewRow[];
  ambiguous: AiTallyImportResult['ambiguous'];
  unmatched: AiTallyImportResult['unmatched'];
  conflicts: string[];
  rejected: AiTallyImportResult['rejected'];
  /**
   * Rows from an earlier paste for this newsletter that this one replaces.
   *
   * A revised tally supersedes rather than stacks, so a corrected score does
   * not sit in the ledger beside the one it corrects.
   */
  wouldRetire: { playerId: string; excerpt: string; polarity: string; magnitude: number }[];
  /** Superseded-looking rows left alone because the user had ruled on them. */
  protectedByUser: { playerId: string; excerpt: string }[];
  /**
   * Parser rows this import displaces, across every player it scores.
   *
   * Flattened alongside the per-row copy so a caller can answer "what stops
   * counting?" without walking the rows.
   */
  parserSuperseded: ParserRowDisposition[];
  parserNeedsReview: ParserRowDisposition[];
  tallyDelta: { playerId: string; playerName: string; net: number }[];
  detail: string;
}

export interface AiTallyApplyOutcome {
  messageId: string;
  inserted: number;
  alreadyPresent: number;
  identityReviews: number;
  retired: number;
  protectedByUser: number;
  /** Parser rows retired because the tally now speaks for this newsletter. */
  parserSuperseded: number;
  /** Parser rows parked for a human because they point the other way. */
  parserNeedsReview: number;
  playersTouched: number;
  detail: string;
}

/** Bodies larger than this are rejected rather than parsed. */
export const MAX_BODY_BYTES = 2_000_000;

/** Pasted tally blocks larger than this are refused rather than parsed. */
export const MAX_TALLY_BYTES = 200_000;

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

  // ------------------------------------------------------- ChatGPT tally ---

  /**
   * The newsletter as one block of text, ready to paste into a chat.
   *
   * Built from the same extracted blocks the parser reads, so whatever the app
   * hands over has already been through MIME repair, charset decoding, HTML
   * stripping, tracking-URL removal and boilerplate exclusion. The reader of
   * that chat gets the article, not the delivery.
   */
  async chatSource(message: EmailMessage): Promise<string> {
    const recovered = recoverBody({ html: message.html, text: message.text });
    const body = recovered.html ?? recovered.text ?? '';
    const blocks = extractBlocks(body, { isHtml: recovered.html != null ? true : undefined });
    return buildNewsletterSource({
      subject: message.subject ?? '',
      receivedAt: message.receivedAt,
      messageId: message.messageId,
      blocks,
    });
  }

  /**
   * Decide what an imported tally does to the parser's own rows.
   *
   * A newsletter that has been scored by hand has one semantic reading, and it
   * is the imported one — so the parser's reading of the same player in the
   * same issue must stop counting rather than stacking underneath it. Nothing
   * is deleted: the parser's finding, its rule and its excerpt stay in the
   * ledger for audit, they simply stop contributing.
   *
   * The split is by direction, because that is what separates the two real
   * cases. Pointing the same way, the two are the same assessment and the
   * import supersedes it. Pointing opposite ways, whether they were ever the
   * same claim is a genuine question — the parser may have read a different
   * sentence — and the honest answer is neither to count both nor to discard
   * one, so it stops counting and waits for a person.
   *
   * Shared by preview and apply so the two cannot describe different outcomes.
   */
  private planParserDisplacement(
    live: EvidenceItem[],
    proposed: ProposedEvidence[],
  ): Map<string, ParserRowDisposition[]> {
    const byPlayer = new Map<string, ParserRowDisposition[]>();
    const scored = new Map<string, ProposedEvidence>();
    for (const item of proposed) scored.set(item.playerId, item);

    for (const row of live) {
      if (row.ruleId === AI_TALLY_RULE_ID) continue;
      const mine = scored.get(row.playerId);
      if (!mine) continue;
      const disposition: ParserRowDisposition['disposition'] = row.userOverride
        ? 'protected'
        : row.polarity === mine.polarity
          ? 'superseded'
          : 'needs_review';
      const list = byPlayer.get(row.playerId) ?? [];
      list.push({
        id: row.id,
        ruleId: row.ruleId,
        excerpt: row.excerpt,
        polarity: row.polarity,
        magnitude: row.magnitude,
        disposition,
      });
      byPlayer.set(row.playerId, list);
    }
    return byPlayer;
  }

  /**
   * What pasting this tally would do. Writes nothing.
   *
   * The preview exists because the app cannot check the judgment in the block —
   * it did not make it and will not second-guess it. What it can check is
   * everything mechanical around it: that the protocol is intact, that each
   * name is one player, that a row is not already in the ledger, and that a
   * score is not about to land beside a deterministic row saying the same
   * thing. Those are the ways an import goes wrong without anybody noticing.
   */
  async previewAiTally(message: EmailMessage, pasted: string): Promise<AiTallyPreview> {
    const index = await this.players.buildIndex();
    const sources = await this.getSources();
    const source = qualifies(message, sources);
    const result = importAiTally(pasted, index, {
      sourceMessageId: message.messageId,
      sourceDate: message.receivedAt,
      sourceName: source?.label ?? message.from,
    });

    if (result.error) {
      return {
        messageId: message.messageId,
        protocolOk: false,
        error: result.error,
        rowsParsed: 0,
        ready: [],
        duplicates: [],
        pending: [],
        ambiguous: [],
        unmatched: [],
        conflicts: [],
        rejected: result.rejected,
        wouldRetire: [],
        protectedByUser: [],
        parserSuperseded: [],
        parserNeedsReview: [],
        tallyDelta: [],
        detail: result.error,
      };
    }

    const stored = await this.evidence.listByDedupeKeys(result.evidence.map((e) => e.dedupeKey));
    const live = await this.evidence.listLiveBySourceMessage(message.messageId);
    // What the parser found for these same players, and what happens to it.
    const displaced = this.planParserDisplacement(live, result.evidence);

    const ready: AiTallyPreviewRow[] = [];
    const duplicates: AiTallyPreviewRow[] = [];
    const pending: AiTallyPreviewRow[] = [];

    for (const item of result.evidence) {
      const already = stored.has(item.dedupeKey);
      const row: AiTallyPreviewRow = {
        name: item.playerName,
        playerId: item.playerId,
        playerName: index.get(item.playerId)?.fullName ?? item.playerName,
        score: item.polarity === 'negative' ? -item.magnitude : item.magnitude,
        reason: item.excerpt,
        dedupeKey: item.dedupeKey,
        alreadyImported: already,
        contested: item.reviewStatus === 'pending',
        parserRows: displaced.get(item.playerId) ?? [],
      };
      if (already) duplicates.push(row);
      else if (row.contested) pending.push(row);
      else ready.push(row);
    }

    // A revised paste replaces the previous one rather than stacking beside it.
    // Scoped to this import's own rows: the parser's evidence for the same
    // newsletter is not this import's to retire.
    const keep = new Set(result.evidence.map((e) => e.dedupeKey));
    const priorImports = live.filter((row) => row.ruleId === AI_TALLY_RULE_ID && !keep.has(row.dedupeKey));
    const wouldRetire = priorImports
      .filter((row) => !row.userOverride)
      .map((row) => ({
        playerId: row.playerId,
        excerpt: row.excerpt,
        polarity: row.polarity,
        magnitude: row.magnitude,
      }));
    const protectedByUser = priorImports
      .filter((row) => row.userOverride)
      .map((row) => ({ playerId: row.playerId, excerpt: row.excerpt }));

    /*
     * What the tally actually moves: new rows in, replaced rows out, and the
     * parser's own rows for these players out too.
     *
     * Counting only the arrivals would advertise a number the ledger will not
     * show, because applying this also stops the parser's reading of the same
     * player from contributing.
     */
    const delta = new Map<string, number>();
    const bump = (playerId: string, by: number) => delta.set(playerId, (delta.get(playerId) ?? 0) + by);
    const signedOf = (polarity: string, magnitude: number) =>
      polarity === 'positive' ? magnitude : polarity === 'negative' ? -magnitude : 0;
    for (const row of ready) bump(row.playerId, row.score);
    for (const row of wouldRetire) bump(row.playerId, -signedOf(row.polarity, row.magnitude));
    for (const [playerId, rows] of displaced) {
      for (const row of rows) {
        if (row.disposition === 'protected') continue;
        bump(playerId, -signedOf(row.polarity, row.magnitude));
      }
    }

    const allDisplaced = [...displaced.values()].flat();
    const parserSuperseded = allDisplaced.filter((r) => r.disposition === 'superseded');
    const parserNeedsReview = allDisplaced.filter((r) => r.disposition === 'needs_review');
    const parserProtected = allDisplaced.filter((r) => r.disposition === 'protected');

    const parts = [`${result.rowsParsed} row(s) read.`];
    if (ready.length) parts.push(`${ready.length} ready to apply.`);
    if (duplicates.length) parts.push(`${duplicates.length} already imported.`);
    if (pending.length + result.ambiguous.length + result.unmatched.length > 0) {
      parts.push(`${pending.length + result.ambiguous.length + result.unmatched.length} need review.`);
    }
    if (wouldRetire.length) parts.push(`${wouldRetire.length} earlier row(s) would be replaced.`);
    if (protectedByUser.length) {
      parts.push(`${protectedByUser.length} row(s) you corrected stay as you set them.`);
    }
    if (parserSuperseded.length) {
      parts.push(
        `${parserSuperseded.length} item(s) this app read from the same issue would stop counting, ` +
          'so the newsletter is counted once.',
      );
    }
    if (parserNeedsReview.length) {
      parts.push(
        `${parserNeedsReview.length} item(s) this app read point the other way and would wait for your decision.`,
      );
    }
    if (parserProtected.length) {
      parts.push(`${parserProtected.length} item(s) you corrected stay exactly as you set them.`);
    }
    if (result.rejected.length) parts.push(`${result.rejected.length} line(s) could not be read.`);
    if (ready.length === 0 && wouldRetire.length === 0 && parserSuperseded.length === 0 && parserNeedsReview.length === 0) {
      parts.push('Nothing would change.');
    }

    return {
      messageId: message.messageId,
      protocolOk: true,
      error: null,
      rowsParsed: result.rowsParsed,
      ready,
      duplicates,
      pending,
      ambiguous: result.ambiguous,
      unmatched: result.unmatched,
      conflicts: result.conflicts,
      rejected: result.rejected,
      wouldRetire,
      protectedByUser,
      parserSuperseded,
      parserNeedsReview,
      tallyDelta: [...delta.entries()]
        .filter(([, net]) => net !== 0)
        .map(([playerId, net]) => ({
          playerId,
          playerName: index.get(playerId)?.fullName ?? playerId,
          net,
        }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
      detail: parts.join(' '),
    };
  }

  /**
   * Write what the preview described.
   *
   * Inserts are deduped on the row's own identity, so pasting the same block
   * twice inserts nothing the second time. A revised block retires the rows it
   * replaces — never the parser's, and never one the user has ruled on.
   */
  async applyAiTally(message: EmailMessage, pasted: string): Promise<AiTallyApplyOutcome> {
    const index = await this.players.buildIndex();
    const sources = await this.getSources();
    const source = qualifies(message, sources);
    const result = importAiTally(pasted, index, {
      sourceMessageId: message.messageId,
      sourceDate: message.receivedAt,
      sourceName: source?.label ?? message.from,
    });

    if (result.error) {
      return {
        messageId: message.messageId,
        inserted: 0,
        alreadyPresent: 0,
        identityReviews: 0,
        retired: 0,
        protectedByUser: 0,
        parserSuperseded: 0,
        parserNeedsReview: 0,
        playersTouched: 0,
        detail: result.error,
      };
    }

    const { inserted, skipped } = await this.evidence.insertProposed(result.evidence);
    const identityReviews = await this.messages.insertIdentityReviews(result.identityReviews);
    const { superseded, keptForUserOverride } = await this.evidence.supersedeStaleImports(
      message.messageId,
      result.evidence.map((e) => e.dedupeKey),
      'superseded-by-newer-tally-import',
      { ruleId: AI_TALLY_RULE_ID },
    );

    /*
     * The tally is now this newsletter's semantic reading, so the parser's
     * reading of the same players stops counting beside it. Nothing is deleted;
     * see `planParserDisplacement` for why the two directions differ.
     */
    const live = await this.evidence.listLiveBySourceMessage(message.messageId);
    const displaced = [...this.planParserDisplacement(live, result.evidence).values()].flat();
    const retireIds = displaced.filter((r) => r.disposition === 'superseded').map((r) => Number(r.id));
    const reviewIds = displaced.filter((r) => r.disposition === 'needs_review').map((r) => Number(r.id));

    const retiredParser = await this.evidence.setStatusForImport(
      retireIds,
      'ignored',
      'superseded-by-chatgpt-tally',
    );
    const reviewParser = await this.evidence.setStatusForImport(
      reviewIds,
      'pending',
      'contested-by-chatgpt-tally',
    );

    const seasonStart = await this.settings.get<string | null>(SETTING_KEYS.seasonStart, null);
    const touched = new Set([
      ...result.evidence.map((e) => e.playerId),
      ...superseded.map((e) => e.playerId),
      ...retiredParser.changed.map((e) => e.playerId),
      ...reviewParser.changed.map((e) => e.playerId),
    ]);
    for (const playerId of touched) {
      await this.evidence.refreshSignal(playerId, { seasonStart });
    }

    const parts = [`${inserted} item(s) applied.`];
    if (skipped) parts.push(`${skipped} were already imported.`);
    if (superseded.length) parts.push(`${superseded.length} earlier row(s) were replaced.`);
    if (retiredParser.changed.length) {
      parts.push(
        `${retiredParser.changed.length} item(s) this app read from the same issue stopped counting, ` +
          'so the newsletter is counted once.',
      );
    }
    if (reviewParser.changed.length) {
      parts.push(
        `${reviewParser.changed.length} item(s) this app read point the other way and are waiting for your decision.`,
      );
    }
    if (keptForUserOverride.length) {
      parts.push(`${keptForUserOverride.length} row(s) you corrected were left as you set them.`);
    }
    if (identityReviews) parts.push(`${identityReviews} name(s) are waiting in Review.`);

    return {
      messageId: message.messageId,
      inserted,
      alreadyPresent: skipped,
      identityReviews,
      retired: superseded.length,
      protectedByUser:
        keptForUserOverride.length +
        retiredParser.keptForUserOverride.length +
        reviewParser.keptForUserOverride.length,
      parserSuperseded: retiredParser.changed.length,
      parserNeedsReview: reviewParser.changed.length,
      playersTouched: touched.size,
      detail: parts.join(' '),
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
