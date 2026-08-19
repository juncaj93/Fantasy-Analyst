/**
 * The whole forecast, assembled once.
 *
 * Pure, and that is load-bearing: everything below this line is arithmetic over
 * a list of players, so the entire model — distributions, correlation,
 * simulation, thresholds, insight ranking — is testable from a fixture a person
 * can read, without a database, a league or a network. The service above it
 * fetches; this decides.
 *
 * ## The degraded path is a first-class outcome, not an error
 *
 * If Fantasy Analyst cannot project anybody — no Vegas coverage, a player
 * dictionary that has not synced, a brand-new deployment in September — the
 * forecast still returns. It returns Sleeper's scoreboard, no projected final,
 * no win probability, and one quiet sentence saying so. §33's rule is the one
 * this file is organised around: **the page must still work as a scoreboard**,
 * and it must never fill the gap with Sleeper's own projection wearing this
 * app's name.
 */

import { assessLineupDecision, type LineupDecision, type SlotSpec } from './decision.ts';
import { BALANCED_BY_DEFAULT, type ModeSuggestion } from '../startsit/modeSuggest.ts';
import {
  buildDistribution,
  effectiveRemaining,
  projectedFinal,
  vsExpectation,
  resolveGameClock,
  type GameClock,
  type PlayerDistribution,
} from './distribution.ts';
import { buildInsights, type HeroInsight, type MatchupPhase, type PreviousInsightState } from './insights.ts';
import { matchupFingerprint } from './fingerprint.ts';
import { shortNamesFor } from './names.ts';
import { assessClinch, rankLeverage, type ClinchState, type PlayerLeverage } from './needs.ts';
import { DEFAULT_DRAWS, simulateMatchup, type SimulationResult } from './simulate.ts';
import { MATCHUP_MODEL_VERSION, type MatchupPlayerInput, type MatchupSide, type SourceFreshness } from './types.ts';

/** One fantasy team, as the score card draws it. */
export interface MatchupTeamView {
  rosterId: number;
  side: MatchupSide;
  /** The fantasy team's name, as its manager set it in Sleeper. */
  name: string;
  /** Sleeper's avatar id, or null. Resolved to a URL by the client. */
  avatar: string | null;
  /** `9-5` when the league publishes a record, else null. */
  record: string | null;
  /** Sleeper's settled score. Authoritative, and never overwritten. */
  actual: number;
  /** Fantasy Analyst's projected final. Null in the degraded state. */
  projectedFinal: number | null;
  /** Fantasy Analyst's live win probability, 0..1. Null in the degraded state. */
  winProbability: number | null;
}

/** One player, as a compact row draws him. */
export interface MatchupPlayerView {
  playerId: string;
  /** `J. Hurts`, disambiguated across this matchup. */
  name: string;
  fullName: string;
  position: string;
  team: string;
  opponent: string | null;
  slot: string | null;
  side: MatchupSide;
  starting: boolean;
  /** Sleeper's points for him. */
  actual: number;
  /** Fantasy Analyst's projected final total. Null when he could not be scored. */
  projectedFinal: number | null;
  /** What is still expected to come. Zero once his game is over. */
  remaining: number | null;
  /**
   * Points ahead of — or behind — what he was projected to have by now.
   *
   * Pace-corrected, so it is comparable at half-time and not only on Monday;
   * see `vsExpectation`. Null when nobody projected him. The rows use it to
   * decide whether a score is worth colouring, and the insight engine uses the
   * same number to decide whether it is worth a card.
   */
  vsExpectation: number | null;
  phase: PlayerDistribution['phase'];
  locked: boolean;
  /** `Q`, `OUT` and friends — shown only when material. */
  statusFlag: string | null;
  /** True when his availability is a live question rather than a fact. */
  availabilityRisky: boolean;
}

/** One lineup slot, with both sides of it. */
export interface MatchupSlotRow {
  slot: string;
  mine: MatchupPlayerView | null;
  theirs: MatchupPlayerView | null;
}

