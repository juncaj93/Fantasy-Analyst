/**
 * The Compare table, as arithmetic a reader can check (13 October 2026).
 *
 * Alex's rule: the number rows add up to Score, and the lines under Base say
 * what Vegas thinks.
 *
 *   Base          the Vegas number when every line his position is priced on
 *                 is there, otherwise Sleeper's published projection (grey).
 *                 Never a fragment of a market: a partly priced player with
 *                 nothing published has no number at all (`weekPointsFrom`).
 *   Yards …       the posted lines themselves, not points (15 October 2026):
 *                 Yards, Catches, TD %, or Pass yds, Pass TD, Rush yds when
 *                 every column is a QB. They explain Base and are not summed.
 *   Recent news   the capped nudge, as it counts in his number
 *   Opponent      the same
 *   Score         `weekPointsOf`, the number every other screen prints
 *
 * Uncertainty had a row until `startsit@6` took it out of the score.
 *
 * Doubtful (the one availability charge left in a score) and a weather nudge
 * get their own row only when they moved somebody, so the column still adds
 * up. Rounding goes to Base: each figure is shown to a tenth, and Base is the
 * Score less the tenths above it, so the column always sums on screen.
 */

import { EXPECTED_MARKETS } from '../core/startsit/expectedMarkets.ts';
import { weekPointsOf } from '../core/startsit/weekPoints.ts';
import type { StartSitEvaluation } from './api.ts';
import { weekIsSleeper } from './sleeperFallback.ts';

export interface TableCell {
  /** The value as it counts in the number, or null for a dash. */
  value: number | null;
  /** What the cell prints. */
  text: string;
  /**
   * Drawn grey: a number built on Sleeper's week rather than a full market,
   * a partial yards total, or a line nobody posted. See `sleeperFallback.ts`.
   */
  muted?: boolean;
  /** Built on Sleeper's week: drawn with the fallback marker as well as grey. */
  sleeper?: boolean;
}

export interface TableRow {
  key: string;
  label: string;
  /** `line` rows are market lines, shown for reading and never added up. */
  kind: 'base' | 'line' | 'nudge';
  cells: TableCell[];
}

const NUDGES: { key: string; label: string; always: boolean }[] = [
  { key: 'news_recent', label: 'Recent news', always: true },
  { key: 'matchup_role', label: 'Opponent', always: true },
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
      kind: 'nudge' as const,
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
    const sleeper = weekIsSleeper(week);
    return { value: e.decision.base, text: tenth(value).toFixed(1), muted: sleeper, sleeper };
  });

  const score: TableCell[] = weeks.map((w) =>
    w.out
      ? { value: null, text: 'Out' }
      : w.points == null
        ? { value: null, text: '–' }
        : { value: w.points, text: w.points.toFixed(1), muted: weekIsSleeper(w), sleeper: weekIsSleeper(w) },
  );

  return { rows: [{ key: 'base', label: 'Base', kind: 'base', cells: base }, ...lineRows(columns), ...nudgeRows], score };
}

/* ------------------------------------------------------------ the lines */

type Contribution = StartSitEvaluation['expectation']['contributions'][number];

const isQb = (e: StartSitEvaluation): boolean => e.position.toUpperCase() === 'QB';

/** Lines a position is priced on; a defence or kicker has none. */
const PRICED_ON: Record<string, readonly string[]> = EXPECTED_MARKETS;

const DASH: TableCell = { value: null, text: '–' };
/** A line his position is priced on that nobody has posted. */
const MISSING: TableCell = { value: null, text: '–', muted: true };

function posted(e: StartSitEvaluation, market: string): Contribution | undefined {
  return e.expectation.contributions.find((c) => c.market === market);
}

/** One decimal always, so a column of lines lines up on the point. */
function lineText(v: number): string {
  return v.toFixed(1);
}

/**
 * One market's line, or a dash: grey when his position is priced on it and
 * it is not posted, plain when it does not apply to him at all.
 */
function lineCell(e: StartSitEvaluation, market: string): TableCell {
  const expected = PRICED_ON[e.position.toUpperCase()] ?? [];
  if (!expected.includes(market)) return DASH;
  const c = posted(e, market);
  if (market === 'anytime_td') {
    return c?.probability == null ? MISSING : { value: c.probability, text: `${Math.round(c.probability * 100)}%` };
  }
  return c?.line == null ? MISSING : { value: c.line, text: lineText(c.line) };
}

/**
 * Rushing plus receiving yards, whichever are posted. A total missing one of
 * the yard lines his position is priced on is shown grey, so a back with only
 * his rushing line posted does not read as a back with no catches.
 */
export function yardsCell(e: StartSitEvaluation): TableCell {
  if (isQb(e)) return lineCell(e, 'pass_yards');
  const expected = (PRICED_ON[e.position.toUpperCase()] ?? []).filter((m) => m === 'rush_yards' || m === 'receiving_yards');
  if (expected.length === 0) return DASH;
  const lines = expected.map((m) => posted(e, m)?.line ?? null);
  const have = lines.filter((v): v is number => v != null);
  if (have.length === 0) return MISSING;
  const total = Math.round(have.reduce((a, v) => a + v, 0) * 10) / 10;
  return { value: total, text: lineText(total), ...(have.length < expected.length ? { muted: true } : {}) };
}

/**
 * The market lines, as Vegas posts them. All QBs: Pass yds, Pass TD, Rush
 * yds. Anyone else, or a mix: Yards, Catches, TD %, with a plain dash where a
 * row does not apply (a QB's catches) and a grey one where a line is missing.
 * A defence or kicker has no player lines and gets dashes throughout.
 */
export function lineRows(columns: StartSitEvaluation[]): TableRow[] {
  if (columns.length > 0 && columns.every(isQb)) {
    return [
      { key: 'pass_yards', label: 'Pass yds', kind: 'line', cells: columns.map((e) => lineCell(e, 'pass_yards')) },
      { key: 'pass_tds', label: 'Pass TD', kind: 'line', cells: columns.map((e) => lineCell(e, 'pass_tds')) },
      { key: 'rush_yards', label: 'Rush yds', kind: 'line', cells: columns.map((e) => lineCell(e, 'rush_yards')) },
    ];
  }
  return [
    { key: 'yards', label: 'Yards', kind: 'line', cells: columns.map(yardsCell) },
    { key: 'receptions', label: 'Catches', kind: 'line', cells: columns.map((e) => (isQb(e) ? DASH : lineCell(e, 'receptions'))) },
    { key: 'anytime_td', label: 'TD %', kind: 'line', cells: columns.map((e) => (isQb(e) ? DASH : lineCell(e, 'anytime_td'))) },
  ];
}

