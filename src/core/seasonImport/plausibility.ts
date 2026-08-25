/**
 * Is this snapshot a betting market, or somebody's projection model?
 *
 * A real export forced this question. A site's season-long *projection* table
 * parses perfectly as season-long *market* lines: same players, same stat
 * names, same magnitudes, and column headers that cannot tell the two apart.
 * Stored, it would appear on the draft board under "Season market" and be
 * presented as what the betting market expects — a model's opinion wearing the
 * market's name. That is the single worst thing this feature could do, and no
 * per-row validation can catch it, because every individual row is fine.
 *
 * So the judgement is made over the whole snapshot, on several weak signals
 * rather than one strong one. Any single signal here has honest exceptions:
 *
 *   - a market table can omit prices (a consensus line is still a line);
 *   - a whole number can be a real line;
 *   - a book may quote a season total for a kicker.
 *
 * Which is exactly why no single signal decides. What no *market* export does
 * is show all of them at once: no prices anywhere, no book named anywhere,
 * mostly whole numbers, kickers and defences included, a derived fantasy-points
 * column, and stat columns no book prices for a season. A file like that is a
 * model, and this refuses it rather than warning about it — a warning on an
 * import somebody is trying to complete is a warning that gets clicked past.
 *
 * The verdict is deliberately conservative in one direction. Refusing a real
 * market export is an annoyance the user can report; accepting a model is a
 * silent, permanent lie on the board.
 */

import type { RawSnapshotRow } from './parse.ts';

/** A single observation about the snapshot, and what it suggests. */
export interface PlausibilitySignal {
  id: string;
  /** True when the observation points at a model rather than a market. */
  suggestsModel: boolean;
  /** Said the way it would be said to a person, with the number that drove it. */
  detail: string;
}

export type SnapshotVerdict = 'market' | 'unclear' | 'model';

export interface PlausibilityReport {
  verdict: SnapshotVerdict;
  signals: PlausibilitySignal[];
  /** One paragraph, for the person holding the clipboard. */
  explanation: string;
  /** How many of the model-shaped signals fired. */
  modelSignals: number;
}

/**
 * Stat columns no sportsbook prices as a standard season-long total.
 *
 * A projection model produces a whole stat line, so it carries these; a book
 * prices the handful of markets people bet on. Their presence is the clearest
 * single hint that a table came out of a model, though still not proof on its
 * own — hence its place among the others.
 */
const MODEL_ONLY_STATS = [
  'completion',
  'comps',
  'attempt',
  'fumble',
  'first down',
  ' fd',
  'snap',
  'target share',
  'carries',
  'projection',
  'fantasy point',
];

/** Positions no book prices season-long player yardage for. */
const NON_MARKET_POSITIONS = new Set(['K', 'DEF', 'DST', 'D/ST', 'PK']);

export interface PlausibilityInput {
  /** Rows as read, before market normalisation drops what it cannot place. */
  rows: RawSnapshotRow[];
  /** Header labels or market names seen in the source, for the column test. */
  columns: string[];
  /** A book named per row or for the snapshot, when the source gave one. */
  book?: string | null;
}

/**
 * Judge a whole snapshot.
 *
 * Returns `model` only when several independent signals agree; `unclear` when
 * the evidence is thin either way, which the caller may allow with a warning;
 * and `market` when something positively says market — a price or a book.
 */