export interface MatchupForecast {
  modelVersion: string;
  /** The state this was computed from. Seeds the simulation and keys the cache. */
  fingerprint: string;
  computedAt: string;
  draws: number;
  phase: MatchupPhase;
  teams: { mine: MatchupTeamView; theirs: MatchupTeamView };
  slots: MatchupSlotRow[];
  bench: { mine: MatchupPlayerView[]; theirs: MatchupPlayerView[] };
  insights: HeroInsight[];
  /** Every uncertain starter, ranked by how much of the outcome he holds. */
  leverage: PlayerLeverage[];
  decision: LineupDecision;
  /**
   * Which question the lineup should be asked this week.
   *
   * Not decided here. This is `suggestMode`'s answer, carried through from the
   * caller so that the Team screen's control and this screen's explanation are
   * the same sentence produced by the same module — and so the matchup model
   * never gets to see it, which is what keeps the anti-circularity guard in
   * `modeSuggest.ts` structural rather than a promise.
   */
  suggestedMode: ModeSuggestion;
  clinch: ClinchState;
  freshness: SourceFreshness;
  /** True when no forecast could be produced and only the scoreboard stands. */
  degraded: boolean;
}

export interface ForecastInput {
  leagueId: string;
  season: string;
  week: number;
  matchupId: number | null;
  players: MatchupPlayerInput[];
  teams: {
    mine: Omit<MatchupTeamView, 'side' | 'actual' | 'projectedFinal' | 'winProbability'>;
    theirs: Omit<MatchupTeamView, 'side' | 'actual' | 'projectedFinal' | 'winProbability'>;
  };
  /** Sleeper's own team totals. Used as-is, never recomputed from players. */
  actualScores: { mine: number; theirs: number };
  /** The league's starting slots, in the league's own order. */
  slots: SlotSpec[];
  now: Date | string;
  draws?: number;
  previous?: PreviousInsightState | null;
  /** True when the league week is over, so a game with no schedule is settled. */
  weekSettled?: boolean;
  /** `suggestMode`'s reading of the week. Balanced-by-default when absent. */
  modeSuggestion?: ModeSuggestion;
}

/**
 * How much of a lineup has to be projectable before the forecast is offered.
 *
 * More than half. Below that the simulation is comparing a team to a fraction
 * of a team, and there is no honest number to print — so the screen keeps
 * Sleeper's scoreboard and says the forecast is unavailable, which is §33's
 * answer and is the only one that does not mislead.
 */
export const MIN_PROJECTED_SHARE = 0.5;

/** The share of one side's starting slots the engine could actually score. */
function coverage(starters: PlayerDistribution[], side: MatchupSide): number {
  const ours = starters.filter((d) => d.side === side);
  if (ours.length === 0) return 0;
  return ours.filter((d) => !d.projectionUnknown).length / ours.length;
}

/**
 * The clock every player's game is on, from one reference time.
 *
 * Its own function because two callers need it and one of them must not pay for
 * the simulation: {@link forecastFingerprint} answers "has anything changed?"
 * from this alone, which is what lets a poll on an unchanged matchup cost a
 * handful of `Date.parse` calls instead of four thousand simulated afternoons.
 */
function clocksFor(input: ForecastInput, now: Date): Map<string, GameClock> {
  const clocks = new Map<string, GameClock>();
  for (const player of input.players) {
    clocks.set(
      player.playerId,
      resolveGameClock(player.kickoff, now, {
        hasPoints: player.actual > 0,
        ...(input.weekSettled === undefined ? {} : { weekSettled: input.weekSettled }),
      }),
    );
  }
  return clocks;
}

/**
 * The fingerprint this input *would* produce, without producing the forecast.
 *
 * The cache check, and the reason it is worth having: §34 asks for no expensive
 * rebuild from a harmless change, and a cache consulted after the simulation has
 * already run saves nothing at all. Cheap by construction — it reads the same
 * fields the forecast does and does no arithmetic beyond placing each game on a
 * clock.
 */
export function forecastFingerprint(input: ForecastInput): string {
  const now = typeof input.now === 'string' ? new Date(input.now) : input.now;
  return matchupFingerprint({
    leagueId: input.leagueId,
    season: input.season,
    week: input.week,
    matchupId: input.matchupId,
    players: input.players,
    clocks: clocksFor(input, now),
  });
}

