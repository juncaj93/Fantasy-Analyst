/**
 * Reading the Big Board off a page rather than out of an endpoint.
 *
 * The primary source publishes `Player | Position | Team | Round | Overall |
 * ADP | …` as an ordinary HTML table, and three of those columns sort exactly
 * like ADP without being it. `Overall` is the one that would do real damage: a
 * dense 1..500 run, which imports as a board that looks entirely plausible and
 * is a ranking.
 *
 * The other failure these guard is the one that arrives without warning — the
 * page is redesigned, or ships an empty shell and renders the board in the
 * browser — and the parser finds *something* table-shaped and imports it. Every
 * one of those cases has to throw with the headers it saw, because a DOG column
 * quietly filled from the wrong source is worse than no DOG column at all.
 */

import { describe, expect, it } from 'vitest';
import {
  findAdpTable,
  lastUpdatedFromHtml,
  parseBestBallTeamBuilder,
  parseBestBallTeamBuilderHtml,
  parseFour4Underdog,
  parseHtmlTables,
  parseLooseDate,
  validateRawAdp,
} from '../src/core/adp/underdog.ts';

/**
 * The Big Board as described: the real column order, real-looking averages,
 * and the two decoys sitting right beside the column that matters.
 */
function bigBoard(
  rows = 30,
  opts: { adpHeader?: string; lastUpdated?: string; extraTable?: boolean; blankAdp?: boolean } = {},
): string {
  const adpHeader = opts.adpHeader ?? 'ADP';
  const body = Array.from({ length: rows }, (_, i) => {
    const overall = i + 1;
    const adp = Math.round((1.4 + i * 1.9 + (i % 3) * 0.4) * 10) / 10;
    const round = Math.floor(i / 12) + 1;
    return `<tr>
      <td><a href="/p/${i}">Player ${overall}</a></td>
      <td>WR</td>
      <td>DET</td>
      <td>${round}.${String((i % 12) + 1).padStart(2, '0')}</td>
      <td>${overall}</td>
      <td>${opts.blankAdp ? '&mdash;' : adp}</td>
      <td>${(300 - i).toFixed(1)}</td>
    </tr>`;
  }).join('\n');

  const nav = opts.extraTable
    ? '<table><tr><th>Section</th><th>Link</th></tr><tr><td>Rankings</td><td>/r</td></tr></table>'
    : '';

  return `<!doctype html><html><head><title>2026 Underdog ADP Big Board</title></head><body>
    ${nav}
    <h1>2026 Underdog ADP Big Board (Top 500)</h1>
    <p>Last updated: ${opts.lastUpdated ?? 'August 17, 2026'}</p>
    <table class="big-board">
      <thead><tr>
        <th>Player</th><th>Position</th><th>Team</th>
        <th>Round</th><th>Overall</th><th>${adpHeader}</th><th>Projected Points</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </body></html>`;
}

describe('the Big Board, read off the page', () => {
  it('takes the ADP column and not the two beside it', () => {
    const { rows, headers } = parseBestBallTeamBuilderHtml(bigBoard());

    expect(rows).toHaveLength(30);
    expect(headers).toEqual(['Player', 'ADP']);
    // 1.4, not 1 (Overall) and not 1.01 (Round).
    expect(rows[0]).toMatchObject({ name: 'Player 1', position: 'WR', team: 'DET', adp: 1.4 });
    expect(rows.map((r) => r.adp)).not.toEqual(rows.map((_, i) => i + 1));
  });

  it('strips the markup inside a cell rather than importing it', () => {
    const { rows } = parseBestBallTeamBuilderHtml(bigBoard());
    expect(rows[0]!.name).toBe('Player 1');
    expect(rows.every((r) => !r.name.includes('<'))).toBe(true);
  });

  it('decodes the entities a name actually contains', () => {
    const html = bigBoard(30).replace('Player 1<', "D&#39;Andre O&amp;Neal<");
    const { rows } = parseBestBallTeamBuilderHtml(html);
    expect(rows.some((r) => r.name === "D'Andre O&Neal")).toBe(true);
  });

  it('finds the board among the other tables on the page', () => {
    const { rows } = parseBestBallTeamBuilderHtml(bigBoard(30, { extraTable: true }));
    expect(rows).toHaveLength(30);
  });

  it('reads the page as raw ADP once it is parsed', () => {
    const { rows, headers } = parseBestBallTeamBuilderHtml(bigBoard(60));
    const verdict = validateRawAdp(rows, headers);
    expect(verdict.valid).toBe(true);
    expect(verdict.sourceType).toBe('raw_adp');
  });

  it('sniffs page or JSON without being told which', () => {
    const fromPage = parseBestBallTeamBuilder(bigBoard());
    expect(fromPage.rows).toHaveLength(30);

    const fromJson = parseBestBallTeamBuilder(
      JSON.stringify({ updatedAt: '2026-08-17T00:00:00.000Z', players: [{ name: 'A', adp: 2.2 }] }),
    );
    expect(fromJson.rows).toEqual([{ name: 'A', team: null, position: null, adp: 2.2 }]);
  });
});

