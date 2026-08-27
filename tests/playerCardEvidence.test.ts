/**
 * What an expanded player card puts on its one line of evidence.
 *
 * The browser walks its own copy of the sentence ladder — the wire type it
 * receives is a projection of the ledger row and carries none of the storage
 * fields `core/evidence/takeaway.ts` needs — so the rule has to hold in two
 * places. It is asserted in both, against the same fixture, because a card that
 * says one thing and a takeaway above it that says another is worse than either
 * being wrong on its own.
 */

import { describe, expect, it } from 'vitest';
import { newsSentence } from '../src/web/components/playerDetail.tsx';
import { sentenceOf } from '../src/core/evidence/takeaway.ts';
import type { EvidenceItem } from '../src/core/evidence/types.ts';

const CARRIED = 'Carried over from a running tally covering several earlier issues (net +11).';
const FOOTBALL =
  'R1–R3 breakout/coverage numbers. R4: #2 FPG excl. injury weeks, #2 YPRR vs. two-high.';

/** A backfilled running-tally row: football in the excerpt, bookkeeping in the summary. */
const backfilled = {
  excerpt: FOOTBALL,
  contextSummary: CARRIED,
  ruleId: 'tally-backfill',
  userOverride: null,
};

/** The same row as the ledger holds it, for the core half of the rule. */
const asLedgerRow = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
  ({
    id: 'e1',
    playerId: 'jsn',
    sourceType: 'newsletter',
    sourceName: 'FF Newsletter',
    sourceMessageId: 'tally-doc',
    sourceDate: '2026-09-18',
    excerpt: FOOTBALL,
    contextSummary: CARRIED,
    category: null,
    polarity: 'positive',
    magnitude: 11,
    confidence: 'medium',
    confidenceScore: 0.6,
    ruleId: 'tally-backfill',
    reviewStatus: 'auto_applied',
    userOverride: null,
    dedupeKey: 'd1',
    createdAt: '2026-09-18T00:00:00.000Z',
    ...over,
  }) as EvidenceItem;

describe('the evidence line on a player card', () => {
  it('quotes the football rather than explaining the bookkeeping', () => {
    const sentence = newsSentence(backfilled);
    expect(sentence.text).toBe(FOOTBALL);
    expect(sentence.quoted).toBe(true);
    expect(sentence.text).not.toContain('Carried over');
  });

  it('agrees with the takeaway above it, which reads the same row', () => {
    expect(sentenceOf(asLedgerRow())).toBe(newsSentence(backfilled).text);
  });

  it('still prefers a rule-composed summary, which is about the player', () => {
    const summary = 'Named the starter, taking first-team reps.';
    const sentence = newsSentence({
      excerpt: 'Bijan Robinson was named the starter and is taking first-team reps.',
      contextSummary: summary,
      ruleId: 'pos.role',
      userOverride: null,
    });
    expect(sentence.text).toBe(summary);
    expect(sentence.quoted).toBe(false);
  });

  it('still lets the user’s own note win over everything', () => {
    const note = 'He is the starter, whatever the tally says.';
    expect(newsSentence({ ...backfilled, userOverride: { note } }).text).toBe(note);
  });

  /**
   * An imported ChatGPT tally row already carries the reason it was scored on
   * and stores no summary at all, so it needs no special case — but if one is
   * ever added, this is the line that will notice.
   */
  it('quotes an approved tally row’s own reason', () => {
    const sentence = newsSentence({
      excerpt: 'Elite target share and every route on third down.',
      contextSummary: null,
      ruleId: 'ai-tally-import',
      userOverride: null,
    });
    expect(sentence.text).toBe('Elite target share and every route on third down.');
  });

  /**
   * A row that has only bookkeeping falls back to whatever it does carry, which
   * for an old backfill is the bare score line. Minimal, and never invented:
   * the app does not write football it has not read.
   */
  it('falls back to what the row has rather than composing analysis', () => {
    const sentence = newsSentence({
      excerpt: 'Jaxon Smith-Njigba: +11',
      contextSummary: CARRIED,
      ruleId: 'tally-backfill',
      userOverride: null,
    });
    expect(sentence.text).toBe('Jaxon Smith-Njigba: +11');
  });
});
