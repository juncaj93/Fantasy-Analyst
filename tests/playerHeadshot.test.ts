/**
 * The one place a portrait's URL is built, held to the three rules that keep it
 * from ever drawing the wrong person.
 *
 * The component that consumes this is covered in `e2e/player-face.spec.ts`,
 * against a real browser, because "the box does not move" and "a failed load
 * shows initials" are facts about layout and network rather than about a
 * string. What is left here is the string, and it is worth its own file for one
 * reason: this is the only step in the feature that could be *silently* wrong.
 * A missing portrait is visible; a portrait keyed on the wrong thing is a
 * confident picture of somebody else.
 */

import { describe, expect, it } from 'vitest';
import { playerHeadshotUrl, playerInitials } from '../src/core/players/headshot.ts';

describe('playerHeadshotUrl', () => {
  it('builds Sleeper’s own path for a numeric player id', () => {
    expect(playerHeadshotUrl('4046')).toBe('https://sleepercdn.com/content/nfl/players/4046.jpg');
    expect(playerHeadshotUrl('1001')).toBe('https://sleepercdn.com/content/nfl/players/1001.jpg');
  });

  it('refuses a team defence, because a club is not a person', () => {
    // Sleeper keys defences by the club abbreviation, so these are real
    // `player_id`s. A portrait request for one is a request for a picture that
    // does not exist and should never leave the browser.
    for (const code of ['CHI', 'GB', 'SF', 'DEF', 'LAR']) {
      expect(playerHeadshotUrl(code), `${code} asked for a player portrait`).toBeNull();
    }
  });

  it('refuses a defence even when its id is numeric', () => {
    /*
      The rule that does not depend on a provider's key format.

      Live Sleeper keys defences by club abbreviation, so the digits rule above
      already covers production data. This repository's own demo seed does not:
      `1030` is Jacksonville's defence. A rule that holds only because one
      source happens to format its keys a certain way is a rule waiting to be
      broken by a fixture, so the position is checked as well.
    */
    for (const position of ['DEF', 'DST', 'D/ST', 'def', ' def ']) {
      expect(playerHeadshotUrl('1030', position), `${position} asked for a player portrait`).toBeNull();
    }
    // And the same id without the position is still a URL, so the digits rule
    // has not quietly been replaced by this one.
    expect(playerHeadshotUrl('1030')).toBe('https://sleepercdn.com/content/nfl/players/1030.jpg');
  });

  it('a real position never suppresses a portrait', () => {
    for (const position of ['QB', 'RB', 'WR', 'TE', 'K', 'FLEX', '', null, undefined]) {
      expect(playerHeadshotUrl('4046', position), `${position} lost its portrait`).toBe(
        'https://sleepercdn.com/content/nfl/players/4046.jpg',
      );
    }
  });

  it('refuses anything that is not entirely digits', () => {
    // Not trimmed into something that looks like it worked: an id from another
    // vocabulary is an id this convention has no answer for.
    for (const id of ['4046x', 'x4046', '40-46', '00-0035229', ' 4046 x', '4046.jpg', '4.6', '-4046']) {
      expect(playerHeadshotUrl(id), `${id} was accepted as a player id`).toBeNull();
    }
  });

  it('answers null for a missing id rather than a path with a hole in it', () => {
    expect(playerHeadshotUrl('')).toBeNull();
    expect(playerHeadshotUrl('   ')).toBeNull();
    expect(playerHeadshotUrl(null)).toBeNull();
    expect(playerHeadshotUrl(undefined)).toBeNull();
  });

  it('takes the id and nothing else — no name ever reaches the URL', () => {
    // The rule that stops two players sharing a face. There is no overload that
    // accepts a name, and the id is passed through untouched.
    expect(playerHeadshotUrl('4046')).toContain('/4046.jpg');
    expect(playerHeadshotUrl('4046')).not.toMatch(/[a-z]+-[a-z]+/);
  });

  it('never carries anything but the id — no query, no session, no league', () => {
    const url = new URL(playerHeadshotUrl('4046')!);
    expect(url.search, 'a portrait URL grew a query string').toBe('');
    expect(url.hash).toBe('');
    expect(url.origin).toBe('https://sleepercdn.com');
    expect(url.protocol, 'portraits must not be fetched over plain http').toBe('https:');
  });

  it('surrounding whitespace is trimmed, not treated as a different player', () => {
    expect(playerHeadshotUrl(' 4046 ')).toBe('https://sleepercdn.com/content/nfl/players/4046.jpg');
  });
});

describe('playerInitials', () => {
  it('takes the first and last initial of a normal name', () => {
    expect(playerInitials('Marcus Vance')).toBe('MV');
    expect(playerInitials('Devin Okafor')).toBe('DO');
  });

  it('uses the first and last of three or more words, not the first two', () => {
    expect(playerInitials('Amon Ra St. Brown')).toBe('AB');
  });

  it('drops a generational suffix, which is not a surname', () => {
    expect(playerInitials('Marvin Harrison Jr.')).toBe('MH');
    expect(playerInitials('Odell Beckham Jr')).toBe('OB');
    expect(playerInitials('Robert Griffin III')).toBe('RG');
  });

  it('takes two letters from a single-word name', () => {
    expect(playerInitials('Ochocinco')).toBe('OC');
  });

  it('ignores punctuation rather than printing it', () => {
    expect(playerInitials("Ja'Marr Chase")).toBe('JC');
    expect(playerInitials('D.K. Metcalf')).toBe('DM');
  });

  it('handles a name written in a non-Latin script', () => {
    // `\p{L}` rather than `A-Za-z`: stripping non-ASCII would empty the word
    // and fall through to a blank box for a name that is perfectly readable.
    expect(playerInitials('Ödegaard Ñuñez')).toBe('ÖÑ');
  });

  it('renders nothing at all when there is no name to read', () => {
    // An empty box is honest. A `?` is a state the reader has to interpret.
    expect(playerInitials('')).toBe('');
    expect(playerInitials('   ')).toBe('');
    expect(playerInitials(null)).toBe('');
    expect(playerInitials(undefined)).toBe('');
    expect(playerInitials('Jr.')).toBe('');
  });

  it('is deterministic, so the same player falls back the same way everywhere', () => {
    const once = playerInitials('Marcus Vance');
    for (let i = 0; i < 5; i++) expect(playerInitials('Marcus Vance')).toBe(once);
  });
});
