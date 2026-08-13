import { describe, expect, it } from 'vitest';
import { fileHash, importAdpSnapshot, parseAdpFile, parseCsv } from '../src/core/adp/import.ts';
import { TEST_INDEX } from './helpers/players.ts';

const CSV = `name,position,team,adp,rank
Bijan Robinson,RB,ATL,2.4,1
Puka Nacua,WR,LAR,7.8,2
"Harrison Jr., Marvin",WR,ARI,11.2,3
D'Andre Swift,RB,CHI,44.1,4
Chris Johnson,RB,KC,88.0,5
Nonexistent Player,WR,SEA,120.5,6
`;

const JSON_FILE = JSON.stringify({
  players: [
    { firstName: 'Bijan', lastName: 'Robinson', slotName: 'RB', team: 'ATL', adp: 2.4 },
    { firstName: 'Puka', lastName: 'Nacua', slotName: 'WR', team: 'LAR', adp: 7.8 },
  ],
});

describe('parseCsv', () => {
  it('parses quoted fields containing commas', () => {
    const rows = parseCsv('a,b\n"one, two",three');
    expect(rows[1]).toEqual(['one, two', 'three']);
  });

  it('handles escaped quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')[1]).toEqual(['say "hi"']);
  });

  it('handles CRLF line endings and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops fully blank rows', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toHaveLength(2);
  });
});

describe('parseAdpFile', () => {
  it('reads CSV into keyed records', () => {
    const records = parseAdpFile(CSV);
    expect(records).toHaveLength(6);
    expect(records[0]?.['name']).toBe('Bijan Robinson');
  });

  it('reads JSON arrays under common wrapper keys', () => {
    expect(parseAdpFile(JSON_FILE)).toHaveLength(2);
  });

  it('reads a bare JSON array', () => {
    expect(parseAdpFile('[{"name":"Puka Nacua","adp":7.8}]')).toHaveLength(1);
  });
});

describe('importAdpSnapshot', () => {
  const result = importAdpSnapshot(CSV, TEST_INDEX, { capturedAt: '2026-08-13T09:00:00.000Z' });

  it('resolves players through the canonical identity ladder', () => {
    const bijan = result.rows.find((r) => r.sourceName === 'Bijan Robinson');
    expect(bijan?.playerId).toBe('10');
    expect(bijan?.match.status).toBe('matched');
  });

  it('uses team and position to break a name collision', () => {
    const cj = result.rows.find((r) => r.sourceName === 'Chris Johnson');
    expect(cj?.playerId).toBe('1'); // the KC RB, not the BUF WR
  });

  it('preserves original source values alongside the resolved id', () => {
    const swift = result.rows.find((r) => r.sourceName === "D'Andre Swift");
    expect(swift?.adp).toBe(44.1);
    expect(swift?.sourceTeam).toBe('CHI');
    expect(swift?.raw['rank']).toBe('4');
  });

  it('resolves a "Last, First" export spelling', () => {
    const row = result.rows.find((r) => r.sourceName.startsWith('Harrison Jr.'));
    expect(row?.playerId).toBe('4');
  });

  it('keeps unmatched rows instead of dropping them', () => {
    const missing = result.rows.find((r) => r.sourceName === 'Nonexistent Player');
    expect(missing).toBeDefined();
    expect(missing?.playerId).toBeNull();
    expect(result.unmatchedCount).toBe(1);
  });

  it('records the capture timestamp for freezing', () => {
    expect(result.capturedAt).toBe('2026-08-13T09:00:00.000Z');
  });

  it('produces a stable file hash for idempotent re-import', () => {
    expect(result.fileHash).toBe(importAdpSnapshot(CSV, TEST_INDEX).fileHash);
    expect(result.fileHash).not.toBe(importAdpSnapshot(`${CSV}extra,row,x,1,7\n`, TEST_INDEX).fileHash);
  });

  it('imports JSON with separate first/last name columns', () => {
    const json = importAdpSnapshot(JSON_FILE, TEST_INDEX);
    expect(json.matchedCount).toBe(2);
  });

  it('skips rows with no name or no adp/rank, reporting why', () => {
    const res = importAdpSnapshot('name,adp\n,12\nPuka Nacua,\n', TEST_INDEX);
    expect(res.rows).toHaveLength(0);
    expect(res.skipped).toHaveLength(2);
    expect(res.skipped[0]?.reason).toContain('name');
    expect(res.skipped[1]?.reason).toContain('adp');
  });

  it('tolerates alternative column names', () => {
    const res = importAdpSnapshot('player,pos,average_pick\nPuka Nacua,WR,7.8\n', TEST_INDEX);
    expect(res.matchedCount).toBe(1);
    expect(res.rows[0]?.adp).toBe(7.8);
  });

  it('strips stray characters from numeric columns', () => {
    const res = importAdpSnapshot('player,adp\nPuka Nacua,"7.8 "\n', TEST_INDEX);
    expect(res.rows[0]?.adp).toBe(7.8);
  });

  it('is deterministic', () => {
    const a = importAdpSnapshot(CSV, TEST_INDEX, { capturedAt: '2026-08-13T09:00:00.000Z' });
    const b = importAdpSnapshot(CSV, TEST_INDEX, { capturedAt: '2026-08-13T09:00:00.000Z' });
    expect(JSON.stringify(a.rows.map((r) => [r.sourceName, r.playerId, r.adp]))).toBe(
      JSON.stringify(b.rows.map((r) => [r.sourceName, r.playerId, r.adp])),
    );
  });
});

describe('fileHash', () => {
  it('differs for different content and matches for identical content', () => {
    expect(fileHash('a')).toBe(fileHash('a'));
    expect(fileHash('a')).not.toBe(fileHash('b'));
  });
});
