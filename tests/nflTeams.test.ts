/**
 * The club table, and the promise that every club has a mark to draw.
 *
 * The point of these tests is that a missing logo is found here, once, rather
 * than in production one team at a time when a player from that team finally
 * reaches the top of somebody's board. So the coverage test does not check that
 * the table has 32 rows — it checks that all 32 rows resolve to a file that is
 * actually on disk, which is the thing that can silently stop being true.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { NFL_TEAMS, nflTeam, nflTeamLogoUrl, nflTeamName } from '../src/core/nfl/teams.ts';

/** Where `publicDir` assets sit before Vite copies them to the site root. */
const publicRoot = fileURLToPath(new URL('../src/web/public', import.meta.url));

/** The league, spelled out independently of the table under test. */
const CANONICAL = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
];

describe('the club table', () => {
  it('carries all 32 clubs and nothing else', () => {
    expect(NFL_TEAMS.map((t) => t.code).sort()).toEqual([...CANONICAL].sort());
  });

  it('gives every club a distinct, non-empty display name', () => {
    const names = NFL_TEAMS.map((t) => t.name);
    expect(new Set(names).size).toBe(32);
    for (const name of names) expect(name.length).toBeGreaterThan(3);
  });

  it('names the current Washington and Los Angeles clubs', () => {
    // The three that a stale logo set gets wrong, called out by name.
    expect(nflTeamName('WAS')).toBe('Washington Commanders');
    expect(nflTeamName('LAR')).toBe('Los Angeles Rams');
    expect(nflTeamName('LV')).toBe('Las Vegas Raiders');
  });
});

describe('logo coverage', () => {
  /*
   * 32 of 32, checked against the filesystem. If an asset is deleted, renamed
   * or never generated, this fails before anything ships — which is the whole
   * reason the mapping is a table and not a string template scattered across
   * five screens.
   */
  it('resolves every club to a mark that exists on disk', () => {
    const missing: string[] = [];
    for (const team of NFL_TEAMS) {
      const url = nflTeamLogoUrl(team.code);
      expect(url).toBe(`/logos/nfl/${team.code.toLowerCase()}.webp`);
      if (!existsSync(`${publicRoot}${url}`)) missing.push(team.code);
    }
    expect(missing).toEqual([]);
  });
});

describe('folding provider vocabularies onto Sleeper codes', () => {
  /*
   * These all arrive from real sources — ADP exports, historical records,
   * newsletters — and every one of them is the same club as the canonical code
   * beside it. They resolve through the identity layer's alias table rather
   * than a second one living next to the logos.
   */
  const aliases: [input: string, code: string][] = [
    ['JAC', 'JAX'],
    ['JAG', 'JAX'],
    ['OAK', 'LV'],
    ['LVR', 'LV'],
    ['WSH', 'WAS'],
    ['WFT', 'WAS'],
    ['SD', 'LAC'],
    ['STL', 'LAR'],
    ['LA', 'LAR'],
    ['KAN', 'KC'],
    ['NWE', 'NE'],
    ['SFO', 'SF'],
    ['TAM', 'TB'],
    ['GNB', 'GB'],
  ];

  for (const [input, code] of aliases) {
    it(`reads ${input} as ${code}`, () => {
      expect(nflTeam(input)?.code).toBe(code);
      expect(nflTeamLogoUrl(input)).toBe(`/logos/nfl/${code.toLowerCase()}.webp`);
    });
  }

  it('is indifferent to case and stray punctuation', () => {
    expect(nflTeam('chi')?.code).toBe('CHI');
    expect(nflTeam(' Chi ')?.code).toBe('CHI');
    expect(nflTeam('N.E.')?.code).toBe('NE');
  });
});

describe('when there is no club', () => {
  /*
   * Four different ways of having no team, all of which want the same answer:
   * nothing to draw, so the row shows what it always showed.
   */
  for (const input of [null, undefined, '', 'FA', 'FREE', 'NONE']) {
    it(`resolves ${JSON.stringify(input)} to nothing`, () => {
      expect(nflTeam(input)).toBeNull();
      expect(nflTeamName(input)).toBeNull();
      expect(nflTeamLogoUrl(input)).toBeNull();
    });
  }

  it('refuses to invent a club for a code it does not know', () => {
    // A defunct franchise and a provider typo: neither becomes a logo.
    expect(nflTeam('STLR')).toBeNull();
    expect(nflTeam('XYZ')).toBeNull();
    expect(nflTeamLogoUrl('XYZ')).toBeNull();
  });
});