export function buildForecast(input: ForecastInput): MatchupForecast {
  const now = typeof input.now === 'string' ? new Date(input.now) : input.now;
  const nowIso = now.toISOString();

  const clocks = clocksFor(input, now);
  const distributions = input.players.map((player) => buildDistribution(player, clocks.get(player.playerId)!));
  const distributionById = new Map(distributions.map((d) => [d.playerId, d]));

  const fingerprint = matchupFingerprint({
    leagueId: input.leagueId,
    season: input.season,
    week: input.week,
    matchupId: input.matchupId,
    players: input.players,
    clocks,
  });

  const startingDistributions = distributions.filter((d) => d.starting);
  /*
   * When a forecast stops being a forecast.
   *
   * Not "when a starter is missing" — a lineup with one unscorable player still
   * produces a useful answer, and refusing to compute one would throw away
   * eight good projections because of a gap. The freshness report below is
   * where partial coverage gets stated.
   *
   * What *is* fatal is one side being mostly invisible. A player this app
   * cannot project contributes nothing to the simulation, so a team with four
   * of seven starters unpriced is modelled as a team that will score about
   * three players' worth — and the resulting 98% is not a cautious answer, it
   * is a confident wrong one. Measured per side, because the failure is
   * asymmetric by nature: it is the *opponent's* coverage that nobody would
   * think to doubt.
   */
  const degraded =
    coverage(startingDistributions, 'mine') < MIN_PROJECTED_SHARE ||
    coverage(startingDistributions, 'theirs') < MIN_PROJECTED_SHARE;

  const result = simulateMatchup({
    players: input.players,
    distributions,
    seed: fingerprint,
    ...(input.draws === undefined ? {} : { draws: input.draws }),
  });

  const phase = resolvePhase(startingDistributions);
  const leverage = degraded ? [] : rankLeverage(result, input.players, distributions);
  const clinch = assessClinch(result, distributions);
  const decision = degraded
    ? { best: null, options: [], considered: 0, note: 'No forecast is available, so no lineup comparison can be made.' }
    : assessLineupDecision({ result, players: input.players, distributions, slots: input.slots });

  const names = shortNamesFor(input.players.map((p) => ({ playerId: p.playerId, name: p.name })));

  const insights = buildInsights({
    result,
    players: input.players,
    distributions,
    leverage,
    clinch,
    decision,
    phase,
    fingerprint,
    now: nowIso,
    names,
    previous: input.previous ?? null,
    degraded,
  });

  const view = (player: MatchupPlayerInput): MatchupPlayerView => {
    const distribution = distributionById.get(player.playerId)!;
    return {
      playerId: player.playerId,
      name: names.get(player.playerId) ?? player.name,
      fullName: player.name,
      position: player.position,
      team: player.team,
      opponent: player.opponent,
      slot: player.slot,
      side: player.side,
      starting: player.starting,
      actual: distribution.settled,
      projectedFinal: distribution.projectionUnknown ? null : projectedFinal(distribution),
      remaining: distribution.projectionUnknown ? null : effectiveRemaining(distribution),
      vsExpectation: vsExpectation(distribution, player.projection),
      phase: distribution.phase,
      locked: distribution.locked,
      statusFlag: statusFlagFor(player),
      availabilityRisky: player.availability === 'uncertain' || player.availability === 'likely_inactive',
    };
  };

  const slots = buildSlotRows(input.players, input.slots, view);
  const bench = {
    mine: input.players.filter((p) => p.side === 'mine' && !p.starting).map(view).sort(byPointsThenName),
    theirs: input.players.filter((p) => p.side === 'theirs' && !p.starting).map(view).sort(byPointsThenName),
  };

  return {
    modelVersion: MATCHUP_MODEL_VERSION,
    fingerprint,
    computedAt: nowIso,
    draws: input.draws ?? DEFAULT_DRAWS,
    phase,
    teams: {
      mine: {
        ...input.teams.mine,
        side: 'mine',
        actual: round2(input.actualScores.mine),
        projectedFinal: degraded ? null : round2(result.projectedMine),
        winProbability: degraded ? null : round4(result.winProbability),
      },
      theirs: {
        ...input.teams.theirs,
        side: 'theirs',
        actual: round2(input.actualScores.theirs),
        projectedFinal: degraded ? null : round2(result.projectedTheirs),
        winProbability: degraded ? null : round4(1 - result.winProbability),
      },
    },
    slots,
    bench,
    insights,
    leverage,
    decision,
    suggestedMode: input.modeSuggestion ?? BALANCED_BY_DEFAULT,
    clinch,
    freshness: assessFreshness(input.players, distributions),
    degraded,
  };
}

