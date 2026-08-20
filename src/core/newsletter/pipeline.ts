/**
 * Newsletter ingestion pipeline (pure).
 *
 * email message -> sanitize -> de-boilerplate -> segment -> detect players ->
 * capture evidence window -> classify -> dedupe -> proposed evidence items.
 *
 * This function performs NO I/O. Persistence, review routing and tally updates
 * are the caller's job (see src/server/services/newsletter.ts), which keeps the
 * whole pipeline trivially testable from fixtures.
 */

import { PlayerIndex } from '../identity/index.ts';
import { classifySentence, canAutoApply, type Classification } from './classify.ts';
import { contentFingerprint, evidenceKey } from './fingerprint.ts';
import { extractBlocks, splitSentences } from './html.ts';
import { collectUnresolvedNames, detectMentions, type PlayerMention } from './mentions.ts';
import { recoverBody } from './mime.ts';
import type { ClassificationRule } from './rules.ts';

/** A newsletter email as delivered by any ingestion source. */
export interface EmailMessage {
  /** Stable provider message id (Gmail message id, inbound-email id, ...). */
  messageId: string;
  from: string;
  subject: string;
  /** ISO-8601 date the newsletter was sent. */
  receivedAt: string;
  /**
   * The SMTP envelope sender, when it differs from `from`.
   *
   * Bulk senders use a per-message bounce address here, so it is recorded but
   * never the primary thing a subscription is matched against.
   */
  envelopeFrom?: string | null;
  html?: string | null;
  text?: string | null;
  /** Optional provider-specific labels/headers used for qualification. */
  headers?: Record<string, string>;
}

export interface ProposedEvidence {
  dedupeKey: string;
  playerId: string;
  playerName: string;
  sourceType: 'newsletter';
  sourceName: string;
  sourceMessageId: string;
  sourceDate: string;
  excerpt: string;
  contextSummary: string | null;
  category: string | null;
  polarity: Classification['polarity'];
  magnitude: number;
  confidence: Classification['confidence'];
  confidenceScore: number;
  ruleId: string | null;
  /**
   * `auto_applied` when it may bypass review, `pending` when it may not, and
   * `accepted` when the user attached it themselves.
   */
  reviewStatus: 'auto_applied' | 'pending' | 'accepted';
  /** Machine-readable reasons the item landed in review. */
  notes: string[];
  blockIndex: number;
}

/** A mention we could not resolve to exactly one player. */
export interface IdentityReviewItem {
  sourceMessageId: string;
  sourceDate: string;
  excerpt: string;
  matchedText: string;
  reason: string;
  candidates: { playerId: string; name: string; team: string; position: string; detail: string }[];
  /** The classification the sentence would have received. */
  proposedPolarity: Classification['polarity'];
  proposedCategory: string | null;
  /**
   * The magnitude the item would have carried had the name resolved.
   *
   * Kept so that confirming who somebody is recreates the evidence the app
   * would have written anyway, rather than a flattened ±1 stand-in. For a
   * newsletter sentence that is the rule's own magnitude; for an imported tally
   * row it is the row's net score.
   */
  proposedMagnitude: number;
}

/**
 * Parser coverage for one newsletter.
 *
 * This is a quality signal, NOT an error report: a sentence that mentions a
 * player but matches no rule is usually just neutral prose. Tracking it makes
 * gaps in the rule dictionary and the player dictionary visible so they can be
 * closed by hand — no LLM required.
 */
