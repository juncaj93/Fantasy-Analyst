/**
 * The market anchor, decomposed — and the gap fill that only ever touches a
 * component nobody has priced.
 *
 * ## The rule this file exists to enforce
 *
 * §19 of the handoff, in full: "If one prop component is missing: use
 * usage/history to estimate only the missing component; do not replace all
 * market-covered components." The worked example is a receiver with a receiving-
 * yards line and no receptions line — estimate the receptions, leave the yards
 * exactly as the market priced them.
 *
 * That is a statement about *arithmetic structure*, not about weights. It cannot
 * be satisfied by blending a market total with a model total, however carefully
 * the blend is tuned, because a blend moves the covered components too. It can
 * only be satisfied by keeping the market expectation **decomposed** and filling
 * holes in it individually. So this module works on
 * `VegasExpectation.contributions` — the per-market breakdown
 * `core/startsit/expectation.ts` already produces — rather than on its total.
 *
 * ## Where the fill numbers come from
 *
 * `core/xfp/model.ts`, unchanged and unreweighted. It already holds this app's
 * published, tested view of what a target and a carry are worth by position,
 * including the depth-of-target adjustment that separates a tight end running
 * seven-yard routes from a shallow receiver. Inventing a second set of rates
 * here would mean two modules in this codebase disagreeing about what a target
 * is worth, and the one that disagreed with the tested one would be this.
 *
 * ## Missing market is not zero
 *
 * §5, and it is the failure this whole design is arranged around. A component
 * with no line and no usable usage is left **absent** — not zero, not imputed
 * from a positional average. `basis` says which of the three worlds the estimate
 * came from and `points` is null when there is nothing at all, so a caller
 * physically cannot render a confident zero for a player nobody has priced and
 * nobody has watched.
 */

import { EXPECTED_MARKETS, type VegasExpectation } from '../startsit/expectation.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { MarketKey } from '../vegas/types.ts';
import { PASS_MODEL, RUSH_MODEL, depthAdjustedRates } from '../xfp/model.ts';
import { mayMoveMean } from './classification.ts';
import type { UsageFeatures } from './features.ts';

/** Where one component of the central estimate came from. */
export type ComponentSource = 'market' | 'model';

export interface AnchorComponent {
  market: MarketKey;
  /** Fantasy points this component contributes, under the league's scoring. */
  points: number;
  /** The market line, when there was one. Null for every modelled component. */
  line: number | null;
  source: ComponentSource;
  /** Human-readable arithmetic, e.g. `5.8 targets x 0.63 catch rate x 1 PPR`. */
  detail: string;
  /** The A-class feature key that authorised the fill. Absent for market components. */
  filledBy?: string;
}

/**
 * Which of the three worlds §14 describes this estimate came from.
 *
 * `market` — every component the position expects was priced.
 * `market_plus_model` — some were, and the rest were filled.
 * `model` — none were, so this is a model estimate and must be labelled one
 *   wherever it is shown. §5: "it must be clearly labeled as model-derived
 *   rather than market-derived."
 * `none` — neither a market nor enough usage. The honest answer is nothing.
 */
export type AnchorBasis = 'market' | 'market_plus_model' | 'model' | 'none';

export interface MarketAnchor {
  /** The sum of the priced components only. Null when none were priced. */
  marketPoints: number | null;
  /** The sum of the filled components only. Zero when nothing was filled. */
  modelPoints: number;
  /** Both together — the central estimate before any C-class adjustment. */
  points: number | null;
  components: AnchorComponent[];
  basis: AnchorBasis;
  /** Share of the position's expected markets that the market actually priced. */
  marketCoverage: number;
  /** Expected markets the market did not price. */
  missingMarkets: MarketKey[];
  /** Of those, the ones usage could estimate. */
  filledMarkets: MarketKey[];
  /** Of those, the ones it could not — left absent rather than zeroed. */
  unfilledMarkets: MarketKey[];
  /** One line per fill, so every estimated component is documented per §19. */
  notes: string[];
}

