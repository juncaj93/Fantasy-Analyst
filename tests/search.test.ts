/**
 * What the search field matches.
 *
 * The rules are small and the failures are all the same shape: a real player
 * the user typed the name of, who did not come up. Each case below is one of
 * those, written down before it can happen on a draft clock.
 */

import { describe, expect, it } from 'vitest';
import { matchesQuery } from '../src/web/search.ts';

describe('matching a typed query against a name', () => {
  it('matches nobody in particular when nothing is typed', () => {
    expect(matchesQuery('Kai Brennan', '')).toBe(true);
    expect(matchesQuery('Kai Brennan', '   ')).toBe(true);
  });

  it('matches a prefix of either name', () => {
    expect(matchesQuery('Kai Brennan', 'kai')).toBe(true);
    expect(matchesQuery('Kai Brennan', 'bren')).toBe(true);
  });

  it('matches the middle of a name, not only its start', () => {
    // A surname typed from memory rarely starts where the field does.
    expect(matchesQuery('Nate Kowalski', 'walski')).toBe(true);
  });

  it('does not care what order the words came in', () => {
    expect(matchesQuery('Kai Brennan', 'brennan kai')).toBe(true);
    expect(matchesQuery('Kai Brennan', 'kai brennan')).toBe(true);
  });

  it('ignores case on both sides', () => {
    expect(matchesQuery('Kai Brennan', 'KAI')).toBe(true);
    expect(matchesQuery('KAI BRENNAN', 'kai')).toBe(true);
  });

  it('ignores punctuation, which is how initials get typed', () => {
    expect(matchesQuery('D.J. Moore', 'dj')).toBe(true);
    expect(matchesQuery('D.J. Moore', 'd.j.')).toBe(true);
    expect(matchesQuery("Ja'Marr Chase", 'jamarr')).toBe(true);
    expect(matchesQuery('Amon-Ra St. Brown', 'amonra')).toBe(true);
    expect(matchesQuery('Amon-Ra St. Brown', 'st brown')).toBe(true);
  });

  it('tolerates the extra spaces a thumb produces', () => {
    expect(matchesQuery('Kai Brennan', '  kai   bren ')).toBe(true);
  });

  it('requires every word, so a second one narrows rather than widens', () => {
    expect(matchesQuery('Kai Brennan', 'kai mbeki')).toBe(false);
    expect(matchesQuery('Silas Mbeki', 'kai mbeki')).toBe(false);
  });

  /*
   * Reversed deliberately, and this is the one assertion in the file that
   * changed rather than being added to.
   *
   * It used to read `expect(matchesQuery('Kai Brennan', 'brennen')).toBe(false)`
   * — not because anybody wanted a misspelled surname to find nothing, but
   * because a substring test cannot tell a typo from a stranger and the test
   * was written to describe what the code did. A one-letter slip on a surname
   * is the single most common thing a thumb does on a draft clock, and coming
   * back empty is the worst available answer.
   */
  it('forgives a one-letter slip on a word long enough to be sure about', () => {
    expect(matchesQuery('Kai Brennan', 'brennen')).toBe(true);
    expect(matchesQuery('Bijan Robinson', 'robnson')).toBe(true);
  });

  it('does not match somebody else', () => {
    expect(matchesQuery('Kai Brennan', 'zzz')).toBe(false);
    // Short words get no typo budget at all: at three letters, one edit reaches
    // most of the league, and a search that returns everybody has failed.
    expect(matchesQuery('Kai Brennan', 'zoe')).toBe(false);
    expect(matchesQuery('Kai Brennan', 'silas')).toBe(false);
  });
});
