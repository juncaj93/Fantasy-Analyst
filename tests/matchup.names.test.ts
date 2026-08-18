/**
 * `J. Hurts`, and the ambiguity that occasionally makes it useless.
 *
 * A matchup row has about seventy pixels for a name at 360px. Shortening is not
 * a nicety there, it is the difference between a lineup that fits on one screen
 * and one that does not — and a shortening that produces two identical rows is
 * worse than the full names it replaced.
 */

import { describe, expect, it } from 'vitest';
import { shortName, shortNamesFor, splitName } from '../src/core/matchup/names.ts';

describe('the short form', () => {
  it('is first initial and last name', () => {
    expect(shortName('Jalen Hurts')).toBe('J. Hurts');
    expect(shortName('Justin Jefferson')).toBe('J. Jefferson');
  });

  it('keeps a compound surname whole', () => {
    expect(shortName('Amon-Ra St. Brown')).toBe('A. St. Brown');
    expect(shortName('Jaxon Smith-Njigba')).toBe('J. Smith-Njigba');
    expect(shortName('Van Jefferson')).toBe('V. Jefferson');
  });

  it('drops a suffix, which is never what tells two players apart on a row', () => {
    expect(shortName('Marvin Harrison Jr.')).toBe('M. Harrison');
    expect(shortName('Odell Beckham Jr')).toBe('O. Beckham');
  });

  it('leaves a one-token name alone rather than printing a bare initial', () => {
    expect(shortName('Ravens')).toBe('Ravens');
    expect(shortName('')).toBe('');
  });

  it('splits a name into the parts a row needs', () => {
    expect(splitName('Amon-Ra St. Brown')).toEqual({ first: 'Amon-Ra', last: 'St. Brown', suffix: null });
    expect(splitName('Marvin Harrison Jr.')).toEqual({ first: 'Marvin', last: 'Harrison', suffix: 'Jr.' });
  });
});

describe('disambiguation across one matchup', () => {
  it('leaves everybody short when nobody collides', () => {
    const names = shortNamesFor([
      { playerId: '1', name: 'Jalen Hurts' },
      { playerId: '2', name: 'Justin Jefferson' },
      { playerId: '3', name: 'Bijan Robinson' },
    ]);
    expect([...names.values()]).toEqual(['J. Hurts', 'J. Jefferson', 'B. Robinson']);
  });

  /** Two letters of the given name, which is the cheapest thing that works. */
  it('spends one more letter when two initials collide', () => {
    const names = shortNamesFor([
      { playerId: '1', name: 'Jalen Hurts' },
      { playerId: '2', name: 'Justin Hurts' },
    ]);
    expect(names.get('1')).toBe('Ja. Hurts');
    expect(names.get('2')).toBe('Ju. Hurts');
  });

  it('falls back to the whole name when two letters are not enough', () => {
    const names = shortNamesFor([
      { playerId: '1', name: 'Jamal Williams' },
      { playerId: '2', name: 'Jamar Williams' },
    ]);
    expect(names.get('1')).toBe('Jamal Williams');
    expect(names.get('2')).toBe('Jamar Williams');
  });

  it('reaches for the suffix only when it is the last thing left', () => {
    const names = shortNamesFor([
      { playerId: '1', name: 'Marvin Harrison' },
      { playerId: '2', name: 'Marvin Harrison Jr.' },
    ]);
    expect(new Set(names.values()).size).toBe(2);
    expect([...names.values()].some((n) => n.includes('Jr.'))).toBe(true);
  });

  /**
   * Deterministic in the input order.
   *
   * The list arrives sorted by id before it reaches here, so the same matchup
   * renders the same names on every poll — a name that changed between two
   * renders of an unchanged state would be the same jitter §5 forbids for the
   * win probability, in a place nobody would think to look for it.
   */
  it('gives the same answer whatever order the players arrive in', () => {
    const players = [
      { playerId: 'b', name: 'Justin Hurts' },
      { playerId: 'a', name: 'Jalen Hurts' },
      { playerId: 'c', name: 'Bijan Robinson' },
    ];
    const forward = shortNamesFor(players);
    const backward = shortNamesFor([...players].reverse());
    for (const player of players) expect(forward.get(player.playerId)).toBe(backward.get(player.playerId));
  });

  it('never leaves a player without a name', () => {
    const names = shortNamesFor([
      { playerId: '1', name: 'Jalen Hurts' },
      { playerId: '2', name: '' },
      { playerId: '3', name: 'Ravens' },
    ]);
    expect(names.size).toBe(3);
    expect(names.get('3')).toBe('Ravens');
  });
});
