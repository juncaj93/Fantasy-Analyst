/**
 * The shared player search, at the resolution the old one could not reach.
 *
 * Two things are being tested and they fail in opposite directions. The
 * punctuation and typo cases are about a real player not coming up — the
 * expensive failure, because the user is on a clock and has no way to tell the
 * difference between "not in this app" and "spelled it differently". The
 * ranking cases are about the right player coming up eleventh, which on a phone
 * is the same thing.
 *
 * The negative cases matter as much as either. A fuzzy matcher that finds
 * everybody is not a feature.
 */

import { describe, expect, it } from 'vitest';
import { matchesQuery, prepareName, prepareQuery, rankByQuery, scoreName } from '../src/core/search/players.ts';

const tier = (name: string, query: string) => scoreName(prepareName(name), prepareQuery(query))?.tier ?? null;

describe('punctuation is not part of a name', () => {
  it('finds a hyphenated name typed without the hyphen, and vice versa', () => {
    // Both directions, because the old matcher failed both and for the same
    // reason: it squashed one side and split the other.
    expect(matchesQuery('Amon-Ra St. Brown', 'amon ra')).toBe(true);
    expect(matchesQuery('Amon-Ra St. Brown', 'amonra')).toBe(true);
    expect(matchesQuery('Amon Ra St Brown', 'amon-ra')).toBe(true);
  });

  it('finds an apostrophe name typed without it, and vice versa', () => {
    expect(matchesQuery("Ja'Marr Chase", 'jamarr')).toBe(true);
    expect(matchesQuery("Ja'Marr Chase", "ja'marr")).toBe(true);
    expect(matchesQuery('JaMarr Chase', "ja'marr")).toBe(true);
  });

  it('folds accents, so a name can be typed off an English keyboard', () => {
    expect(matchesQuery('José Ramírez', 'jose ramirez')).toBe(true);
    expect(matchesQuery('Jose Ramirez', 'josé')).toBe(true);
  });

  it('ignores initials punctuation and stray whitespace', () => {
    expect(matchesQuery('D.J. Moore', 'dj')).toBe(true);
    expect(matchesQuery('T.J. Hockenson', '  tj   hock ')).toBe(true);
  });
});

describe('a small typo is forgiven, a stranger is not', () => {
  it('forgives one edit on a word long enough to be sure about', () => {
    expect(matchesQuery('Bijan Robinson', 'robnson')).toBe(true);
    expect(matchesQuery('Puka Nacua', 'nacau')).toBe(true);
    expect(matchesQuery('Garrett Wilson', 'garret')).toBe(true);
  });

  it('gives short words no typo budget at all', () => {
    // Three letters and one edit reaches half the league. `joe` must not find
    // Zoe, and this is the guard that stops it.
    expect(matchesQuery('Zoe Carter', 'joe')).toBe(false);
    expect(matchesQuery('Jon Rivers', 'joe')).toBe(false);
  });

  it('will not stretch a short query over a long name', () => {
    // `chas` is a prefix of Chase and nothing else; it must not come back with
    // Charbonnet as a "misspelling" on the strength of four shared letters.
    expect(tier('Ja\'Marr Chase', 'chas')).toBe('word_prefix');
    expect(matchesQuery('Aaron Charbonnet', 'chas')).toBe(false);
  });

  it('still requires every word to find a home', () => {
    expect(matchesQuery('Kai Brennan', 'kai mbeki')).toBe(false);
    expect(matchesQuery('Silas Mbeki', 'kai mbeki')).toBe(false);
  });
});

describe('how a match was made decides where it ranks', () => {
  it('grades exact above prefix above word-prefix above substring above fuzzy', () => {
    expect(tier('Kai Brennan', 'kai brennan')).toBe('exact');
    expect(tier('Kai Brennan', 'kai bre')).toBe('prefix');
    expect(tier('Kai Brennan', 'bren')).toBe('word_prefix');
    expect(tier('Nate Kowalski', 'walski')).toBe('substring');
    expect(tier('Kai Brennan', 'brennen')).toBe('fuzzy');
  });

  it('is only as good as its weakest word', () => {
    // `bijan` is exact and `robnson` is a typo; the match as a whole is fuzzy,
    // which is what stops it outranking a literal hit on somebody else.
    expect(tier('Bijan Robinson', 'bijan robnson')).toBe('fuzzy');
  });
});

describe('ranking', () => {
  const board = [
    { name: 'William Robinson' },
    { name: 'Will Levis' },
    { name: 'Willis Gray' },
    { name: 'Kai Brennan' },
  ];

  it('puts the literal hits above the rest, in the board’s own order', () => {
    const out = rankByQuery(board, 'will', (p) => p.name).map((p) => p.name);
    // All three Wills match as word-prefixes; among equals the board's order
    // (which is ADP, or Draft Score, or whatever the screen was sorted by)
    // decides — search does not re-rank the board by string similarity.
    expect(out).toEqual(['William Robinson', 'Will Levis', 'Willis Gray']);
  });

  it('puts an exact hit first even when the board had it last', () => {
    const out = rankByQuery(board, 'will levis', (p) => p.name).map((p) => p.name);
    expect(out[0]).toBe('Will Levis');
  });

  it('never lets a typo outrank a literal match', () => {
    const pool = [{ name: 'Kai Brennen' }, { name: 'Kai Brennan' }];
    // "Brennan" is exact; "Brennen" is one edit away. The exact one wins even
    // though the board listed it second.
    const out = rankByQuery(pool, 'kai brennan', (p) => p.name).map((p) => p.name);
    expect(out[0]).toBe('Kai Brennan');
  });

  it('returns the list untouched when nothing is typed', () => {
    const out = rankByQuery(board, '   ', (p) => p.name).map((p) => p.name);
    expect(out).toEqual(board.map((p) => p.name));
  });

  it('drops what does not match', () => {
    const out = rankByQuery(board, 'brennan', (p) => p.name).map((p) => p.name);
    expect(out).toEqual(['Kai Brennan']);
  });
});
