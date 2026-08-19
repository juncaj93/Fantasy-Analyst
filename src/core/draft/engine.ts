/**
 * Draft recommendation engine.
 *
 * Composes independent, individually inspectable components into a ranking.
 * There is no opaque magic number: every component score, its weight and its
 * contribution are stored on the result and rendered in the UI.
 *
 * Safety: this module ranks and explains. It never drafts.
 */

import type { PlayerSignal } from '../evidence/types.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import { leagueFitMultipliers } from '../sleeper/scoring.ts';
import {
  assessAvoid,
  assessWait,
  myGuy,
  type AvoidTag,
  type MyGuyFlag,
  type MyGuyLevel,
  type WaitGuidance,
} from './decisions.ts';
import { NO_CLIFF, buildPositionTierMap, type PositionTierMap, type TierCliff } from './tiers.ts';
import { SEPARATION, draftScore, separationScore } from './score.ts';
import { CONCENTRATION, assessConcentration, type ConcentrationResult, type RosteredPlayer } from './concentration.ts';
import { OPPORTUNITY, evaluateOpportunity, type OpportunityResult } from './opportunity.ts';
import { computeNeed, computeScarcity, type NeedBreakdown, type RosterCounts } from './need.ts';
import { marketStrategyNote, type MarketStrategyNote } from './marketStrategy.ts';
import { estimateSurvival } from './survival.ts';
import {
  blendMarketBaseline,
  marketDisagreement,
  type MarketBaselineBlend,
  type MarketFormat,
} from './marketBaseline.ts';
import {
  marketExpectationScore,
  marketStandings,
  seasonBaseline,
  seasonPropSummary,
  type MarketBaseline,
  type PropSummary,
} from '../vegas/season.ts';
import type { SeasonMarketKey } from '../vegas/types.ts';

export interface DraftComponentWeights {
  marketValue: number;
  need: number;
  scarcity: number;
  leagueFit: number;
  /** Everything ever accepted about this player. Never decays. */
  newsLifetime: number;
  /** The last 30 days: the trend. */
  news30: number;
  /** The last 7 days: acceleration on top of the trend. */
  news7: number;
  survivalUrgency: number;
  /** What the season-long betting market expects of him, in this league's points. */
  marketExpectation: number;
  /** How far the user's own ★ flag can move a player. */
  myGuy: number;
  /** Extra caution on a player the accumulated research is against. */
  avoid: number;
  /** Acting sooner because the position is about to fall off a tier. */
  tierCliff: number;
}

/**
 * Default weights.
 *
 * The news tally is a strong *secondary* input, not a tiebreaker and not a
 * trump card. Calibrated deliberately:
 *
 * In the reach regime a point of ADP is worth about 0.05 of contribution, so
 * the news components together (up to ~0.67) can move a player roughly ten
 * places when the market is close — visibly reordering the board, which is the
 * point of keeping the tally at all. Against a large ADP gap they cannot win:
 * a player who fell 30 picks scores a full 1.0 on market value alone.
 *
 * Lifetime carries the most weight of the three. A player who was favoured all
 * offseason should still be favoured on draft day; recency modifies that
 * judgement rather than replacing it.
 */
export const DEFAULT_WEIGHTS: DraftComponentWeights = {
  marketValue: 1,
  // Best player available, not best player at a position I am missing.
  //
  // Need used to be worth 0.35 — a swing of 0.63 between an empty starting slot
  // and a filled one, which is about thirteen picks of ADP. Stacked on scarcity
  // and the tier cliff (both of which also rise when a position is needed) it
  // was enough to float a quarterback over objectively better players for no
  // reason except that the quarterback slot was empty. Nobody drafts like that.
  //
  // At 0.1, and scaled down further in the early rounds by `needUrgency`, an
  // empty slot is worth one or two picks in round one and three or four in the
  // last rounds: enough to break a genuine tie, never enough to beat a better
  // player.
  need: 0.1,
  scarcity: 0.2,
  leagueFit: 0.25,
  newsLifetime: 0.35,
  news30: 0.2,
  news7: 0.12,
  survivalUrgency: 0.22,
  // A second opinion on how good the player is, from people with money on it —
  // and deliberately a smaller voice than the draft market itself. At full
  // strength this is about four picks of ADP: enough to separate two players
  // the board rates the same, never enough to reorder the board on its own.
  // It is also scaled by coverage, so a baseline built from one market out of
  // three moves a player less than a complete one.
  marketExpectation: 0.2,
  // At full strength (★★★) this contributes 0.5 — about ten picks of ADP, the
  // "modest reach" the brief asks for and no more.
  myGuy: 0.5,
  // Stacks on top of the negative the news components already produce, so a
  // heavily negative player is pushed down twice without being removed.
  avoid: 0.3,
  // Enough to reorder players the market rates similarly; never enough to beat
  // a genuine bargain. Trimmed alongside `need`, because a cliff at a position
  // you need is scored partly on that need and would otherwise smuggle the
  // roster-need signal back in at full strength.
  tierCliff: 0.15,
};

/**
 * How much of the roster-need weight applies at this point in the draft.
 *
 * Round one is a market: the best player on the board is the best pick, and an
 * empty quarterback slot in the first ten picks is not news — there are fifteen
 * rounds left to fill it. By the last rounds an unfilled starting slot is a real
 * problem, because there is no longer time to solve it, so the same signal is
 * allowed its full (already small) weight.
 *
 * Returns a multiplier in [0.35, 1].
 */
export function needUrgency(currentPick: number, totalPicks: number): number {
  if (!Number.isFinite(totalPicks) || totalPicks <= 1) return 1;
  const progress = clamp((currentPick - 1) / (totalPicks - 1), 0, 1);
  return round3(0.35 + 0.65 * progress);
}

/**
 * Net tally at which each window is considered maxed out.
 *
 * Shorter windows saturate sooner because they hold fewer items: +3 in a week
 * is as emphatic as a week gets, while +10 over a career is merely strong.
 */
export const NEWS_SATURATION = { lifetime: 10, last30: 5, last7: 3 } as const;

/**
 * How much the recent windows are damped when they contradict lifetime.
 *
 * Disagreement between "all offseason" and "the last month" is real
 * information, but it is ambiguous information — the honest response is to
 * trust it less, not to pick a side.
 */
export const NEWS_CONFLICT_DAMPING = 0.5;

