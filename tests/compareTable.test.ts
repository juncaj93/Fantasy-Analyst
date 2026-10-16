/**
 * The Compare table adds up (13 October 2026), and since 15 October 2026 the
 * Vegas lines sit under Base in place of the paragraph that explained it.
 */
import { describe, expect, it } from 'vitest';
import { compareTable, lineRows, yardsCell } from '../src/web/compareTable.ts';
import type { StartSitEvaluation } from '../src/web/api.ts';

type Component = StartSitEvaluation['components'][number];
const c = (key: string, value: number, extra: Partial<Component> = {}): Component => ({ key, label: key, display: `${key} said so`, value, unknown: false, ...extra });

function evaluation(over: Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>): StartSitEvaluation {
  return {
    position: 'WR',
    team: 'TB',
    expectation: { points: null, contributions: [], missingMarkets: [], coverage: 0, notes: [] },
    components: [],
    score: null,
    ruledOut: false,
    ...over,
  } as StartSitEvaluation;
}

/* A full market: Vegas 12.34, news +0.26, opponent -0.41. Uncertainty is text only since `startsit@6`. */
const priced = evaluation({
  playerId: 'w',
  name: 'Kenneth Walker',
  position: 'RB',
  expectation: {
    points: 12.34,
    contributions: [
      { market: 'rush_yards', line: 68.5, points: 6.85, detail: '' },
      { market: 'receptions', line: 2.5, points: 1.25, detail: '' },
      { market: 'receiving_yards', line: 16.5, points: 1.65, detail: '' },
      { market: 'anytime_td', line: null, points: 2.59, detail: '', probability: 0.43 },
    ],
    missingMarkets: [],
    coverage: 1,
    notes: [],
  },
  components: [
    c('vegas', 12.34),
    c('news_recent', 0.26),
    c('matchup_role', -0.41),
    c('uncertainty', 0, { textOnly: true }),
    c('status', 0),
  ],
  score: 12.19,
  decision: { points: 12.19, basis: 'market', base: 12.34, adjustments: -0.15 },
} as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);

/* Part of a market, and Sleeper's 9.2 used as the base: Egbuka's shape. */
const published = evaluation({
  playerId: 'e',
  name: 'Emeka Egbuka',
  expectation: {
    points: 2.0,
    contributions: [{ market: 'anytime_td', line: null, points: 2.0, detail: '', probability: 0.33 }],
    missingMarkets: ['receiving_yards', 'receptions'],
    coverage: 0.33,
    notes: [],
  },
  components: [c('vegas', 2.0), c('news_recent', -0.05, { shownValue: -0.3 }), c('uncertainty', 0, { textOnly: true })],
  score: 1.95,
  decision: { points: 8.9, basis: 'published', base: 9.2, adjustments: -0.3 },
} as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);

/* A fragment and nothing published: Tre' Harris. */
const fragment = evaluation({
  playerId: 't',
  name: "Tre' Harris",
  expectation: {
    points: 1.6,
    contributions: [{ market: 'anytime_td', line: null, points: 1.6, detail: '', probability: 0.27 }],
    missingMarkets: ['receiving_yards', 'receptions'],
    coverage: 0.33,
    notes: [],
  },
  components: [c('vegas', 1.6)],
  score: 1.6,
  decision: { points: 1.6, basis: 'partial', base: 1.6, adjustments: 0 },
} as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);

const out = evaluation({
  playerId: 's',
  name: 'Will Shipley',
  position: 'RB',
  ruledOut: true,
  components: [c('status', -99)],
  score: -97,
  decision: { points: -97, basis: 'published', base: 2, adjustments: -99 },
} as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);

const numberRows = (rows: ReturnType<typeof compareTable>['rows']) => rows.filter((r) => r.kind !== 'line');

describe('the Compare table', () => {
  const { rows, score } = compareTable([priced, published, fragment, out]);

  it('has Base, the Vegas lines, Recent news, Opponent, then Score, and no Uncertainty', () => {
    expect(rows.map((r) => r.label)).toEqual(['Base', 'Yards', 'Catches', 'TD %', 'Recent news', 'Opponent']);
    expect(rows.map((r) => r.kind)).toEqual(['base', 'line', 'line', 'line', 'nudge', 'nudge']);
  });

  it('adds up to Score on screen, column by column, without the lines', () => {
    for (const i of [0, 1]) {
      const total = numberRows(rows).reduce((sum, row) => sum + (row.cells[i]!.text === '–' ? 0 : Number(row.cells[i]!.text.replace('−', '-'))), 0);
      expect(total.toFixed(1), `column ${i}`).toBe(score[i]!.text);
    }
    expect(score.map((s) => s.text)).toEqual(['12.2', '8.9', '–', 'Out']);
  });

  it('starts a published week from Sleeper, never from the Vegas fragment', () => {
    expect(rows[0]!.cells[1]!.text).toBe('9.2');
  });

  it('gives a fragment and an Out player no number at all', () => {
    expect(rows[0]!.cells[2]!.text).toBe('–');
    expect(rows[0]!.cells[3]!.text).toBe('–');
  });

  it('greys Base and Score on Sleeper’s week, and only there', () => {
    expect(rows[0]!.cells.map((x) => x.muted === true)).toEqual([false, true, false, false]);
    expect(score.map((x) => x.muted === true)).toEqual([false, true, false, false]);
  });

  it('marks Base and Score as Sleeper fallbacks, and never a missing line or a partial total', () => {
    expect(rows[0]!.cells.map((x) => x.sleeper === true)).toEqual([false, true, false, false]);
    expect(score.map((x) => x.sleeper === true)).toEqual([false, true, false, false]);
    for (const row of rows.filter((r) => r.kind === 'line')) for (const c of row.cells) expect(c.sleeper).toBeUndefined();
  });

  it('keeps a posted line in normal colour under a grey number, and greys the missing ones', () => {
    const [yards, catches, td] = rows.slice(1, 4);
    // Egbuka: only his touchdown price is posted.
    expect(td!.cells[1]).toMatchObject({ text: '33%' });
    expect(td!.cells[1]!.muted).toBeFalsy();
    expect(yards!.cells[1]).toMatchObject({ text: '–', muted: true });
    expect(catches!.cells[1]).toMatchObject({ text: '–', muted: true });
  });
});

