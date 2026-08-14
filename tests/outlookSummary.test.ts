/**
 * Shortening somebody else's writing without changing what it says.
 *
 * The whole design rests on one rule — every printed word came out of the
 * source, in the order the source put it — so most of these are about that rule
 * rather than about which sentences get chosen. A summariser that picks a
 * duller sentence than it might have is a mediocre summariser; one that prints
 * a sentence the provider did not write, under the provider's name, is a
 * different kind of thing entirely.
 *
 * The two failures that actually occurred while this was being built are both
 * here as named cases: a question separated from its answer, and a sentence
 * whose subject was defined in the sentence before it.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SENTENCES,
  scoreSentence,
  splitSentences,
  standsAlone,
  summariseOutlook,
} from '../src/core/sleeper/outlookSummary.ts';

/** Nine sentences in the register these actually arrive in. */
const LONG = [
  'Fitzgerald was a fourth-round pick in 2022 and spent two years as a rotational piece before anyone paid much attention.',
  'He broke out in the second half of last season, going for 61-844-6 over the final nine games.',
  'That role is now his: Philadelphia let their veteran slot receiver walk in March and did not draft a replacement.',
  'He ran 88 percent of his routes from the slot after the switch and was targeted on 27.4 percent of them.',
  'The offense projects to throw more this year with a new coordinator arriving from a pass-heavy system.',
  'His yards per reception fell from 14.1 to 11.6 after the move, which is the shape of the role.',
  'The one concern is touchdown regression, since six scores on 61 catches is not a rate anybody sustains.',
  'He turns 26 in October and is under contract through 2028.',
  'Fitzgerald should see something close to 130 targets in an every-down role, which most receivers around him do not have.',
].join(' ');

describe('splitting prose into sentences', () => {
  it('keeps initials and abbreviations together', () => {
    const text = 'The Rams discussed acquiring A.J. Brown in March. Nothing came of it.';
    expect(splitSentences(text)).toHaveLength(2);
  });

  it('does not break on decimals', () => {
    const text = 'He led the NFL in yards per route run (3.70) in 2024. He was targeted on 36.1 percent of routes.';
    expect(splitSentences(text)).toHaveLength(2);
  });

  it('keeps No. and St. attached to what follows', () => {
    expect(splitSentences('Hubbard handles the No. 1 job in the backfield. Brooks is behind him.')).toHaveLength(2);
  });

  it('splits on questions and exclamations', () => {
    expect(splitSentences('The lone disappointment? His red-zone share. That was it.')).toHaveLength(3);
  });
});

describe('whether a sentence survives being lifted out', () => {
  /**
   * The Nacua case, exactly as it happened. The source read "The lone
   * disappointment? Nacua's 17.0 percent target share in the red zone, where
   * Davante Adams took precedence." Taking the second half alone printed a noun
   * phrase with no verb as though it were a finding.
   */
  it('will not separate an answer from its question', () => {
    expect(standsAlone("Nacua's 17.0 percent target share in the red zone.", 'The lone disappointment?')).toBe(false);
    expect(standsAlone("Nacua's 17.0 percent target share in the red zone.", 'He was excellent otherwise.')).toBe(true);
  });

  /**
   * The McCaffrey case. "The question is whether the 49ers will actually have
   * that luxury" is a grammatical sentence and, without its predecessor, means
   * nothing — the luxury was defined there.
   */
  it('will not lift a sentence whose subject is in the one before it', () => {
    expect(standsAlone('The question is whether the 49ers will have that luxury.', 'They may lessen his workload.')).toBe(
      false,
    );
  });

  it('allows a pointer whose referent is in the same sentence', () => {
    expect(
      standsAlone('His route share was low, but that low volume helped him stay fresh.', 'He was healthy.'),
    ).toBe(true);
  });

  it('rejects an opener that points backwards', () => {
    expect(standsAlone('That role is now his.', 'He broke out late.')).toBe(false);
    expect(standsAlone('This is the shape of the offense.', 'He broke out late.')).toBe(false);
  });

  it('rejects a time reference relative to an unstated event', () => {
    expect(standsAlone('Two weeks and nine carries later, he re-tore his right ACL.', 'He returned in October.')).toBe(
      false,
    );
  });

  /** An outlook is about one man, so a pronoun for him is never ambiguous. */
  it('allows a pronoun for the player', () => {
    expect(standsAlone('He led the position in rushing touchdowns.', 'The Bills leaned on him.')).toBe(true);
  });
});

