/**
 * Two jobs, and the whole design is in the gap between them.
 *
 * **Taking delivery** — validate the sender, decode and repair the body, store
 * it, and mark it as awaiting a tally. That is `ingest`, and it writes no
 * evidence at all. An issue arriving creates work waiting for a person, not
 * fantasy opinions: judging what a paragraph of editorial analysis means for a
 * player's value is a semantic question, and the honest ways to answer it are a
 * paid model at runtime or somebody who reads it. This app has ruled out the
 * first, so the second is the only path a score reaches the ledger by.
 *
 * **Scoring it** — hand the cleaned article over in one tap, parse a strict
 * answer back, resolve the names against Sleeper, show exactly what would
 * change, and write it once. That is `chatSource`, `previewAiTally` and
 * `applyAiTally`, and it is the single authoritative scoring path in the app.
 *
 * Idempotent at three levels: a message already seen (by id or by content
 * fingerprint) is never handled twice, an application of one tally is claimed
 * durably before it runs, and every evidence insert is deduped on the row's own
 * identity. See `applyAiTally` for why all three are needed.
 */

import { effectiveEvidence } from '../../core/evidence/aggregate.ts';
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
  AI_TALLY_REINSTATED_NOTE,
  AI_TALLY_RULE_ID,
  AI_TALLY_SUPERSEDED_NOTE,
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
import { NewsletterRepo, type MessageRecord, type TallyState } from '../repos/newsletter.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';

/**
 * `no_players` is gone, and its absence is the point.
 *
 * It meant "read, understood, and it said nothing about anybody" — a verdict on
 * the football in an issue, reached by the app on arrival. Arrival no longer
 * reaches a verdict about anything: a qualifying newsletter is `processed`,
 * which now means received and stored, and whether it says anything about a
 * player is a question only the approved tally answers.
 */
export type IngestStatus = 'processed' | 'duplicate' | 'quarantined' | 'rejected' | 'error';

export interface IngestOutcome {
  messageId: string;
  status: IngestStatus;
  /**
   * Always zero for an inbound newsletter, and kept so callers that report it
   * keep compiling. Arrival writes no evidence; the approved tally does.
   */
  evidenceInserted: number;
  evidencePending: number;
  identityReviews: number;
  playersTouched: number;
  /** True when this issue is now waiting for its ChatGPT tally. */
  awaitingTally?: boolean;
  /** One plain-language sentence, safe to show in the UI as-is. */
  detail: string;
  coverage?: CoverageReport;
  result?: NewsletterProcessResult;
}

