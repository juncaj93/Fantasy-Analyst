import { describe, expect, it } from 'vitest';
import { canAutoApply, classifySentence, detectNegation, tallyDelta } from '../src/core/newsletter/classify.ts';

describe('positive rules', () => {
  const cases: [string, string][] = [
    ['Marcus Vance was named the starter for Week 1.', 'pos.named_starter'],
    ['He has been promoted to the top of the depth chart.', 'pos.promoted'],
    ['He is taking first-team reps in camp.', 'pos.first_team_reps'],
    ['He is expected to lead the backfield.', 'pos.expected_to_lead'],
    ['He will see an increased workload this season.', 'pos.increased_workload'],
    ['He was cleared to play on Sunday.', 'pos.cleared'],
    ['He returned to practice on Wednesday.', 'pos.returned_to_practice'],
    ['He signed a contract extension yesterday.', 'pos.extension'],
    ['He will be the featured back in this offense.', 'pos.featured'],
    ['He is getting goal-line work in camp.', 'pos.goal_line'],
    ['He has been a standout camp performer.', 'pos.standout_camp'],
  ];

  for (const [sentence, ruleId] of cases) {
    it(`classifies "${sentence.slice(0, 40)}..." as positive via ${ruleId}`, () => {
      const result = classifySentence(sentence);
      expect(result.polarity).toBe('positive');
      expect(result.matches.map((m) => m.ruleId)).toContain(ruleId);
      expect(result.magnitude).toBeGreaterThan(0);
    });
  }

  it('produces a deterministic template summary, not generated prose', () => {
    const result = classifySentence('He returned to practice on Wednesday.');
    expect(result.contextSummary).toBe('Returned to practice.');
  });
});

describe('negative rules', () => {
  const cases: [string, string][] = [
    ['He suffered a season-ending torn ACL.', 'neg.season_ending'],
    ['He will undergo surgery next week.', 'neg.surgery'],
    ['He was suspended for six games.', 'neg.suspended'],
    ['He is dealing with a hamstring injury.', 'neg.injured'],
    ['He had a setback in his recovery.', 'neg.setback'],
    ['He has been ruled out for Sunday.', 'neg.out'],
    ['He was limited in practice again.', 'neg.limited'],
    ['He was demoted to the second team.', 'neg.demoted'],
    ['He is working as a backup right now.', 'neg.backup'],
    ['The team will use a committee approach.', 'neg.committee'],
    ['He has been struggling all camp.', 'neg.struggling'],
    ['His role is unclear heading into the season.', 'neg.questionable_role'],
  ];

  for (const [sentence, ruleId] of cases) {
    it(`classifies "${sentence.slice(0, 40)}..." as negative via ${ruleId}`, () => {
      const result = classifySentence(sentence);
      expect(result.polarity).toBe('negative');
      expect(result.matches.map((m) => m.ruleId)).toContain(ruleId);
    });
  }

  /**
   * One piece of news counts once. Severity is still reported, so a torn ACL
   * stays distinguishable from a missed practice without outweighing it three
   * to one in the tally.
   */
  it('counts every piece of bad news as exactly one', () => {
    expect(classifySentence('He suffered a season-ending torn ACL.').magnitude).toBe(1);
    expect(classifySentence('He was suspended for six games.').magnitude).toBe(1);
    expect(classifySentence('He was limited in practice again.').magnitude).toBe(1);
  });

  it('still reports how serious the news is, separately from the count', () => {
    expect(classifySentence('He suffered a season-ending torn ACL.').severity).toBe(3);
    expect(classifySentence('He was limited in practice again.').severity).toBe(1);
  });

  it('counts good news as exactly one too', () => {
    expect(classifySentence('He was named the starter.').magnitude).toBe(1);
    expect(classifySentence('He was limited in practice again.').polarity).toBe('negative');
  });

  it('does not count news that is neutral or points both ways', () => {
    expect(classifySentence('The team held a walkthrough.').magnitude).toBe(0);
    const mixed = classifySentence('He returned to practice but is expected to split work in a committee.');
    expect(mixed.polarity).toBe('mixed');
    expect(mixed.magnitude).toBe(0);
  });
});

