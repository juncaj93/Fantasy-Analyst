/**
 * The newsletter workflow, as a test fixture.
 *
 * A newsletter arriving no longer produces evidence, so a suite that needs a
 * populated ledger has to do what a person does: receive the issue, then apply
 * an approved ChatGPT tally to it. That is two steps rather than one, and it is
 * worth the two — a fixture that wrote rows into `evidence_items` directly
 * would prove that the tests can write rows, while every test that used it
 * would silently stop covering the only path that puts a score in front of a
 * reader.
 */

import { TALLY_PROTOCOL } from '../../src/core/newsletter/aiTally.ts';
import { toEmailMessage } from '../../src/core/newsletter/source.ts';
import type { EmailMessage } from '../../src/core/newsletter/pipeline.ts';
import type { EvidenceRepo } from '../../src/server/repos/evidence.ts';
import type { NewsletterService } from '../../src/server/services/newsletterService.ts';
import { CLEAN_NEWSLETTER } from '../fixtures/newsletters.ts';

export const NEWSLETTER_SOURCES = [
  {
    id: 'ff',
    label: 'FF Newsletter',
    fromPatterns: ['@ffnewsletter.example'],
    subjectPatterns: [],
    enabled: true,
  },
];

export function newsletterMessage(html = CLEAN_NEWSLETTER, messageId = 'msg-1'): EmailMessage {
  return toEmailMessage({
    messageId,
    from: 'editor@ffnewsletter.example',
    subject: 'Training Camp Notes',
    date: '2026-08-13T12:00:00.000Z',
    html,
  });
}

/** Wrap rows in the protocol markers a real paste arrives with. */
export function tallyBlock(...rows: string[]): string {
  return [TALLY_PROTOCOL, ...rows, 'END_NEWSLETTER_TALLY'].join('\n');
}

/**
 * The default scored issue: three rows that apply and one that cannot.
 *
 * `Chris Johnson` is two players in the fixture roster, so it resolves to
 * neither and lands in Review as a name to confirm — which is what gives a
 * suite an identity queue with something real in it without any test having to
 * arrange one.
 */
export const DEFAULT_TALLY = tallyBlock(
  'Bijan Robinson | +2 | Named the starter and taking every first-team rep.',
  'Puka Nacua | -1 | Missed Wednesday with a hamstring.',
  'Jordan Love | +1 | The team is not concerned and he is expected to play.',
  'Chris Johnson | +1 | Two players in this league share the name.',
);

/**
 * Receive one newsletter and score it, the way the product does.
 *
 * Returns the apply outcome so a caller can assert on what actually moved.
 */
export async function ingestAndScore(
  service: NewsletterService,
  opts: { message?: EmailMessage; tally?: string } = {},
) {
  const message = opts.message ?? newsletterMessage();
  await service.ingest(message);
  const stored = (await service.storedMessage(message.messageId))!;
  return service.applyAiTally(stored, opts.tally ?? DEFAULT_TALLY);
}

/**
 * Rows the retired sentence classifier would have written on arrival.
 *
 * Nothing in the product creates these any more, and plenty of them are in the
 * production ledger — one newsletter arrived under the old path and produced
 * three. That is precisely what has to keep being tested: the reconciliation
 * that stops those rows counting beside the approved tally cannot be exercised
 * by a fixture that no longer contains any.
 *
 * Written through `insertProposed`, so they are ordinary ledger rows in every
 * respect a query can see — same table, same statuses, same `source_message_id`
 * — distinguishable only by `rule_id`, which is exactly the provenance the
 * reconciliation reads.
 */
export async function seedLegacyClassifierRows(
  evidence: EvidenceRepo,
  sourceMessageId: string,
  rows: {
    playerId: string;
    polarity: 'positive' | 'negative' | 'neutral' | 'mixed';
    magnitude: number;
    excerpt: string;
    ruleId?: string;
    reviewStatus?: 'auto_applied' | 'pending';
  }[],
  opts: { sourceDate?: string } = {},
): Promise<void> {
  await evidence.insertProposed(
    rows.map((row, i) => ({
      dedupeKey: `legacy|${sourceMessageId}|${row.playerId}|${i}`,
      playerId: row.playerId,
      playerName: row.playerId,
      sourceType: 'newsletter' as const,
      sourceName: 'FF Newsletter',
      sourceMessageId,
      sourceDate: opts.sourceDate ?? '2026-08-13T12:00:00.000Z',
      excerpt: row.excerpt,
      contextSummary: null,
      category: null,
      polarity: row.polarity,
      magnitude: row.magnitude,
      confidence: 'high',
      confidenceScore: 0.9,
      ruleId: row.ruleId ?? 'legacy-classifier',
      reviewStatus: row.reviewStatus ?? ('auto_applied' as const),
      notes: [],
      blockIndex: i,
    })),
  );
}

/** What the old classifier left behind on the demo issue, at its real shape. */
export const LEGACY_ROWS = [
  { playerId: '10', polarity: 'positive' as const, magnitude: 1, excerpt: 'Bijan Robinson was named the starter.' },
  { playerId: '11', polarity: 'negative' as const, magnitude: 1, excerpt: 'Puka Nacua did not practice on Wednesday.' },
  { playerId: '9', polarity: 'positive' as const, magnitude: 1, excerpt: 'Jordan Love is not expected to miss time.' },
];