export interface AvailablePlayerInput {
  player: CanonicalPlayer;
  /**
   * Sleeper ADP — the market the user is drafting in.
   *
   * Still the number the card shows, still what `Val` is measured from, still
   * what scarcity, the tier ladders and the survival model read. It is one of
   * two inputs to the market baseline rather than the baseline itself; see
   * `dogAdp` below and `marketBaseline.ts`.
   */
  adp: number | null;
  /**
   * Raw Underdog ADP, when a usable snapshot has priced him.
   *
   * Absent, null or stale means the market baseline falls back to Sleeper alone
   * and reports itself single-source. It is never derived from `adp`: an
   * Underdog number this app invented would be indistinguishable from one
   * Underdog published, which is the whole reason DOG is worth having.
   */
  dogAdp?: number | null;
  /** ADP rank within the snapshot, when present. */
  adpRank: number | null;
  signal: PlayerSignal | null;
  /** The user's own ★ flag, 0 when they have not marked this player. */
  myGuyLevel?: MyGuyLevel;
  /**
   * Season-long market lines for this player, already resolved to him.
   *
   * Absent means the market has not priced him — which is not the same as
   * pricing him at zero, and is scored as unknown.
   */
  seasonMarkets?: { market: SeasonMarketKey; line: number | null; bookCount?: number }[];
  /**
   * The chance the room leaves him until your next pick, when the caller has
   * simulated it.
   *
   * The engine's own `estimateSurvival` reads ADP and nothing else, which is all
   * a pure ranking function can see: who else is picking, what those managers
   * are short of and what the room has been doing are live draft state that
   * deliberately never enters this module. The board service does have that
   * state, so it runs the simulation and hands the answer in here — and when it
   * cannot (no draft loaded, a unit test, a degraded board) the ADP estimate
   * still answers, which is why this is optional rather than required.
   *
   * `note` carries the drivers behind the number, and is appended to the
   * component's own sentence rather than replacing it.
   */
  nextPickSurvival?: { probability: number | null; note: string };
}

export interface DraftContext {
  currentPick: number;
  /**
   * The pick a player would have to survive to if you passed on him now — the
   * user's next selection *after* the one on the clock, never the one on it.
   *
   * Everything in this engine that asks "what happens if I wait" measures
   * against this: survival, positional scarcity, and how urgent a tier cliff
   * is. Setting it to the pick on the clock makes all three answer "nothing
   * happens if you wait", which is exactly wrong at the moment they are read.
   *
   * `null` on the final selection of the draft, and it stays null: there is no
   * later pick, and every one of those three is then honestly unknown.
   */
  nextPick: number | null;
  shape: RosterShape;
  profile: ScoringProfile;
  rosterCounts: RosterCounts;
  /** Total picks in the draft, used to bound value normalisation. */
  totalPicks: number;
  /**
   * Who the user has already drafted, with their NFL teams.
   *
   * Optional, and absent means the concentration component scores nothing at
   * all rather than assuming an empty roster — a board built before the live
   * roster is known should not tell the user their offences are nicely spread.
   * `rosterCounts` cannot stand in for it: a count per position has no idea
   * which NFL team anybody plays for.
   */
  rosterPlayers?: RosteredPlayer[];
  /**
   * Which blend the market baseline uses — `standard` (60/40) or `best_ball`
   * (75/25).
   *
   * Read from Sleeper's own league settings by `detectBestBall`, never guessed
   * from a name or a date. Absent means `standard`, which is also what an
   * unconfident detection resolves to.
   */
  marketFormat?: MarketFormat;
}

export interface ComponentScore {
  key: string;
  label: string;
  /** Raw, human-meaningful value (e.g. "+8 picks of value"). */
  display: string;
  /**
   * Normalised score in [-1, 1].
   *
   * One exception: market value goes below -1, without limit, so that a large
   * reach cannot be outvoted by the smaller components put together.
   */
  score: number;
  weight: number;
  /** score * weight — what actually moved the ranking. */
  contribution: number;
  /** True when the underlying data was missing; contribution is then 0. */
  unknown: boolean;
}

