/**
 * Parsing beatadp.com's inline ADP payload.
 *
 * The fixture below is the real shape, trimmed: the page streams its table into
 * the HTML as RSC flight chunks, and every chunk is a JavaScript string literal
 * that has to be decoded before any of it is JSON.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFlight,
  parseBeatAdpPage,
  sliceJsonValue,
  toAdpImportFile,
} from '../src/core/adp/beatadp.ts';

/** Wrap JSON the way the page does: as an escaped literal inside a push call. */
function chunk(text: string): string {
  return `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
}

const ROWS = [
  { player: { id: 585, fullName: 'Jahmyr Gibbs', position: 'RB', teamId: 'DET' }, adps: { ESPN: 1, SLEEPER: 1.6 } },
  { player: { id: 535, fullName: 'Bijan Robinson', position: 'RB', teamId: 'ATL' }, adps: { ESPN: 2, SLEEPER: 1.8 } },
  { player: { id: 720, fullName: "Ja'Marr Chase", position: 'WR', teamId: 'CIN' }, adps: { SLEEPER: 3.4, ESPN: 4 } },
  // A player one platform ranks and another does not.
  { player: { id: 9, fullName: 'Tyler Allgeier', position: 'RB', teamId: 'ATL' }, adps: { ESPN: 140 } },
];

const PAGE =
  chunk(`{"filters":{"scoringFormat":"HALF_PPR","draftType":"REDRAFT","qbType":"1QB"}}`) +
  chunk(`{"rows":${JSON.stringify(ROWS)}}`);

describe('decoding the flight payload', () => {
  it('joins the chunks back into one payload', () => {
    const flight = decodeFlight(chunk('{"a":1}') + chunk('{"b":2}'));
    expect(flight).toBe('{"a":1}{"b":2}');
  });

  it('ignores a chunk it cannot decode rather than losing the rest', () => {
    const broken = '<script>self.__next_f.push([1,"unterminated])</script>';
    expect(decodeFlight(broken + chunk('{"b":2}'))).toBe('{"b":2}');
  });

  /** A brace inside a name must not be read as the end of the value. */
  it('respects strings and escapes when slicing a value', () => {
    const text = '{"name":"a}b\\"c","n":1}';
    expect(sliceJsonValue(text, 0)).toBe(text);
  });

  it('reports a truncated value rather than returning a broken slice', () => {
    expect(sliceJsonValue('{"a":[1,2', 0)).toBeNull();
  });
});

describe('parsing the page', () => {
  it('reports the filters the page actually applied', () => {
    expect(parseBeatAdpPage(PAGE).filters).toEqual({
      scoringFormat: 'HALF_PPR',
      draftType: 'REDRAFT',
      qbType: '1QB',
    });
  });

  it('reads every row with its per-platform ADP', () => {
    const { rows } = parseBeatAdpPage(PAGE);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', adps: { ESPN: 1, SLEEPER: 1.6 } });
  });

  it('returns nothing rather than guessing when the payload is absent', () => {
    const page = parseBeatAdpPage('<html><body>no data here</body></html>');
    expect(page.rows).toEqual([]);
    expect(page.filters).toBeNull();
  });
});

describe('converting to an importable file', () => {
  it('orders by the chosen platform and numbers the ranks from that order', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, 'SLEEPER'));
    expect(rows.map((r: { name: string }) => r.name)).toEqual(['Jahmyr Gibbs', 'Bijan Robinson', "Ja'Marr Chase"]);
    expect(rows.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ team: 'DET', position: 'RB', adp: 1.6 });
  });

  /**
   * A player Sleeper has no ADP for is not a player Sleeper ranks last. Filling
   * the gap from another platform would mix sources inside one snapshot.
   */
  it('omits players the chosen platform does not rank', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, 'SLEEPER'));
    expect(rows.some((r: { name: string }) => r.name === 'Tyler Allgeier')).toBe(false);
  });

  it('can produce another platform on request', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, 'ESPN'));
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toMatchObject({ name: 'Tyler Allgeier', adp: 140 });
  });
});
