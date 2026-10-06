/**
 * The one number a start/sit decision is made on, wherever it is made.
 *
 * ## Why this exists
 *
 * Reported 30 September 2026, and measured on production the same night with
 * `scripts/probe-banner-vs-compare.mjs`:
 *
 *     Team card     Start RJ Harvey over Mark Andrews · +2.31 · FLEX
 *     Compare sheet Recommended: start Mark Andrews · 3.9 against −1.6
 *
 * Two screens, one decision, opposite answers. The card ranked on
 * `rankingPoints` in `lineup.ts`, which for a partly priced player is
 * Rotowire's published week with nothing else in it (9.53 − 7.22 = 2.31). The
 * sheet ranked on `score`, the sum of whichever betting lines were posted plus
 * this app's nudges. Harvey had one of his four lines posted (0.46 points, a
 * touchdown price) and Andrews three of four (5.00), so the sheet's 5.4-point
 * gap was almost entirely *coverage*: their injury charges were nearly equal
 * (−2.63 and −2.50).
 *
 * Neither number was the whole story. The card threw away the injury and
 * usage reads; the sheet measured how many lines a sportsbook happened to post.
 * So both now read this function, and it keeps the good half of each:
 *
 *  - **A complete market** is the week, so the answer is `score`, exactly as
 *    before: the market expectation plus every adjustment.
 *  - **An incomplete market with a published week** starts from Rotowire's
 *    figure (the whole week) and adds the *same* adjustments `score` carries —
 *    status, news, usage, matchup, game script — and not the market's partial
 *    sum or its coverage penalty, which describe the market, not the player.
 *  - **An incomplete market with nothing published** keeps `score`, the
 *    partial answer, as the lineup already did.
 *  - **No market and nothing published** is `unpriced`: `score` is only
 *    nudges. The Compare sheet still prints it (it always has, under a
 *    warning); the lineup treats it as unrankable, as it always has.
 *
 * ## What is left out, and why
 *
 * `replacement_risk` is the lineup's charge for the bench that would have to
 * cover a questionable starter. It needs the whole roster, which the Compare
 * sheet does not have (it compares anybody in the league), so a number built
 * with it could never be reproduced there. It still orders the lineup; it is
 * kept out of the number a *suggestion* is printed with, so a suggestion and
 * the sheet it opens are always the same arithmetic.
 */
import { budgetAdjustments, BUDGETED_KEYS } from './adjustmentBudget.ts';
import { marketIsComplete } from './projection.ts';

/** Where the base of a decision number came from. */
export type DecisionBasis = 'market' | 'published' | 'partial' | 'unpriced';

export interface DecisionPoints {
  /** The number decisions are made on. */
  points: number;
  basis: DecisionBasis;
  /** The weekly figure it was built from: the market's sum, or Rotowire's week. */
  base: number;
  /** Everything added to the base: status, news, usage, matchup and the rest. */
  adjustments: number;
}

export interface DecisionEvaluation {
  playerId: string;
  score: number | null;
  expectation?: { points: number | null; missingMarkets?: readonly string[] } | null;
  components?: readonly { key: string; value: number; unknown: boolean; preBudgetValue?: number }[];
}

/** Components that describe the market rather than the player. */
const MARKET_KEYS = new Set(['vegas', 'uncertainty']);
/** Needs the whole roster; see the docblock. */
const ROSTER_KEYS = new Set(['replacement_risk']);

const round2 = (v: number): number => Math.round(v * 100) / 100;

function sum(evaluation: DecisionEvaluation, keep: (key: string) => boolean): number {
  return (evaluation.components ?? [])
    .filter((c) => !c.unknown && keep(c.key))
    .reduce((total, c) => total + c.value, 0);
}

/**
 * The adjustments a published week carries, held to the same budget the market
 * number's are, measured against the published figure instead.
 *
 * The engine budgeted each secondary value against the market expectation,
 * which for a partly priced player is a few points at best, so it is read from
 * `preBudgetValue` here (the value before that) and budgeted again against the
 * week actually being used. Availability and the lineup-only cover charge are
 * not nudges and pass through as they are.
 */
function publishedAdjustments(evaluation: DecisionEvaluation, base: number, rosterRisk: boolean): number {
  const live = (evaluation.components ?? []).filter(
    (c) => !c.unknown && !MARKET_KEYS.has(c.key) && (rosterRisk || !ROSTER_KEYS.has(c.key)),
  );
  const nudges = budgetAdjustments(
    live.filter((c) => BUDGETED_KEYS.includes(c.key)).map((c) => ({ key: c.key, value: c.preBudgetValue ?? c.value })),
    base,
  );
  const rest = live.filter((c) => !BUDGETED_KEYS.includes(c.key)).reduce((a, c) => a + c.value, 0);
  return [...nudges.values()].reduce((a, v) => a + v, 0) + rest;
}

/**
 * The decision number for one player, or null when there is nothing to decide on.
 *
 * `published` is Rotowire's weekly figure by player id, the same map the lineup
 * and the Compare sheet both read. `rosterRisk` adds the lineup-only
 * `replacement_risk` charge back; only the lineup's own ordering asks for it.
 */
export function decisionPoints(
  evaluation: DecisionEvaluation,
  published?: ReadonlyMap<string, number>,
  opts: { rosterRisk?: boolean } = {},
): DecisionPoints | null {
  if (evaluation.score == null) return null;
  const rosterRisk = opts.rosterRisk === true;
  const hasMarket = evaluation.expectation?.points != null;
  const complete = hasMarket && marketIsComplete({ score: evaluation.score, expectation: evaluation.expectation ?? null });

  if (!complete) {
    const figure = published?.get(evaluation.playerId);
    if (figure != null && Number.isFinite(figure)) {
      const base = Math.max(0, figure);
      const adjustments = publishedAdjustments(evaluation, base, rosterRisk);
      return { points: round2(base + adjustments), basis: 'published', base: round2(base), adjustments: round2(adjustments) };
    }
  }

  const base = sum(evaluation, (k) => k === 'vegas');
  const withoutRoster = rosterRisk ? 0 : sum(evaluation, (k) => ROSTER_KEYS.has(k));
  const points = evaluation.score - withoutRoster;
  return {
    points: round2(points),
    basis: complete ? 'market' : hasMarket ? 'partial' : 'unpriced',
    base: round2(base),
    adjustments: round2(points - base),
  };
}
