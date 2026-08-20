/**
 * The weekly ChatGPT tally import, at the layer where it decides things.
 *
 * The protocol is the contract between a chat reply and the evidence ledger, so
 * these tests are mostly about what the parser REFUSES: a score outside the
 * agreed scale, a row that is really a sentence, a name that matches two
 * players. Accepting any of those quietly would put a number in the ledger that
 * nobody chose.
 */

import { describe, expect, it } from 'vitest';
import {
  AI_TALLY_PROVENANCE,
  AI_TALLY_RULE_ID,
  aiTallyKey,
  buildNewsletterSource,
  importAiTally,
  parseAiTally,
  SOURCE_PROTOCOL,
  TALLY_PROTOCOL,
} from '../src/core/newsletter/aiTally.ts';
import { extractBlocks } from '../src/core/newsletter/html.ts';
import { TEST_INDEX } from './helpers/players.ts';

const OPTS = {
  sourceMessageId: '<issue.4f2a1c@mg-d0.substack.com>',
  sourceDate: '2026-08-20T11:45:48.000Z',
  sourceName: 'FF Newsletter',
};

const block = (...rows: string[]) => [TALLY_PROTOCOL, ...rows, 'END_NEWSLETTER_TALLY'].join('\n');

// ------------------------------------------------------------------ source ---
describe('Copy for ChatGPT', () => {
  it('wraps the cleaned body in the source envelope', () => {
    const blocks = extractBlocks(
      '<h2>Camp Risers</h2><ul><li>Bijan Robinson was named the starter.</li></ul>' +
        '<p>Puka Nacua did not practice.</p>',
      { isHtml: true },
    );
    const source = buildNewsletterSource({
      subject: 'Week 1 Camp Risers',
      receivedAt: '2026-08-20T11:45:48.000Z',
      messageId: OPTS.sourceMessageId,
      blocks,
    });

    expect(source.startsWith(SOURCE_PROTOCOL)).toBe(true);
    expect(source).toContain('Subject: Week 1 Camp Risers');
    expect(source).toContain(`Message-ID: ${OPTS.sourceMessageId}`);
    expect(source.trimEnd().endsWith('END_NEWSLETTER_SOURCE')).toBe(true);
    // Structure survives: a heading carries the meaning of the rows beneath it,
    // and every block stands on its own line rather than running together.
    expect(source).toContain('Camp Risers\nBijan Robinson was named the starter.');
    expect(source).toContain('Puka Nacua did not practice.');
  });

  /**
   * `list_item` means the marker survived into the text, which is what happens
   * to a real newsletter's bullets. It is not a claim about the original tag —
   * an HTML `<li>` whose marker was the tag itself reads as a paragraph, and
   * that is fine: the dash is a courtesy, the line break is the structure.
   */
  it('keeps a surviving bullet marker as a dash', () => {
    const blocks = extractBlocks('• Averaged 18.8 PPG in Shough starts\n• 151 targets', {
      isHtml: false,
    });
    expect(blocks.every((b) => b.kind === 'list_item')).toBe(true);
    const source = buildNewsletterSource({ messageId: OPTS.sourceMessageId, subject: 's', receivedAt: 'd', blocks });
    expect(source).toContain('- Averaged 18.8 PPG in Shough starts');
    expect(source).toContain('- 151 targets');
  });

  it('hands over clean text, not what arrived on the wire', () => {
    const blocks = extractBlocks(
      '<p><a href="https://substack.com/redirect/9f2b1a3c?j=eyJ1">Keenan Allen</a> is dealing with a heel injury.</p>' +
        '<p>Unsubscribe</p><p>Like · Comment · Restack</p>',
      { isHtml: true },
    );
    const source = buildNewsletterSource({ messageId: OPTS.sourceMessageId, subject: 's', receivedAt: 'd', blocks });
    expect(source).toContain('Keenan Allen is dealing with a heel injury.');

    // Asserted against the body, not the envelope: `Message-ID` is a header and
    // a real one contains the sending domain, which is not a tracking link.
    const body = source.slice(source.indexOf('\n\n') + 2);
    expect(body).not.toMatch(/substack\.com|https?:/);
    expect(body).not.toMatch(/Unsubscribe|Restack/);
    expect(body).not.toMatch(/=E2=80|Content-Type:|<[a-z]/i);
  });
});

