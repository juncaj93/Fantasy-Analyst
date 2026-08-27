/**
 * The weekly ChatGPT tally import.
 *
 * The deterministic parser reads a newsletter and finds the sentences that
 * announce something — a start, a demotion, a missed practice. What it cannot
 * do, and should not be taught to do, is read editorial analysis and judge what
 * it means for a player's value. That is a semantic question, and the honest
 * ways to answer it are a paid model at runtime or a person. This app has ruled
 * out the first and the second does not scale to a weekly newsletter.
 *
 * So the judgment moves out of the app and into a recurring conversation the
 * user already has, and the app keeps every part of the job it can do
 * deterministically: receive the mail, repair and clean the text, hand it over
 * in one tap, parse a strict answer back, resolve the names against Sleeper,
 * show exactly what would change, and write it to the ledger once.
 *
 * What this module is NOT: a second classifier. It parses no prose and applies
 * no rules. Each row is a score somebody else decided, carried across verbatim
 * and labelled so it stays distinguishable from anything the parser produced —
 * and reversible in Review like any other item.
 *
 * The same honesty rules as the backfill importer apply, for the same reasons:
 * a score is carried at the magnitude it was written, a name that does not
 * resolve is never guessed at, and a player scored twice in one block is a
 * contradiction rather than something to settle by preferring one.
 */

import { resolvePlayer, type PlayerIndex } from '../identity/index.ts';
import { canonicalText, stableHash } from './fingerprint.ts';
import type { TextBlock } from './html.ts';
import type { IdentityReviewItem, ProposedEvidence } from './pipeline.ts';
import type { Polarity } from './rules.ts';

/** The envelope the app hands to ChatGPT. */
export const SOURCE_PROTOCOL = 'NEWSLETTER_SOURCE_V1';
const SOURCE_END = 'END_NEWSLETTER_SOURCE';

/** The answer protocol the app accepts back. */
export const TALLY_PROTOCOL = 'NEWSLETTER_TALLY_V1';
const TALLY_END = 'END_NEWSLETTER_TALLY';

/**
 * Everything imported this way carries this rule id.
 *
 * `rule_id` is already how the ledger distinguishes where an item came from —
 * the backfill importer writes `tally-backfill` — so provenance needs no new
 * column and no migration, and every existing query that groups by origin keeps
 * working.
 */
export const AI_TALLY_RULE_ID = 'ai-tally-import';

/** Recorded on every row so a later protocol change is visible in the ledger. */
export const AI_TALLY_PROVENANCE = 'manual_chatgpt_import';

/**
 * Notes the replacement rules write, and read back.
 *
 * A revised paste retires the rows it replaces, and a later paste that asks for
 * one of them again has to be able to tell "an import retired this" from "a
 * person did". The note is how, so it is named once and shared rather than
 * spelled out at each site — a typo in one of them would silently turn
 * reinstatement off.
 */
export const AI_TALLY_SUPERSEDED_NOTE = 'superseded-by-newer-tally-import';
export const AI_TALLY_REINSTATED_NOTE = 'reinstated-by-later-tally-import';

/**
 * The only scores the protocol accepts.
 *
 * Bounded on purpose. An open range invites a scale nobody agreed on, and the
 * ledger's magnitudes mean something: ±1 is news, ±2 is news that changes how
 * you would draft. Zero is excluded because a neutral row contributes nothing —
 * importing it would be importing nothing while looking like a decision.
 */
export const ALLOWED_SCORES = [2, 1, -1, -2] as const;
export type AllowedScore = (typeof ALLOWED_SCORES)[number];

export interface AiTallyRow {
  name: string;
  score: AllowedScore;
  reason: string;
  lineNumber: number;
}

/** A line inside the block that could not be read as a row. */
export interface RejectedLine {
  line: string;
  lineNumber: number;
  why: string;
}