const EMPTY: MarketAnchor = {
  marketPoints: null,
  modelPoints: 0,
  points: null,
  components: [],
  basis: 'none',
  marketCoverage: 0,
  missingMarkets: [],
  filledMarkets: [],
  unfilledMarkets: [],
  notes: [],
};

/**
 * Build the anchor for one player.
 *
 * `expectation` is whatever `buildExpectation` produced for him — including the
 * case where it produced nothing, which is the ordinary state of the world
 * before a book has priced the week and is exactly when the usage model has to
 * carry the estimate on its own.
 */
export function buildAnchor(
  position: string,
  expectation: VegasExpectation | null | undefined,
  features: UsageFeatures | null | undefined,
  profile: ScoringProfile,
): MarketAnchor {
  const pos = position.toUpperCase();
  const expected = EXPECTED_MARKETS[pos] ?? [];
  if (expected.length === 0) return EMPTY;

  const components: AnchorComponent[] = [];
  const priced = new Set<MarketKey>();

  for (const contribution of expectation?.contributions ?? []) {
    priced.add(contribution.market);
    components.push({
      market: contribution.market,
      points: contribution.points,
      line: contribution.line,
      source: 'market',
      detail: contribution.detail,
    });
  }

  const missing = expected.filter((m) => !priced.has(m));
  const filled: MarketKey[] = [];
  const unfilled: MarketKey[] = [];
  const notes: string[] = [];

  for (const market of missing) {
    const fill = fillComponent(market, pos, features ?? null, profile);
    if (!fill) {
      unfilled.push(market);
      continue;
    }
    /*
     * The classification gate, on the path rather than beside it.
     *
     * `mayMoveMean` refuses any key that is not registered as A or C in
     * `core/projection/classification.ts`. A fill added to the switch below and
     * not added to that table therefore contributes nothing — which is the
     * failure mode worth having, because the alternative is a feature that
     * quietly moves every projection and appears in no audit.
     */
    if (!mayMoveMean(fill.filledBy)) {
      unfilled.push(market);
      notes.push(`${market} was not filled: ${fill.filledBy} is not classified as able to move the mean`);
      continue;
    }
    filled.push(market);
    components.push({ ...fill, market, source: 'model' });
    notes.push(`${market} had no market line and was estimated from usage: ${fill.detail}`);
  }

  const marketPoints = sum(components.filter((c) => c.source === 'market').map((c) => c.points));
  const modelPoints = sum(components.filter((c) => c.source === 'model').map((c) => c.points)) ?? 0;
  const marketCoverage = round3((expected.length - missing.length) / expected.length);

  if (components.length === 0) {
    return { ...EMPTY, missingMarkets: missing, unfilledMarkets: missing, marketCoverage };
  }

  const basis: AnchorBasis =
    marketPoints == null ? 'model' : filled.length === 0 ? 'market' : 'market_plus_model';

  if (unfilled.length > 0) {
    notes.push(
      `no market and no usable usage for ${unfilled.join(', ')}; ` +
        'left out of the estimate rather than counted as zero',
    );
  }

  return {
    marketPoints,
    modelPoints: round2(modelPoints),
    points: round2((marketPoints ?? 0) + modelPoints),
    components,
    basis,
    marketCoverage,
    missingMarkets: missing,
    filledMarkets: filled,
    unfilledMarkets: unfilled,
    notes,
  };
}

/**
 * Estimate one missing component, or return null when it cannot be estimated.
 *
 * Every branch returns null rather than zero when the usage it needs is absent.
 * A back with no stored carries has an *unknown* rushing component, and the
 * difference between that and a zero one is the difference between a player the
 * app declines to project and a player it projects as useless.
 */