describe('the Vegas lines', () => {
  it('adds rushing and receiving yards into one number when both are posted', () => {
    expect(yardsCell(priced)).toEqual({ value: 85, text: '85.0' });
    const r = lineRows([priced])!;
    expect(r.map((x) => x.cells[0]!.text)).toEqual(['85.0', '2.5', '43%']);
  });

  it('shows a back’s partial total in grey when only one yard line is posted', () => {
    const rushOnly = evaluation({
      playerId: 'r',
      name: 'Rush Only',
      position: 'RB',
      expectation: {
        points: 6.85,
        contributions: [{ market: 'rush_yards', line: 68.5, points: 6.85, detail: '' }],
        missingMarkets: ['receiving_yards', 'receptions', 'anytime_td'],
        coverage: 0.25,
        notes: [],
      },
    } as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);
    expect(yardsCell(rushOnly)).toEqual({ value: 68.5, text: '68.5', muted: true });
  });

  it('reads a receiver’s yards from his receiving line alone, in normal colour', () => {
    const wr = evaluation({
      playerId: 'n',
      name: 'Nico Collins',
      position: 'WR',
      expectation: {
        points: 12.3,
        contributions: [
          { market: 'receiving_yards', line: 71.5, points: 7.15, detail: '' },
          { market: 'receptions', line: 5.5, points: 2.75, detail: '' },
          { market: 'anytime_td', line: null, points: 2.3, detail: '', probability: 0.38 },
        ],
        missingMarkets: [],
        coverage: 1,
        notes: [],
      },
    } as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);
    expect(lineRows([wr]).map((x) => x.cells[0])).toEqual([
      { value: 71.5, text: '71.5' },
      { value: 5.5, text: '5.5' },
      { value: 0.38, text: '38%' },
    ]);
  });

  it('greys a dash for a line nobody posted', () => {
    expect(yardsCell(fragment)).toEqual({ value: null, text: '–', muted: true });
  });

  const qb = (id: string, name: string, lines: [string, number][]) =>
    evaluation({
      playerId: id,
      name,
      position: 'QB',
      expectation: {
        points: 18,
        contributions: lines.map(([market, line]) => ({ market, line, points: 1, detail: '' })),
        missingMarkets: ['pass_yards', 'pass_tds', 'rush_yards'].filter((m) => !lines.some(([k]) => k === m)),
        coverage: lines.length / 3,
        notes: [],
      },
    } as Partial<StartSitEvaluation> & Pick<StartSitEvaluation, 'playerId' | 'name'>);
  const love = qb('l', 'Jordan Love', [
    ['pass_yards', 245.5],
    ['pass_tds', 1.5],
    ['rush_yards', 12.5],
  ]);
  const nix = qb('x', 'Bo Nix', [
    ['pass_yards', 228.5],
    ['pass_tds', 1.5],
  ]);

  it('gives a group of QBs Pass yds, Pass TD and Rush yds', () => {
    const r = lineRows([love, nix]);
    expect(r.map((x) => x.label)).toEqual(['Pass yds', 'Pass TD', 'Rush yds']);
    expect(r.map((x) => x.cells.map((c) => c.text))).toEqual([
      ['245.5', '228.5'],
      ['1.5', '1.5'],
      ['12.5', '–'],
    ]);
    expect(r[2]!.cells[1]!.muted, 'Nix has no rushing line posted').toBe(true);
  });

  it('gives a mixed group the generic rows: a QB’s yards are passing yards, his catches and TD % a plain dash', () => {
    const r = lineRows([love, priced]);
    expect(r.map((x) => x.label)).toEqual(['Yards', 'Catches', 'TD %']);
    expect(r.map((x) => x.cells[0])).toEqual([{ value: 245.5, text: '245.5' }, { value: null, text: '–' }, { value: null, text: '–' }]);
    expect(r.map((x) => x.cells[1]!.text)).toEqual(['85.0', '2.5', '43%']);
  });

  it('gives a defence plain dashes: it has no player lines', () => {
    const dst = evaluation({ playerId: 'd', name: 'Jets Defense', position: 'DEF' });
    expect(lineRows([dst, priced]).map((x) => x.cells[0])).toEqual([
      { value: null, text: '–' },
      { value: null, text: '–' },
      { value: null, text: '–' },
    ]);
  });
});
