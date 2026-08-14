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
import { computeNeed, computeScarcity, type RosterCounts } from './need.ts';
import { estimateSurvival } from './survival.ts';
import { marketExpectationScore, seasonBaseline, seasonHeadline, type MarketBaseline } from '../vegas/season.ts';
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
  adp: number | null;
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
  seasonMarkets?: { market: SeasonMarketKey; line: number | null }[];
}

export interface DraftContext {
  currentPick: number;
  nextPick: number | null;
  shape: RosterShape;
  profile: ScoringProfile;
  rosterCounts: RosterCounts;
  /** Total picks in the draft, used to bound value normalisation. */
  totalPicks: number;
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
  adpValue: number | null;
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
  /** Whether the position is about to fall off a tier. */
  tierCliff: TierCliff;
  /** The automatic caution from accumulated research. */
  avoid: AvoidTag;
  /** The user's own preference, separate from the news tally. */
  myGuy: MyGuyFlag;
  /** Take Now / Can Probably Wait / ... */
  wait: WaitGuidance;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Market value = currentPick - ADP (docs/03_DRAFT_ENGINE.md).
 *
 * Positive means the player has FALLEN past their ADP and is a bargain at this
 * pick. Negative means taking them here is a reach, which is damped rather than
 * fully penalised — survival probability separately handles "he won't last".
 */
export function marketValueComponent(adp: number | null, currentPick: number, teams: number): ComponentScore {
  const weight = DEFAULT_WEIGHTS.marketValue;
  if (adp == null) {
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
  const delta = currentPick - adp; // positive = fell past ADP to you
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
  return {
    key: 'market_value',
    label: 'ADP value',
    display: delta >= 0 ? `+${round1(delta)} picks of value` : `${round1(delta)} picks (a reach)`,
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
  const poolByPosition = new Map<string, number[]>();
  for (const entry of available) {
    if (!entry.seasonMarkets || entry.seasonMarkets.length === 0) continue;
    const baseline = seasonBaseline(entry.player.position, entry.seasonMarkets, ctx.profile);
    baselines.set(entry.player.id, baseline);
    if (baseline.points != null) {
      const list = poolByPosition.get(entry.player.position);
      if (list) list.push(baseline.points);
      else poolByPosition.set(entry.player.position, [baseline.points]);
    }
  }

  const recommendations = available.map((entry) => {
    const { player, adp, signal } = entry;
    const components: ComponentScore[] = [];

    const market = marketValueComponent(adp, ctx.currentPick, teamCount);
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
    const scarcity = computeScarcity({
      availableAdps: adpsByPosition.get(player.position) ?? [],
      playerAdp: adp,
      picksUntilNext,
    });
    components.push({
      key: 'scarcity',
      label: 'Positional scarcity',
      display: scarcity.reason,
      score: round3(scarcity.score * 2 - 1),
      weight: weights.scarcity,
      contribution: round3((scarcity.score * 2 - 1) * weights.scarcity),
      unknown: adp == null,
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
    const survival = estimateSurvival({
      adp,
      currentPick: ctx.currentPick,
      nextPick: ctx.nextPick ?? ctx.currentPick,
    });
    const urgencyScore = survival.probability == null ? 0 : clamp(1 - survival.probability * 2, -1, 1);
    components.push({
      key: 'survival',
      label: 'Survival to next pick',
      display:
        survival.probability == null
          ? 'unknown (no ADP)'
          : `${Math.round(survival.probability * 100)}% chance to last to pick ${ctx.nextPick ?? ctx.currentPick}`,
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
    const marketScore = baseline
      ? marketExpectationScore(baseline.points, baseline.coverage, poolByPosition.get(player.position) ?? [])
      : null;
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

    const wait = assessWait({
      survivalProbability: survival.probability,
      cliff,
      needScore,
      expectedRemaining: scarcity.expectedRemaining,
      position: player.position,
      nextPick: ctx.nextPick,
    });

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

    return {
      playerId: player.id,
      name: player.fullName,
      position: player.position,
      team: player.team,
      adp,
      adpValue: adp == null ? null : round1(ctx.currentPick - adp),
      survivalProbability: survival.probability,
      newsLifetimeNet: lifetimeNet,
      news30Net: net30,
      news7Net: net7,
      newsConflicted: conflicted,
      components,
      total,
      reasons,
      counterpoints,
      degraded: adp == null,
      marketBaseline: baseline,
      marketHeadline: entry.seasonMarkets?.length
        ? seasonHeadline(player.position, entry.seasonMarkets)
        : null,
      tierCliff: cliff,
      avoid,
      myGuy: flag,
      wait,
    } satisfies DraftRecommendation;
  });

  // Deterministic ordering: total desc, then ADP asc, then name.
  return recommendations.sort(
    (a, b) =>
      b.total - a.total ||
      (a.adp ?? Number.MAX_SAFE_INTEGER) - (b.adp ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );
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
  // it did, and by roughly how much.
  const picksMoved = (contribution: number) => {
    // In the reach regime a point of ADP is worth about 0.05 of contribution.
    const picks = Math.round(Math.abs(contribution) / 0.05);
    return picks >= 1 ? ` (about ${picks} ${picks === 1 ? 'spot' : 'spots'})` : '';
  };

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
