/**
 * Convert Vegas market lines into a league-scoring-aware fantasy expectation.
 *
 * This is explicitly a MARKET EXPECTATION, not a projection: it is what the
 * betting market implies, converted with the league's own scoring settings.
 * Missing markets are reported as missing — never imputed.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { MarketKey, PlayerProp } from '../vegas/types.ts';
import { convertLine, touchdownRate, type ConversionRules } from './propConversion.ts';
import { SCORING_RULES } from './scoringRules.ts';
import { EXPECTED_MARKETS } from './expectedMarkets.ts';

export interface MarketContribution {
  market: MarketKey;
  line: number | null;
  /** Fantasy points this market contributes. */
  points: number;
  /**
   * What the line alone would have been worth, multiplied straight into the
   * league's scoring: the method before October 2026. Present when the
   * conversion moved the number, so the breakdown can show both.
   */
  linePoints?: number;
  /** The average the conversion read off the line, in the market's own unit. */
  mean?: number;
  detail: string;
  /**
   * The market's implied chance, for a yes/no market with no line to print.
   *
   * Only the anytime-TD market sets it. It is carried so a card can show the
   * touchdown part of the total as `Anytime TD 42%`: without it the one market
   * with no number of its own was the one market no card showed, and a total
   * built from yards, catches and a touchdown read as yards and catches alone.
   */
  probability?: number;
}

export interface VegasExpectation {
  /** Total expected fantasy points, or null when nothing usable was available. */
  points: number | null;
  contributions: MarketContribution[];
  /** Markets we wanted for this position but did not receive. */
  missingMarkets: MarketKey[];
  /** 0..1 — share of the expected markets that were actually present. */
  coverage: number;
  /** Number of books behind the thinnest market used. */
  minBookCount: number | null;
  notes: string[];
  /**
   * Set when some of the position's markets are in the total and some are
   * not: which are missing, in a sentence for the card's Market line.
   *
   * Written here rather than on the card so the wording is decided where the
   * total is, and so the browser carries a string rather than a vocabulary.
   * See `marketIsComplete` in `projection.ts` for what a partial total is and
   * is not allowed to become.
   */
  partial?: string;
  /**
   * The same markets read as bare lines (the method before October 2026),
   * when the conversion moved the total. For the breakdown's "line alone" note
   * and for the audit; nothing ranks on it.
   */
  lineTotal?: number;
  /**
   * Set when the props were taken before the latest game line and the total
   * was scaled for the move (see `staleLine.ts`): the factor and the sentence.
   */
  staleScale?: { factor: number; detail: string };
}

/**
 * Names for the markets a partial total is missing, as a reader says them.
 *
 * Lower case and not the chip labels (`Pass TDs`), because this is written
 * into a sentence rather than printed as a label.
 */
const MISSING_WORDS: Record<MarketKey, string> = {
  pass_yards: 'passing yards',
  pass_tds: 'passing TD',
  rush_yards: 'rushing yards',
  receiving_yards: 'receiving yards',
  receptions: 'receptions',
  anytime_td: 'touchdown',
};

/** Markets we expect to exist for each position; a leaf of its own so Compare can read it without this module. */
export { EXPECTED_MARKETS };

/**
 * Build the expectation for one player.
 *
 * Anytime-TD is applied only for non-QB positions, where it stands in for
 * rushing/receiving TDs. For QBs the passing-TD line already carries the TD
 * scoring, and their rushing TDs are left out rather than double-counted —
 * the resulting expectation is therefore slightly conservative for rushing QBs,
 * which is stated in `notes`.
 */
