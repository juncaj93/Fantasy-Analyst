/**
 * The Compare table, as arithmetic a reader can check (13 October 2026).
 *
 * Alex's rule: the rows add up to Score, and Base says where it came from.
 *
 *   Base          the Vegas number when every line his position is priced on
 *                 is there, otherwise Sleeper's published projection. Never a
 *                 fragment of a market: a partly priced player with nothing
 *                 published has no number at all (see `weekPointsFrom`).
 *   Recent news   the capped nudge, as it counts in his number
 *   Opponent      the same
 *   Uncertainty   the market's coverage charge; a dash on a published week,
 *                 which does not carry it (`decisionPoints`)
 *   Score         `weekPointsOf`, the number every other screen prints
 *
 * Doubtful (the one availability charge left in a score) and a weather nudge
 * get their own row only when they moved somebody, so the column still adds
 * up. Rounding goes to Base: each figure is shown to a tenth, and Base is the
 * Score less the tenths above it, so the column always sums on screen.
 */

import { weekPointsOf } from '../core/startsit/weekPoints.ts';
import type { StartSitEvaluation } from './api.ts';

export interface TableCell {
  /** The value as it counts in the number, or null for a dash. */
  value: number | null;
  /** What the cell prints. */
  text: string;
}

export interface TableRow {
  key: string;
  label: string;
  cells: TableCell[];
}

const NUDGES: { key: string; label: string; always: boolean }[] = [
  { key: 'news_recent', label: 'Recent news', always: true },
  { key: 'matchup_role', label: 'Opponent', always: true },
  { key: 'uncertainty', label: 'Uncertainty', always: true },
  { key: 'weather', label: 'Weather', always: false },
  { key: 'status', label: 'Availability', always: false },
];

const tenth = (v: number): number => Math.round(v * 10) / 10;

function signed(v: number): string {
  const t = tenth(v);
  if (t === 0) return '0.0';
  return `${t > 0 ? '+' : '−'}${Math.abs(t).toFixed(1)}`;
}

/** The value a nudge contributes to this player's number, or null when it is not part of it. */
function nudge(e: StartSitEvaluation, key: string): number | null {
  const week = weekPointsOf(e);
  if (week.points == null) return null;
  // A published week leaves the market's own charge out (`decisionPoints`).
  if (key === 'uncertainty' && week.basis !== 'market') return null;
  // Out is a gate, not a number; Questionable costs nothing.
  if (key === 'status' && e.ruledOut) return null;
  const c = e.components.find((x) => x.key === key);
  if (c == null || c.unknown || c.textOnly) return null;
  const v = c.shownValue ?? c.value;
  return Math.abs(v) < 0.005 ? null : v;
}

export function compareTable(columns: StartSitEvaluation[]): { rows: TableRow[]; score: TableCell[] } {
  const weeks = columns.map((e) => weekPointsOf(e));
  const nudgeRows = NUDGES.filter(({ key, always }) => always || columns.some((e) => nudge(e, key) != null)).map(
    ({ key, label }) => ({
      key,
      label,
      cells: columns.map((e) => {
        const v = nudge(e, key);
        return { value: v, text: v == null ? '–' : signed(v) };
      }),
    }),
  );

  const base: TableCell[] = columns.map((e, i) => {
    const week = weeks[i]!;
    if (week.points == null || e.decision == null) return { value: null, text: '–' };
    // Score less the tenths shown above it, so the column adds up on screen.
    const shownNudges = nudgeRows.reduce((total, row) => total + (row.cells[i]!.value == null ? 0 : tenth(row.cells[i]!.value!)), 0);
    const value = tenth(week.points) - shownNudges;
    return { value: e.decision.base, text: tenth(value).toFixed(1) };
  });

  const score: TableCell[] = weeks.map((w) =>
    w.out ? { value: null, text: 'Out' } : w.points == null ? { value: null, text: '–' } : { value: w.points, text: w.points.toFixed(1) },
  );

  return { rows: [{ key: 'base', label: 'Base', cells: base }, ...nudgeRows], score };
}

const MARKET_WORDS: Record<string, string> = {
  pass_yards: 'Pass yards',
  pass_tds: 'Pass TDs',
  rush_yards: 'Rush yards',
  receptions: 'Receptions',
  receiving_yards: 'Rec yards',
  anytime_td: 'TD price',
};

const MISSING_WORDS: Record<string, string> = {
  pass_yards: 'passing yards',
  pass_tds: 'passing TDs',
  rush_yards: 'rushing yards',
  receptions: 'receptions',
  receiving_yards: 'receiving yards',
  anytime_td: 'touchdown',
};

/** `Receptions line 5.5 = 2.8 pts`, `TD price 38% = 3.1 pts`. */
function lineWords(c: StartSitEvaluation['expectation']['contributions'][number]): string {
  const word = MARKET_WORDS[c.market] ?? c.market;
  const worth = `${tenth(c.points).toFixed(1)} pts`;
  if (c.market === 'anytime_td' && c.probability != null) return `${word} ${Math.round(c.probability * 100)}% = ${worth}`;
  if (c.line == null) return `${word} = ${worth}`;
  return `${word}${c.market === 'receptions' ? ' line' : ''} ${c.line} = ${worth}`;
}

/**
 * Where one player's Base came from, in plain words, for the row's tap.
 * Says which lines are priced and what each is worth, and when the base is
 * Sleeper's published week, says so and why.
 */
export function baseExplanation(e: StartSitEvaluation): string {
  const week = weekPointsOf(e);
  const lines = e.expectation.contributions.map(lineWords);
  const missing = e.expectation.missingMarkets.map((m) => MISSING_WORDS[m] ?? m);
  if (week.out) return 'Out this week, so no number.';
  if (week.basis === 'market') {
    if (lines.length === 0) return `Vegas game line: ${(e.decision?.base ?? 0).toFixed(1)} pts.`;
    return `Vegas: ${lines.join(', ')}.`;
  }
  if (week.basis === 'published') {
    const published = `Sleeper projection: ${(e.decision?.base ?? 0).toFixed(1)} pts.`;
    if (lines.length === 0) return `${published} No Vegas lines yet.`;
    return `${published} Only part of his market is priced (${lines.join(', ')}; no ${missing.join(', ')} line yet), so Sleeper's whole week is used instead.`;
  }
  if (lines.length > 0) return `Only part of his market is priced (${lines.join(', ')}) and Sleeper has no projection, so there is no number yet.`;
  return 'No Vegas lines and no Sleeper projection yet.';
}