export interface DraftRecommendation {
  playerId: string;
  name: string;
  position: string;
  team: string;
  adp: number | null;
  /**
   * Raw Underdog ADP, or null when no usable snapshot priced him.
   *
   * Carried through untouched so the card can print it beside Sleeper's number
   * and the `DOG` sort can order by it. Never filled in from Sleeper.
   */
  dogAdp: number | null;
  /**
   * `Val`: how far past **Sleeper's** ADP this pick is, unchanged.
   *
   * Deliberately not the blend. `Val` has always meant "what this player is
   * worth in the room I am drafting in", and quietly turning it into a
   * DOG-versus-Sleeper composite would change what a number on screen means
   * without changing its label. The blended baseline is reported separately, on
   * the market-value component and in `marketBlend` below.
   */
  adpValue: number | null;
  /**
   * The market baseline that actually priced him: the blend, its weights, which
   * markets contributed, and whether it was single-source.
   */
  marketBlend: MarketBaselineBlend;
  /**
   * How far apart the two markets are, as context and never as a second bonus.
   *
   * The blend has already paid for the disagreement. This exists so a card can
   * say "Underdog takes him 18 picks earlier than Sleeper" without anything in
   * the ranking counting those eighteen picks twice.
   */
  marketDisagreement: ReturnType<typeof marketDisagreement>;
  survivalProbability: number | null;
  /** Net tally per window, so the UI never has to re-derive them. */
  newsLifetimeNet: number;
  news30Net: number;
  news7Net: number;
  /** True when the recent trend contradicts the lifetime record. */
  newsConflicted: boolean;
  components: ComponentScore[];
  /** Sum of contributions. Comparable within one board state only. */
  total: number;
  /**
   * `total`, as a whole number a person can read: 0–100, higher is better.
   *
   * A pure function of `total` and nothing else — see `score.ts`. It is the
   * same ordering the board is sorted by, so board rank and Score can only
   * disagree where two totals round to the same number.
   *
   * **Null when no market has priced him.** His total is real but it is not on
   * the same scale as a priced player's, because the component that dominates
   * that scale is absent rather than low — and a total near zero maps to 83 on
   * a curve calibrated for boards whose middle is negative. He shows `—` here
   * for the same reason he already shows `—` for `ADP`, `Val` and `Next`.
   */
  score: number | null;
  reasons: string[];
  counterpoints: string[];
  /** True when a key input (ADP) was missing. */
  degraded: boolean;
  /**
   * What the season-long market expects of him, in this league's points, and
   * the one-line form of it a card shows. Null when nothing is priced.
   */
  marketBaseline: MarketBaseline | null;
  marketHeadline: string | null;
  /**
   * The same line, taken apart.
   *
   * The card prints `marketHeadline`; this is what it is made of, so the
   * expanded card can say which markets were summed, what each one's line was
   * and what was absent. A quantity this app derived from two markets is never
   * presented as one book's number, and `derived` is how a renderer knows.
   */
  marketProps: PropSummary | null;
  /**
   * Why that number is a good one for his position, and whether the draft
   * market agrees. Explanation only; see `marketStrategy.ts`.
   */
  marketStrategy: MarketStrategyNote | null;
  /** Whether the position is about to fall off a tier. */
  tierCliff: TierCliff;
  /** The automatic caution from accumulated research. */
  avoid: AvoidTag;
  /** The user's own preference, separate from the news tally. */
  myGuy: MyGuyFlag;
  /** Take Now / Can Probably Wait / ... */
  wait: WaitGuidance;
  /**
   * What passing on him would cost: scarcity of comparable alternatives, and
   * the gap to the best one expected to survive to your next pick.
   */
  opportunity: OpportunityResult;
  /** Overlap with the NFL offences already on the user's roster. */
  concentration: ConcentrationResult;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Enforce the one contract every component in this file claims to keep:
 * **unknown contributes nothing.**
 *
 * It is written down on `ComponentScore.unknown` — "contribution is then 0" —
 * and it was quietly false. Positional scarcity returned its no-data default
 * for a player with no ADP, mapped it onto −0.4 like a real measurement, and
 * spent −0.08 of composite on him while the same row of the breakdown told the
 * reader the number was unknown. Every unpriced player on the board carried it.
 *
 * A single choke point rather than care at twelve call sites, because the
 * failure was not carelessness at any one of them: it was that nothing checked.
 * `contribution` is what moves the ranking, so that is what is corrected, and
 * `score` follows it so the breakdown cannot show a number the total did not
 * use. Returns the components it was given, mutated in place — they are freshly
 * built and nothing else has seen them.
 */
export function sealComponents(components: ComponentScore[]): ComponentScore[] {
  for (const component of components) {
    if (!component.unknown) continue;
    component.score = 0;
    component.contribution = 0;
  }
  return components;
}

/** Before pass two has run, nothing is known about the cost of waiting. */
const NO_OPPORTUNITY: OpportunityResult = {
  score: 0,
  opportunityScore: 0,
  replacementScore: 0,
  expectedComparableSurvivors: null,
  expectedReplacement: null,
  replacementValueRaw: null,
  replacementValueNet: null,
  confidence: 'low',
  reason: 'not yet measured',
  driver: null,
};

/** What a board with no known roster says about NFL-team overlap: nothing. */
const NO_CONCENTRATION: ConcentrationResult = {
  score: 0,
  skillCount: 0,
  hasQuarterback: false,
  isQuarterbackOfOwned: false,
  display: 'your drafted roster is not known yet',
  driver: null,
};

/**
 * Market value = currentPick - market baseline (docs/03_DRAFT_ENGINE.md).
 *
 * Positive means the player has FALLEN past their market price and is a bargain
 * at this pick. Negative means taking them here is a reach, which is damped
 * rather than fully penalised — survival probability separately handles "he
 * won't last".
 *
 * **The baseline is not Sleeper's ADP alone.** It is the blend of raw Underdog
 * ADP and Sleeper ADP defined in `marketBaseline.ts` — 60/40, or 75/25 in a
 * best-ball league — collapsing to whichever single market answered when the
 * other has not priced him. This is the *only* component the blend reaches: the
 * ADP shown on the card, the `Val` beside it, positional scarcity, the tier
 * ladders and the survival model all still read Sleeper's own number, which is
 * the market the user is drafting in. See `blendMarketBaseline`.
 *
 * `blend` is optional so that every existing caller — the tests, the probes, a
 * board built before DOG was ever imported — keeps the behaviour it had, with
 * Sleeper's ADP as the whole baseline.
 */
export function marketValueComponent(
  adp: number | null,
  currentPick: number,
  teams: number,
  blend?: MarketBaselineBlend | null,
): ComponentScore {
  const weight = DEFAULT_WEIGHTS.marketValue;
  // The blend when there is one, Sleeper's own number when there is not.
  const baseline = blend ? blend.adp : adp;
  if (baseline == null) {
    return {
      key: 'market_value',
      label: 'ADP value',
      display: 'no ADP',
      score: 0,
      weight,
      contribution: 0,
      unknown: true,
    };
  }
  const delta = currentPick - baseline; // positive = fell past the market to you
  const scale = Math.max(6, teams || 12);
  // Asymmetric: falling value counts fully, reaching is damped by half.
  const raw = delta >= 0 ? delta / scale : delta / (scale * 2);
  // Value saturates; a reach does not.
  //
  // A player who fell 100 picks is not ten times better than one who fell ten,
  // because you can only spend the one pick — so the upside caps at 1. A reach
  // has no such ceiling: taking a player 160 picks early is not "somewhat bad",
  // it is unjustifiable, and capping it at -1 made every distant player look
  // identical. That is what let a quarterback with an ADP of 202 reach the top
  // ten of the board at pick 38, on roster need alone.
  const score = Math.min(raw, 1);
  /*
   * The number, and — when two markets made it — which markets and in what
   * proportion. A blended baseline that printed only its own answer would be
   * the one line of the breakdown nobody could check against the card.
   */
  const provenance = blend && blend.sources.length > 0 ? ` · baseline ${blend.adp} (${blend.note})` : '';
  return {
    key: 'market_value',
    label: 'ADP value',
    display: `${delta >= 0 ? `+${round1(delta)} picks of value` : `${round1(delta)} picks (a reach)`}${provenance}`,
    score: round3(score),
    weight,
    contribution: round3(score * weight),
    unknown: false,
  };
}

export type NewsWindowKey = 'news_lifetime' | 'news_30d' | 'news_7d';

const NEWS_META: Record<NewsWindowKey, { label: string; saturation: number; weightKey: keyof DraftComponentWeights }> = {
  news_lifetime: { label: 'Lifetime news', saturation: NEWS_SATURATION.lifetime, weightKey: 'newsLifetime' },
  news_30d: { label: 'Last 30 days', saturation: NEWS_SATURATION.last30, weightKey: 'news30' },
  news_7d: { label: 'Last 7 days', saturation: NEWS_SATURATION.last7, weightKey: 'news7' },
};

/**
 * One news window as a scored component.
 *
 * `damping` is applied to the recent windows when they contradict lifetime; it
 * is always 1 for the lifetime window itself.
 */
export function newsComponent(
  key: NewsWindowKey,
  net: number,
  items: number,
  weights: DraftComponentWeights = DEFAULT_WEIGHTS,
  damping = 1,
): ComponentScore {
  const meta = NEWS_META[key];
  const weight = weights[meta.weightKey];
  if (items === 0) {
    return { key, label: meta.label, display: 'no evidence', score: 0, weight, contribution: 0, unknown: true };
  }
  const score = clamp(net / meta.saturation, -1, 1) * damping;
  return {
    key,
    label: meta.label,
    display: `${net > 0 ? '+' : ''}${net} net (${items} item${items === 1 ? '' : 's'})${damping < 1 ? ', damped' : ''}`,
    score: round3(score),
    weight,
    contribution: round3(score * weight),
    unknown: false,
  };
}

/**
 * True when the recent trend points the opposite way to the lifetime record.
 *
 * Only counts when both are actually saying something: a zero is not a
 * disagreement, it is an absence.
 */
export function newsConflicts(lifetimeNet: number, recentNet: number): boolean {
  return lifetimeNet !== 0 && recentNet !== 0 && Math.sign(lifetimeNet) !== Math.sign(recentNet);
}

/** Rank the available pool. Pure and deterministic. */
export function rankAvailablePlayers(
  available: AvailablePlayerInput[],
  ctx: DraftContext,
  weights: DraftComponentWeights = DEFAULT_WEIGHTS,
): DraftRecommendation[] {
  const needs = computeNeed(ctx.shape, ctx.rosterCounts);
  const fit = leagueFitMultipliers(ctx.profile, ctx.shape);
  const teams = Math.max(1, ctx.shape.totalStarters > 0 ? ctx.totalPicks / Math.max(1, ctx.totalPicks) : 1);
  void teams;

  // ADP pools per position, used for scarcity.
  const adpsByPosition = new Map<string, number[]>();
  for (const a of available) {
    if (a.adp == null) continue;
    const list = adpsByPosition.get(a.player.position);
    if (list) list.push(a.adp);
    else adpsByPosition.set(a.player.position, [a.adp]);
  }

  const picksUntilNext = ctx.nextPick == null ? 0 : Math.max(0, ctx.nextPick - ctx.currentPick);

  /*
   * Tier ladders, one per position, built once for the whole board.
   *
   * Every player at a position is classified from the same sorted array of
   * still-available ADPs, so a card cannot disagree with the card above it, and
   * a forty-row board costs one pass per position rather than one ladder per
   * row. Recomputed on every call, which is every poll and every refresh — a
   * cluster that empties during the draft becomes a real edge immediately.
   */
  const tierMaps = new Map<string, PositionTierMap>();
  for (const [position, adps] of adpsByPosition) {
    tierMaps.set(position, buildPositionTierMap(position, adps, { picksUntilNext }));
  }
  const teamCount = estimateTeamCount(ctx);
  // Round and draft length, derived from the same team estimate the rest of the
  // engine uses, so the concentration ramp cannot disagree with the board about
  // how late it is.
  const round = Math.max(1, Math.ceil(ctx.currentPick / teamCount));
  const totalRounds = Math.max(1, Math.round(ctx.totalPicks / teamCount));
  const needRamp = needUrgency(ctx.currentPick, ctx.totalPicks);
  const needWeight = round3(weights.need * needRamp);

  /*
   * Market baselines, computed once for the whole pool.
   *
   * A player's season expectation only means something next to the other
   * players at his position — a thousand receiving yards is ordinary for a
   * receiver and exceptional for a tight end — so the comparison pool is built
   * here rather than per player.
   */
  const baselines = new Map<string, MarketBaseline>();
  const poolByPosition = new Map<string, MarketBaseline[]>();
  /*
   * What the draft charges for each priced player, keyed by his baseline.
   *
   * Only the expanded card's explanation reads this -- it is how "the books are
   * keener than the room" is measured against the same peers the props
   * comparison used. The blended baseline rather than Sleeper's own number,
   * because that is the price the board actually holds him at.
   */
  const costByBaseline = new Map<MarketBaseline, number | null>();
  for (const entry of available) {
    if (!entry.seasonMarkets || entry.seasonMarkets.length === 0) continue;
    const baseline = seasonBaseline(entry.player.position, entry.seasonMarkets, ctx.profile);
    baselines.set(entry.player.id, baseline);
    costByBaseline.set(
      baseline,
      blendMarketBaseline({
        dogAdp: entry.dogAdp ?? null,
        sleeperAdp: entry.adp,
        format: ctx.marketFormat ?? 'standard',
      }).adp,
    );
    if (baseline.points != null) {
      // Whole baselines, not their totals: the comparison is made market by
      // market so a player priced on fewer of them is not read as a worse
      // player. See `marketExpectationScore`.
      const list = poolByPosition.get(entry.player.position);
      if (list) list.push(baseline);
      else poolByPosition.set(entry.player.position, [baseline]);
    }
  }

  /*
   * Pass one: every component except separation.
   *
   * Split in two on purpose. Separation asks how far ahead of his alternatives
   * a player is, and the only honest answer comes from composites that are
   * already settled — see the second pass below.
   */
  const recommendations = available.map((entry) => {
    const { player, adp, signal } = entry;
    const components: ComponentScore[] = [];

    /*
     * The price the board holds him at, from whichever markets have one.
     *
     * Computed per player rather than per board because the renormalisation is
     * per player: a board can perfectly well hold one player Underdog has
     * priced and Sleeper has not, and another the other way round, and neither
     * should be penalised for the gap in the other's coverage.
     */
    const blend = blendMarketBaseline({
      dogAdp: entry.dogAdp ?? null,
      sleeperAdp: adp,
      format: ctx.marketFormat ?? 'standard',
    });

    const market = marketValueComponent(adp, ctx.currentPick, teamCount, blend);
    market.weight = weights.marketValue;
    market.contribution = round3(market.score * weights.marketValue);
    components.push(market);

    // --- roster need -------------------------------------------------------
    // Deliberately light, and lighter still early on: the weight actually used
    // is on the component, so "score × weight" in the breakdown always shows
    // the real number rather than a nominal one.
    const need = needs[player.position];
    const needScoreMapped = round3((need?.score ?? 0.1) * 2 - 1); // map 0..1 onto -1..1
    components.push({
      key: 'need',
      label: 'Roster need',
      display: `${need?.reason ?? 'not used by this league'}${needRamp < 1 ? ' (early-round need is discounted)' : ''}`,
      score: needScoreMapped,
      weight: needWeight,
      contribution: round3(needScoreMapped * needWeight),
      unknown: false,
    });

    // --- positional scarcity ----------------------------------------------
    // Scarcity is measured from where he sits on the board, so a player the
    // market has not priced has no scarcity: `computeScarcity` returns its
    // "insufficient data" 0.3, which maps to −0.4 and used to be spent as a
    // real −0.08 on a component the breakdown was simultaneously labelling
    // unknown. An unpriced player is unknown, not slightly bad.
    const scarcityKnown = adp != null;
    const scarcity = computeScarcity({
      availableAdps: adpsByPosition.get(player.position) ?? [],
      playerAdp: adp,
      picksUntilNext,
    });
    const scarcityScore = scarcityKnown ? round3(scarcity.score * 2 - 1) : 0;
    components.push({
      key: 'scarcity',
      label: 'Positional scarcity',
      display: scarcity.reason,
      score: scarcityScore,
      weight: weights.scarcity,
      contribution: round3(scarcityScore * weights.scarcity),
      unknown: !scarcityKnown,
    });

    // --- league fit --------------------------------------------------------
    const multiplier = fit[player.position] ?? 1;
    const fitScore = clamp((multiplier - 1) / 0.25, -1, 1);
    components.push({
      key: 'league_fit',
      label: 'League fit',
      display: `${player.position} x${multiplier.toFixed(2)} in ${ctx.profile.label}${ctx.shape.superflex ? ' superflex' : ''}`,
      score: round3(fitScore),
      weight: weights.leagueFit,
      contribution: round3(fitScore * weights.leagueFit),
      unknown: false,
    });

    // --- news ---------------------------------------------------------------
    // Three windows, kept separate so the reasoning stays legible: lifetime is
    // the base and never decays, 30 days is the trend, 7 days is acceleration.
    const lifetimeNet = signal?.raw.net ?? 0;
    const net30 = signal?.last30.net ?? 0;
    const net7 = signal?.last7.net ?? 0;
    const conflicted = newsConflicts(lifetimeNet, net30);
    const damping = conflicted ? NEWS_CONFLICT_DAMPING : 1;

    const lifetimeNews = newsComponent('news_lifetime', lifetimeNet, signal?.raw.items ?? 0, weights);
    const news30 = newsComponent('news_30d', net30, signal?.last30.items ?? 0, weights, damping);
    const news7 = newsComponent('news_7d', net7, signal?.last7.items ?? 0, weights, damping);
    components.push(lifetimeNews, news30, news7);

    // --- survival urgency --------------------------------------------------
    const survival: { probability: number | null; note: string } =
      entry.nextPickSurvival ??
      estimateSurvival({
        adp,
        currentPick: ctx.currentPick,
        // Passed through, null and all. Substituting the current pick here turned
        // "there is no later pick" into "certain to last", which is its opposite.
        nextPick: ctx.nextPick,
      });
    const urgencyScore = survival.probability == null ? 0 : clamp(1 - survival.probability * 2, -1, 1);
    components.push({
      key: 'survival',
      label: 'Survival to next pick',
      display:
        survival.probability == null
          ? survival.note
          : // The number, then whatever the model found to say about it. The
            // drivers arrive already filtered to the ones that actually moved
            // the simulation, so an empty note means nothing stood out rather
            // than that nothing was checked.
            `${Math.round(survival.probability * 100)}% chance to last to pick ${ctx.nextPick}${
              survival.note ? ` · ${survival.note}` : ''
            }`,
      score: round3(urgencyScore),
      weight: weights.survivalUrgency,
      contribution: round3(urgencyScore * weights.survivalUrgency),
      unknown: survival.probability == null,
    });

    // --- season market expectation -----------------------------------------
    // Market context, not a bet: the line is converted into this league's own
    // points and compared with the rest of the position. Unpriced players score
    // nothing rather than zero, because "nobody has quoted him" is not "the
    // market expects nothing of him".
    const baseline = baselines.get(player.id) ?? null;
    const marketScore = marketExpectationScore(baseline, poolByPosition.get(player.position) ?? []);
    components.push({
      key: 'market_expectation',
      label: 'Season market',
      display:
        baseline?.points == null
          ? 'no season market for this player'
          : `${baseline.points} pts implied · ${baseline.note}`,
      score: marketScore ?? 0,
      weight: weights.marketExpectation,
      contribution: round3((marketScore ?? 0) * weights.marketExpectation),
      unknown: marketScore == null,
    });

    // --- decision quality ---------------------------------------------------
    // These are judgements rather than measurements, so each one is attached to
    // the result in full: the tag the UI shows and the contribution that moved
    // the ranking come from the same object, and cannot drift apart.
    const needScore = need?.score ?? 0.1;

    /*
     * Market landscape only. Roster need used to scale this, which meant the
     * same board reported a different tier structure to two different rosters —
     * "is there a hole in the board" is not a question about your team. Need
     * still moves the ranking; it moves it through its own component.
     */
    const cliff = tierMaps.get(player.position)?.at(adp) ?? NO_CLIFF;
    components.push({
      key: 'tier_cliff',
      label: 'Tier cliff',
      // When the answer is "no", say what was measured. A silent "no cliff" is
      // the one line of the breakdown that cannot be checked against the board.
      display: cliff.message ?? describeQuietTier(player.position, cliff),
      score: round3(cliff.score),
      weight: weights.tierCliff,
      contribution: round3(cliff.score * weights.tierCliff),
      unknown: adp == null,
    });

    const avoid = assessAvoid(lifetimeNet, net30);
    components.push({
      key: 'avoid',
      label: 'Research caution',
      display: avoid.active ? avoid.message : 'nothing in the ledger warns against him',
      score: round3(avoid.score),
      weight: weights.avoid,
      contribution: round3(avoid.score * weights.avoid),
      unknown: false,
    });

    const flag = myGuy(entry.myGuyLevel ?? 0);
    components.push({
      key: 'my_guy',
      label: 'Personal preference',
      display: flag.level > 0 ? `${flag.stars} ${flag.label}` : 'not flagged',
      score: round3(flag.score),
      weight: weights.myGuy,
      contribution: round3(flag.score * weights.myGuy),
      unknown: false,
    });

    /*
     * Roster texture: one NFL offence, and how much of it you already own.
     *
     * Scored in pass one because it depends on the user's roster and not at all
     * on the rest of the board — unlike separation and opportunity cost below,
     * which cannot be answered until every other player's composite exists.
     */
    const concentration = ctx.rosterPlayers
      ? assessConcentration({
          position: player.position,
          team: player.team,
          roster: ctx.rosterPlayers,
          round,
          totalRounds,
        })
      : NO_CONCENTRATION;
    components.push({
      key: 'team_concentration',
      label: 'NFL team overlap',
      display: ctx.rosterPlayers ? concentration.display : 'your drafted roster is not known yet',
      score: concentration.score,
      weight: CONCENTRATION.weight,
      contribution: round3(concentration.score * CONCENTRATION.weight),
      unknown: ctx.rosterPlayers == null,
    });

    const wait = assessWait({
      survivalProbability: survival.probability,
      cliff,
      needScore,
      expectedRemaining: scarcity.expectedRemaining,
      position: player.position,
      nextPick: ctx.nextPick,
    });

    sealComponents(components);
    const total = round3(components.reduce((a, c) => a + c.contribution, 0));
    const { reasons, counterpoints } = explain(entry, components, {
      need,
      scarcity,
      survival: survival.probability,
      profile: ctx.profile,
      shape: ctx.shape,
      newsConflicted: conflicted,
      cliff,
      avoid,
      myGuyFlag: flag,
      wait,
    });

    /*
     * The market line and its workings, built once.
     *
     * Display only. Nothing below reads it, and nothing in the ranking reads it
     * at any point — the score's own view of the market is `marketBaseline`,
     * computed in the first pass and untouched by this.
     */
    const props = entry.seasonMarkets?.length
      ? seasonPropSummary(player.position, entry.seasonMarkets, { baseline })
      : null;
    /*
     * And why that number is a good one or a poor one, for the expanded card.
     *
     * Explanation only -- see `marketStrategy.ts`. The two markets it compares
     * are both already in the composite as separate components, so their
     * disagreement is priced; saying it out loud is not scoring it again.
     */
    const strategy = marketStrategyNote(
      marketStandings(baseline, poolByPosition.get(player.position) ?? [], (b) => costByBaseline.get(b) ?? null),
      player.position,
    );

    return {
      playerId: player.id,
      name: player.fullName,
      position: player.position,
      team: player.team,
      adp,
      dogAdp: entry.dogAdp ?? null,
      // Sleeper's own value, unchanged — see the field's own note.
      adpValue: adp == null ? null : round1(ctx.currentPick - adp),
      marketBlend: blend,
      marketDisagreement: marketDisagreement(entry.dogAdp ?? null, adp),
      survivalProbability: survival.probability,
      newsLifetimeNet: lifetimeNet,
      news30Net: net30,
      news7Net: net7,
      newsConflicted: conflicted,
      components,
      total,
      reasons,
      counterpoints,
      /*
       * Degraded means "no market has priced him", not "Sleeper has not".
       *
       * A player Underdog prices and Sleeper does not is priced — that is the
       * whole point of having two markets — and marking him degraded would be
       * penalising him for a hole in one source's coverage, which the brief
       * rules out in as many words.
       */
      degraded: blend.unknown,
      // Filled in by the second pass, once every base composite exists.
      score: 0,
      marketBaseline: baseline,
      marketHeadline: props?.headline ?? null,
      marketProps: props,
      marketStrategy: strategy,
      tierCliff: cliff,
      avoid,
      myGuy: flag,
      wait,
      // Both filled in by the second pass, which needs every base composite.
      opportunity: NO_OPPORTUNITY,
      concentration,
    } satisfies DraftRecommendation;
  });

  applyBoardComponents(recommendations, { needs, nextPick: ctx.nextPick });

  /*
   * Priced players first, then by total, then by ADP, then by name.
   *
   * The first key is a policy rather than arithmetic, and it is there because
   * the arithmetic alone gets this badly wrong. Market value is measured
   * against the pick on the clock, so at pick 1 a player with an ADP of 245
   * scores heavily negative — he is a huge reach right now — while a player
   * with no ADP at all scores exactly zero, because an unknown contributes
   * nothing. Sorting on the total alone therefore floats every anonymous player
   * above every genuinely-ranked one who happens to be going later, and the
   * board opens with names nobody has heard of. Measured on a 305-player pool,
   * the first unpriced player came second.
   *
   * The honest reading of a missing ADP is "we cannot price him", and the
   * conservative thing to do with a player we cannot price is to rank him after
   * the players we can. He keeps his real score, shows `ADP —`, and is marked
   * degraded; what he does not get is a place he earned only by being unknown.
   */
  /*
   * "Priced" now means priced by *either* market.
   *
   * The policy is unchanged — a player nobody has priced ranks after every
   * player somebody has — but the question it asks moved from "does Sleeper
   * rank him" to "does any market rank him", which is what stops a player
   * Underdog has priced and Sleeper has not from being sorted to the tail for
   * a reason that has nothing to do with him.
   */
  return recommendations.sort(
    (a, b) =>
      Number(a.marketBlend.adp == null) - Number(b.marketBlend.adp == null) ||
      b.total - a.total ||
      (a.marketBlend.adp ?? Number.MAX_SAFE_INTEGER) - (b.marketBlend.adp ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Pass two: how isolated each player is, and the readable Score.
 *
 * The board already knew that a player who falls gets better — market value is
 * a function of how far past his ADP the draft has run. What it did not know is
 * the other half of the same fact: **who is left instead of him.** Three
 * receivers going in the six picks before your turn moves nobody's ADP by one,
 * and changes the decision completely.
 *
 * So this measures the distance between a player's composite and the composites
 * of the next few available players at his own position, and adds a bounded
 * quarter-point for it. Two properties make it safe:
 *
 *  - it reads *base composites*, fixed before this function runs, never ordinal
 *    board rank — so its input cannot be moved by its own output, and a player
 *    cannot climb because he is already high;
 *  - it only ever adds, and never more than {@link SEPARATION.weight} — about
 *    five picks of ADP. A player who slides twenty picks becomes better
 *    relative to what is left, which is the claim; he does not become a lock.
 *
 * Mutates in place, because the recommendations are freshly built above and
 * nothing else has seen them yet.
 */
function applyBoardComponents(
  recommendations: DraftRecommendation[],
  ctx: { needs: Record<string, NeedBreakdown>; nextPick: number | null },
): void {
  /*
   * Only priced players are comparable, either as a subject or as an alternative.
   *
   * A composite is dominated by market value, whose weight is 1.0 against about
   * 2.4 for everything else put together — and market value is *absent* for an
   * unpriced player rather than low. His base therefore sits near zero while a
   * priced player who is not yet due sits well below it, because being taken
   * before his ADP is a real cost that the board is right to charge him.
   *
   * Zero is not neutral on that scale. It is a good score. So measuring "how
   * clear of his alternatives is he" or "what would waiting cost" against an
   * unpriced base compares an absence with a measurement and returns the
   * absence as an edge: on a live-shaped board an unpriced back collected
   * +0.183 of cost-of-waiting for being nothing but unknown. Both components
   * are therefore restricted to the priced population on both sides.
   */
  const priced = recommendations.filter((rec) => rec.marketBlend.adp != null);
  const byPosition = new Map<string, { id: string; base: number; survival: number | null }[]>();
  for (const rec of priced) {
    const entry = { id: rec.playerId, base: rec.total, survival: rec.survivalProbability };
    const list = byPosition.get(rec.position);
    if (list) list.push(entry);
    else byPosition.set(rec.position, [entry]);
  }

  for (const rec of recommendations) {
    const comparable = rec.marketBlend.adp != null;
    const peers = byPosition.get(rec.position) ?? [];
    const others = comparable ? peers.filter((p) => p.id !== rec.playerId) : [];
    const separation = comparable
      ? separationScore({
          base: rec.total,
          // Himself removed: a player is not one of his own alternatives.
          positionBases: others.map((p) => p.base),
        })
      : {
          score: 0,
          gap: null,
          comparedWith: 0,
          reason: 'no market price, so there is no comparable composite to measure a gap from',
        };
    const component: ComponentScore = {
      key: 'separation',
      label: 'Clear of the alternatives',
      display: separation.reason,
      score: separation.score,
      weight: SEPARATION.weight,
      contribution: round3(separation.score * SEPARATION.weight),
      unknown: separation.comparedWith === 0,
    };
    /*
     * What waiting would cost, measured from the same settled composites.
     *
     * Reads the base — the composite before separation was added — and is told
     * the separation gap explicitly, so the distance between him and the
     * players behind him is paid for exactly once. See `opportunity.ts`.
     */
    const opportunity = comparable
      ? evaluateOpportunity({
          base: rec.total,
          alternatives: others.map((p) => ({ base: p.base, survival: p.survival })),
          separationGap: separation.gap ?? 0,
          needScore: ctx.needs[rec.position]?.score ?? 0.5,
          nextPick: ctx.nextPick,
        })
      : {
          ...NO_OPPORTUNITY,
          reason: 'no market price, so what waiting would cost him cannot be measured',
        };
    const opportunityComponent: ComponentScore = {
      key: 'opportunity',
      label: 'Cost of waiting',
      display: opportunity.reason,
      score: opportunity.score,
      weight: OPPORTUNITY.weight,
      contribution: round3(opportunity.score * OPPORTUNITY.weight),
      unknown: opportunity.expectedReplacement == null,
    };

    rec.components.push(component, opportunityComponent);
    sealComponents([component, opportunityComponent]);
    capPositionalStructure(rec.components);
    // Re-summed rather than added to, because the cap above can have changed a
    // component that was counted on the first pass.
    rec.total = round3(rec.components.reduce((a, c) => a + c.contribution, 0));
    /*
     * No market price, no Score.
     *
     * `draftScore` is a logistic centred at a total of −2.5, because that is
     * where a real board's middle sits: market value charges every player the
     * distance between the clock and his ADP, so almost everybody worth
     * considering carries a negative total. A total of exactly zero maps to
     * **83**.
     *
     * A player nobody has priced has a total of almost exactly zero — not
     * because he is good, but because the one component that would have had an
     * opinion is missing and the rest contribute nothing. So "we know nothing
     * about him" rendered as a confident 83–85, above every priced player the
     * draft had not yet reached, and a board sorted by Score opened with seven
     * players carrying `ADP —`, `Val —` and `Next —`.
     *
     * The composite is not wrong; it is *not comparable*, which is the same
     * defect the Start/Sit and season-market fixes addressed. `total` is kept
     * for inspection and `score` is unknown, exactly as `Val` and `Next`
     * already are for the same player and for the same reason.
     */
    rec.score = comparable ? draftScore(rec.total) : null;
    rec.opportunity = opportunity;

    // Worth a sentence only when it is most of the component. Below that it is
    // a tie-breaker, and a bullet saying "0.1 clear of the next three" is the
    // kind of line this card keeps having to delete.
    if (separation.score >= 0.5) {
      rec.reasons.push(`little left like him at ${rec.position}: ${separation.reason}${picksMoved(component.contribution)}`);
    }
    if (opportunity.driver) {
      rec.reasons.push(`${opportunity.driver}${picksMoved(opportunityComponent.contribution)}`);
    }
    if (rec.concentration.driver) {
      const concentrationComponent = rec.components.find((c) => c.key === 'team_concentration');
      const moved = concentrationComponent ? picksMoved(concentrationComponent.contribution) : '';
      if (rec.concentration.score < 0) rec.counterpoints.push(`${rec.concentration.driver}${moved}`);
      else rec.reasons.push(`${rec.concentration.driver}${moved}`);
    }
  }
}

/**
 * The four components that all answer "how thin is this position", and the
 * ceiling on what they may be worth between them.
 *
 * Each was bounded on its own and none was wrong. What nothing checked is that
 * they **all rise together for the same reason**, so a sparse position collects
 * every one of them at once:
 *
 *   - `scarcity` counts how many are left,
 *   - `tier_cliff` measures how far apart they are,
 *   - `separation` measures the gap to the next one,
 *   - `opportunity` prices what waiting for the next one would cost.
 *
 * Those are four different questions and one underlying fact. Measured on a
 * board shaped like a real one — twelve quarterbacks in three bands against
 * forty backs and forty receivers — at pick 60 the best quarterback collected
 * `+0.083 + 0.150 + 0.250 + 0.227 = 0.710` of positional structure while the
 * best back collected `0.151` and the best receiver `0.109`. Market value was
 * saturated at 1.0 for all three, so that half-point of structure *was* the
 * ranking: it is about fourteen picks of ADP, more than the season market and
 * the news tally can produce together, handed to a position for being sparse.
 *
 * That is what "QBs rank too high" is. It is not roster need — an empty
 * quarterback slot moves a quarterback by 0.05, which is the calibration
 * working exactly as `DEFAULT_WEIGHTS.need` describes — and it is not any one
 * of these four. It is their sum, which nothing bounded.
 *
 * So they are capped jointly, in the same shape Start/Sit already caps its own
 * correlated pairs: scaled proportionally, so the cap decides how loudly the
 * family may speak and never which member of it is speaking. Every component
 * keeps its own line in the breakdown with the number that actually moved the
 * ranking on it.
 */
export const POSITIONAL_STRUCTURE = {
  keys: ['scarcity', 'tier_cliff', 'separation', 'opportunity'] as const,
  /**
   * About ten picks of ADP, at the ~0.05-per-pick exchange rate the rest of the
   * engine uses.
   *
   * The four weights sum to 0.9, so an unbounded sparse position could claim
   * eighteen picks — most of a round and a half — for structure alone. Ten is
   * enough for a genuinely thin position to be heard over two players the market
   * rates alike, and not enough to lift a quarterback over a back the market
   * rates a round higher. `separation` and `opportunity` alone are documented as
   * five and six picks respectively, so this is deliberately below their sum:
   * the point is that they are not independent.
   */
  cap: 0.5,
} as const;

/**
 * Hold the positional-structure family to its joint ceiling.
 *
 * Symmetric, though only the positive side can reach the cap in practice — a
 * dense position's worst case is `scarcity` alone at −0.2. Written symmetrically
 * anyway so the invariant is "this family is worth at most `cap`" rather than
 * "at most `cap` in the direction we happened to check".
 *
 * Unknown components are skipped: they contribute nothing, and including them
 * would let an absent measurement dilute the scaling applied to a real one.
 *
 * **The weight is what moves, not the contribution.** Every card in this app
 * shows `score × weight = contribution` and a reader is invited to check it, so
 * scaling the product alone would put a sum on screen that does not add up. The
 * score is the sub-model's own measurement and stays untouched; the weight is
 * this engine's judgement about what that measurement is worth, which is
 * exactly what the cap is revising.
 */
export function capPositionalStructure(components: ComponentScore[]): void {
  const family = components.filter(
    (c) => (POSITIONAL_STRUCTURE.keys as readonly string[]).includes(c.key) && !c.unknown,
  );
  const total = family.reduce((a, c) => a + c.contribution, 0);
  if (total === 0 || Math.abs(total) <= POSITIONAL_STRUCTURE.cap) return;
  const scale = POSITIONAL_STRUCTURE.cap / Math.abs(total);
  for (const component of family) {
    component.weight = round3(component.weight * scale);
    component.contribution = round3(component.score * component.weight);
  }
}

/**
 * A contribution, said in the unit the rest of the card uses.
 *
 * In the reach regime a point of ADP is worth about 0.05 of contribution, so
 * this is the honest translation of "how far did that move him".
 */
function picksMoved(contribution: number): string {
  const picks = Math.round(Math.abs(contribution) / 0.05);
  return picks >= 1 ? ` (about ${picks} ${picks === 1 ? 'spot' : 'spots'})` : '';
}

/**
 * What the tier model looked at, when it decided there was nothing to say.
 *
 * The spacing and the ratio are exactly the numbers the classifier used, so the
 * breakdown can be checked against the board rather than taken on trust.
 */
function describeQuietTier(position: string, cliff: TierCliff): string {
  if (cliff.gapToNext == null) return `no ${position} available after him to measure a gap against`;
  const spacing = cliff.localMedianGap ?? cliff.positionMedianGap;
  return `next ${position} is ~${Math.round(cliff.gapToNext)} picks later${
    spacing == null ? '' : `, against ~${spacing} typical here`
  }${cliff.gapRatio == null ? '' : ` (${cliff.gapRatio}x)`}`;
}

function estimateTeamCount(ctx: DraftContext): number {
  const starters = ctx.shape.totalStarters + ctx.shape.benchSlots;
  if (starters > 0 && ctx.totalPicks > 0) {
    const est = Math.round(ctx.totalPicks / starters);
    if (est >= 4 && est <= 32) return est;
  }
  return 12;
}

/** Deterministic natural-language reasons derived from component thresholds. */
function explain(
  entry: AvailablePlayerInput,
  components: ComponentScore[],
  extra: {
    need: { reason: string; startersUnfilled: number } | undefined;
    scarcity: { tierGap: number | null; expectedRemaining: number };
    survival: number | null;
    profile: ScoringProfile;
    shape: RosterShape;
    newsConflicted: boolean;
    cliff: TierCliff;
    avoid: AvoidTag;
    myGuyFlag: MyGuyFlag;
    wait: WaitGuidance;
  },
): { reasons: string[]; counterpoints: string[] } {
  const reasons: string[] = [];
  const counterpoints: string[] = [];
  const by = (key: string) => components.find((c) => c.key === key);

  const market = by('market_value');
  if (market && !market.unknown) {
    const delta = entry.adp == null ? 0 : entry.adp;
    void delta;
    if (market.score > 0.15) reasons.push(`strong ADP value: ${market.display}`);
    else if (market.score < -0.15) counterpoints.push(`this is a reach: ${market.display}`);
  } else {
    counterpoints.push('no ADP in the current snapshot — value unknown');
  }

  // The survival number itself is on the card, in colour, so repeating it as a
  // bullet said nothing new. The wait guidance below still says it, but only
  // where it has something to add — the tier, or the slot it would fill.
  if (extra.survival == null) counterpoints.push('survival estimate unavailable');

  if (extra.need && extra.need.startersUnfilled > 0) reasons.push(`fills a starting need: ${extra.need.reason}`);
  else if (extra.need) counterpoints.push(extra.need.reason);

  if (extra.scarcity.tierGap != null && extra.scarcity.tierGap >= 12) {
    reasons.push(`major tier drop after this player (${extra.scarcity.tierGap} picks to the next one)`);
  }
  if (extra.scarcity.expectedRemaining <= 2) {
    reasons.push('position is nearly exhausted before your next pick');
  }

  // News, said plainly and with the size of the effect attached. A player whose
  // ranking moved because of the user's own research should be able to see that
  // it did, and by roughly how much — `picksMoved` is the translation.
  const lifetimeNews = by('news_lifetime');
  if (lifetimeNews && !lifetimeNews.unknown) {
    if (lifetimeNews.score > 0.25) {
      reasons.push(`boosted by strong lifetime signal: ${lifetimeNews.display}${picksMoved(lifetimeNews.contribution)}`);
    } else if (lifetimeNews.score < -0.25) {
      counterpoints.push(
        `downgraded by negative lifetime signal: ${lifetimeNews.display}${picksMoved(lifetimeNews.contribution)}`,
      );
    }
  }

  const news30 = by('news_30d');
  if (news30 && !news30.unknown) {
    if (news30.score > 0.2) reasons.push(`boosted by recent positive trend: ${news30.display}`);
    else if (news30.score < -0.2) counterpoints.push(`downgraded by recent deterioration: ${news30.display}`);
  }

  const news7 = by('news_7d');
  if (news7 && !news7.unknown) {
    if (news7.score > 0.3) reasons.push(`accelerating this week: ${news7.display}`);
    else if (news7.score < -0.3) counterpoints.push(`deteriorating this week: ${news7.display}`);
  }

  if (extra.newsConflicted) {
    counterpoints.push('recent news contradicts the lifetime record, so both are trusted less');
  }

  const fit = by('league_fit');
  if (fit && fit.score > 0.2) reasons.push(`league scoring favours ${entry.player.position} here (${fit.display})`);
  if (fit && fit.score < -0.2) counterpoints.push(`league scoring is unkind to ${entry.player.position}`);

  if (entry.signal && entry.signal.pendingCount > 0) {
    counterpoints.push(`${entry.signal.pendingCount} news item(s) awaiting your review`);
  }

  // --- decision quality, each said in this draft's own terms ----------------
  // A label with no context is the thing the brief specifically rules out, so
  // every one of these carries the number or the sentence it came from.
  const cliffComponent = by('tier_cliff');
  if (extra.cliff.message && cliffComponent) {
    reasons.push(`${extra.cliff.message}${picksMoved(cliffComponent.contribution)}`);
  }

  if (extra.avoid.active) {
    const avoidComponent = by('avoid');
    counterpoints.push(
      `${extra.avoid.message}${avoidComponent ? picksMoved(avoidComponent.contribution) : ''}`,
    );
    // The improvement is shown beside the tag, never instead of it: the
    // lifetime record is what earned the caution and it has not changed.
    if (extra.avoid.trendNote) counterpoints.push(extra.avoid.trendNote);
  }

  if (extra.myGuyFlag.level > 0) {
    const myGuyComponent = by('my_guy');
    reasons.push(
      `personal preference boost: you marked him ${extra.myGuyFlag.stars} ${extra.myGuyFlag.label}` +
        `${myGuyComponent ? picksMoved(myGuyComponent.contribution) : ''}`,
    );
  }

  // Timing, as a sentence about this player rather than as a label.
  //
  // "Take Now" and "Can Probably Wait" were chips on every row, which made them
  // wallpaper; the chance he reaches your next pick is now a number on the card
  // and does that job better. What is left worth saying is the *why* — the tier
  // that ends with him, the slot he would fill — so only the detail survives.
  if (extra.wait.state === 'can_probably_wait' || extra.wait.state === 'likely_available_later') {
    counterpoints.push(lowerFirst(extra.wait.detail));
  } else if (extra.wait.state === 'take_now' || extra.wait.state === 'risky_to_wait') {
    reasons.push(lowerFirst(extra.wait.detail));
  }

  if (reasons.length === 0) reasons.push('ranked on market value with no standout component');
  return { reasons, counterpoints };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}
