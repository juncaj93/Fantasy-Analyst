/**
 * Two defects found by auditing a whole real issue rather than a sample of it.
 *
 * The parser repair left today's newsletter clean, and the coverage report then
 * said: 119 sentences named a player, 1 became a signal, 118 matched no rule.
 * Eight of those 118 were visible. Walking all of them — see
 * `scripts/audit-newsletter-sentences.mjs` — turned up no missing rule at all,
 * because the issue is a statistics digest, and two things that were wrong.
 *
 * The sentences quoted here are the real ones, kept verbatim so the tests say
 * what they are protecting against rather than describing it.
 */

import { describe, expect, it } from 'vitest';
import { canAutoApply, classifySentence } from '../src/core/newsletter/classify.ts';
import { collectUnresolvedNames, detectMentions } from '../src/core/newsletter/mentions.ts';
import { processNewsletter } from '../src/core/newsletter/pipeline.ts';
import { TEST_INDEX } from './helpers/players.ts';

// ------------------------------------------------- a highlight is not news ---
describe('depth-chart movement means the depth chart', () => {
  /**
   * The single signal the audited issue produced, and it was wrong.
   *
   * "Climbed the ladder" is what a receiver does to catch a high ball. It sat
   * in the fun-stuff section between a fan sneaking into training camp and a
   * Madden rating, and it was auto-applied at high confidence as a promotion.
   */
  it('does not read a leaping catch as a promotion', () => {
    const result = classifySentence('Cyrus Allen climbed the ladder to get that one');
    expect(result.polarity).toBe('neutral');
    expect(result.matches).toEqual([]);
  });

  it('does not read raised play as a raised role', () => {
    for (const sentence of [
      'He elevated his game in the second half.',
      'He climbed the ladder for a spectacular grab.',
      'He moved up in a lot of mock drafts this week.',
      'He jumped the snap count on that play.',
    ]) {
      expect(classifySentence(sentence).matches.map((m) => m.ruleId), sentence).not.toContain('pos.promoted');
    }
  });

  it('still reads real depth-chart movement', () => {
    for (const sentence of [
      'He has been promoted to the top of the depth chart.',
      'He was promoted to the starting lineup this week.',
      'He was elevated to WR2 this week.',
      'He climbed the depth chart during camp.',
      'He has moved up the depth chart this month.',
      'He worked his way up the depth chart all summer.',
    ]) {
      const result = classifySentence(sentence);
      expect(result.matches.map((m) => m.ruleId), sentence).toContain('pos.promoted');
      expect(result.polarity, sentence).toBe('positive');
    }
  });

  /**
   * A practice-squad elevation is a roster mechanic with a fixed weekly cost,
   * not a verdict on anybody's role. That exclusion predates this change and
   * has to survive it.
   */
  it('still ignores a practice-squad elevation', () => {
    for (const sentence of [
      'He was promoted from the practice squad for Sunday.',
      'He was elevated to the active roster from the practice squad.',
    ]) {
      expect(classifySentence(sentence).matches.map((m) => m.ruleId), sentence).not.toContain('pos.promoted');
    }
  });
});

// ------------------------------------------ a position label is not a name ---
describe('a position label introduces a name rather than joining it', () => {
  /**
   * Both position-prefixed sentences in the audited issue went unresolved:
   *
   *   "Our 2026 projections have TE Colston Loveland at 6.9 targets per game…"
   *   "WR Jaylen Waddle projects for a 26% target share in Denver."
   *
   * Not merely unmatched — the fuzzy ladder answered "ambiguous" for the whole
   * three-token span, which consumed the tokens, so the real two-token name
   * inside was never tried.
   */
  it('resolves a player written with his position in front', () => {
    for (const prefix of ['RB', 'WR', 'TE', 'QB', 'FB']) {
      const mentions = detectMentions(`${prefix} Bijan Robinson projects for more work.`, TEST_INDEX);
      expect(mentions.map((m) => m.matchedText), prefix).toContain('Bijan Robinson');
      expect(mentions.find((m) => m.matchedText === 'Bijan Robinson')?.playerId, prefix).toBe('10');
    }
  });

  it('does not offer the label as part of a missing player name', () => {
    const unknown = collectUnresolvedNames('Rookie WR Camaron Edgecomb had a strong day.', TEST_INDEX);
    expect(unknown.some((n) => /^(WR|RB|TE|QB)\b/.test(n))).toBe(false);
    expect(unknown.join(' ')).toContain('Camaron Edgecomb');
  });

  /**
   * Case-sensitive on purpose: these are abbreviations. A name that merely
   * starts with the same letters is still a name.
   */
  it('does not treat a real name as a label', () => {
    const mentions = detectMentions("Te'Vion Robinson and Bijan Robinson both played.", TEST_INDEX);
    expect(mentions.map((m) => m.matchedText)).toContain('Bijan Robinson');
  });

  it('carries the position prefix through the whole pipeline', () => {
    const result = processNewsletter(
      {
        messageId: 'pos-prefix',
        from: 'ffweekly@substack.com',
        subject: 'x',
        receivedAt: '2026-08-20T12:00:00.000Z',
        html: '<p>RB Bijan Robinson was named the starter.</p>',
        text: null,
      },
      TEST_INDEX,
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.playerName).toBe('Bijan Robinson');
    expect(result.evidence[0]?.ruleId).toContain('pos.named_starter');
  });
});