export interface AiTallyParse {
  /** False when the markers are missing entirely — nothing was pasted. */
  recognised: boolean;
  rows: AiTallyRow[];
  rejected: RejectedLine[];
  /** Set when the paste could not be read at all. */
  error: string | null;
}

// ------------------------------------------------------------------ source ---

/**
 * Render the cleaned newsletter as the block ChatGPT is given.
 *
 * Built from the same extracted blocks the parser reads, so the text handed
 * over has already been through MIME repair, charset decoding, HTML stripping,
 * tracking-URL removal and boilerplate exclusion. Headings and bullets survive
 * because they carry the meaning of the rows beneath them — a leaderboard row
 * reads `Romeo Doubs - 0.216`, and only the heading above it says whether that
 * is a good number.
 */
export function buildNewsletterSource(input: {
  subject: string;
  receivedAt: string;
  messageId: string;
  blocks: TextBlock[];
}): string {
  const body = input.blocks
    .map((b) => (b.kind === 'list_item' ? `- ${b.text}` : b.text))
    .join('\n');
  return [
    SOURCE_PROTOCOL,
    `Subject: ${input.subject}`,
    `Received: ${input.receivedAt}`,
    `Message-ID: ${input.messageId}`,
    '',
    body,
    SOURCE_END,
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ parsing --

/**
 * Read a pasted answer.
 *
 * Tolerant about what surrounds the block and strict about what is inside it.
 * A chat reply routinely arrives wrapped in explanation or a code fence, and
 * refusing the whole paste over that would be refusing the user's actual work;
 * a row whose score is not one of the four allowed values is a different
 * matter, because guessing what `+3` was meant to mean is exactly the judgment
 * this module exists not to make.
 *
 * A malformed row is reported rather than dropped. Silently ignoring a line
 * would mean a player the user believes they imported is simply absent, which
 * is the failure mode hardest to notice.
 */
export function parseAiTally(text: string): AiTallyParse {
  const empty: AiTallyParse = { recognised: false, rows: [], rejected: [], error: null };
  if (!text || !text.trim()) {
    return { ...empty, error: 'Nothing was pasted.' };
  }

  const lines = text.split(/\r?\n/);
  const startAt = lines.findIndex((l) => l.trim().toUpperCase().startsWith(TALLY_PROTOCOL));
  if (startAt === -1) {
    return {
      ...empty,
      error: `That does not look like a tally. It should begin with ${TALLY_PROTOCOL}.`,
    };
  }
  const endRelative = lines.slice(startAt + 1).findIndex((l) => l.trim().toUpperCase().startsWith(TALLY_END));
  // A missing end marker is recoverable: read to the end of the paste. A chat
  // reply truncated mid-block still carries the rows above the cut.
  const endAt = endRelative === -1 ? lines.length : startAt + 1 + endRelative;

  const rows: AiTallyRow[] = [];
  const rejected: RejectedLine[] = [];

  for (let i = startAt + 1; i < endAt; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const lineNumber = i + 1;
    // Blank lines and fences are layout, not content.
    if (!line || /^(```|~~~)/.test(line)) continue;

    const parts = line.split('|').map((p) => p.trim());
    if (parts.length !== 3) {
      rejected.push({
        line,
        lineNumber,
        why: 'expected three fields separated by | (name | score | reason)',
      });
      continue;
    }

    const [name, scoreText, reason] = parts as [string, string, string];
    if (!name) {
      rejected.push({ line, lineNumber, why: 'no player name' });
      continue;
    }
    if (!/^[+-]?\d+$/.test(scoreText)) {
      rejected.push({ line, lineNumber, why: `"${scoreText}" is not a score` });
      continue;
    }
    const score = Number(scoreText);
    if (!(ALLOWED_SCORES as readonly number[]).includes(score)) {
      rejected.push({
        line,
        lineNumber,
        why: `${scoreText} is not an allowed score (${ALLOWED_SCORES.map((s) => (s > 0 ? `+${s}` : s)).join(', ')})`,
      });
      continue;
    }
    if (!reason) {
      rejected.push({ line, lineNumber, why: 'no reason given' });
      continue;
    }

    rows.push({ name, score: score as AllowedScore, reason, lineNumber });
  }

  return { recognised: true, rows, rejected, error: null };
}

// ---------------------------------------------------------------- importing --

export interface AiTallyImportResult {
  evidence: ProposedEvidence[];
  identityReviews: IdentityReviewItem[];
  rowsParsed: number;
  matched: number;
  ambiguous: { name: string; score: number; reason: string; candidates: string[] }[];
  unmatched: { name: string; score: number; reason: string }[];
  /** Rows that contradict each other. */
  conflicts: string[];
  rejected: RejectedLine[];
  /** Set when the paste could not be read at all. */
  error: string | null;
  /**
   * This tally's identity, for exactly-once. Null when nothing was readable —
   * an unreadable paste is not a tally and has nothing to be idempotent about.
   */
  payloadFingerprint: string | null;
  detail: string;
}

export interface AiTallyImportOptions {
  /** The newsletter this tally is about. Every row is filed under it. */
  sourceMessageId: string;
  sourceDate: string;
  sourceName?: string;
}

/**
 * The identity of one pasted tally, as a whole.
 *
 * Exactly-once needs a name for "this tally, again". The ledger's per-row
 * dedupe keys already stop a repeat from *counting* twice, and this is what
 * lets the server *recognise* the repeat: a second apply of the same tally is
 * answered with what the first one did rather than with a truthful but useless
 * report that nothing was applied.
 *
 * Computed from the rows the parser read, not from the raw paste. A chat reply
 * arrives wrapped in explanation, a code fence and whatever else the model felt
 * like saying, and none of that is the tally — so a second paste of the same
 * scores with a different preamble is the same tally, and is treated as one.
 * The rows are sorted for the same reason: their order is presentational.
 *
 * A block with no rows has an identity too, and it is a stable one. That is
 * deliberate: "this issue had nothing worth scoring" is a real answer, and
 * approving it twice must still complete the newsletter exactly once.
 */
export function tallyPayloadFingerprint(rows: AiTallyRow[]): string {
  const canonical = rows
    .map((r) => [canonicalText(r.name), String(r.score), canonicalText(r.reason)].join('|'))
    .sort()
    .join('\n');
  return stableHash([TALLY_PROTOCOL, canonical].join('|'));
}

/** The dedupe identity of one imported row. */
export function aiTallyKey(parts: {
  sourceMessageId: string;
  playerId: string;
  score: number;
  reason: string;
}): string {
  return stableHash(
    [
      'ai-tally',
      TALLY_PROTOCOL,
      parts.sourceMessageId,
      parts.playerId,
      String(parts.score),
      canonicalText(parts.reason),
    ].join('|'),
  );
}

/**
 * Turn a pasted answer into proposed evidence.
 *
 * Pure: it resolves names and shapes rows, and writes nothing. Whether any of
 * this reaches the ledger is the caller's decision, taken after the user has
 * seen it.
 */
export function importAiTally(
  text: string,
  index: PlayerIndex,
  opts: AiTallyImportOptions,
): AiTallyImportResult {
  const parsed = parseAiTally(text);
  const sourceName = opts.sourceName ?? 'Newsletter tally';

  if (parsed.error) {
    return {
      evidence: [],
      identityReviews: [],
      rowsParsed: 0,
      matched: 0,
      ambiguous: [],
      unmatched: [],
      conflicts: [],
      rejected: parsed.rejected,
      error: parsed.error,
      payloadFingerprint: null,
      detail: parsed.error,
    };
  }

  const evidence: ProposedEvidence[] = [];
  const identityReviews: IdentityReviewItem[] = [];
  const ambiguous: AiTallyImportResult['ambiguous'] = [];
  const unmatched: AiTallyImportResult['unmatched'] = [];
  const conflicts: string[] = [];

  // One player scored twice in one block has two different answers. Neither is
  // preferred; both go to review, exactly as the backfill importer does.
  const seen = new Map<string, AiTallyRow>();
  const duplicated = new Set<string>();
  for (const row of parsed.rows) {
    const key = row.name.toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      duplicated.add(key);
      conflicts.push(
        `${row.name} is scored twice (${signed(previous.score)} and ${signed(row.score)}) — ` +
          'both were sent to review rather than picking one.',
      );
    } else {
      seen.set(key, row);
    }
  }

  parsed.rows.forEach((row, i) => {
    const match = resolvePlayer({ name: row.name }, index);
    const polarity: Polarity = row.score > 0 ? 'positive' : 'negative';

    if (match.status !== 'matched' || !match.playerId) {
      identityReviews.push({
        sourceMessageId: opts.sourceMessageId,
        sourceDate: opts.sourceDate,
        excerpt: row.reason,
        matchedText: row.name,
        reason: match.reason,
        candidates: match.candidates.map((c) => ({
          playerId: c.player.id,
          name: c.player.fullName,
          team: c.player.team ?? '',
          position: c.player.position ?? '',
          detail: c.detail ?? '',
        })),
        proposedPolarity: polarity,
        proposedCategory: null,
        // The score as written, so confirming who this is recovers the decision
        // rather than a flattened stand-in for it.
        proposedMagnitude: Math.abs(row.score),
      });
      const shared = { name: row.name, score: row.score, reason: row.reason };
      if (match.status === 'ambiguous') {
        ambiguous.push({
          ...shared,
          candidates: match.candidates.map(
            (c) => `${c.player.fullName} (${c.player.position} ${c.player.team})`,
          ),
        });
      } else {
        unmatched.push(shared);
      }
      return;
    }

    const contested = duplicated.has(row.name.toLowerCase());
    evidence.push({
      dedupeKey: aiTallyKey({
        sourceMessageId: opts.sourceMessageId,
        playerId: match.playerId,
        score: row.score,
        reason: row.reason,
      }),
      playerId: match.playerId,
      playerName: row.name,
      sourceType: 'newsletter',
      sourceName,
      sourceMessageId: opts.sourceMessageId,
      sourceDate: opts.sourceDate,
      // The reason is carried verbatim. Rewriting it in the app would be the
      // app having an opinion about material it did not read.
      excerpt: row.reason,
      contextSummary: null,
      category: null,
      polarity,
      // Exactly as scored. A ±2 stays a ±2.
      magnitude: Math.abs(row.score),
      // Never "high": this is somebody else's reading of the issue, and it
      // should not outrank a rule that matched the actual sentence.
      confidence: 'medium',
      confidenceScore: 0.6,
      ruleId: AI_TALLY_RULE_ID,
      reviewStatus: contested ? 'pending' : 'auto_applied',
      notes: [AI_TALLY_PROVENANCE, `protocol:${TALLY_PROTOCOL}`, ...(contested ? ['scored-twice'] : [])],
      blockIndex: i,
    });
  });

  const applied = evidence.filter((e) => e.reviewStatus === 'auto_applied').length;
  const parts: string[] = [`${parsed.rows.length} row(s) read.`];
  parts.push(`${evidence.length} matched to a player (${applied} ready to apply).`);
  if (ambiguous.length) parts.push(`${ambiguous.length} name(s) matched more than one player.`);
  if (unmatched.length) parts.push(`${unmatched.length} name(s) were not recognised.`);
  if (conflicts.length) parts.push(`${conflicts.length} contradiction(s) found.`);
  if (parsed.rejected.length) parts.push(`${parsed.rejected.length} line(s) could not be read.`);

  return {
    evidence,
    identityReviews,
    rowsParsed: parsed.rows.length,
    matched: evidence.length,
    ambiguous,
    unmatched,
    conflicts,
    rejected: parsed.rejected,
    error: null,
    payloadFingerprint: tallyPayloadFingerprint(parsed.rows),
    detail: parts.join(' '),
  };
}

function signed(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}