// ----------------------------------------------------------------- parsing ---
describe('parseAiTally', () => {
  it('reads a well-formed block', () => {
    const parsed = parseAiTally(
      block(
        'Bijan Robinson | +2 | Named the starter and taking every first-team rep',
        'Puka Nacua | -1 | Did not practice Wednesday',
      ),
    );
    expect(parsed.recognised).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ name: 'Bijan Robinson', score: 2 });
    expect(parsed.rows[1]).toMatchObject({ name: 'Puka Nacua', score: -1 });
  });

  it('accepts all four scores and nothing else', () => {
    const ok = parseAiTally(
      block(
        'Bijan Robinson | +2 | a',
        'Puka Nacua | 1 | b',
        'Jordan Love | -1 | c',
        'Tyler Boyd | -2 | d',
      ),
    );
    expect(ok.rows.map((r) => r.score)).toEqual([2, 1, -1, -2]);

    const bad = parseAiTally(
      block('Bijan Robinson | +3 | too strong', 'Puka Nacua | 0 | neutral', 'Jordan Love | ++1 | typo'),
    );
    expect(bad.rows).toHaveLength(0);
    expect(bad.rejected).toHaveLength(3);
    expect(bad.rejected[0]?.why).toContain('not an allowed score');
    expect(bad.rejected[1]?.why).toContain('not an allowed score');
  });

  /**
   * A chat reply arrives wrapped in explanation. Refusing the whole paste over
   * that would be refusing the user's actual work.
   */
  it('finds the block inside surrounding chatter and code fences', () => {
    const parsed = parseAiTally(
      [
        'Sure! Here is the tally for this week:',
        '```',
        TALLY_PROTOCOL,
        'Bijan Robinson | +2 | Named the starter',
        'END_NEWSLETTER_TALLY',
        '```',
        'Let me know if you want me to adjust anything.',
      ].join('\n'),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(0);
  });

  it('reads the rows above a truncated reply', () => {
    const parsed = parseAiTally([TALLY_PROTOCOL, 'Bijan Robinson | +2 | Named the starter'].join('\n'));
    expect(parsed.recognised).toBe(true);
    expect(parsed.rows).toHaveLength(1);
  });

  it('refuses a paste with no protocol marker', () => {
    const parsed = parseAiTally('Bijan Robinson | +2 | Named the starter');
    expect(parsed.recognised).toBe(false);
    expect(parsed.error).toContain(TALLY_PROTOCOL);
    expect(parsed.rows).toHaveLength(0);
  });

  it('refuses an empty paste', () => {
    expect(parseAiTally('').error).toBe('Nothing was pasted.');
    expect(parseAiTally('   \n  ').error).toBe('Nothing was pasted.');
  });

  /**
   * Reported, never dropped. A silently ignored line is a player the user
   * believes they imported and cannot find.
   */
  it('reports a malformed row rather than discarding it', () => {
    const parsed = parseAiTally(
      block(
        'Bijan Robinson | +2 | Named the starter',
        'Puka Nacua had a good week',
        ' | +1 | no name at all',
        'Jordan Love | +1 | ',
      ),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected.map((r) => r.why)).toEqual([
      'expected three fields separated by | (name | score | reason)',
      'no player name',
      'no reason given',
    ]);
    expect(parsed.rejected[0]?.line).toContain('Puka Nacua had a good week');
  });

  it('keeps punctuation inside a reason', () => {
    const parsed = parseAiTally(
      block("Bijan Robinson | +2 | Coach: \"he's the engine\" — 1st-team reps, 80% snaps (up from 55%)"),
    );
    expect(parsed.rows[0]?.reason).toBe(
      'Coach: "he\'s the engine" — 1st-team reps, 80% snaps (up from 55%)',
    );
  });
});

