/**
 * Reading the StartWho clipboard, against the real thing.
 *
 * `tests/fixtures/startwho-sample.txt` is a verbatim copy out of the My League
 * table — tabs, disclosure triangles, trailing "Last updated" line and all. It
 * is deliberately not tidied: the whole point of a direct adapter is that it
 * copes with what the page actually puts on the clipboard, and a fixture some
 * hand cleaned up would prove nothing about that.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureDateFrom,
  looksLikeStartWho,
  parseStartWho,
  StartWhoFormatError,
} from '../src/core/startWho/parse.ts';
import { parseSnapshot } from '../src/core/seasonImport/parse.ts';

const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures', 'startwho-sample.txt'), 'utf8');

describe('recognising the shape', () => {
  it('recognises a real StartWho paste', () => {
    expect(looksLikeStartWho(SAMPLE)).toBe(true);
  });

  it('does not claim an ordinary table', () => {
    expect(looksLikeStartWho('player,team,market,line\nJosh Allen,BUF,Passing TDs,32.5')).toBe(false);
  });

  it('does not claim prose', () => {
    expect(looksLikeStartWho('Gibbs is going to be great this year')).toBe(false);
  });

  it('needs both the markers and the detail rows, not either alone', () => {
    // Triangles with no detail lines is not a StartWho table.
    expect(looksLikeStartWho('▸\nJosh Allen\n▸\nJahmyr Gibbs')).toBe(false);
    // Detail lines with no triangles is somebody else's table.
    expect(looksLikeStartWho('RB1\tDetroit Lions\t292.0\nRB2\tAtlanta Falcons\t280.1')).toBe(false);
  });

  it('is still refused by the generic table reader, which is correct', () => {
    // The generic sniffer wants a delimiter on every line and this has tabs on
    // two lines in five. Loosening that to admit this shape would put every
    // other paste at risk, which is why this adapter exists separately.
    expect(() => parseSnapshot(SAMPLE)).toThrow();
  });
});

describe('reading the real sample', () => {
  const parsed = parseStartWho(SAMPLE);

  it('reads every record in the paste', () => {
    expect(parsed.rows).toHaveLength(20);
    expect(parsed.malformed).toEqual([]);
  });

  it('reads the fields off the fused detail line', () => {
    expect(parsed.rows[0]).toMatchObject({
      sourceRank: 1,
      playerName: 'Jahmyr Gibbs',
      team: 'Detroit Lions',
      position: 'RB',
      positionRank: 1,
      points: 292.0,
      sourceCount: '5/5',
    });
  });

  it('keeps names with apostrophes, periods, hyphens and suffixes intact', () => {
    const names = parsed.rows.map((r) => r.playerName);
    expect(names).toContain("Ja'Marr Chase");
    expect(names).toContain('Amon-Ra St. Brown');
    expect(names).toContain('A.J. Brown');
    expect(names).toContain('Kenneth Walker III');
    expect(names).toContain('Harold Fannin Jr.');
    expect(names).toContain("Wan'Dale Robinson");
    expect(names).toContain('K.C. Concepcion');
    expect(names).toContain('Jacory Croskey-Merritt');
  });

  it('splits the positional rank off the position', () => {
    const pierce = parsed.rows.find((r) => r.playerName === 'Alec Pierce');
    expect(pierce?.position).toBe('WR');
    expect(pierce?.positionRank).toBe(34);
  });

  it('reads the source ordinal without treating it as an order of points', () => {
    // Gibbs is 1st at 292.0 and Josh Allen is 14th at 386.1: StartWho's rank is
    // their own draft-value opinion, which is why it is never a ranking input.
    const gibbs = parsed.rows.find((r) => r.playerName === 'Jahmyr Gibbs');
    const allen = parsed.rows.find((r) => r.playerName === 'Josh Allen');
    expect(gibbs?.sourceRank).toBe(1);
    expect(allen?.sourceRank).toBe(14);
    expect(allen!.points).toBeGreaterThan(gibbs!.points);
  });

  it('reads the capture stamp the page prints', () => {
    expect(parsed.lastUpdated).toBe('Aug 22 at 9:01 AM');
    expect(captureDateFrom(parsed.lastUpdated, '2026')).toBe('2026-08-22');
  });

  it('keeps the source count without letting it mean anything yet', () => {
    expect(parsed.rows.find((r) => r.playerName === 'Alec Pierce')?.sourceCount).toBe('1/3');
    expect(parsed.rows.find((r) => r.playerName === 'Josh Allen')?.sourceCount).toBe('4/5');
  });
});

describe('records are cut on the marker, not by counting', () => {
  it('survives a record with a missing source count', () => {
    // A fixed five-line stride would go permanently out of phase here and every
    // row after it would be quietly wrong.
    const text = `1\t\n▸\nJahmyr Gibbs\nRB1\tDetroit Lions\t292.0\t\n2\t\n▸\nBijan Robinson\nRB2\tAtlanta Falcons\t280.1\t\n5/5`;
    const out = parseStartWho(text);
    expect(out.rows.map((r) => r.playerName)).toEqual(['Jahmyr Gibbs', 'Bijan Robinson']);
    expect(out.rows[1]?.points).toBe(280.1);
  });

  it('reports a record it cannot read rather than dropping it', () => {
    const text = `1\t\n▸\nJahmyr Gibbs\nRB1\tDetroit Lions\t292.0\t\n5/5\n2\t\n▸\nBroken Row\nnot a detail line\n3\t\n▸\nBijan Robinson\nRB2\tAtlanta Falcons\t280.1\t\n5/5`;
    const out = parseStartWho(text);
    expect(out.rows).toHaveLength(2);
    expect(out.malformed).toHaveLength(1);
    expect(out.malformed[0]?.reason).toMatch(/Broken Row/);
  });

  it('refuses a paste with no records at all', () => {
    expect(() => parseStartWho('just some words')).toThrow(StartWhoFormatError);
  });
});

describe('the capture date', () => {
  it('is null rather than a guess when the stamp cannot be read', () => {
    expect(captureDateFrom('sometime last week', '2026')).toBeNull();
    expect(captureDateFrom(null, '2026')).toBeNull();
  });

  it('takes its year from the season, since the page prints none', () => {
    expect(captureDateFrom('Sep 3 at 8:00 AM', '2026')).toBe('2026-09-03');
  });
});
