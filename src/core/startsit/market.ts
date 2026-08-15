/**
 * Where the model and the betting market disagree — said out loud, not resolved.
 *
 * The market's player props are the closest thing to an independent projection
 * this app can see, and they are already inside the score: `buildExpectation`
 * turns them into points and that is the largest single component. So this
 * module deliberately **adds no points at all**. Scoring disagreement would be
 * counting the same lines twice, once as a projection and once as an opinion
 * about the projection, which is exactly the double-count the brief names.
 *
 * What it produces instead is a *flag* and a confidence effect. The useful
 * sentence is not "Vegas prefers the other one, start the other one" — the
 * market does not know your league's scoring, and the model has usage and
 * practice reports the market's number cannot show you. The useful sentence is
 * "these two sources disagree about this decision", because that is when a
 * human should look at it themselves.
 *
 * ## How the comparison is made fair
 *
 * The model score is taken **with the market component removed**. Comparing the
 * full score against the market would be comparing the market with itself plus
 * some noise, and it would report agreement almost everywhere.
 */

export type MarketVerdict = 'agrees' | 'neutral' | 'disagrees' | 'unavailable';

export const MARKET_AGREEMENT = {
  /**
   * Points of model separation below which the model has no opinion worth
   * checking against anything.
   */
  minModelMargin: 0.75,
  /** Points of market separation below which the market has no opinion either. */
  minMarketMargin: 1.5,
  /**
   * Market margin, in points, at which a disagreement is worth lowering
   * confidence over rather than merely mentioning.
   */
  strongMarketMargin: 3,
} as const;

export interface MarketCandidate {
  playerId: string;
  name: string;
  /** The Start/Sit score with the market component subtracted out. */
  modelScoreExMarket: number | null;
  /** The market's own expectation, in this league's points. */
  marketPoints: number | null;
}

export interface MarketAgreement {
  verdict: MarketVerdict;
  label: string;
  detail: string;
  /** Who the model prefers, ignoring the market. */
  modelPreferredId: string | null;
  /** Who the market prefers. */
  marketPreferredId: string | null;
  /** How much the market prefers its choice by, in points. */
  marketMargin: number | null;
  /** True when the disagreement is large enough to lower confidence. */
  material: boolean;
}

const LABEL: Record<MarketVerdict, string> = {
  agrees: 'Market agrees',
  neutral: 'Market neutral',
  disagrees: 'Market disagrees',
  unavailable: 'No market view',
};

export function compareWithMarket(candidates: MarketCandidate[]): MarketAgreement {
  const priced = candidates.filter((c) => c.marketPoints != null && c.modelScoreExMarket != null);
  if (priced.length < 2) {
    return {
      verdict: 'unavailable',
      label: LABEL.unavailable,
      detail:
        priced.length === 0
          ? 'No player in this decision has a market line, so there is nothing to compare against.'
          : 'Only one player in this decision has a market line, so the market cannot pick between them.',
      modelPreferredId: null,
      marketPreferredId: null,
      marketMargin: null,
      material: false,
    };
  }

  const byModel = [...priced].sort(
    (a, b) => (b.modelScoreExMarket ?? 0) - (a.modelScoreExMarket ?? 0) || a.name.localeCompare(b.name),
  );
  const byMarket = [...priced].sort(
    (a, b) => (b.marketPoints ?? 0) - (a.marketPoints ?? 0) || a.name.localeCompare(b.name),
  );

  const modelTop = byModel[0]!;
  const marketTop = byMarket[0]!;
  const modelMargin = round2((modelTop.modelScoreExMarket ?? 0) - (byModel[1]?.modelScoreExMarket ?? 0));
  const marketMargin = round2((marketTop.marketPoints ?? 0) - (byMarket[1]?.marketPoints ?? 0));

  if (modelMargin < MARKET_AGREEMENT.minModelMargin || marketMargin < MARKET_AGREEMENT.minMarketMargin) {
    return {
      verdict: 'neutral',
      label: LABEL.neutral,
      detail:
        modelMargin < MARKET_AGREEMENT.minModelMargin
          ? 'The evidence outside the market barely separates these players, so there is nothing for the market to agree or disagree with.'
          : `The market separates them by only ${marketMargin} points, which is not an opinion.`,
      modelPreferredId: modelTop.playerId,
      marketPreferredId: marketTop.playerId,
      marketMargin,
      material: false,
    };
  }

  if (modelTop.playerId === marketTop.playerId) {
    return {
      verdict: 'agrees',
      label: LABEL.agrees,
      detail: `The market and the rest of the evidence both favour ${modelTop.name}, by ${marketMargin} points of market expectation.`,
      modelPreferredId: modelTop.playerId,
      marketPreferredId: marketTop.playerId,
      marketMargin,
      material: false,
    };
  }

  const material = marketMargin >= MARKET_AGREEMENT.strongMarketMargin;
  return {
    verdict: 'disagrees',
    label: LABEL.disagrees,
    detail:
      `Usage, role and availability favour ${modelTop.name}, but the market prices ${marketTop.name} ` +
      `${marketMargin} points higher. Neither is overruled${material ? '; the gap is wide enough to be worth a second look' : ''}.`,
    modelPreferredId: modelTop.playerId,
    marketPreferredId: marketTop.playerId,
    marketMargin,
    material,
  };
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