describe('what counts as worth keeping', () => {
  it('prefers role and volume over career retrospection', () => {
    const role = scoreSentence('He should open the season as the every-down back with goal-line touches.');
    const trivia = scoreSentence('Famously just a fifth-round pick, he set a rookie record in 2023 for his career.');
    expect(role).toBeGreaterThan(trivia);
  });

  it('prefers a sentence about the player over one about his team', () => {
    const about = scoreSentence('Jeanty should benefit from an improved offensive line and better quarterback play.', 'Jeanty');
    const around = scoreSentence('Adding a centre and a left guard provides two upgrades on the offensive line.', 'Jeanty');
    expect(about).toBeGreaterThan(around);
  });

  it('counts injury and recovery as decision-relevant', () => {
    expect(scoreSentence('He was cleared in June after ACL surgery and has practised fully.')).toBeGreaterThan(0);
  });
});

describe('the summary itself', () => {
  it('prints only sentences that are in the source, in the source order', () => {
    const summary = summariseOutlook(LONG, { name: 'Owen Fitzgerald' })!;
    expect(summary).not.toBeNull();
    const sentences = splitSentences(summary.text);
    const original = splitSentences(LONG);
    for (const sentence of sentences) expect(original).toContain(sentence);
    // Order preserved: their indices in the source ascend.
    const indices = sentences.map((s) => original.indexOf(s));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it('is a lot shorter than what it summarises', () => {
    const summary = summariseOutlook(LONG, { name: 'Owen Fitzgerald' })!;
    expect(summary.text.length).toBeLessThan(LONG.length * 0.4);
    expect(summary.kept).toBeLessThanOrEqual(MAX_SENTENCES);
    expect(summary.of).toBe(9);
  });

  it('picks the sentences about his role rather than his contract', () => {
    const summary = summariseOutlook(LONG, { name: 'Owen Fitzgerald' })!;
    expect(summary.text).toContain('130 targets in an every-down role');
    expect(summary.text).not.toContain('under contract through 2028');
    expect(summary.text).not.toContain('fourth-round pick in 2022');
  });

  /* The fallback the brief asks for, in each of the ways it is reached. */
  describe('declining, which is always allowed', () => {
    it('leaves a short outlook alone', () => {
      const short = 'He is the clear starter. The backup is unproven. Health is the only question.';
      expect(summariseOutlook(short)).toBeNull();
    });

    it('declines when nothing in it bears on a draft pick', () => {
      const chatter = [
        'He grew up in Ohio and went to school there.',
        'His brother played in the league for a decade.',
        'The city has been good to him and he says so often.',
        'He bought a house near the facility last spring.',
      ].join(' ');
      expect(summariseOutlook(chatter)).toBeNull();
    });

    it('declines rather than return something barely shorter', () => {
      const two = [
        'He should open the year as the every-down back with all the goal-line touches available to him.',
        'The offensive line returns four starters and he is healthy after a full camp of practices.',
        'His workload projects near 300 carries with a meaningful target share out of the backfield.',
        'A committee is possible but nobody on the roster has taken a meaningful snap at the position.',
      ].join(' ');
      // Every sentence is relevant and there are only four, so a "summary"
      // would be most of it.
      const summary = summariseOutlook(two);
      if (summary) expect(summary.text.length).toBeLessThanOrEqual(two.length * 0.55);
    });

    it('says nothing about nothing', () => {
      expect(summariseOutlook('')).toBeNull();
      expect(summariseOutlook('   ')).toBeNull();
    });
  });

  it('is deterministic', () => {
    const a = summariseOutlook(LONG, { name: 'Owen Fitzgerald' });
    const b = summariseOutlook(LONG, { name: 'Owen Fitzgerald' });
    expect(a).toEqual(b);
  });

  /**
   * The property that makes this safe without a language model: nothing is
   * composed. Every character printed can be found in the source.
   */
  it('never writes a word the provider did not', () => {
    for (const name of ['Owen Fitzgerald', undefined]) {
      const summary = summariseOutlook(LONG, { name });
      if (!summary) continue;
      for (const sentence of splitSentences(summary.text)) {
        expect(LONG).toContain(sentence);
      }
    }
  });
});