export function buildExpectation(
  position: string,
  props: PlayerProp[],
  profile: ScoringProfile,
  conversion: ConversionRules = SCORING_RULES.conversion,
): VegasExpectation {
  const expected = EXPECTED_MARKETS[position] ?? [];
  const byMarket = new Map<MarketKey, PlayerProp>();
  for (const p of props) {
    if (p.line == null && p.impliedProbability == null) continue;
    byMarket.set(p.market, p);
  }

  const contributions: MarketContribution[] = [];
  const notes: string[] = [];
  const bookCounts: number[] = [];

  for (const market of expected) {
    const prop = byMarket.get(market);
    if (!prop) continue;
    bookCounts.push(prop.bookCount);

    if (market === 'anytime_td') {
      if (position === 'QB') continue;
      /*
       * The quote may be "two or more" rather than "any": see
       * `touchdownLine.ts`. Converted to the any-touchdown chance it implies,
       * then to the touchdowns that chance averages (`touchdownRate`). A line
       * too far into the tail to convert is a missing market, never a guess.
       */
      const td = touchdownRate(prop.line, prop.impliedProbability, prop.underPrice != null, conversion);
      if (td == null) continue;
      const tdPoints = position === 'RB' ? profile.rushTd : profile.recTd;
      const quoted =
        prop.line != null && prop.line > 0.5 && prop.impliedProbability != null
          ? `${Math.round(prop.impliedProbability * 100)}% for over ${prop.line} TDs, so `
          : '';
      const linePoints = round2(td.probability * tdPoints);
      const points = round2(td.expected * tdPoints);
      const rate = td.expected !== td.probability ? ` (${td.expected.toFixed(2)} TDs on average)` : '';
      contributions.push({
        ...contribution(market, null, points, `${quoted}${Math.round(td.probability * 100)}% anytime TD${rate} x ${tdPoints}`),
        probability: td.probability,
        ...(points !== linePoints ? { linePoints, mean: round2(td.expected) } : {}),
      });
      continue;
    }

    const perUnit = pointsPerUnit(market, position, profile);
    const converted = convertLine(market, prop.line, prop, conversion);
    const line = prop.line ?? 0;
    const mean = converted?.mean ?? line;
    const linePoints = round2(line * perUnit);
    const points = round2(mean * perUnit);
    const avg = Math.abs(mean - line) >= 0.005 ? ` (avg ${formatUnit(market, mean)})` : '';
    contributions.push({
      ...contribution(market, prop.line, points, `${prop.line} ${UNIT_WORDS[market]}${avg} x ${perUnit}`),
      ...(points !== linePoints ? { linePoints, mean: round2(mean) } : {}),
    });
  }

  const present = new Set(contributions.map((c) => c.market));
  const missingMarkets = expected.filter((m) => !present.has(m));
  const coverage = expected.length === 0 ? 0 : round3((expected.length - missingMarkets.length) / expected.length);

  if (position === 'QB' && byMarket.has('rush_yards')) {
    notes.push('QB rushing TDs are not modeled; expectation is slightly conservative');
  }
  if (missingMarkets.length > 0) {
    notes.push(`missing market(s): ${missingMarkets.join(', ')}`);
  }
  if (contributions.length === 0) {
    notes.push('no usable Vegas markets for this player');
  }

  const points = contributions.length === 0 ? null : round2(contributions.reduce((a, c) => a + c.points, 0));
  const lineTotal = round2(contributions.reduce((a, c) => a + (c.linePoints ?? c.points), 0));
  return {
    points,
    ...(points != null && lineTotal !== points ? { lineTotal } : {}),
    contributions,
    missingMarkets,
    coverage,
    minBookCount: bookCounts.length === 0 ? null : Math.min(...bookCounts),
    notes,
    ...(contributions.length > 0 && missingMarkets.length > 0
      ? { partial: `Partial: no ${missingMarkets.map((m) => MISSING_WORDS[m]).join(', ')} line yet` }
      : {}),
  };
}

/** How the breakdown names each market's unit, after the line. */
const UNIT_WORDS: Record<Exclude<MarketKey, 'anytime_td'>, string> = {
  pass_yards: 'pass yds',
  pass_tds: 'pass TDs',
  rush_yards: 'rush yds',
  receiving_yards: 'rec yds',
  receptions: 'rec',
};

function formatUnit(market: MarketKey, value: number): string {
  return market === 'receptions' || market === 'pass_tds' ? value.toFixed(2) : value.toFixed(1);
}

/** Fantasy points per yard, catch or touchdown, in this league. */
function pointsPerUnit(market: Exclude<MarketKey, 'anytime_td'>, position: string, profile: ScoringProfile): number {
  switch (market) {
    case 'pass_yards':
      return profile.pointsPerPassYard;
    case 'pass_tds':
      return profile.passTd;
    case 'rush_yards':
      return profile.pointsPerRushYard;
    case 'receiving_yards':
      return profile.pointsPerRecYard;
    case 'receptions':
      return profile.ppr + (position === 'TE' ? profile.teBonus : 0);
  }
}

function contribution(market: MarketKey, line: number | null, points: number, detail: string): MarketContribution {
  return { market, line, points: round2(points), detail };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