describe('negation handling', () => {
  it('does not classify "not expected to miss time" as negative', () => {
    const result = classifySentence('He is not expected to miss time.');
    expect(result.polarity).not.toBe('negative');
    expect(result.polarity).toBe('positive');
  });

  it('leans positive on "no longer limited"', () => {
    const result = classifySentence('He is no longer limited in practice.');
    expect(result.polarity).toBe('positive');
  });

  it('classifies "did not practice" as negative', () => {
    const result = classifySentence('He did not practice on Wednesday.');
    expect(result.polarity).toBe('negative');
    expect(result.matches.map((m) => m.ruleId)).toContain('neg.did_not_practice');
  });

  it('does not inherit a negative signal from "not concerned"', () => {
    const result = classifySentence('The team is not concerned about the injury report.');
    expect(result.polarity).not.toBe('negative');
  });

  it('flips a positive rule when negated', () => {
    const result = classifySentence('He is not expected to lead the backfield.');
    expect(result.polarity).toBe('negative');
  });

  it('does not let negation cross a clause boundary', () => {
    // The "not" belongs to the first clause; the practice news is unnegated.
    const result = classifySentence('He is not the starter, but he returned to practice.');
    const practiceMatch = result.matches.find((m) => m.ruleId === 'pos.returned_to_practice');
    expect(practiceMatch?.negated).toBe(false);
  });

  it('weakens magnitude for negation-derived polarity', () => {
    const result = classifySentence('He is no longer limited.');
    expect(result.magnitude).toBe(1);
  });

  it('detectNegation finds cues only inside the window', () => {
    const sentence = 'He was not limited';
    expect(detectNegation(sentence, sentence.indexOf('limited')).negated).toBe(true);
    const far = 'He was not a factor in week one two three four five six limited';
    expect(detectNegation(far, far.indexOf('limited')).negated).toBe(false);
  });
});

describe('mixed statements', () => {
  it('keeps contradictory news mixed instead of forcing a polarity', () => {
    const result = classifySentence('He returned to practice but is expected to split work.');
    expect(result.polarity).toBe('mixed');
    expect(result.magnitude).toBe(0);
  });

  it('marks mixed evidence low confidence so it must be reviewed', () => {
    const result = classifySentence('He returned to practice but is expected to split work.');
    expect(result.confidence).toBe('low');
    expect(canAutoApply(result)).toBe(false);
  });

  it('contributes zero to the tally', () => {
    expect(tallyDelta('mixed', 2)).toBe(0);
    expect(tallyDelta('neutral', 2)).toBe(0);
    expect(tallyDelta('positive', 2)).toBe(2);
    expect(tallyDelta('negative', 3)).toBe(-3);
  });

  it('summarises both sides of a mixed statement from templates only', () => {
    const result = classifySentence('He returned to practice but is expected to split work.');
    expect(result.contextSummary).toContain('Returned to practice.');
    expect(result.contextSummary).toContain('However');
  });
});

describe('confidence policy', () => {
  it('gives a clean single-signal sentence high confidence', () => {
    const result = classifySentence('He was named the starter.');
    expect(result.confidence).toBe('high');
    expect(canAutoApply(result)).toBe(true);
  });

  it('demotes hedged language to medium', () => {
    const result = classifySentence('He could see an expanded role this year.');
    expect(result.confidence).toBe('medium');
    expect(canAutoApply(result)).toBe(false);
  });

  it('demotes when two players share the sentence', () => {
    const result = classifySentence('He was named the starter.', { playersInSentence: 2 });
    expect(result.confidence).toBe('medium');
  });

  it('drops to low with more than two players', () => {
    const result = classifySentence('He was named the starter.', { playersInSentence: 3 });
    expect(result.confidence).toBe('low');
  });

  it('drops to low when identity is ambiguous', () => {
    const result = classifySentence('He was named the starter.', { identityAmbiguous: true });
    expect(result.confidence).toBe('low');
    expect(canAutoApply(result)).toBe(false);
  });

  it('returns neutral with no matched rule and no summary', () => {
    const result = classifySentence('The team travels to Denver on Sunday.');
    expect(result.polarity).toBe('neutral');
    expect(result.ruleId).toBeNull();
    expect(result.contextSummary).toBeNull();
  });

  it('is deterministic across repeated calls', () => {
    const sentence = 'He returned to practice but is expected to split work.';
    expect(JSON.stringify(classifySentence(sentence))).toBe(JSON.stringify(classifySentence(sentence)));
  });
});
