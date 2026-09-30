/**
 * The rebuilt Compare sheet's rules (`reference-mockup-v2.html`, 30 September 2026).
 */
import { describe, expect, it } from 'vitest';
import { gapSentence, matchupCell, propRows, signed, splitStatus, standoutNote } from '../src/web/compareLayout.ts';

const harvey = {
  playerId: 'harvey',
  position: 'RB',
  expectation: {
    contributions: [
      { market: 'rush_yards', line: 61.5 },
      { market: 'receiving_yards', line: 12.5 },
      { market: 'anytime_td', line: null, probability: 0.24 },
    ],
    missingMarkets: ['receptions'],
  },
};
const andrews = {
  playerId: 'andrews',
  position: 'TE',
  expectation: { contributions: [{ market: 'receiving_yards', line: 38.5 }, { market: 'receptions', line: 3.5 }], missingMarkets: ['anytime_td'] },
};

describe('propRows', () => {
  it('draws only the markets these positions are priced on, in reading order', () => {
    expect(propRows([andrews, harvey]).map((r) => r.label)).toEqual(['Rush yards', 'Rec yards', 'Receptions', 'Anytime TD']);
  });

  it('tells a market that does not apply from one nobody posted, and never fakes either', () => {
    const rows = propRows([andrews, harvey]);
    const rush = rows.find((r) => r.market === 'rush_yards')!;
    expect(rush.cells).toEqual([{ kind: 'na' }, { kind: 'line', text: '61.5' }]);
    const receptions = rows.find((r) => r.market === 'receptions')!;
    expect(receptions.cells).toEqual([{ kind: 'line', text: '3.5' }, { kind: 'missing' }]);
    const td = rows.find((r) => r.market === 'anytime_td')!;
    expect(td.cells).toEqual([{ kind: 'missing' }, { kind: 'line', text: '24%' }]);
  });

  it('has nothing to draw for two defences', () => {
    const def = { playerId: 'd', position: 'DEF', expectation: { contributions: [], missingMarkets: [] } };
    expect(propRows([def, { ...def, playerId: 'e' }])).toEqual([]);
  });
});

describe('the signals', () => {
  it('splits a designation from its detail', () => {
    expect(splitStatus('Questionable · practised fully')).toEqual({ word: 'Questionable', detail: 'practised fully' });
    expect(splitStatus('Questionable')).toEqual({ word: 'Questionable', detail: null });
    expect(splitStatus(null)).toBeNull();
  });

  it('words a matchup the way the Team chip rates it', () => {
    expect(matchupCell({ opponent: 'TEN', rating: 'tough' })).toEqual({ text: 'Tough · TEN', tone: 'bad' });
    expect(matchupCell({ opponent: 'SF', rating: 'soft' })).toEqual({ text: 'Favorable · SF', tone: 'good' });
    expect(matchupCell({ opponent: 'SF', rating: 'insufficient_data' })).toEqual({ text: 'SF', tone: 'unknown' });
  });

  it('prints a real minus sign', () => {
    expect(signed(-1.62)).toBe('−1.6');
    expect(signed(1.7)).toBe('+1.7');
  });
});

describe('gapSentence', () => {
  it('decomposes a published-week gap into its two halves', () => {
    const s = gapSentence({
      leader: { name: 'RJ Harvey', decision: { points: 9.11, basis: 'published', base: 9.53, adjustments: -0.42 } },
      runnerUp: { name: 'Mark Andrews', decision: { points: 7.08, basis: 'published', base: 7.22, adjustments: -0.14 } },
      margin: 2.03,
      drivers: [],
      projectionShortfall: null,
    });
    expect(s).toBe('Harvey leads by 2.0: a 9.5 week against 7.2 before adjustments, −0.4 against −0.1 for status, usage and matchup.');
  });

  it('names the largest factors on a market gap', () => {
    const s = gapSentence({
      leader: { name: 'Mark Andrews', decision: { points: 3.9, basis: 'market', base: 5, adjustments: -1.1 } },
      runnerUp: { name: 'RJ Harvey', decision: { points: -1.6, basis: 'market', base: 0.5, adjustments: -2.1 } },
      margin: 5.4,
      drivers: [{ label: 'Vegas market expectation', delta: 4.5 }, { label: 'Opportunity', delta: 1.7 }],
      projectionShortfall: 2.3,
    });
    expect(s).toBe('Andrews leads by 5.4 despite a lower raw projection. Most of the gap: vegas market expectation +4.5, opportunity +1.7.');
  });
});

describe('standoutNote', () => {
  const two = (a: string | null, b: string | null) => [
    { name: 'Mark Andrews', statusWord: a, locked: false },
    { name: 'RJ Harvey', statusWord: b, locked: false },
  ];

  it('says one thing when both players share a designation', () => {
    expect(standoutNote({ players: two('Questionable', 'Questionable'), lateSwap: null, coverageNote: 'coverage differs' })).toBe(
      'Both players are Questionable this week. Check the injury report before your lineup locks.',
    );
  });

  it('prefers a locked game over everything', () => {
    const players = [{ name: 'A', statusWord: null, locked: true }, { name: 'B', statusWord: null, locked: false }];
    expect(standoutNote({ players, lateSwap: null, coverageNote: 'x' })).toBe('A has already kicked off, so that spot is fixed.');
  });

  it('falls back to the coverage note, then to one designation, then to nothing', () => {
    expect(standoutNote({ players: two('Questionable', null), lateSwap: null, coverageNote: 'coverage differs' })).toBe('coverage differs');
    expect(standoutNote({ players: two('Questionable', null), lateSwap: null, coverageNote: null })).toMatch(/^Mark Andrews is questionable/);
    expect(standoutNote({ players: two(null, null), lateSwap: null, coverageNote: null })).toBeNull();
  });
});