// ------------------------------------------- what correctly stays no-rule ----
describe('the rest of the issue correctly carries no signal', () => {
  /**
   * Verbatim from the audit, one per category it stands for. These are the
   * reason the answer to "which rules are missing?" is "none": a statistics
   * digest is not news, however many player names it contains.
   */
  const noNews: [string, string][] = [
    ['Romeo Doubs - 0.216', 'bare stat-table row'],
    ['Dalton Kincaid: 23.9%', 'bare stat-table row'],
    ['Bijan Robinson - 2,298*', 'bare stat-table row'],
    ['Christian McCaffrey', 'a name used as a list label'],
    ['Keenan Allen is fewer than 50 receptions away from having the third most in NFL history among wide receivers.', 'career milestone'],
    ['Dallas Goedert has finished as a PPG TE1 in SEVEN straight seasons.', 'historical record'],
    ['Kenneth Walker has never had a season of double-digit rushing TDs.', 'historical rate'],
    ['Malik Willis has averaged 6.8 rush attempts per start in his career.', 'career average'],
    ['Made fun of Jayden Daniels, his mom, and the whole LSU jersey number saga', 'a joke'],
    ['Check out 11 year old Tyler Warren.', 'human interest'],
    ['Per Madden 27, the best quarterback in football is 38-year-old Matthew Stafford.', 'a video-game rating'],
    ['Trevor Lawrence is one of our favorite QBs to draft this season.', 'analyst preference'],
    ['Our 2026 projections have TE Colston Loveland at 6.9 targets per game on a 21% total target share.', 'a projection'],
    ['WR Jaylen Waddle projects for a 26% target share in Denver.', 'a projection'],
  ];

  for (const [sentence, why] of noNews) {
    it(`leaves ${why} alone: "${sentence.slice(0, 45)}..."`, () => {
      const result = classifySentence(sentence);
      expect(result.polarity).toBe('neutral');
      expect(result.magnitude).toBe(0);
    });
  }

  /**
   * Analyst preference is deliberately not evidence. The recommendation engine
   * already has its own opinion, led by the market; importing somebody else's
   * into the ledger would let one view count twice while looking like two.
   */
  it('does not treat a draft recommendation as news', () => {
    const result = classifySentence(
      'Our research shows that in the middle rounds we want to target running backs in split ' +
        'backfields with high target shares, and Jaylen Warren is one of our favorites.',
    );
    expect(result.polarity).toBe('neutral');
  });
});

// ------------------------------------------------------- the guard holds -----
describe('a surname alone still cannot apply itself', () => {
  /**
   * The audit found retired names attaching to active players who happen to
   * share a surname — "Peyton Manning - 296" resolved to an active Manning.
   * No rule fired on any of them, so nothing was written, but the guard that
   * would have caught it if one had is worth pinning.
   */
  it('never auto-applies a surname-only mention', () => {
    const result = processNewsletter(
      {
        messageId: 'surname-only',
        from: 'ffweekly@substack.com',
        subject: 'x',
        receivedAt: '2026-08-20T12:00:00.000Z',
        html: '<p>Puka Nacua is healthy.</p><p>Nacua was named the starter.</p>',
        text: null,
      },
      TEST_INDEX,
    );
    const bySurname = result.evidence.find((e) => e.excerpt.startsWith('Nacua was named'));
    expect(bySurname?.reviewStatus).toBe('pending');
    expect(bySurname?.notes.join(' ')).toContain('surname-only');
  });

  it('keeps the auto-apply bar where it was for a full name', () => {
    expect(canAutoApply(classifySentence('Puka Nacua was named the starter.'))).toBe(true);
  });
});
