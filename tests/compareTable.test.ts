/**
 * The Compare table adds up, and Base says where it came from (13 October 2026).
 */
import { describe, expect, it } from 'vitest';
import { baseExplanation, compareTable } from '../src/web/compareTable.ts';
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

/* A full market: Vegas 12.34, news +0.26, opponent -0.41, uncertainty -0.5. */
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
  components: [c('vegas', 12.34), c('news_recent', 0.26), c('matchup_role', -0.41), c('uncertainty', -0.5), c('status', 0)],
  score: 11.69,
  decision: { points: 11.69, basis: 'market', base: 12.34, adjustments: -0.65 },
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
  components: [c('vegas', 2.0), c('news_recent', -0.05, { shownValue: -0.3 }), c('uncertainty', -1.0)],
  score: 0.95,
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

describe('the Compare table', () => {
  const { rows, score } = compareTable([priced, published, fragment, out]);

  it('has Base, Recent news, Opponent, Uncertainty, then Score', () => {
    expect(rows.map((r) => r.label)).toEqual(['Base', 'Recent news', 'Opponent', 'Uncertainty']);
  });

  it('adds up to Score on screen, column by column', () => {
    for (const i of [0, 1]) {
      const total = rows.reduce((sum, row) => sum + (row.cells[i]!.text === '–' ? 0 : Number(row.cells[i]!.text.replace('−', '-'))), 0);
      expect(total.toFixed(1), `column ${i}`).toBe(score[i]!.text);
    }
    expect(score.map((s) => s.text)).toEqual(['11.7', '8.9', '–', 'Out']);
  });

  it('starts a published week from Sleeper, never from the Vegas fragment', () => {
    expect(rows[0]!.cells[1]!.text).toBe('9.2');
    expect(rows[3]!.cells[1]!.text, 'a published week carries no market charge').toBe('–');
  });

  it('gives a fragment and an Out player no number at all', () => {
    expect(rows[0]!.cells[2]!.text).toBe('–');
    expect(rows[0]!.cells[3]!.text).toBe('–');
  });
});

describe('where Base came from', () => {
  it('lists every priced line and what it is worth', () => {
    expect(baseExplanation(priced)).toBe(
      'Vegas: Rush yards 68.5 = 6.9 pts, Receptions line 2.5 = 1.3 pts, Rec yards 16.5 = 1.7 pts, TD price 43% = 2.6 pts.',
    );
  });

  it('says when Sleeper’s projection is the base, and why', () => {
    expect(baseExplanation(published)).toBe(
      "Sleeper projection: 9.2 pts. Only part of his market is priced (TD price 33% = 2.0 pts; no receiving yards, receptions line yet), so Sleeper's whole week is used instead.",
    );
  });

  it('says there is no number yet for a fragment, and Out for a ruled-out player', () => {
    expect(baseExplanation(fragment)).toMatch(/no number yet/);
    expect(baseExplanation(out)).toBe('Out this week, so no number.');
  });
});
