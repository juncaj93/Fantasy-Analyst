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
import { detectMentions, type PlayerMention } from './mentions.ts';
import type { ClassificationRule } from './rules.ts';

/** A newsletter email as delivered by any ingestion source. */
export interface EmailMessage {
  /** Stable provider message id (Gmail message id, inbound-email id, ...). */
  messageId: string;
  from: string;
  subject: string;
  /** ISO-8601 date the newsletter was sent. */
  receivedAt: string;
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
  /** `auto_applied` when it may bypass review, otherwise `pending`. */
  reviewStatus: 'auto_applied' | 'pending';
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
}

export interface NewsletterProcessResult {
  messageId: string;
  fingerprint: string;
  sourceName: string;
  sourceDate: string;
  blocks: number;
  evidence: ProposedEvidence[];
  identityReview: IdentityReviewItem[];
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

export function qualifies(
  message: EmailMessage,
  sources: NewsletterSourceConfig[],
): NewsletterSourceConfig | null {
  const from = (message.from ?? '').toLowerCase();
  const subject = message.subject ?? '';
  for (const source of sources) {
    if (source.enabled === false) continue;
    const fromOk = source.fromPatterns.some((p) => from.includes(p.toLowerCase()));
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
  const body = message.html ?? message.text ?? '';
  const blocks = extractBlocks(body, { isHtml: message.html != null });

  const evidence: ProposedEvidence[] = [];
  const identityReview: IdentityReviewItem[] = [];
  const seenKeys = new Set<string>();
  const documentPlayerIds = new Set<string>();

  let mentionCount = 0;
  let resolved = 0;
  let unresolved = 0;
  let neutralDropped = 0;
  let duplicates = 0;

  for (const block of blocks) {
    for (const sentence of splitSentences(block.text)) {
      const mentions = detectMentions(sentence, index, { documentPlayerIds });
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

      // Neutral sentences carry no signal: nothing to store.
      if (classification.polarity === 'neutral') {
        neutralDropped += resolvedMentions.length;
        unresolved += ambiguousMentions.length;
        continue;
      }

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

  return {
    messageId: message.messageId,
    fingerprint: contentFingerprint(body),
    sourceName,
    sourceDate: message.receivedAt,
    blocks: blocks.length,
    evidence,
    identityReview,
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