export interface CoverageReport {
  /** Every sentence the extractor produced, whether or not it named a player. */
  sentences: number;
  /**
   * Decoding repairs that had to be applied to read this email at all.
   *
   * Empty is the healthy state. A non-empty list means the body as stored was
   * not readable text — undecoded MIME, quoted-printable or mojibake — and says
   * which. It is surfaced in Settings so the next decoding regression is a
   * visible line rather than an unexplained collapse in matched rules.
   */
  repairs: string[];
  /** Sentences containing at least one recognised player. */
  sentencesWithPlayers: number;
  /** ...of those, how many produced a classification. */
  classifiedSentences: number;
  /** ...of those, how many matched no rule at all. */
  unclassifiedSentences: number;
  /** Sentences whose player could not be pinned down. */
  ambiguousIdentitySentences: number;
  /** Examples of unclassified sentences, for rule-writing. Capped. */
  samples: { excerpt: string; players: string[] }[];
  /** Name-like spans that matched no player in the dictionary. Capped. */
  unknownNames: string[];
}

export interface NewsletterProcessResult {
  messageId: string;
  fingerprint: string;
  sourceName: string;
  sourceDate: string;
  blocks: number;
  evidence: ProposedEvidence[];
  identityReview: IdentityReviewItem[];
  coverage: CoverageReport;
  stats: {
    mentions: number;
    resolved: number;
    unresolved: number;
    autoApplied: number;
    pendingReview: number;
    neutralDropped: number;
    duplicatesWithinEmail: number;
  };
}

export interface ProcessOptions {
  rules?: ClassificationRule[];
  /** Max excerpt length persisted. */
  maxExcerpt?: number;
  /** Source label stored on every evidence row. */
  sourceName?: string;
  /** Max unclassified-sentence samples kept in the coverage report. */
  maxSamples?: number;
}

/**
 * Qualification: does this message look like the FF newsletter we ingest?
 *
 * Configured per-deployment rather than hardcoded, so a change of newsletter
 * provider is a config edit, not a code change.
 */
export interface NewsletterSourceConfig {
  id: string;
  label: string;
  /** Lower-cased sender addresses or domains that qualify. */
  fromPatterns: string[];
  /** Optional subject regex sources; any match qualifies. */
  subjectPatterns?: string[];
  enabled?: boolean;
}

/**
 * Does one sender address satisfy one configured pattern?
 *
 * A pattern written as a domain (`@substack.com`) covers that domain's
 * subdomains too. Bulk senders deliver from sending shards — Substack's
 * envelope is `...@mg-d0.substack.com` — so a plain substring test would reject
 * the very mail the user meant to accept, while `@substack.com` looks like it
 * should obviously match.
 *
 * The dot is required: `@substack.com` must not match `@notsubstack.com`.
 */
/**
 * `*` accepts any sender.
 *
 * The inbound address is dedicated to one newsletter and is never published, so
 * "whatever arrives here is the newsletter" is both true and the safest rule.
 * Sender matching is fragile in ways that lose mail silently: Substack sends
 * from per-subscriber VERP envelopes like
 * `bounce+93e88f...=juncaj.net@mg-d0.substack.com`, and the visible From: is
 * often a writer's own domain rather than the platform's. Missing a newsletter
 * costs a week of evidence; accepting a stray email costs nothing, because a
 * message with no player news simply produces none.
 */
export const ACCEPT_ANY_SENDER = '*';

export function senderMatches(from: string, pattern: string): boolean {
  if (pattern === ACCEPT_ANY_SENDER) return true;
  if (!from || !pattern) return false;
  if (!pattern.startsWith('@')) return from.includes(pattern);

  const domain = from.slice(from.lastIndexOf('@') + 1);
  const wanted = pattern.slice(1);
  return domain === wanted || domain.endsWith(`.${wanted}`);
}

