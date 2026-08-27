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
  findSlice,
  parseBeatAdpPage,
  sliceJsonValue,
  sliceKey,
  toAdpImportFile,
} from '../src/core/adp/beatadp.ts';

/** Wrap JSON the way the page does: as an escaped literal inside a push call. */
function chunk(text: string): string {
  return `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
}

const HALF = 'SLEEPER|HALF_PPR|REDRAFT|1QB';
const FULL = 'SLEEPER|PPR|REDRAFT|1QB';
const ESPN = 'ESPN|PPR|REDRAFT|1QB';

const SLICES = [
  { platform: 'SLEEPER', scoringFormat: 'PPR', draftType: 'REDRAFT', qbType: '1QB', recordedAt: '2026-08-26', playerCount: 269 },
  { platform: 'ESPN', scoringFormat: 'PPR', draftType: 'REDRAFT', qbType: '1QB', recordedAt: '2026-08-26', playerCount: 294 },
  { platform: 'SLEEPER', scoringFormat: 'HALF_PPR', draftType: 'REDRAFT', qbType: '1QB', recordedAt: '2026-08-26', playerCount: 278 },
];

const PLAYERS = [
  { id: 585, fullName: 'Jahmyr Gibbs', position: 'RB', teamId: 'DET', adps: { [ESPN]: 1, [HALF]: 1.6, [FULL]: 1.2 } },
  { id: 535, fullName: 'Bijan Robinson', position: 'RB', teamId: 'ATL', adps: { [ESPN]: 2, [HALF]: 1.8 } },
  { id: 720, fullName: "Ja'Marr Chase", position: 'WR', teamId: 'CIN', adps: { [HALF]: 3.4, [ESPN]: 4 } },
  // A player one slice ranks and another does not.
  { id: 9, fullName: 'Tyler Allgeier', position: 'RB', teamId: 'ATL', adps: { [ESPN]: 140 } },
];

const PAGE =
  chunk(`{"heading":"comparison board","slices":${JSON.stringify(SLICES)},`) +
  chunk(`"players":${JSON.stringify(PLAYERS)}}`);

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
  it('reports every slice the page publishes, with the date it recorded them', () => {
    const { slices } = parseBeatAdpPage(PAGE);
    expect(slices.map(sliceKey)).toEqual([FULL, ESPN, HALF]);
    expect(slices[2]).toEqual({
      platform: 'SLEEPER',
      scoringFormat: 'HALF_PPR',
      draftType: 'REDRAFT',
      qbType: '1QB',
      recordedAt: '2026-08-26',
      playerCount: 278,
    });
  });

  it('reads every row with its per-slice ADP', () => {
    const { rows } = parseBeatAdpPage(PAGE);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      name: 'Jahmyr Gibbs',
      position: 'RB',
      team: 'DET',
      adps: { [ESPN]: 1, [HALF]: 1.6, [FULL]: 1.2 },
    });
  });

  it('returns nothing rather than guessing when the payload is absent', () => {
    const page = parseBeatAdpPage('<html><body>no data here</body></html>');
    expect(page.rows).toEqual([]);
    expect(page.slices).toEqual([]);
  });

  /**
   * The shape this parser was written against before 2026-08-16: a single
   * applied `filters` object and `rows` of `{ player, adps }` keyed by platform
   * alone. Reading it would mean importing PPR numbers as half PPR, because
   * nothing in that payload says which format the ADPs belong to any more.
   */
  it('reads nothing from the shape the page used to publish', () => {
    const old =
      chunk(`{"filters":{"scoringFormat":"HALF_PPR","draftType":"REDRAFT","qbType":"1QB"}}`) +
      chunk(`{"rows":[{"player":{"fullName":"Jahmyr Gibbs","position":"RB","teamId":"DET"},"adps":{"SLEEPER":1.6}}]}`);
    expect(parseBeatAdpPage(old)).toEqual({ slices: [], rows: [] });
  });

  it('skips a slice that cannot say what it is', () => {
    const page = parseBeatAdpPage(
      chunk('{"slices":[{"platform":"SLEEPER","scoringFormat":"HALF_PPR","draftType":"REDRAFT"}],"players":[]}'),
    );
    expect(page.slices).toEqual([]);
  });
});

describe('finding the slice a league drafts in', () => {
  const wanted = { platform: 'SLEEPER', scoringFormat: 'HALF_PPR', draftType: 'REDRAFT', qbType: '1QB' };

  it('finds the exact combination however it is spelled', () => {
    const { slices } = parseBeatAdpPage(PAGE);
    expect(findSlice(slices, { ...wanted, scoringFormat: 'half_ppr' })?.playerCount).toBe(278);
  });

  /** Never the nearest neighbour: a superflex board is not a 1QB board. */
  it('finds nothing rather than the closest published slice', () => {
    const { slices } = parseBeatAdpPage(PAGE);
    expect(findSlice(slices, { ...wanted, qbType: '2QB' })).toBeNull();
    expect(findSlice(slices, { ...wanted, draftType: 'DYNASTY' })).toBeNull();
    expect(findSlice(slices, { ...wanted, platform: 'YAHOO' })).toBeNull();
  });
});

describe('converting to an importable file', () => {
  it('orders by the chosen slice and numbers the ranks from that order', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, HALF));
    expect(rows.map((r: { name: string }) => r.name)).toEqual(['Jahmyr Gibbs', 'Bijan Robinson', "Ja'Marr Chase"]);
    expect(rows.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ team: 'DET', position: 'RB', adp: 1.6 });
  });

  /**
   * A player this slice has no ADP for is not a player it ranks last. Filling
   * the gap from another platform — or from the same platform in another
   * format — would mix sources inside one snapshot.
   */
  it('omits players the chosen slice does not rank', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, HALF));
    expect(rows.some((r: { name: string }) => r.name === 'Tyler Allgeier')).toBe(false);
  });

  /** The same platform in the wrong format is the failure this key prevents. */
  it('never reads a neighbouring format for the same platform', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, FULL));
    expect(rows).toEqual([{ name: 'Jahmyr Gibbs', team: 'DET', position: 'RB', adp: 1.2, rank: 1 }]);
  });

  it('can produce another slice on request', () => {
    const rows = JSON.parse(toAdpImportFile(parseBeatAdpPage(PAGE).rows, ESPN));
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toMatchObject({ name: 'Tyler Allgeier', adp: 140 });
  });
});
