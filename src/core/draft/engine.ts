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
import { computeNeed, computeScarcity, type RosterCounts } from './need.ts';
import { estimateSurvival } from './survival.ts';

export interface DraftComponentWeights {
  marketValue: number;
  need: number;
  scarcity: number;
  leagueFit: number;
  newsRecent: number;
  newsRaw: number;
  survivalUrgency: number;
}

/**
 * Default weights.
 *
 * Market value dominates by design: the news tally is a tiebreaker for close
 * calls, never an override of a large ADP gap (see docs/03_DRAFT_ENGINE.md).
 * The news components are additionally hard-capped in `newsComponent`.
 */
export const DEFAULT_WEIGHTS: DraftComponentWeights = {
  marketValue: 1,
  need: 0.35,
  scarcity: 0.3,
  leagueFit: 0.25,
  newsRecent: 0.12,
  newsRaw: 0.06,
  survivalUrgency: 0.22,
};

export interface AvailablePlayerInput {
  player: CanonicalPlayer;
  adp: number | null;
  /** ADP rank within the snapshot, when present. */
  adpRank: number | null;
  signal: PlayerSignal | null;
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
  /** Normalised score in [-1, 1]. */
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
  newsRawNet: number;
  newsRecentNet: number;
  components: ComponentScore[];
  /** Sum of contributions. Comparable within one board state only. */
  total: number;
  reasons: string[];
  counterpoints: string[];
  /** True when a key input (ADP) was missing. */
  degraded: boolean;
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
  const score = clamp(raw, -1, 1);
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

/**
 * News components. Hard-capped so a large tally cannot outweigh a big ADP gap:
 * even a perfect news score contributes less than ~2 picks of ADP value.
 */
export function newsComponent(
  key: 'news_recent' | 'news_raw',
  net: number,
  items: number,
): ComponentScore {
  const weight = key === 'news_recent' ? DEFAULT_WEIGHTS.newsRecent : DEFAULT_WEIGHTS.newsRaw;
  const label = key === 'news_recent' ? 'Recent news' : 'Lifetime news';
  if (items === 0) {
    return { key, label, display: 'no evidence', score: 0, weight, contribution: 0, unknown: true };
  }
  // Saturating: +/-6 net is effectively the ceiling.
  const score = clamp(net / 6, -1, 1);
  return {
    key,
    label,
    display: `${net > 0 ? '+' : ''}${net} net (${items} item${items === 1 ? '' : 's'})`,
    score: round3(score),
    weight,
    contribution: round3(score * weight),
    unknown: false,
  };
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
  const teamCount = estimateTeamCount(ctx);

  const recommendations = available.map((entry) => {
    const { player, adp, signal } = entry;
    const components: ComponentScore[] = [];

    const market = marketValueComponent(adp, ctx.currentPick, teamCount);
    market.weight = weights.marketValue;
    market.contribution = round3(market.score * weights.marketValue);
    components.push(market);

    // --- roster need -------------------------------------------------------
    const need = needs[player.position];
    components.push({
      key: 'need',
      label: 'Roster need',
      display: need?.reason ?? 'not used by this league',
      score: round3((need?.score ?? 0.1) * 2 - 1), // map 0..1 onto -1..1
      weight: weights.need,
      contribution: round3(((need?.score ?? 0.1) * 2 - 1) * weights.need),
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

    // --- news --------------------------------------------------------------
    const recent = newsComponent('news_recent', signal?.last21.net ?? 0, signal?.last21.items ?? 0);
    recent.weight = weights.newsRecent;
    recent.contribution = round3(recent.score * weights.newsRecent);
    const raw = newsComponent('news_raw', signal?.raw.net ?? 0, signal?.raw.items ?? 0);
    raw.weight = weights.newsRaw;
    raw.contribution = round3(raw.score * weights.newsRaw);
    components.push(recent, raw);

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

    const total = round3(components.reduce((a, c) => a + c.contribution, 0));
    const { reasons, counterpoints } = explain(entry, components, {
      need,
      scarcity,
      survival: survival.probability,
      profile: ctx.profile,
      shape: ctx.shape,
    });

    return {
      playerId: player.id,
      name: player.fullName,
      position: player.position,
      team: player.team,
      adp,
      adpValue: adp == null ? null : round1(ctx.currentPick - adp),
      survivalProbability: survival.probability,
      newsRawNet: signal?.raw.net ?? 0,
      newsRecentNet: signal?.last21.net ?? 0,
      components,
      total,
      reasons,
      counterpoints,
      degraded: adp == null,
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

  if (extra.survival != null) {
    if (extra.survival <= 0.35) reasons.push(`low chance to reach your next pick (${Math.round(extra.survival * 100)}%)`);
    else if (extra.survival >= 0.75) counterpoints.push(`likely still available at your next pick (${Math.round(extra.survival * 100)}%)`);
  } else {
    counterpoints.push('survival estimate unavailable');
  }

  if (extra.need && extra.need.startersUnfilled > 0) reasons.push(`fills a starting need: ${extra.need.reason}`);
  else if (extra.need) counterpoints.push(extra.need.reason);

  if (extra.scarcity.tierGap != null && extra.scarcity.tierGap >= 12) {
    reasons.push(`major tier drop after this player (${extra.scarcity.tierGap} picks to the next one)`);
  }
  if (extra.scarcity.expectedRemaining <= 2) {
    reasons.push('position is nearly exhausted before your next pick');
  }

  const recent = by('news_recent');
  if (recent && !recent.unknown) {
    if (recent.score > 0.1) reasons.push(`positive recent news signal (${recent.display})`);
    else if (recent.score < -0.1) counterpoints.push(`negative recent news signal (${recent.display})`);
  }

  const fit = by('league_fit');
  if (fit && fit.score > 0.2) reasons.push(`league scoring favours ${entry.player.position} here (${fit.display})`);
  if (fit && fit.score < -0.2) counterpoints.push(`league scoring is unkind to ${entry.player.position}`);

  if (entry.signal && entry.signal.pendingCount > 0) {
    counterpoints.push(`${entry.signal.pendingCount} news item(s) awaiting your review`);
  }

  if (reasons.length === 0) reasons.push('ranked on market value with no standout component');
  return { reasons, counterpoints };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
