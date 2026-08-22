/**
 * Reading a pasted preseason snapshot.
 *
 * The shapes below are the ones a person actually produces: a CSV download, the
 * tab-separated text a browser table copy puts on the clipboard, a pipe table,
 * and the canonical block the normalisation fallback returns wrapped in the
 * prose an assistant replies with.
 *
 * The most valuable test here is the one that fails: an input this cannot read
 * must say so, because a parser that guesses produces season lines nobody
 * published.
 */

import { describe, expect, it } from 'vitest';
import { buildSourceBlock, parseSnapshot, sniffDelimiter, SnapshotFormatError } from '../src/core/seasonImport/parse.ts';

const CSV = `player,team,position,market,line,over_price,under_price
Ja'Marr Chase,CIN,WR,Receiving Yards,1425.5,-115,-105
Bijan Robinson,ATL,RB,Rushing Yards,1250.5,-112,-108`;

// What a browser table copy actually puts on the clipboard.
const TSV = `Player\tTeam\tPos\tMarket\tLine\tOver\tUnder
Ja'Marr Chase\tCIN\tWR\tReceiving Yards\t1425.5\t-115\t-105
Bijan Robinson\tATL\tRB\tRushing Yards\t1250.5\t-112\t-108`;

const CANONICAL = `Here you go!

\`\`\`
PRESEASON_VEGAS_V1
META | season=2026 | source=Win With Odds | captured=2026-08-27
Ja'Marr Chase | CIN | WR | season_receiving_yards | 1425.5 | -115 | -105
Josh Allen | BUF | QB | season_pass_tds | 32.5 | -110 | -110
END_PRESEASON_VEGAS
\`\`\`

Let me know if you need anything else.`;

describe('delimiter sniffing', () => {
  it('recognises a clipboard table as tab-separated', () => {
    expect(sniffDelimiter(TSV)).toEqual({ delimiter: '\t', format: 'tsv' });
  });

  it('recognises a comma file as csv', () => {
    expect(sniffDelimiter(CSV)).toEqual({ delimiter: ',', format: 'csv' });
  });

  it('is not fooled by a comma inside a name', () => {
    // The tab appears the same number of times on every line; the comma does
    // not. Consistency is what separates a separator from punctuation.
    const text = `Player\tMarket\tLine\nSmith, Jr.\tReceiving Yards\t900.5\nJones\tReceiving Yards\t800.5`;
    expect(sniffDelimiter(text)?.delimiter).toBe('\t');
  });
});

describe('parsing the shapes a person produces', () => {
  it('reads a CSV download', () => {
    const out = parseSnapshot(CSV);
    expect(out.format).toBe('csv');
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({ player: "Ja'Marr Chase", team: 'CIN', market: 'Receiving Yards', line: '1425.5' });
  });

  it('reads a tab-separated clipboard copy', () => {
    const out = parseSnapshot(TSV);
    expect(out.format).toBe('tsv');
    expect(out.rows).toHaveLength(2);
    expect(out.rows[1]).toMatchObject({ player: 'Bijan Robinson', position: 'RB', line: '1250.5' });
  });

  it('reads the canonical block out of an assistant reply, and ignores the prose', () => {
    const out = parseSnapshot(CANONICAL);
    expect(out.format).toBe('canonical');
    expect(out.rows).toHaveLength(2);
    // The surrounding sentences are not rows, and the code fence is not a row.
    expect(out.rows.map((r) => r.player)).toEqual(["Ja'Marr Chase", 'Josh Allen']);
  });

  it('takes provenance from the canonical META line', () => {
    expect(parseSnapshot(CANONICAL).meta).toEqual({
      season: '2026',
      source: 'Win With Odds',
      capturedAt: '2026-08-27',
    });
  });

  it('reports a short canonical row instead of padding it', () => {
    const out = parseSnapshot(`PRESEASON_VEGAS_V1\nJosh Allen | BUF\nEND_PRESEASON_VEGAS`);
    expect(out.rows).toHaveLength(0);
    expect(out.malformed[0]?.reason).toMatch(/at least 5 fields/);
  });

  it('keeps optional odds absent rather than inventing them', () => {
    const out = parseSnapshot(`player,market,line\nJosh Allen,Passing TDs,32.5`);
    expect(out.rows[0]?.overPrice).toBeNull();
    expect(out.rows[0]?.underPrice).toBeNull();
  });
});

describe('an unreadable paste fails loudly', () => {
  it('refuses prose with no columns', () => {
    // The failure mode that matters: this must not become one row per line.
    expect(() => parseSnapshot('Chase is going to have a big year I think')).toThrow(SnapshotFormatError);
  });

  it('refuses an empty paste', () => {
    expect(() => parseSnapshot('   ')).toThrow(/nothing was pasted/);
  });

  it('names the missing column rather than guessing which one it was', () => {
    let message = '';
    try {
      parseSnapshot(`player,team,position\nJosh Allen,BUF,QB`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/market column/);
    expect(message).toMatch(/line column/);
  });

  it('tells the reader what to do next', () => {
    let message = '';
    try {
      parseSnapshot('just some words here');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Copy for ChatGPT|header row/);
  });
});

describe('the block handed to the assistant', () => {
  it('carries the provenance with the data', () => {
    const block = buildSourceBlock({
      season: '2026',
      source: 'Win With Odds',
      capturedAt: '2026-08-27',
      raw: 'Chase 1425.5',
    });
    expect(block).toContain('PRESEASON_VEGAS_SOURCE_V1');
    expect(block).toContain('Season: 2026');
    expect(block).toContain('Captured: 2026-08-27');
    expect(block).toContain('Chase 1425.5');
    expect(block.trimEnd().endsWith('END_PRESEASON_VEGAS_SOURCE')).toBe(true);
  });
});
