/**
 * Whether two Start/Sit scores are actually comparable.
 *
 * `buildExpectation` sums the markets a player has. That is the honest number
 * for one player and a trap for two, because the sum is silently conditioned on
 * *which* markets exist. A receiver priced on receiving yards, receptions and an
 * anytime touchdown carries about thirteen points of market expectation; the
 * same receiver priced on receiving yards alone carries about six. Nothing about
 * him changed. Two of his lines are absent, and `compareStartSit` sorts on the
 * total, so the absence reads as seven points of inferiority — and then the
 * uncertainty penalty takes another point off him for good measure.
 *
 * §15 of the model-integrity brief states the rule this file enforces:
 * **a missing prop is not a negative.** The whole board is built on unknown
 * staying unknown, and this was the one place a gap in a provider's coverage
 * was being spent as if it were information about a player.
 *
 * ## What this does, and what it deliberately does not
 *
 * It does not invent the missing line. There is no way to know what a book
 * would have hung on a receiver it never quoted, and guessing would be exactly
 * the imputation the rest of the codebase refuses.
 *
 * What it does instead is **measure the size of the blind spot from the other
 * player's own lines.** If the preferred player is priced on receptions and the
 * alternative is not, then the preferred player's receptions contribution is a
 * fair scale for what the comparison cannot see. When that blind spot is as
 * large as the margin between them, the margin is not evidence: it is the shape
 * of the provider's coverage. The recommendation still stands — the model has
 * usage, practice and role information the missing line would not have carried —
 * but it is no longer allowed to be confident, and the reader is told why.
 *
 * Position-aware, because "missing" only means something against what a
 * position is expected to have. A receiver has no rushing-yards line and is
 * missing nothing; a running back without one is missing his largest market.
 *
 * Pure and deterministic.
 */

import { EXPECTED_MARKETS, type VegasExpectation } from './expectation.ts';
import type { MarketKey } from '../vegas/types.ts';

/** One side of the comparison, as this module needs it. */
export interface ComparabilityCandidate {
  name: string;
  position: string;
  expectation: VegasExpectation;
}

export interface MarketComparability {
  /**
   * False when the margin between the two is inside what the market comparison
   * could not see. Never a claim that the recommendation is wrong.
   */
  comparable: boolean;
  /**
   * Points of market expectation the preferred player holds over the
   * alternative purely because the alternative's markets were not all priced.
   *
   * Signed toward the preferred player: positive means the coverage gap flatters
   * him, negative means it flatters the alternative. Zero when both are priced
   * on the same markets, which is the ordinary case.
   */
  coverageEdge: number;
  /** Whose markets are missing, and which ones. Empty when nothing is. */
  unpriced: { name: string; markets: MarketKey[]; points: number }[];
  /** One sentence, or null when the two are priced on the same footing. */
  detail: string | null;
}

export const COMPARABLE: MarketComparability = {
  comparable: true,
  coverageEdge: 0,
  unpriced: [],
  detail: null,
};

/**
 * Markets this position is expected to have that the player was not priced on,
 * valued at what the *peer's* lines say they are worth.
 *
 * The peer supplies the scale and nothing else — no line is copied onto the
 * player, and the result is used only to decide whether a comparison is safe.
 */
function blindSpot(
  player: ComparabilityCandidate,
  peer: ComparabilityCandidate,
): { markets: MarketKey[]; points: number } {
  const expected = new Set(EXPECTED_MARKETS[player.position.toUpperCase()] ?? []);
  const priced = new Set(player.expectation.contributions.map((c) => c.market));

  const markets: MarketKey[] = [];
  let points = 0;
  for (const contribution of peer.expectation.contributions) {
    if (!expected.has(contribution.market)) continue; // not a market he should have
    if (priced.has(contribution.market)) continue; // he has it
    markets.push(contribution.market);
    points += contribution.points;
  }
  return { markets, points: round2(points) };
}

/**
 * Is the gap between these two players evidence, or is it coverage?
 *
 * `margin` is the points the preferred player leads by. A margin smaller than
 * the coverage edge is not a finding about football.
 */
export function assessMarketComparability(
  preferred: ComparabilityCandidate,
  alternative: ComparabilityCandidate,
  margin: number | null,
): MarketComparability {
  // Nothing to compare on: a player with no market at all is already warned
  // about by name, and this module has no scale to measure with.
  if (preferred.expectation.points == null || alternative.expectation.points == null) return COMPARABLE;

  const alternativeBlind = blindSpot(alternative, preferred);
  const preferredBlind = blindSpot(preferred, alternative);
  const coverageEdge = round2(alternativeBlind.points - preferredBlind.points);

  const unpriced = [
    ...(alternativeBlind.markets.length > 0
      ? [{ name: alternative.name, markets: alternativeBlind.markets, points: alternativeBlind.points }]
      : []),
    ...(preferredBlind.markets.length > 0
      ? [{ name: preferred.name, markets: preferredBlind.markets, points: preferredBlind.points }]
      : []),
  ];
  if (unpriced.length === 0) return COMPARABLE;

  // Only a coverage gap that runs *toward* the preferred player can have
  // manufactured his lead. One running the other way makes his lead harder to
  // earn, not easier, and is not a reason to doubt it.
  const comparable = margin == null || coverageEdge <= 0 || coverageEdge < margin;

  const said = unpriced
    .map((u) => `${u.name} has no ${u.markets.map(label).join(' or ')} line (worth ~${Math.abs(u.points).toFixed(1)} pts to the other)`)
    .join('; ');

  return {
    comparable,
    coverageEdge,
    unpriced,
    detail: comparable
      ? `Market coverage differs: ${said}. The gap between them is wider than that, so the comparison still stands.`
      : `Market coverage differs: ${said}. That is at least as large as the ${margin?.toFixed(2)} pt gap between them, so this comparison is not decided by the market.`,
  };
}

const MARKET_LABEL: Record<MarketKey, string> = {
  pass_yards: 'passing yards',
  pass_tds: 'passing TD',
  rush_yards: 'rushing yards',
  receiving_yards: 'receiving yards',
  receptions: 'receptions',
  anytime_td: 'anytime touchdown',
};

function label(market: MarketKey): string {
  return MARKET_LABEL[market] ?? market;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