export function qualifies(
  message: EmailMessage,
  sources: NewsletterSourceConfig[],
): NewsletterSourceConfig | null {
  // Either address may carry the subscription: the visible From: is the stable
  // one, but a user who copied the envelope sender out of the log should not be
  // punished for it.
  const candidates = [message.from, message.envelopeFrom]
    .map((a) => (a ?? '').toLowerCase())
    .filter(Boolean);
  const subject = message.subject ?? '';
  for (const source of sources) {
    if (source.enabled === false) continue;
    // The wildcard does not need a sender to compare against, so it is checked
    // before the candidate list — mail with no readable From: still qualifies.
    const fromOk =
      source.fromPatterns.includes(ACCEPT_ANY_SENDER) ||
      source.fromPatterns.some((p) => candidates.some((from) => senderMatches(from, p.toLowerCase())));
    if (!fromOk) continue;
    const patterns = source.subjectPatterns ?? [];
    if (patterns.length === 0) return source;
    if (patterns.some((p) => new RegExp(p, 'i').test(subject))) return source;
  }
  return null;
}

/**
 * Process one newsletter into proposed evidence items.
 * Deterministic: the same message always yields the same dedupe keys.
 */
export function processNewsletter(
  message: EmailMessage,
  index: PlayerIndex,
  opts: ProcessOptions = {},
): NewsletterProcessResult {
  const maxExcerpt = opts.maxExcerpt ?? 400;
  const sourceName = opts.sourceName ?? message.from ?? 'newsletter';

  /*
   * Repair before reading.
   *
   * A newsletter already sitting in the message log may have been stored with a
   * raw MIME blob for a body — that is what the folded-header bug produced —
   * and reprocessing reads what was stored, not what arrived. Running the
   * recovery here means re-running the rules over that stored message repairs
   * it, with no migration and no re-delivery, and the message keeps its
   * identity. On a body that was decoded correctly every check declines and the
   * text is returned untouched, which is what makes it safe unconditionally.
   */
  const recovered = recoverBody({ html: message.html, text: message.text });
  const body = recovered.html ?? recovered.text ?? '';
  // Auto-detect when the HTML part is absent: a plain-text part that is really
  // HTML should still have its markup stripped rather than read as prose.
  const blocks = extractBlocks(body, { isHtml: recovered.html != null ? true : undefined });

  const evidence: ProposedEvidence[] = [];
  const identityReview: IdentityReviewItem[] = [];
  const seenKeys = new Set<string>();
  const documentPlayerIds = new Set<string>();

  let mentionCount = 0;
  let resolved = 0;
  let unresolved = 0;
  let neutralDropped = 0;
  let duplicates = 0;

  const maxSamples = opts.maxSamples ?? 8;
  const coverage: CoverageReport = {
    sentences: 0,
    repairs: recovered.repairs,
    sentencesWithPlayers: 0,
    classifiedSentences: 0,
    unclassifiedSentences: 0,
    ambiguousIdentitySentences: 0,
    samples: [],
    unknownNames: [],
  };
  const unknownNames = new Set<string>();

  for (const block of blocks) {
    for (const sentence of splitSentences(block.text)) {
      coverage.sentences++;
      const mentions = detectMentions(sentence, index, { documentPlayerIds });

      // Coverage only: name-like spans the dictionary does not know.
      for (const name of collectUnresolvedNames(sentence, index, mentions)) {
        unknownNames.add(name);
      }

      if (mentions.length === 0) continue;
      mentionCount += mentions.length;

      const resolvedMentions = mentions.filter((m) => m.playerId);
      for (const m of resolvedMentions) documentPlayerIds.add(m.playerId!);

      const distinctPlayers = new Set(resolvedMentions.map((m) => m.playerId!)).size;
      const ambiguousMentions = mentions.filter((m) => m.match.status === 'ambiguous');

      const classification = classifySentence(sentence, {
        rules: opts.rules,
        playersInSentence: Math.max(distinctPlayers, mentions.length),
        identityAmbiguous: ambiguousMentions.length > 0,
      });

      if (resolvedMentions.length > 0) coverage.sentencesWithPlayers++;
      if (ambiguousMentions.length > 0) coverage.ambiguousIdentitySentences++;

      // Neutral sentences carry no signal: nothing to store.
      if (classification.polarity === 'neutral') {
        if (resolvedMentions.length > 0) {
          coverage.unclassifiedSentences++;
          if (coverage.samples.length < maxSamples) {
            coverage.samples.push({
              excerpt: truncate(sentence, 200),
              players: resolvedMentions.map((m) => index.get(m.playerId!)?.fullName ?? m.matchedText),
            });
          }
        }
        neutralDropped += resolvedMentions.length;
        unresolved += ambiguousMentions.length;
        continue;
      }

      if (resolvedMentions.length > 0) coverage.classifiedSentences++;

      // Ambiguous identity + a real signal => identity review item.
      for (const m of ambiguousMentions) {
        unresolved++;
        identityReview.push({
          sourceMessageId: message.messageId,
          sourceDate: message.receivedAt,
          excerpt: truncate(sentence, maxExcerpt),
          matchedText: m.matchedText,
          reason: m.match.reason,
          candidates: m.match.candidates.map((c) => ({
            playerId: c.playerId,
            name: c.player.fullName,
            team: c.player.team,
            position: c.player.position,
            detail: c.detail,
          })),
          proposedPolarity: classification.polarity,
          proposedCategory: classification.category,
          // The sentence's own magnitude, unchanged: resolving the name later
          // should produce the item this sentence would have produced all along.
          proposedMagnitude: classification.magnitude,
        });
      }

      for (const mention of dedupeMentions(resolvedMentions)) {
        resolved++;
        const playerId = mention.playerId!;
        const player = index.get(playerId);
        const key = evidenceKey({
          sourceMessageId: message.messageId,
          playerId,
          excerpt: sentence,
          ruleId: classification.ruleId,
        });
        if (seenKeys.has(key)) {
          duplicates++;
          continue;
        }
        seenKeys.add(key);

        // Surname-only mentions never auto-apply.
        const autoApply = canAutoApply(classification) && !mention.surnameOnly;
        const notes = [...classification.notes];
        if (mention.surnameOnly && classification.confidence === 'high') {
          notes.push('surname-only mention requires confirmation');
        }

        evidence.push({
          dedupeKey: key,
          playerId,
          playerName: player?.fullName ?? mention.matchedText,
          sourceType: 'newsletter',
          sourceName,
          sourceMessageId: message.messageId,
          sourceDate: message.receivedAt,
          excerpt: truncate(sentence, maxExcerpt),
          contextSummary: classification.contextSummary ?? truncate(sentence, 140),
          category: classification.category,
          polarity: classification.polarity,
          magnitude: classification.magnitude,
          confidence: classification.confidence,
          confidenceScore: classification.confidenceScore,
          ruleId: classification.ruleId,
          reviewStatus: autoApply ? 'auto_applied' : 'pending',
          notes,
          blockIndex: block.index,
        });
      }
    }
  }

  coverage.unknownNames = [...unknownNames].slice(0, 25);

  return {
    messageId: message.messageId,
    fingerprint: contentFingerprint(body),
    sourceName,
    sourceDate: message.receivedAt,
    blocks: blocks.length,
    evidence,
    identityReview,
    coverage,
    stats: {
      mentions: mentionCount,
      resolved,
      unresolved,
      autoApplied: evidence.filter((e) => e.reviewStatus === 'auto_applied').length,
      pendingReview: evidence.filter((e) => e.reviewStatus === 'pending').length,
      neutralDropped,
      duplicatesWithinEmail: duplicates,
    },
  };
}

/** Collapse repeated mentions of the same player inside one sentence. */
function dedupeMentions(mentions: PlayerMention[]): PlayerMention[] {
  const byPlayer = new Map<string, PlayerMention>();
  for (const m of mentions) {
    if (!m.playerId) continue;
    const existing = byPlayer.get(m.playerId);
    // Prefer the full-name mention over a surname-only one.
    if (!existing || (existing.surnameOnly && !m.surnameOnly)) byPlayer.set(m.playerId, m);
  }
  return [...byPlayer.values()];
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