export function assessSnapshot(input: PlausibilityInput): PlausibilityReport {
  const rows = input.rows;
  const signals: PlausibilitySignal[] = [];

  if (rows.length === 0) {
    return {
      verdict: 'unclear',
      signals,
      modelSignals: 0,
      explanation: 'there are no rows to judge',
    };
  }

  // --- positive evidence: something that only a market has ------------------

  const priced = rows.filter((r) => r.overPrice != null || r.underPrice != null).length;
  const priceShare = priced / rows.length;
  signals.push({
    id: 'prices',
    suggestsModel: priced === 0,
    detail:
      priced === 0
        ? 'no over/under prices anywhere in the snapshot'
        : `${priced} of ${rows.length} rows carry an over/under price`,
  });

  const book = (input.book ?? '').trim();
  signals.push({
    id: 'book',
    suggestsModel: book === '',
    detail: book === '' ? 'no sportsbook is named' : `sportsbook named: ${book}`,
  });

  // --- shape evidence: what a model looks like ------------------------------

  const numeric = rows
    .map((r) => Number(String(r.line).replace(/[\s,]/g, '')))
    .filter((n) => Number.isFinite(n));
  const whole = numeric.filter((n) => Math.abs(n - Math.round(n)) < 1e-9).length;
  const wholeShare = numeric.length === 0 ? 0 : whole / numeric.length;
  signals.push({
    id: 'whole-numbers',
    // Books quote the half point to avoid a push. A table that mostly does not
    // is a table that was not written by somebody taking bets on it.
    suggestsModel: wholeShare > 0.5,
    detail: `${Math.round(wholeShare * 100)}% of lines are whole numbers rather than half points`,
  });

  const nonMarketPositions = new Set(
    rows
      .map((r) => (r.position ?? '').trim().toUpperCase())
      .filter((p) => NON_MARKET_POSITIONS.has(p)),
  );
  signals.push({
    id: 'non-market-positions',
    suggestsModel: nonMarketPositions.size > 0,
    detail:
      nonMarketPositions.size > 0
        ? `includes positions books do not price season-long yardage for: ${[...nonMarketPositions].join(', ')}`
        : 'no kicker or defence rows',
  });

  const haystack = [...input.columns, ...rows.map((r) => r.market)]
    .join(' ')
    .toLowerCase();
  const modelStats = MODEL_ONLY_STATS.filter((s) => haystack.includes(s));
  signals.push({
    id: 'model-only-stats',
    suggestsModel: modelStats.length > 0,
    detail:
      modelStats.length > 0
        ? `carries stats no book prices as a season total: ${modelStats.map((s) => s.trim()).join(', ')}`
        : 'every stat named is one a book prices',
  });

  const modelSignals = signals.filter((s) => s.suggestsModel).length;

  // --- the verdict ---------------------------------------------------------

  // A price or a named book is positive proof of a market, and outweighs the
  // shape signals entirely: a real market export with a few whole numbers and a
  // kicker in it is still a market export.
  if (priceShare > 0.1 || book !== '') {
    return {
      verdict: 'market',
      signals,
      modelSignals,
      explanation:
        book !== ''
          ? `This carries sportsbook provenance (${book}), so it is being read as market data.`
          : 'This carries over/under prices, so it is being read as market data.',
    };
  }

  // No positive evidence. Now the shape decides, and only a pile-up refuses.
  if (modelSignals >= 4) {
    return {
      verdict: 'model',
      signals,
      modelSignals,
      explanation:
        'This looks like a fantasy projection table, not season-long betting lines. ' +
        `No sportsbook prices or market provenance were found, and ${describeModelEvidence(signals)}. ` +
        'Nothing was imported as Preseason Vegas. If this really is a market export, ' +
        'include the over/under prices or the sportsbook name and import it again.',
    };
  }

  return {
    verdict: 'unclear',
    signals,
    modelSignals,
    explanation:
      'No prices or sportsbook were found, so this cannot be proven to be market data. ' +
      'It will be stored with that caveat — check the source is a betting market and not a projection model.',
  };
}

/**
 * Do the column headers alone give a projection table away?
 *
 * Needed because the shape that prompted all of this never reaches the row
 * check: a projection export is one row per player with a column per stat, and
 * the reader rejects it for having no market column long before anything looks
 * at a line. That rejection is true and useless — it sends somebody off to find
 * a "market column" in a file that was never going to have one.
 *
 * Two headers decide it, and both must be there: a derived fantasy-points
 * column, and at least one stat no book prices as a season total. Either alone
 * is too weak — "projected" appears in the furniture of plenty of odds pages,
 * and a market table may well carry an attempts line.
 *
 * Returns null when the headers say nothing, so the caller falls back to
 * whatever the real problem with the file was.
 */
export function assessColumns(columns: string[]): PlausibilityReport | null {
  if (columns.length === 0) return null;
  const labels = columns.map((c) => c.trim().toLowerCase());
  const joined = labels.join(' ');

  const fantasyPoints = labels.filter((c) => /^projection|^proj\b|fantasy point|^fpts$|^points$/.test(c));
  const modelStats = MODEL_ONLY_STATS.filter((s) => joined.includes(s) && !/^projection/.test(s));

  if (fantasyPoints.length === 0 || modelStats.length === 0) return null;

  const signals: PlausibilitySignal[] = [
    {
      id: 'derived-points-column',
      suggestsModel: true,
      detail: `a derived fantasy-points column ("${fantasyPoints[0]}")`,
    },
    {
      id: 'model-only-stats',
      suggestsModel: true,
      detail: `stat columns no book prices as a season total (${modelStats.map((s) => s.trim()).join(', ')})`,
    },
    {
      id: 'no-market-columns',
      suggestsModel: true,
      detail: 'no market or line column, because each stat is its own column',
    },
  ];

  return {
    verdict: 'model',
    signals,
    modelSignals: signals.length,
    explanation:
      'This looks like a fantasy projection table, not season-long betting lines. ' +
      `It has ${signals[0]!.detail} and ${signals[1]!.detail}, and no over/under prices or ` +
      'sportsbook provenance, so nothing was imported as Preseason Vegas. ' +
      'A market export names a book or carries prices — look for a season-long odds or ' +
      'props page rather than a projections page.',
  };
}

function describeModelEvidence(signals: PlausibilitySignal[]): string {
  const parts = signals
    .filter((s) => s.suggestsModel && s.id !== 'prices' && s.id !== 'book')
    .map((s) => s.detail);
  if (parts.length === 0) return 'nothing identifies it as a market';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