/**
 * Where the matchup as a whole is.
 *
 * Deliberately not the same question as one player's game phase: a matchup is
 * live from the first kickoff to the last whistle, and it is final only when
 * there is nothing left anywhere. A matchup with eight finished players and one
 * Monday-night receiver is live, and calling it final — which a "most players
 * are done" rule would — would drop the live win probability while the thing
 * that decides it has not happened.
 */
function resolvePhase(starters: PlayerDistribution[]): MatchupPhase {
  if (starters.length === 0) return 'pregame';
  if (starters.every((d) => d.phase === 'final')) return 'final';
  if (starters.every((d) => d.phase === 'not_started')) return 'pregame';
  return 'live';
}

/**
 * Pair the two lineups slot for slot.
 *
 * Sleeper's `starters` array is already in the league's slot order, so the nth
 * starter fills the nth slot — that is how the slot each player occupies is
 * known at all. A slot one side has not filled comes back as a null half, which
 * the row renders as an empty side rather than by shifting everybody below it
 * up by one.
 */
function buildSlotRows(
  players: MatchupPlayerInput[],
  slots: SlotSpec[],
  view: (player: MatchupPlayerInput) => MatchupPlayerView,
): MatchupSlotRow[] {
  const rows: MatchupSlotRow[] = [];
  const mine = players.filter((p) => p.side === 'mine' && p.starting);
  const theirs = players.filter((p) => p.side === 'theirs' && p.starting);

  for (const slot of slots) {
    const mineAt = mine.find((p) => p.slot === slot.key) ?? null;
    const theirsAt = theirs.find((p) => p.slot === slot.key) ?? null;
    rows.push({
      slot: slot.slot,
      mine: mineAt ? view(mineAt) : null,
      theirs: theirsAt ? view(theirsAt) : null,
    });
  }
  return rows;
}

/**
 * The slot key a player carries.
 *
 * A league with two running-back slots has two rows called `RB`, and a player
 * has to belong to one of them rather than to both. The index is appended by
 * the service when it assigns slots and is matched here; the label the screen
 * prints is still the bare slot name.
 */
export function slotKey(slot: string, index: number): string {
  return `${slot}#${index}`;
}

/** `Q` / `OUT` and friends — a short mark, and only when it changes something. */
function statusFlagFor(player: MatchupPlayerInput): string | null {
  if (player.ruledOut) return 'OUT';
  switch (player.availability) {
    case 'likely_inactive':
      return 'D';
    case 'uncertain':
      return 'Q';
    case 'inactive':
      return 'OUT';
    default:
      return null;
  }
}

/**
 * How much of the truth behind this forecast is actually known.
 *
 * Counted over the *starters* only: a bench player nobody can project costs the
 * counterfactual and nothing else, and inflating the confidence warning with
 * him would make the line fire every week for no reason.
 */
function assessFreshness(players: MatchupPlayerInput[], distributions: PlayerDistribution[]): SourceFreshness {
  const starters = players.filter((p) => p.starting);
  const byId = new Map(distributions.map((d) => [d.playerId, d]));

  const unresolvedAvailability = starters.filter(
    (p) => p.availability === 'uncertain' || p.availability === 'likely_inactive',
  ).length;
  const missingProjection = starters.filter((p) => p.projection == null).length;
  const unknownKickoff = starters.filter((p) => byId.get(p.playerId)?.clockInferred && !byId.get(p.playerId)?.locked).length;

  const share = starters.length === 0 ? 0 : missingProjection / starters.length;
  let level: SourceFreshness['level'] = 'high';
  if (share >= 0.34 || unresolvedAvailability >= 3) level = 'low';
  else if (missingProjection > 0 || unresolvedAvailability > 0 || unknownKickoff >= 2) level = 'medium';

  const clauses: string[] = [];
  if (missingProjection > 0) clauses.push(`${missingProjection} starter${missingProjection === 1 ? '' : 's'} not projected`);
  if (unresolvedAvailability > 0) clauses.push(`${unresolvedAvailability} availability unresolved`);
  if (unknownKickoff >= 2) clauses.push('kickoff times unknown');

  return {
    unresolvedAvailability,
    missingProjection,
    unknownKickoff,
    level,
    detail: level === 'high' ? null : clauses.join(' · '),
  };
}

function byPointsThenName(a: MatchupPlayerView, b: MatchupPlayerView): number {
  return (b.projectedFinal ?? b.actual) - (a.projectedFinal ?? a.actual) || a.name.localeCompare(b.name);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export type { SimulationResult };
