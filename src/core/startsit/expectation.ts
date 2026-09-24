/**
 * Convert Vegas market lines into a league-scoring-aware fantasy expectation.
 *
 * This is explicitly a MARKET EXPECTATION, not a projection: it is what the
 * betting market implies, converted with the league's own scoring settings.
 * Missing markets are reported as missing — never imputed.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { MarketKey, PlayerProp } from '../vegas/types.ts';

export interface MarketContribution {
  market: MarketKey;
  line: number | null;
  /** Fantasy points this market contributes. */
  points: number;
  detail: string;
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

/** Markets we expect to exist for each position. */
export const EXPECTED_MARKETS: Record<string, MarketKey[]> = {
  QB: ['pass_yards', 'pass_tds', 'rush_yards'],
  RB: ['rush_yards', 'receiving_yards', 'receptions', 'anytime_td'],
  WR: ['receiving_yards', 'receptions', 'anytime_td'],
  TE: ['receiving_yards', 'receptions', 'anytime_td'],
};

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

    switch (market) {
      case 'pass_yards':
        contributions.push(contribution(market, prop.line, (prop.line ?? 0) * profile.pointsPerPassYard, `${prop.line} pass yds x ${profile.pointsPerPassYard}`));
        break;
      case 'pass_tds':
        contributions.push(contribution(market, prop.line, (prop.line ?? 0) * profile.passTd, `${prop.line} pass TDs x ${profile.passTd}`));
        break;
      case 'rush_yards':
        contributions.push(contribution(market, prop.line, (prop.line ?? 0) * profile.pointsPerRushYard, `${prop.line} rush yds x ${profile.pointsPerRushYard}`));
        break;
      case 'receiving_yards':
        contributions.push(contribution(market, prop.line, (prop.line ?? 0) * profile.pointsPerRecYard, `${prop.line} rec yds x ${profile.pointsPerRecYard}`));
        break;
      case 'receptions': {
        const perRec = profile.ppr + (position === 'TE' ? profile.teBonus : 0);
        contributions.push(contribution(market, prop.line, (prop.line ?? 0) * perRec, `${prop.line} rec x ${perRec}`));
        break;
      }
      case 'anytime_td': {
        if (position === 'QB') break;
        const prob = prop.impliedProbability;
        if (prob == null) break;
        const tdPoints = position === 'RB' ? profile.rushTd : profile.recTd;
        contributions.push(
          contribution(market, null, prob * tdPoints, `${Math.round(prob * 100)}% anytime TD x ${tdPoints}`),
        );
        break;
      }
    }
  }

  const present = new Set(contributions.map((c) => c.market));
  const missingMarkets = expected.filter((m) => !present.has(m));
  const coverage = expected.length === 0 ? 0 : round3((expected.length - missingMarkets.length) / expected.length);

  if (position === 'QB' && byMarket.has('rush_yards')) {
    notes.push('QB rushing TDs are not modelled; expectation is slightly conservative');
  }
  if (missingMarkets.length > 0) {
    notes.push(`missing market(s): ${missingMarkets.join(', ')}`);
  }
  if (contributions.length === 0) {
    notes.push('no usable Vegas markets for this player');
  }

  return {
    points: contributions.length === 0 ? null : round2(contributions.reduce((a, c) => a + c.points, 0)),
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

function contribution(market: MarketKey, line: number | null, points: number, detail: string): MarketContribution {
  return { market, line, points: round2(points), detail };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