function fillComponent(
  market: MarketKey,
  position: string,
  features: UsageFeatures | null,
  profile: ScoringProfile,
): (Omit<AnchorComponent, 'market' | 'source'> & { filledBy: string }) | null {
  if (!features || features.games === 0) return null;
  const targets = features.targetsPerGame.value;
  const carries = features.carriesPerGame.value;
  const attempts = features.passAttemptsPerGame.value;
  const adot = features.averageDepthOfTarget;

  switch (market) {
    case 'receptions': {
      if (targets == null || targets <= 0) return null;
      const rates = depthAdjustedRates(position, 1, adot);
      const perRec = profile.ppr + (position === 'TE' ? profile.teBonus : 0);
      const receptions = targets * rates.catchRate;
      return {
        points: round2(receptions * perRec),
        line: null,
        detail: `${round1(targets)} targets/gm x ${round2(rates.catchRate)} catch rate x ${perRec} per rec`,
        filledBy: 'fill.receptions',
      };
    }
    case 'receiving_yards': {
      if (targets == null || targets <= 0) return null;
      const rates = depthAdjustedRates(position, 1, adot);
      const yards = targets * rates.yardsPerTarget;
      return {
        points: round2(yards * profile.pointsPerRecYard),
        line: null,
        detail: `${round1(targets)} targets/gm x ${round2(rates.yardsPerTarget)} yds/target x ${profile.pointsPerRecYard}`,
        filledBy: 'fill.receiving_yards',
      };
    }
    case 'rush_yards': {
      if (carries == null || carries <= 0) return null;
      const rush = RUSH_MODEL[position] ?? RUSH_MODEL.RB!;
      return {
        points: round2(carries * rush.yardsPerCarry * profile.pointsPerRushYard),
        line: null,
        detail: `${round1(carries)} carries/gm x ${rush.yardsPerCarry} yds/carry x ${profile.pointsPerRushYard}`,
        filledBy: 'fill.rush_yards',
      };
    }
    case 'pass_yards': {
      if (attempts == null || attempts <= 0) return null;
      return {
        points: round2(attempts * PASS_MODEL.yardsPerAttempt * profile.pointsPerPassYard),
        line: null,
        detail: `${round1(attempts)} attempts/gm x ${PASS_MODEL.yardsPerAttempt} yds/att x ${profile.pointsPerPassYard}`,
        filledBy: 'fill.pass_yards',
      };
    }
    case 'pass_tds': {
      if (attempts == null || attempts <= 0) return null;
      return {
        points: round2(attempts * PASS_MODEL.tdPerAttempt * profile.passTd),
        line: null,
        detail: `${round1(attempts)} attempts/gm x ${PASS_MODEL.tdPerAttempt} TD/att x ${profile.passTd}`,
        filledBy: 'fill.touchdowns',
      };
    }
    case 'anytime_td': {
      /*
       * A probability, not a count, because that is what the market this
       * replaces is: `buildExpectation` multiplies an implied probability by
       * the touchdown's point value, and a fill that handed it an expected
       * *count* would overstate every high-volume back — two expected scores
       * is not two hundred per cent.
       *
       * Expected scores per game become P(at least one) through 1 - e^-λ, the
       * Poisson zero term. It is a modelling assumption and it is the standard
       * one; what makes it acceptable here is that it is bounded above by 1 by
       * construction, which is the property a share of a touchdown needs.
       *
       * This is also where the missing red-zone data hurts most, and the note
       * saying so travels with the component: a goal-line back and a back with
       * the same carries between the twenties come out identical.
       */
      if (position === 'QB') return null;
      const rates = depthAdjustedRates(position, 1, adot);
      const rush = RUSH_MODEL[position] ?? RUSH_MODEL.RB!;
      const fromTargets = targets != null && targets > 0 ? targets * rates.tdPerTarget : 0;
      const fromCarries = carries != null && carries > 0 ? carries * rush.tdPerCarry : 0;
      const lambda = fromTargets + fromCarries;
      if (lambda <= 0) return null;
      const probability = 1 - Math.exp(-lambda);
      const tdPoints = position === 'RB' ? profile.rushTd : profile.recTd;
      return {
        points: round2(probability * tdPoints),
        line: null,
        detail:
          `${round2(lambda)} expected scores/gm -> ${Math.round(probability * 100)}% anytime x ${tdPoints} ` +
          '(no red-zone split is published free, so a carry from the two counts as a carry)',
        filledBy: 'fill.touchdowns',
      };
    }
    default:
      return null;
  }
}

function sum(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((a, b) => a + b, 0));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