/**
 * Re-running the classifier over a stored newsletter is gone, and so are its
 * preview and its two endpoints.
 *
 * It was the last live path by which the sentence classifier could put a score
 * into a player's tally, and §8 of this lane allows exactly one: the approved
 * ChatGPT tally. The distinction that used to make reprocessing safe — it only
 * ever *added* what the rules now found — is precisely what made it unsafe
 * here, because what it added was automatic scoring evidence, filed against an
 * issue whose approved tally is the only reading that is supposed to count.
 *
 * The decoding repair it also carried is not lost, and did not need it: the
 * repair happens on the way *out* now. `chatSource` runs `recoverBody` over the
 * stored email every time it is copied, so an issue kept with an undecoded MIME
 * body still hands ChatGPT clean readable text — and since arrival writes no
 * evidence at all, there is no longer a ledger row derived from garbage for a
 * repair to have to retire.
 */

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
  /**
   * When this exact tally has already been applied to this newsletter.
   *
   * Not an error and not a refusal — the preview still describes the tally in
   * full. It is here so the screen can say "this was applied on the 20th" and
   * so the apply, when it is pressed anyway, is a recognised replay rather than
   * a write that finds nothing to do.
   */
  alreadyAppliedAt: string | null;
  rowsParsed: number;
  /** Rows ready to apply. */
  ready: AiTallyPreviewRow[];
  /**
   * Rows a later revision retired that this paste asks for again.
   *
   * Reported apart from `ready` because nothing is inserted for them — the row
   * is already in the ledger, and what changes is that it counts again. Apart
   * from `duplicates` too, because those are already counting and these are not.
   */
  reinstated: AiTallyPreviewRow[];
  /** Rows already in the ledger and counting; applying again changes nothing. */
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
  wouldRetire: { id: string; playerId: string; excerpt: string; polarity: string; magnitude: number }[];
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
  /** Rows a later revision had retired that this paste brought back. */
  reinstated: number;
  alreadyPresent: number;
  identityReviews: number;
  retired: number;
  protectedByUser: number;
  /** Parser rows retired because the tally now speaks for this newsletter. */
  parserSuperseded: number;
  /** Parser rows parked for a human because they point the other way. */
  parserNeedsReview: number;
  playersTouched: number;
  /**
   * True once this newsletter has an approved tally and stops asking for
   * attention. False only when the paste could not be read at all.
   */
  completed: boolean;
  /**
   * True when this exact tally had already been applied and this call wrote
   * nothing. Reported rather than hidden: "nothing was added" and "nothing was
   * added *again*" are different answers, and only one of them is a problem.
   */
  replayed: boolean;
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

    // --- store, and wait for a person ---------------------------------------
    /*
     * The whole point of this lane, in one block.
     *
     * A newsletter arriving used to be read by the sentence classifier and
     * written straight into the evidence ledger — "found news on 5 players, 2
     * applied automatically, 3 waiting for your review". That was the app
     * forming a fantasy opinion about editorial prose, which is the one
     * judgment it cannot make and has decided not to fake. So the issue is
     * received, repaired, stored and marked as awaiting its reviewed ChatGPT
     * tally, and **not one row reaches the ledger here**.
     *
     * `processNewsletter` still runs, and still writes nothing: what is kept
     * from it is the coverage report — the decoding repairs the body needed,
     * how much text came out of it, and which name-like spans the player
     * dictionary does not know. Those are diagnostics about *delivery*, they
     * are what Settings shows when an issue arrives unreadable, and none of
     * them is an opinion about a player. Its classifications are discarded.
     */
    try {
      const index = await this.players.buildIndex();
      const result = processNewsletter(message, index, {
        sourceName: source?.label ?? message.from,
      });

      // Only a body that was kept can be copied for ChatGPT, so only that can
      // be tallied. Anything else is stored and asks for nothing.
      const readable = (message.html ?? message.text ?? '').trim().length > 0;
      const detail = readable
        ? 'Received and stored. Score it with ChatGPT to move any player tallies.'
        : 'Received, but it arrived with no readable text, so there is nothing to score.';

      await this.log(message, fingerprint, {
        status: 'processed',
        sourceId: source?.id ?? 'manual',
        coverage: result.coverage as unknown as Record<string, unknown>,
        detail,
        tallyState: readable ? 'awaiting' : 'not_applicable',
      });

      return {
        messageId: message.messageId,
        status: 'processed',
        evidenceInserted: 0,
        evidencePending: 0,
        identityReviews: 0,
        playersTouched: 0,
        awaitingTally: readable,
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
    fields: Partial<MessageRecord> & { status: string; sourceId: string; tallyState?: TallyState },
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
      // Only a stored, readable newsletter can be worked on. Everything else —
      // quarantined, oversized, unreadable — is recorded and asks for nothing.
      tallyState: fields.tallyState ?? 'not_applicable',
      talliedAt: null,
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

  // ------------------------------------------------------- ChatGPT tally ---

  /**
   * The newsletter the workflow is about right now, and how many are behind it.
   *
   * One at a time, oldest first — see `NewsletterRepo.nextAwaitingTally`. Setup
   * uses this to decide whether to show the two workflow controls at all, and
   * which issue they act on, so the reader never has to pick a newsletter when
   * there is only one thing to do.
   */
  async pendingTally(): Promise<{
    messageId: string;
    subject: string;
    receivedAt: string;
    /** Including this one. */
    waiting: number;
  } | null> {
    const next = await this.messages.nextAwaitingTally();
    if (!next) return null;
    return {
      messageId: next.messageId,
      subject: next.subject,
      receivedAt: next.receivedAt,
      waiting: await this.messages.awaitingTallyCount(),
    };
  }

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
   * Decide what an approved tally does to the classifier's own rows.
   *
   * The approved tally is the newsletter's reading. Not its reading of the
   * players it happens to name — its reading of the *issue*, whole. A player
   * the tally omits was omitted on purpose: the tally protocol says so
   * explicitly, "omit players whose meaningful signals roughly cancel". So the
   * classifier's rows for that newsletter stop counting, whether or not the
   * tally scores the same player.
   *
   * That scope is the correction. It used to displace only the players the
   * tally named, which left the rest of the classifier's automatic reading of
   * the same issue stacked underneath the approved one — the exact double-count
   * this lane exists to close.
   *
   * Nothing is deleted: the classifier's finding, its rule and its excerpt stay
   * in the ledger for audit, they simply stop contributing.
   *
   * Three dispositions, and the split is by what a person has already said:
   *
   *   `protected` — the user ruled on this row. Nothing an import does may
   *     touch that, and it keeps counting exactly as they left it.
   *   `needs_review` — the tally scores this player the *other* way. Whether
   *     the two were ever the same claim is a genuine question, so the row
   *     stops counting and waits for a person rather than being counted or
   *     discarded by default.
   *   `superseded` — everything else. Retired, because the issue has been read.
   *
   * Shared by preview and apply so the two cannot describe different outcomes.
   */
  private async planParserDisplacement(
    live: EvidenceItem[],
    proposed: ProposedEvidence[],
  ): Promise<Map<string, ParserRowDisposition[]>> {
    const byPlayer = new Map<string, ParserRowDisposition[]>();
    const scored = new Map<string, ProposedEvidence>();
    for (const item of proposed) scored.set(item.playerId, item);

    /*
     * Who has been ruled on, asked of the ledger's own decision record.
     *
     * Not read off `review_status`: `accepted` is a status an import is also
     * allowed to write — the identity-repair path writes it for every row it
     * recovers, because the user confirmed *who* somebody is rather than what
     * the news said about them. `user_reviews` is written by a person pressing
     * a button in Review and by nothing else.
     */
    const ruled = await this.evidence.idsWithUserDecision(live.map((row) => Number(row.id)));

    for (const row of live) {
      if (row.ruleId === AI_TALLY_RULE_ID) continue;
      const mine = scored.get(row.playerId);
      const disposition: ParserRowDisposition['disposition'] =
        row.userOverride != null || ruled.has(Number(row.id))
          ? 'protected'
          : mine && row.polarity !== mine.polarity
            ? 'needs_review'
            : 'superseded';
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
        alreadyAppliedAt: null,
        rowsParsed: 0,
        ready: [],
        reinstated: [],
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

    /*
     * Applied *and still standing*.
     *
     * A tally that was applied and then corrected by a later one is on the
     * record but is no longer what this newsletter says, so pasting it again is
     * a revision back to it — a real change, previewed as one. Only the tally
     * currently standing makes a repeat inert.
     */
    const previous = result.payloadFingerprint
      ? await this.messages.findTallyApplication(message.messageId, result.payloadFingerprint)
      : null;
    const applied = previous?.standing && previous.completed ? previous : null;

    const keys = result.evidence.map((e) => e.dedupeKey);
    const stored = await this.evidence.listByDedupeKeys(keys);
    const live = await this.evidence.listLiveBySourceMessage(message.messageId);
    // Rows an earlier revision of this tally retired, that this one asks for again.
    const retiredEarlier = await this.evidence.listRetiredImports(keys, AI_TALLY_SUPERSEDED_NOTE);
    // What the parser found for these same players, and what happens to it.
    const displaced = await this.planParserDisplacement(live, result.evidence);

    const ready: AiTallyPreviewRow[] = [];
    const duplicates: AiTallyPreviewRow[] = [];
    const pending: AiTallyPreviewRow[] = [];
    const reinstated: AiTallyPreviewRow[] = [];

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
      if (row.contested) pending.push(row);
      // Present but retired by a later revision, and asked for again: it comes
      // back rather than being reported as already imported while counting
      // nothing.
      else if (retiredEarlier.has(item.dedupeKey)) reinstated.push(row);
      else if (already) duplicates.push(row);
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
        id: row.id,
        playerId: row.playerId,
        excerpt: row.excerpt,
        polarity: row.polarity,
        magnitude: row.magnitude,
      }));
    const protectedByUser = priorImports
      .filter((row) => row.userOverride)
      .map((row) => ({ playerId: row.playerId, excerpt: row.excerpt }));

    /*
     * What the tally actually moves: new rows in, rows an earlier revision
     * retired back in, replaced rows out, and the parser's own rows for these
     * players out too.
     *
     * Counting only the arrivals would advertise a number the ledger will not
     * show, because applying this also stops the parser's reading of the same
     * player from contributing.
     *
     * What leaves is measured by what the row contributes today, not by its
     * polarity and magnitude. Those two are the same number only for a row that
     * is currently counted, and plenty of the rows here are not: a score held
     * back as contested, or a parser row a previous paste already parked,
     * contributes nothing, so retiring it moves nothing. `effectiveEvidence` is
     * the ledger's own answer to that question — asking it is what keeps the
     * promise the preview makes equal to the move the tally makes.
     */
    const delta = new Map<string, number>();
    const bump = (playerId: string, by: number) => delta.set(playerId, (delta.get(playerId) ?? 0) + by);
    const contributes = new Map<string, number>();
    for (const row of live) contributes.set(row.id, effectiveEvidence(row).delta);
    for (const row of ready) bump(row.playerId, row.score);
    for (const row of reinstated) bump(row.playerId, row.score);
    for (const row of priorImports) {
      if (row.userOverride) continue;
      bump(row.playerId, -(contributes.get(row.id) ?? 0));
    }
    for (const [playerId, rows] of displaced) {
      for (const row of rows) {
        if (row.disposition === 'protected') continue;
        bump(playerId, -(contributes.get(row.id) ?? 0));
      }
    }

    const allDisplaced = [...displaced.values()].flat();
    const parserSuperseded = allDisplaced.filter((r) => r.disposition === 'superseded');
    const parserNeedsReview = allDisplaced.filter((r) => r.disposition === 'needs_review');
    const parserProtected = allDisplaced.filter((r) => r.disposition === 'protected');

    const parts = [`${result.rowsParsed} row(s) read.`];
    if (ready.length) parts.push(`${ready.length} ready to apply.`);
    if (reinstated.length) {
      parts.push(`${reinstated.length} row(s) a later paste had retired would count again.`);
    }
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
    if (
      ready.length === 0 &&
      reinstated.length === 0 &&
      wouldRetire.length === 0 &&
      parserSuperseded.length === 0 &&
      parserNeedsReview.length === 0
    ) {
      parts.push('Nothing would change.');
    }
    if (applied) {
      parts.push(`This exact tally was already applied on ${applied.appliedAt.slice(0, 10)}; applying it again does nothing.`);
    }

    return {
      messageId: message.messageId,
      protocolOk: true,
      error: null,
      alreadyAppliedAt: applied?.appliedAt ?? null,
      rowsParsed: result.rowsParsed,
      ready,
      reinstated,
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
   * Write what the preview described, exactly once.
   *
   * Three independent guards, because this is the one operation whose failure
   * mode is a player's score silently doubling:
   *
   *   1. **The claim.** `claimTallyApplication` inserts one row for
   *      (this newsletter, this tally) and returns whether it won. The insert
   *      *is* the decision, so two requests racing on a double tap cannot both
   *      conclude they are first — the loser writes nothing and answers with
   *      what the winner did. A reload, a retry after a timeout, and a repeated
   *      paste all land here.
   *   2. **The row keys.** Every insert is deduped on the row's own identity, so
   *      even a revised tally that repeats a row adds nothing for it.
   *   3. **The displacement.** Applying makes the tally this issue's reading, so
   *      the classifier's rows for the same issue stop counting rather than
   *      stacking underneath — never one the user has ruled on.
   *
   * Nothing here relies on a disabled button or on anything the client
   * remembers.
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

    const nothing = (detail: string, over: Partial<AiTallyApplyOutcome> = {}): AiTallyApplyOutcome => ({
      messageId: message.messageId,
      inserted: 0,
      reinstated: 0,
      alreadyPresent: 0,
      identityReviews: 0,
      retired: 0,
      protectedByUser: 0,
      parserSuperseded: 0,
      parserNeedsReview: 0,
      playersTouched: 0,
      completed: false,
      replayed: false,
      detail,
      ...over,
    });

    // An unreadable paste is not a tally: it completes nothing and is not
    // recorded as an application, so the newsletter stays where it was.
    if (result.error || !result.payloadFingerprint) return nothing(result.error ?? 'That paste could not be read.');

    const now = nowIso();
    const won = await this.messages.claimTallyApplication(message.messageId, result.payloadFingerprint, now);
    if (!won) {
      const previous = await this.messages.findTallyApplication(message.messageId, result.payloadFingerprint);
      return nothing(
        `This tally was already applied on ${(previous?.appliedAt ?? now).slice(0, 10)}. ` +
          'Nothing was added a second time.',
        { completed: true, replayed: true },
      );
    }

    const { inserted, skipped } = await this.evidence.insertProposed(result.evidence);
    const identityReviews = await this.messages.insertIdentityReviews(result.identityReviews);

    /*
     * A row this tally asks for may already exist and be retired, because an
     * earlier revision replaced it and a later one has brought it back. The
     * insert above did nothing for it — the key was taken — so without this it
     * would be reported as already present while contributing nothing.
     */
    const reinstated = await this.evidence.reinstateRetiredImports(
      result.evidence.filter((e) => e.reviewStatus === 'auto_applied').map((e) => e.dedupeKey),
      AI_TALLY_SUPERSEDED_NOTE,
      AI_TALLY_REINSTATED_NOTE,
    );

    const { superseded, keptForUserOverride } = await this.evidence.supersedeStaleImports(
      message.messageId,
      result.evidence.map((e) => e.dedupeKey),
      AI_TALLY_SUPERSEDED_NOTE,
      { ruleId: AI_TALLY_RULE_ID },
    );

    /*
     * The tally is now this newsletter's semantic reading, so the parser's
     * reading of the same players stops counting beside it. Nothing is deleted;
     * see `planParserDisplacement` for why the two directions differ.
     */
    const live = await this.evidence.listLiveBySourceMessage(message.messageId);
    const displaced = [...(await this.planParserDisplacement(live, result.evidence)).values()].flat();
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
      ...reinstated.map((e) => e.playerId),
      ...superseded.map((e) => e.playerId),
      ...retiredParser.changed.map((e) => e.playerId),
      ...reviewParser.changed.map((e) => e.playerId),
    ]);
    for (const playerId of touched) {
      await this.evidence.refreshSignal(playerId, { seasonStart });
    }

    // A reinstated row was "already present" to the insert, and did change. It
    // is reported as its own outcome so the two are not conflated.
    const alreadyPresent = Math.max(0, skipped - reinstated.length);
    const parts = [`${inserted} item(s) applied.`];
    if (reinstated.length) {
      parts.push(`${reinstated.length} row(s) a later paste had retired count again.`);
    }
    if (alreadyPresent) parts.push(`${alreadyPresent} were already imported.`);
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

    /*
     * The issue is done, and that is a decision about the workflow rather than
     * about how much moved.
     *
     * An approved tally with no rows in it — "nothing in this issue was worth
     * scoring" — is a real answer, and the commonest one for a quiet week. If
     * completion depended on something changing, that answer would leave the
     * newsletter asking for attention it can never be given, for ever. What
     * completes it is that a person read the preview and approved it.
     */
    await this.messages.markTallied(message.messageId, now);

    const outcome = {
      messageId: message.messageId,
      inserted,
      reinstated: reinstated.length,
      alreadyPresent,
      identityReviews,
      retired: superseded.length,
      protectedByUser:
        keptForUserOverride.length +
        retiredParser.keptForUserOverride.length +
        reviewParser.keptForUserOverride.length,
      parserSuperseded: retiredParser.changed.length,
      parserNeedsReview: reviewParser.changed.length,
      playersTouched: touched.size,
      completed: true,
      replayed: false,
      detail: parts.join(' '),
    };

    // Kept so a replay can answer with what this run actually did, rather than
    // with a truthful but useless report that nothing happened.
    await this.messages.recordTallyOutcome(message.messageId, result.payloadFingerprint, { ...outcome });
    return outcome;
  }
}
