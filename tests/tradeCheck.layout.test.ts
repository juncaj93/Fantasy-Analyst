/**
 * The shape of a trade-check result row, and the rule it exists to keep.
 *
 * Past rounds regressed when a third number was added to a row and the layout
 * spread across the whole width. A browser test measures that at four widths
 * (`e2e/trade-check.spec.ts`); this is the cheaper half that fails before a
 * browser is started: a row is a label, **one** figure and a sentence, and the
 * sentence never becomes a second column of numbers.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { horizonLine, resultRows, signed, sideName } from '../src/web/components/tradeCheck.tsx';
import type { TradeEvaluation, SideResult } from '../src/core/tradeValue/evaluate.ts';

function side(over: Partial<SideResult> = {}): SideResult {
  return {
    label: 'Dermot',
    rosterId: 2,
    isMine: false,
    lineupChange: 12.34,
    depthChange: 1.2,
    adjustments: [],
    adjustmentTotal: 0,
    net: 13.5,
    incoming: [],
    outgoing: [],
    mustDrop: null,
    unvaluedStarters: [],
    ...over,
  };
}

function evaluation(a: SideResult, b: SideResult): TradeEvaluation {
  return {
    status: 'ok',
    insufficientReason: null,
    weeks: { first: 5, last: 17, count: 13 },
    a,
    b,
    verdict: { kind: 'close', gap: 0, band: 4, headline: 'Close call.' },
    reasons: [],
    caveats: [],
    confidence: 'high',
    confidenceReasons: [],
    replacement: [],
  };
}

/** Numbers that read as figures: a signed or plain decimal, not part of a word. */
const FIGURES = /[+−-]?\d+(?:\.\d+)?/g;

describe('a result row', () => {
  const rows = resultRows(
    evaluation(
      side({ label: 'Alex', isMine: true, rosterId: 1, net: 42.1, lineupChange: 40, depthChange: 1.1, adjustmentTotal: 1, adjustments: [{ key: 'rb_lean', label: 'x', points: 1 }] }),
      side({ net: -8.8, lineupChange: -9, depthChange: 0.2 }),
    ),
  );

  it('is one per side, labelled', () => {
    expect(rows.map((r) => r.label)).toEqual(['You', 'Dermot']);
  });

  it('carries exactly one figure in its value, and it is the net', () => {
    expect(rows[0]!.value).toBe('+42.1 pts');
    expect(rows[1]!.value).toBe('−8.8 pts');
    for (const row of rows) expect(row.value.match(FIGURES)).toHaveLength(1);
  });

  it('puts the breakdown in a sentence and never in a second value', () => {
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['key', 'label', 'note', 'tone', 'value']);
      expect(row.note).toMatch(/^over 13 weeks: lineup /);
    }
  });

  it('points the colour the way the number points', () => {
    expect(rows.map((r) => r.tone)).toEqual(['pos', 'neg']);
  });

  it('is absent when there is no verdict to draw', () => {
    expect(resultRows({ ...evaluation(side(), side()), status: 'insufficient', a: null, b: null })).toEqual([]);
  });
});

describe('the wording helpers', () => {
  it('prints a real minus sign and a plain zero', () => {
    expect(signed(-3)).toBe('−3.0');
    expect(signed(3)).toBe('+3.0');
    expect(signed(0)).toBe('0.0');
    expect(signed(-0.04)).toBe('−0.0');
  });

  it('calls Alex you, and everybody else by name', () => {
    expect(sideName({ label: 'Alex', isMine: true })).toBe('You');
    expect(sideName({ label: 'Dermot', isMine: false })).toBe('Dermot');
  });

  it('states the horizon and the deadline from the league’s own settings', () => {
    const base = { currentWeek: 5, lastWeek: 17, weeks: 13, playoffWeeks: [15, 16, 17], deadlineWeek: 11, deadlinePassed: false, weeksToDeadline: 7 };
    expect(horizonLine(base)).toBe('Rest of the season: week 5 to week 17, through the playoffs. Trades close after week 11 (7 weeks left).');
    expect(horizonLine({ ...base, weeksToDeadline: 1 })).toMatch(/\(1 week left\)/);
    expect(horizonLine({ ...base, deadlinePassed: true })).toMatch(/deadline was week 11/);
    expect(horizonLine({ ...base, deadlineWeek: null, weeksToDeadline: null })).not.toMatch(/deadline|close/);
  });
});

describe('a long username on a result row', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  const rule = (selector: string) => {
    const at = css.lastIndexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('keeps the name as one label, whole, with the full text available', () => {
    const rows = resultRows(evaluation(side({ label: 'zackstephens54', isMine: false }), side({ label: 'Alex', isMine: true })));
    expect(rows[0]!.label).toBe('zackstephens54');
  });

  it('is cut with an ellipsis, never split mid-word, in a column that fits 14 characters', () => {
    const dt = rule('.weekly-line-team dt');
    expect(dt).toMatch(/text-overflow:\s*ellipsis/);
    expect(dt).toMatch(/white-space:\s*nowrap/);
    expect(dt).toMatch(/overflow-wrap:\s*normal/);
    expect(dt).not.toMatch(/anywhere|break-all|break-word/);
    expect(rule('.weekly-line-team')).toMatch(/grid-template-columns:\s*120px/);
  });

  it('is marked in the markup so the rule applies only to result rows', () => {
    const src = readFileSync(new URL('../src/web/components/tradeCheck.tsx', import.meta.url), 'utf8');
    expect(src).toContain('weekly-line weekly-line-team');
  });
});