describe('what it refuses rather than guesses', () => {
  it('throws, naming the headers, when the board is gone', () => {
    const page = `<html><body><h1>2026 Underdog ADP Big Board</h1>
      <table><tr><th>Player</th><th>Overall</th></tr><tr><td>A</td><td>1</td></tr></table>
    </body></html>`;
    expect(() => parseBestBallTeamBuilderHtml(page)).toThrow(/no Big Board table/i);
    expect(() => parseBestBallTeamBuilderHtml(page)).toThrow(/Player \| Overall/);
  });

  it('throws on a page that renders its board in the browser', () => {
    const shell = '<html><body><div id="root"></div><script>renderBoard()</script></body></html>';
    expect(() => parseBestBallTeamBuilderHtml(shell)).toThrow(/no <table> elements at all/);
  });

  it('will not accept Overall dressed up as the ADP column', () => {
    // The header says ADP and the values are 1..N. The shape check is what
    // catches this, and it has to, because the name no longer can.
    const page = bigBoard(40).replace(/<td>(\d+\.\d)<\/td>\s*<td>\d+\.\d<\/td>/g, '<td>0</td><td>0</td>');
    const parsed = parseHtmlTables(page)[0]!;
    const found = findAdpTable([parsed])!;
    const rows = parsed.rows.map((cells, i) => ({
      name: cells[found.nameAt]!,
      team: null,
      position: null,
      adp: i + 1,
    }));
    const verdict = validateRawAdp(rows, ['Player', 'ADP']);
    expect(verdict.valid).toBe(false);
    expect(verdict.sourceType).toBe('ranking');
  });

  it('throws when the ADP column holds no numbers', () => {
    expect(() => parseBestBallTeamBuilderHtml(bigBoard(20, { blankAdp: true }))).toThrow(/held no usable numbers/);
  });
});

describe('when the source says its numbers are from', () => {
  it('reads the page’s own last-updated date', () => {
    const { snapshotAt } = parseBestBallTeamBuilderHtml(bigBoard(20, { lastUpdated: 'August 17, 2026' }));
    expect(snapshotAt).toBe('2026-08-17T00:00:00.000Z');
  });

  it('reads the three spellings a page like this uses', () => {
    expect(parseLooseDate('August 17, 2026')).toBe('2026-08-17T00:00:00.000Z');
    expect(parseLooseDate('Aug. 17th, 2026')).toBe('2026-08-17T00:00:00.000Z');
    expect(parseLooseDate('2026-08-17')).toBe('2026-08-17T00:00:00.000Z');
    expect(parseLooseDate('8/17/2026')).toBe('2026-08-17T00:00:00.000Z');
  });

  it('returns null rather than a confident wrong answer', () => {
    expect(parseLooseDate('some time last week')).toBeNull();
    expect(parseLooseDate('Smarch 40, 1804')).toBeNull();
    expect(lastUpdatedFromHtml('<html><body>no date here</body></html>')).toBeNull();
  });

  it('reports undated rather than substituting the fetch time', () => {
    const page = bigBoard(20).replace(/<p>Last updated:[^<]*<\/p>/, '');
    expect(parseBestBallTeamBuilderHtml(page).snapshotAt).toBeNull();
  });
});

describe('the 4for4 fallback, as a page', () => {
  const page = (headers: string[], values: number[][]) => `<html><head><title>Underdog ADP</title></head><body>
    <table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
    ${values
      .map((v, i) => `<tr><td>Player ${i + 1}</td>${v.map((n) => `<td>${n}</td>`).join('')}</tr>`)
      .join('')}
    </tbody></table></body></html>`;

  const adps = Array.from({ length: 20 }, (_, i) => [Math.round((1.5 + i * 2.3) * 10) / 10]);

  it('prefers a column that names Underdog', () => {
    const html = page(
      ['Player', 'ADP', 'Underdog ADP'],
      adps.map(([a]) => [a! + 9, a!]),
    );
    const { rows, headers } = parseFour4Underdog(html);
    expect(headers).toEqual(['Player', 'Underdog ADP']);
    expect(rows[0]!.adp).toBe(1.5);
  });

  it('accepts a lone ADP column on a page that says Underdog', () => {
    const { rows, headers } = parseFour4Underdog(page(['Player', 'ADP'], adps));
    expect(headers).toEqual(['Player', 'ADP']);
    expect(rows).toHaveLength(20);
  });

  it('refuses a lone ADP column on a page that does not', () => {
    const html = page(['Player', 'ADP'], adps).replace(/Underdog/g, 'Consensus');
    expect(() => parseFour4Underdog(html)).toThrow(/does not mention Underdog/);
  });

  it('refuses to choose between two unnamed ADP columns', () => {
    const html = page(
      ['Player', 'ADP', 'Avg ADP'],
      adps.map(([a]) => [a!, a! + 4]),
    );
    expect(() => parseFour4Underdog(html)).toThrow(/refusing to guess which one/);
  });

  it('still reads the CSV export, and still requires the Underdog column there', () => {
    const csv = ['Player,Team,Underdog ADP', ...adps.map(([a], i) => `Player ${i + 1},DET,${a}`)].join('\n');
    expect(parseFour4Underdog(csv).rows).toHaveLength(20);

    const consensus = csv.replace('Underdog ADP', 'ADP');
    expect(() => parseFour4Underdog(consensus)).toThrow(/no Underdog ADP column/);
  });
});
