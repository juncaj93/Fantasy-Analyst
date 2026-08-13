import { describe, expect, it } from 'vitest';
import { extractBlocks, htmlToText, isBoilerplate, splitSentences } from '../src/core/newsletter/html.ts';
import { detectMentions } from '../src/core/newsletter/mentions.ts';
import { contentFingerprint, evidenceKey, stableHash } from '../src/core/newsletter/fingerprint.ts';
import { processNewsletter, qualifies, type EmailMessage } from '../src/core/newsletter/pipeline.ts';
import { TEST_INDEX } from './helpers/players.ts';
import {
  CLEAN_NEWSLETTER,
  MALFORMED_NEWSLETTER,
  NO_PLAYERS,
  PLAIN_TEXT_NEWSLETTER,
  REPEATED_MENTION,
  SURNAME_ANAPHORA,
  SURNAME_COLLISION,
  TWO_PLAYERS_ONE_SENTENCE,
} from './fixtures/newsletters.ts';

function message(html: string, overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    messageId: 'msg-1',
    from: 'editor@ffnewsletter.example',
    subject: 'Training Camp Notes',
    receivedAt: '2026-08-13T12:00:00.000Z',
    html,
    text: null,
    ...overrides,
  };
}

describe('html sanitization', () => {
  it('removes script and style content entirely', () => {
    const text = htmlToText(MALFORMED_NEWSLETTER);
    expect(text).not.toContain('var tracking');
    expect(text).not.toContain('not real content');
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>Smith &amp; Jones &nbsp;&mdash; done</p>')).toContain('Smith & Jones');
  });

  it('survives malformed markup without throwing', () => {
    expect(() => extractBlocks(MALFORMED_NEWSLETTER)).not.toThrow();
    expect(extractBlocks(MALFORMED_NEWSLETTER).length).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(extractBlocks('')).toEqual([]);
  });
});

describe('boilerplate removal', () => {
  it('detects common newsletter chrome', () => {
    for (const line of [
      'Unsubscribe',
      'View this email in your browser',
      '© 2026 FF Newsletter',
      'All rights reserved',
      'Privacy Policy',
      '123 Main Street, Suite 400, Springfield, IL 62704',
      'https://example.com/tracking',
    ]) {
      expect(isBoilerplate(line).boilerplate, line).toBe(true);
    }
  });

  it('keeps real content', () => {
    expect(isBoilerplate('Bijan Robinson was named the starter.').boilerplate).toBe(false);
  });

  it('strips boilerplate and duplicate title lines from extracted blocks', () => {
    const blocks = extractBlocks(CLEAN_NEWSLETTER);
    const joined = blocks.map((b) => b.text).join(' | ');
    expect(joined).not.toMatch(/unsubscribe/i);
    expect(joined).not.toMatch(/rights reserved/i);
    expect(joined).not.toMatch(/browser/i);
    // "Training Camp Notes" appears twice in the source, once after dedupe.
    expect(blocks.filter((b) => b.text === 'Training Camp Notes')).toHaveLength(1);
  });
});

describe('sentence splitting', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('He is out. He will miss Sunday.')).toHaveLength(2);
  });

  it('does not split on common abbreviations', () => {
    expect(splitSentences('He is the No. 1 back in camp.')).toHaveLength(1);
    expect(splitSentences('Amon-Ra St. Brown is healthy.')).toHaveLength(1);
  });
});

describe('mention detection', () => {
  it('finds full-name mentions', () => {
    const mentions = detectMentions('Bijan Robinson was named the starter.', TEST_INDEX);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.playerId).toBe('10');
  });

  it('finds two players in one sentence', () => {
    const mentions = detectMentions('Bijan Robinson and Puka Nacua both practiced.', TEST_INDEX);
    expect(mentions.map((m) => m.playerId).sort()).toEqual(['10', '11']);
  });

  it('resolves a surname via anaphora when introduced earlier', () => {
    const mentions = detectMentions('Nacua is getting goal-line work.', TEST_INDEX, {
      documentPlayerIds: new Set(['11']),
    });
    expect(mentions[0]?.playerId).toBe('11');
    expect(mentions[0]?.surnameOnly).toBe(true);
  });

  it('does not guess on an ambiguous surname', () => {
    const mentions = detectMentions('Johnson is taking first-team reps.', TEST_INDEX);
    const johnson = mentions.find((m) => m.matchedText === 'Johnson');
    expect(johnson?.playerId ?? null).toBeNull();
  });

  it('ignores a common word that is also a surname without anaphora', () => {
    const mentions = detectMentions('Love for the game is what drives him.', TEST_INDEX);
    expect(mentions.every((m) => m.playerId !== '9')).toBe(true);
  });

  it('handles a name with punctuation', () => {
    expect(detectMentions("D'Andre Swift is healthy.", TEST_INDEX)[0]?.playerId).toBe('3');
  });
});