// --------------------------------------------------------------- importing ---
describe('importAiTally', () => {
  it('carries the score and the reason across exactly', () => {
    const result = importAiTally(
      block('Bijan Robinson | +2 | Named the starter and taking every first-team rep'),
      TEST_INDEX,
      OPTS,
    );
    const item = result.evidence[0]!;
    expect(item.polarity).toBe('positive');
    // A +2 stays a +2; nothing is flattened.
    expect(item.magnitude).toBe(2);
    expect(item.excerpt).toBe('Named the starter and taking every first-team rep');
    expect(item.sourceMessageId).toBe(OPTS.sourceMessageId);
    expect(item.sourceDate).toBe(OPTS.sourceDate);
    expect(item.ruleId).toBe(AI_TALLY_RULE_ID);
    expect(item.notes).toContain(AI_TALLY_PROVENANCE);
    expect(item.notes).toContain(`protocol:${TALLY_PROTOCOL}`);
    expect(item.reviewStatus).toBe('auto_applied');
    // Somebody else's reading should not outrank a rule that read the sentence.
    expect(item.confidence).toBe('medium');
  });

  it('carries a negative score as a negative of the same size', () => {
    const result = importAiTally(block('Tyler Boyd | -2 | Lost the job outright'), TEST_INDEX, OPTS);
    expect(result.evidence[0]).toMatchObject({ polarity: 'negative', magnitude: 2 });
  });

  it('resolves names written with an apostrophe, a hyphen or odd spacing', () => {
    const result = importAiTally(
      block(
        "D'Andre Swift | +1 | a",
        'Amon-Ra St. Brown | +1 | b',
        '  puka   nacua   | +1 | c',
        'Marvin Harrison Jr. | +1 | d',
      ),
      TEST_INDEX,
      OPTS,
    );
    expect(result.matched).toBe(4);
    expect(result.unmatched).toHaveLength(0);
  });

  it('sends an ambiguous name to review instead of guessing', () => {
    // Two active players are called Chris Johnson.
    const result = importAiTally(block('Chris Johnson | +2 | Won the job'), TEST_INDEX, OPTS);
    expect(result.evidence).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]?.candidates.length).toBeGreaterThan(1);

    const review = result.identityReviews[0]!;
    expect(review.matchedText).toBe('Chris Johnson');
    expect(review.proposedPolarity).toBe('positive');
    // Confirming who this is must recover the score, not a ±1 stand-in.
    expect(review.proposedMagnitude).toBe(2);
    expect(review.excerpt).toBe('Won the job');
    expect(review.sourceMessageId).toBe(OPTS.sourceMessageId);
  });

  it('sends an unknown name to review with the score intact', () => {
    const result = importAiTally(block('Somebody Nobody | -2 | Season-ending injury'), TEST_INDEX, OPTS);
    expect(result.evidence).toHaveLength(0);
    expect(result.unmatched).toEqual([
      { name: 'Somebody Nobody', score: -2, reason: 'Season-ending injury' },
    ]);
    expect(result.identityReviews[0]?.proposedMagnitude).toBe(2);
  });

  it('lets clean rows through while unresolved ones wait', () => {
    const result = importAiTally(
      block('Bijan Robinson | +2 | Named the starter', 'Chris Johnson | +1 | Ambiguous on purpose'),
      TEST_INDEX,
      OPTS,
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.reviewStatus).toBe('auto_applied');
    expect(result.identityReviews).toHaveLength(1);
  });

  it('treats a player scored twice as a contradiction, not a preference', () => {
    const result = importAiTally(
      block('Bijan Robinson | +2 | Named the starter', 'Bijan Robinson | -1 | Actually limited'),
      TEST_INDEX,
      OPTS,
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain('scored twice');
    // Neither is preferred: both wait for a human.
    expect(result.evidence.every((e) => e.reviewStatus === 'pending')).toBe(true);
    expect(result.evidence.map((e) => e.notes).flat()).toContain('scored-twice');
  });

  it('reports an unreadable paste rather than importing nothing quietly', () => {
    const result = importAiTally('just some prose', TEST_INDEX, OPTS);
    expect(result.error).toContain(TALLY_PROTOCOL);
    expect(result.evidence).toHaveLength(0);
    expect(result.detail).toContain(TALLY_PROTOCOL);
  });

  it('summarises what happened in one readable sentence', () => {
    const result = importAiTally(
      block(
        'Bijan Robinson | +2 | Named the starter',
        'Chris Johnson | +1 | Ambiguous',
        'Somebody Nobody | -1 | Unknown',
        'not a row at all',
      ),
      TEST_INDEX,
      OPTS,
    );
    expect(result.detail).toContain('3 row(s) read');
    expect(result.detail).toContain('1 matched');
    expect(result.detail).toContain('1 name(s) matched more than one player');
    expect(result.detail).toContain('1 name(s) were not recognised');
    expect(result.detail).toContain('1 line(s) could not be read');
  });
});

// -------------------------------------------------------------- idempotence --
describe('the dedupe identity', () => {
  it('is stable across runs of the same import', () => {
    const of = () =>
      importAiTally(block('Bijan Robinson | +2 | Named the starter'), TEST_INDEX, OPTS).evidence[0]!
        .dedupeKey;
    expect(of()).toBe(of());
  });

  it('ignores whitespace and case in the reason, as the ledger does elsewhere', () => {
    const a = importAiTally(block('Bijan Robinson | +2 | Named the starter'), TEST_INDEX, OPTS);
    const b = importAiTally(block('Bijan Robinson | +2 |   named   THE   starter  '), TEST_INDEX, OPTS);
    expect(a.evidence[0]?.dedupeKey).toBe(b.evidence[0]?.dedupeKey);
  });

  it('changes when the score, the player, the reason or the newsletter changes', () => {
    const base = aiTallyKey({ sourceMessageId: 'm', playerId: '10', score: 2, reason: 'r' });
    expect(aiTallyKey({ sourceMessageId: 'm', playerId: '10', score: 1, reason: 'r' })).not.toBe(base);
    expect(aiTallyKey({ sourceMessageId: 'm', playerId: '11', score: 2, reason: 'r' })).not.toBe(base);
    expect(aiTallyKey({ sourceMessageId: 'm', playerId: '10', score: 2, reason: 'other' })).not.toBe(base);
    expect(aiTallyKey({ sourceMessageId: 'n', playerId: '10', score: 2, reason: 'r' })).not.toBe(base);
  });

  it('does not collide with the deterministic parser or the backfill importer', () => {
    const item = importAiTally(block('Bijan Robinson | +2 | Named the starter'), TEST_INDEX, OPTS)
      .evidence[0]!;
    expect(item.ruleId).toBe(AI_TALLY_RULE_ID);
    expect(item.ruleId).not.toBe('tally-backfill');
  });
});
