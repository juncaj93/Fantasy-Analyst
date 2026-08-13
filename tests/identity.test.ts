import { describe, expect, it } from 'vitest';
import {
  PlayerIndex,
  editDistance,
  initialForm,
  normalizeName,
  normalizePosition,
  normalizeTeam,
  normalizedSurname,
  resolvePlayer,
} from '../src/core/identity/index.ts';
import { TEST_INDEX, player } from './helpers/players.ts';

describe('normalizeName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('  Justin   Jefferson ')).toBe('justin jefferson');
  });

  it('removes apostrophes without inserting a space', () => {
    expect(normalizeName("D'Andre Swift")).toBe('dandre swift');
    expect(normalizeName('D’Andre Swift')).toBe('dandre swift');
  });

  it('strips generational suffixes', () => {
    expect(normalizeName('Marvin Harrison Jr.')).toBe('marvin harrison');
    expect(normalizeName('Odell Beckham Jr')).toBe('odell beckham');
    expect(normalizeName('Robert Griffin III')).toBe('robert griffin');
  });

  it('normalizes hyphens and periods to spaces', () => {
    expect(normalizeName('Amon-Ra St. Brown')).toBe('amon ra st brown');
    expect(normalizeName('J.K. Dobbins')).toBe('j k dobbins');
  });

  it('strips accents for lookup', () => {
    expect(normalizeName('José Ramírez')).toBe('jose ramirez');
  });

  it('never strips a single-token name', () => {
    expect(normalizeName('Jr')).toBe('jr');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });

  it('is stable across repeated application', () => {
    const once = normalizeName('Amon-Ra St. Brown');
    expect(normalizeName(once)).toBe(once);
  });
});

describe('surname and initial helpers', () => {
  it('extracts the surname after suffix stripping', () => {
    expect(normalizedSurname('Marvin Harrison Jr.')).toBe('harrison');
  });

  it('builds the initial form', () => {
    expect(initialForm('Justin Jefferson')).toBe('j jefferson');
    expect(initialForm('Prince')).toBe('');
  });
});

describe('normalizeTeam / normalizePosition', () => {
  it('maps team aliases to Sleeper codes', () => {
    expect(normalizeTeam('JAC')).toBe('JAX');
    expect(normalizeTeam('WSH')).toBe('WAS');
    expect(normalizeTeam('LA')).toBe('LAR');
    expect(normalizeTeam('oak')).toBe('LV');
  });

  it('treats free agency as no team', () => {
    expect(normalizeTeam('FA')).toBe('');
    expect(normalizeTeam(null)).toBe('');
  });

  it('maps position aliases', () => {
    expect(normalizePosition('D/ST')).toBe('DEF');
    expect(normalizePosition('PK')).toBe('K');
    expect(normalizePosition('hb')).toBe('RB');
  });
});

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('nacua', 'nacua')).toBe(0);
  });

  it('counts single edits', () => {
    expect(editDistance('nacua', 'nakua')).toBe(1);
  });

  it('treats an adjacent transposition as one edit', () => {
    expect(editDistance('puka nacua', 'puka nacau')).toBe(1);
  });

  it('bails out beyond the bound', () => {
    expect(editDistance('abc', 'xyzxyzxyz', 2)).toBeGreaterThan(2);
  });
});

describe('resolvePlayer — matching ladder', () => {
  it('1. matches on exact external id first', () => {
    const result = resolvePlayer({ name: 'wrong name entirely', externalIds: { sleeper: '3' } }, TEST_INDEX);
    expect(result.status).toBe('matched');
    expect(result.playerId).toBe('3');
    expect(result.method).toBe('external_id');
  });

  it('2. disambiguates a duplicate name using team', () => {
    const result = resolvePlayer({ name: 'Chris Johnson', team: 'BUF' }, TEST_INDEX);
    expect(result.status).toBe('matched');
    expect(result.playerId).toBe('2');
    expect(result.method).toBe('name_team');
  });

  it('3. disambiguates a duplicate name using position', () => {
    const result = resolvePlayer({ name: 'Chris Johnson', position: 'RB' }, TEST_INDEX);
    expect(result.status).toBe('matched');
    expect(result.playerId).toBe('1');
    expect(result.method).toBe('name_position');
  });

  it('4. matches a known alias', () => {
    const result = resolvePlayer({ name: 'B. Rob' }, TEST_INDEX);
    expect(result.status).toBe('matched');
    expect(result.playerId).toBe('10');
    expect(result.method).toBe('alias');
  });

  it('5. matches a unique exact name', () => {
    const result = resolvePlayer({ name: 'Puka Nacua' }, TEST_INDEX);
    expect(result.status).toBe('matched');
    expect(result.method).toBe('name_unique');
  });

  it('returns ambiguous — never a guess — for a duplicate name with no hint', () => {
    const result = resolvePlayer({ name: 'Chris Johnson' }, TEST_INDEX);
    expect(result.status).toBe('ambiguous');
    expect(result.playerId).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.reason).toContain('2 active players');
  });

  it('handles punctuation and suffix variants of the same player', () => {
    for (const variant of ['Marvin Harrison Jr.', 'Marvin Harrison', 'marvin harrison jr']) {
      const result = resolvePlayer({ name: variant }, TEST_INDEX);
      expect(result.playerId, variant).toBe('4');
    }
  });

  it('matches an accented name written without accents', () => {
    expect(resolvePlayer({ name: 'Jose Ramirez' }, TEST_INDEX).playerId).toBe('6');
  });

  it('returns unmatched for an unknown player instead of forcing a match', () => {
    const result = resolvePlayer({ name: 'Zebediah Nonexistent' }, TEST_INDEX);
    expect(result.status).toBe('unmatched');
    expect(result.playerId).toBeNull();
  });

  it('routes a fuzzy near-miss to review rather than committing it', () => {
    // "Puka Nacau" is one edit away but carries no team/position hint.
    const result = resolvePlayer({ name: 'Puka Nacau' }, TEST_INDEX);
    expect(result.status).toBe('ambiguous');
    expect(result.candidates[0]?.playerId).toBe('11');
    expect(result.reason).toContain('needs review');
  });

  it('auto-commits a fuzzy match only with matching team AND position', () => {
    const result = resolvePlayer({ name: 'Puka Nacau', team: 'LAR', position: 'WR' }, TEST_INDEX);
    expect(result.status).toBe('matched');
    expect(result.method).toBe('fuzzy');
    expect(result.playerId).toBe('11');
  });

  it('refuses to auto-commit a fuzzy match when the team disagrees', () => {
    const result = resolvePlayer({ name: 'Puka Nacau', team: 'SEA', position: 'WR' }, TEST_INDEX);
    expect(result.status).toBe('ambiguous');
  });

  it('prefers the active player when an inactive one shares the name space', () => {
    const result = resolvePlayer({ name: 'Tyler Boyd' }, TEST_INDEX);
    expect(result.playerId).toBe('7');
  });

  it('flags a duplicate external id as ambiguous', () => {
    const index = new PlayerIndex([
      player({ id: 'a', fullName: 'One Guy', externalIds: { odds: 'X1' } }),
      player({ id: 'b', fullName: 'Two Guy', externalIds: { odds: 'X1' } }),
    ]);
    const result = resolvePlayer({ name: 'One Guy', externalIds: { odds: 'X1' } }, index);
    expect(result.status).toBe('ambiguous');
  });

  it('handles an empty name without throwing', () => {
    expect(resolvePlayer({ name: '' }, TEST_INDEX).status).toBe('unmatched');
  });
});