describe('processNewsletter', () => {
  it('produces evidence for each resolved player with a signal', () => {
    const result = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    const byPlayer = new Map(result.evidence.map((e) => [e.playerId, e]));
    expect(byPlayer.get('10')?.polarity).toBe('positive');
    expect(byPlayer.get('11')?.polarity).toBe('negative');
    expect(byPlayer.get('7')?.polarity).toBe('mixed');
  });

  it('routes mixed and low-confidence items to review, not to the tally', () => {
    const result = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    const mixed = result.evidence.find((e) => e.polarity === 'mixed');
    expect(mixed?.reviewStatus).toBe('pending');
  });

  it('auto-applies only unambiguous high-confidence items', () => {
    const result = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    for (const item of result.evidence) {
      if (item.reviewStatus === 'auto_applied') {
        expect(item.confidence).toBe('high');
        expect(item.polarity).not.toBe('mixed');
      }
    }
  });

  it('never auto-applies a sentence containing two players', () => {
    const result = processNewsletter(message(TWO_PLAYERS_ONE_SENTENCE), TEST_INDEX);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every((e) => e.reviewStatus === 'pending')).toBe(true);
  });

  it('sends colliding names with a real signal to identity review, never to a guess', () => {
    const result = processNewsletter(message(SURNAME_COLLISION), TEST_INDEX);
    // Both the full-name collision and the later bare surname are unresolvable.
    expect(result.identityReview.length).toBe(2);
    expect(result.evidence).toHaveLength(0);
    const fullName = result.identityReview.find((r) => r.matchedText === 'Chris Johnson');
    expect(fullName?.reason).toContain('2 active players named');
    expect(fullName?.candidates).toHaveLength(2);
    const surname = result.identityReview.find((r) => r.matchedText === 'Johnson');
    expect(surname?.reason).toContain('surname');
    expect(surname?.candidates).toHaveLength(2);
  });

  it('resolves a later surname mention to the player named earlier', () => {
    const result = processNewsletter(message(SURNAME_ANAPHORA), TEST_INDEX);
    const forNacua = result.evidence.filter((e) => e.playerId === '11');
    expect(forNacua.length).toBe(2);
    expect(result.identityReview).toHaveLength(0);
  });

  it('never auto-applies a surname-only mention', () => {
    const result = processNewsletter(message(SURNAME_ANAPHORA), TEST_INDEX);
    const goalLine = result.evidence.find((e) => e.ruleId?.includes('goal_line'));
    expect(goalLine?.reviewStatus).toBe('pending');
  });

  it('deduplicates a repeated identical mention inside one email', () => {
    const result = processNewsletter(message(REPEATED_MENTION), TEST_INDEX);
    expect(result.evidence.filter((e) => e.playerId === '10')).toHaveLength(1);
    expect(result.stats.duplicatesWithinEmail).toBeGreaterThan(0);
  });

  it('produces nothing for a newsletter with no recognised players', () => {
    const result = processNewsletter(message(NO_PLAYERS), TEST_INDEX);
    expect(result.evidence).toHaveLength(0);
    expect(result.identityReview).toHaveLength(0);
  });

  it('processes plain text as well as HTML', () => {
    const result = processNewsletter(
      { ...message(''), html: null, text: PLAIN_TEXT_NEWSLETTER },
      TEST_INDEX,
    );
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('never fabricates a context summary', () => {
    const result = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    for (const item of result.evidence) {
      expect(item.contextSummary).toBeTruthy();
      // Either a rule template or a slice of the original excerpt.
      const isTemplate = /^[A-Z][^"]*\.$/.test(item.contextSummary!);
      const isExcerpt = item.excerpt.startsWith(item.contextSummary!.replace(/…$/, ''));
      expect(isTemplate || isExcerpt, item.contextSummary!).toBe(true);
    }
  });

  it('is fully deterministic', () => {
    const a = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    const b = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('generates identical dedupe keys on reprocessing', () => {
    const a = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    const b = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    expect(a.evidence.map((e) => e.dedupeKey)).toEqual(b.evidence.map((e) => e.dedupeKey));
  });

  it('gives different message ids different dedupe keys', () => {
    const a = processNewsletter(message(CLEAN_NEWSLETTER), TEST_INDEX);
    const b = processNewsletter(message(CLEAN_NEWSLETTER, { messageId: 'msg-2' }), TEST_INDEX);
    expect(a.evidence[0]?.dedupeKey).not.toBe(b.evidence[0]?.dedupeKey);
  });
});

describe('qualification', () => {
  const sources = [
    {
      id: 'ff',
      label: 'FF Newsletter',
      fromPatterns: ['@ffnewsletter.example'],
      subjectPatterns: ['camp', 'week \\d+'],
      enabled: true,
    },
  ];

  it('qualifies a matching sender and subject', () => {
    expect(qualifies(message(''), sources)?.id).toBe('ff');
  });

  it('rejects an unrelated sender', () => {
    expect(qualifies(message('', { from: 'spam@elsewhere.example' }), sources)).toBeNull();
  });

  it('rejects a matching sender with an unrelated subject', () => {
    expect(qualifies(message('', { subject: 'Your invoice' }), sources)).toBeNull();
  });

  it('respects the enabled flag', () => {
    expect(qualifies(message(''), [{ ...sources[0]!, enabled: false }])).toBeNull();
  });
});

describe('fingerprints', () => {
  it('is stable and whitespace-insensitive', () => {
    expect(contentFingerprint('Hello   world')).toBe(contentFingerprint('hello world'));
  });

  it('differs for different content', () => {
    expect(contentFingerprint('a')).not.toBe(contentFingerprint('b'));
  });

  it('produces a fixed-width digest', () => {
    expect(stableHash('anything')).toHaveLength(32);
  });

  it('builds evidence keys from all identifying parts', () => {
    const base = { sourceMessageId: 'm1', playerId: 'p1', excerpt: 'text', ruleId: 'r1' };
    expect(evidenceKey(base)).toBe(evidenceKey({ ...base }));
    expect(evidenceKey(base)).not.toBe(evidenceKey({ ...base, playerId: 'p2' }));
    expect(evidenceKey(base)).not.toBe(evidenceKey({ ...base, ruleId: 'r2' }));
  });
});
