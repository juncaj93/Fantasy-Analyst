/**
 * `Next` — the probability a player is still on the board at your next pick.
 *
 * One call, one board state, every candidate answered at once. That last part is
 * the reason this is affordable: a simulation that plays out picks 54 to 67 has,
 * by the time it finishes, decided the fate of every player on the board, so the
 * cost is per *board state* and not per player. Five thousand simulated drafts
 * answer three hundred players in about fifty milliseconds.
 *
 * See `simulate.ts` for the model itself. This file is the seam: it assembles
 * the inputs, caches by draft state so a board polled every three seconds is
 * computed once, and hands back a per-player answer with its explanation.
 */

import type { PositionTierMap } from '../tiers.ts';
import { explainNextPick, type NextPickExplanation } from './explain.ts';
import { readRoom, type CompletedPick, type RoomBehaviour, type UniversePlayer } from './room.ts';
import { readTeamPrior, type TeamPriorResult } from './teamPrior.ts';
import { hashString } from './rng.ts';
import { positionsInPlay } from './demand.ts';
import { SIMULATION, simulateNextPick, type SimulationInput, type SimulationResult } from './simulate.ts';

export type { SimCandidate, SimulationResult } from './simulate.ts';
export type { CompletedPick, RoomBehaviour, UniversePlayer } from './room.ts';
export type { NextPickExplanation } from './explain.ts';
export { buildPickOwnership, slotAtPick, type PickOwnership, type TradedPick } from './ownership.ts';
export { positionDemand, positionsInPlay, phaseWeight, DEMAND } from './demand.ts';
export { readRoom, ROOM, NEUTRAL_ROOM } from './room.ts';
export { readTeamPrior, teamMultiplier, TEAM_PRIOR, type TeamPriorResult } from './teamPrior.ts';
export { SIMULATION, simulateNextPick, needShareAt, tierScarcityBonus } from './simulate.ts';
export { explainNextPick, driverLine } from './explain.ts';
export { hashString, mulberry32 } from './rng.ts';

export interface NextPickAvailability {
  playerId: string;
  /** The number the board shows, in [0,1]. Null when it cannot be known. */
  probability: number | null;
  /** The same question asked of ADP alone — what the old model would have said. */
  marketBaseline: number | null;
  drivers: string[];
  confidence: 'high' | 'medium' | 'low';
  degraded: string[];
}

export interface NextPickReport {
  /** Per player, keyed by player id. Every candidate handed in appears. */
  byPlayer: Map<string, NextPickAvailability>;
  targetPick: number | null;
  picksSimulated: number;
  simulations: number;
  slotsAhead: number[];
  needAhead: Map<string, number>;
  room: RoomBehaviour;
  /** The local-team appetite that was applied, if any. Diagnostics only. */
  teamPrior: TeamPriorResult | null;
  /** True when the board was too thin to simulate and the ADP model answered. */
  marketOnly: boolean;
  degraded: string[];
  elapsedMs: number;
  /** True when this answer came from the cache rather than a fresh run. */
  cached: boolean;
  stateKey: string;
}

export interface NextPickRequest extends Omit<SimulationInput, 'room' | 'stateKey' | 'teamPrior'> {
  /**
   * Completed picks in this draft, for reading the room.
   *
   * Carries the NFL team of the player taken as well, which the local-team read
   * needs and the positional reads ignore.
   */
  completed: (CompletedPick & { team?: string | null })[];
  /**
   * NFL teams this room is expected to favour, upper-case.
   *
   * Empty or absent in every league that has not named one, and the model is
   * then exactly what it was before this existed.
   */
  localTeams?: readonly string[];
  /** Managers in the league, for scaling "how early is early". */
  teamsInLeague?: number;
  /** Every priced player, drafted or not — the market's own map of the board. */
  universe: UniversePlayer[];
  tiers?: Map<string, PositionTierMap>;
  /** Comparable players left at each position, for the explanation only. */
  alternatives?: Map<string, number>;
  /** Skip the cache. Tests and the probe use this; the board never does. */
  noCache?: boolean;
}

/**
 * How many board states are remembered.
 *
 * A live draft polls the same state repeatedly and then moves on for good, so
 * the useful history is one deep and everything past that is insurance against
 * two boards being open (a position filter and the full board are two different
 * candidate sets, and therefore two different states). Four is generous and
 * costs a few kilobytes.
 */
const CACHE_LIMIT = 4;

const cache = new Map<string, SimulationResult>();

/** Drop everything remembered. Tests use this; nothing in production does. */
export function clearNextPickCache(): void {
  cache.clear();
}

/**
 * A fingerprint of everything the answer depends on.
 *
 * If two boards produce the same key they must produce the same number, so
 * every input that can move the model is in it: which pick it is, which pick is
 * being measured to, who is on the board and at what price, what every roster
 * ahead holds, and which picks have been made. Miss one and a stale answer
 * survives a change that should have invalidated it — the failure mode being
 * guarded against is a `Next` that does not move when a pick lands.
 */
export function draftStateKey(request: NextPickRequest): string {
  const rosters = [...request.rosters.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, counts]) => `${slot}:${Object.entries(counts).sort().map(([p, n]) => `${p}${n}`).join('')}`)
    .join(',');
  const board = request.candidates
    .map((c) => `${c.playerId}${c.adp ?? 'x'}`)
    .sort()
    .join(',');
  /*
   * The picks themselves, not how many there are.
   *
   * `readRoom` reads every completed pick — which position went where, and how
   * far from ADP — so the room's dispersion, its runs and each manager's lean
   * are all functions of the *content* of this list. Fingerprinting its length
   * held only while the list could do nothing but grow. It can do more than
   * that: a Sleeper re-sync that corrects who was taken at pick 41, or a
   * commissioner reversing a mis-pick, changes a pick without changing the
   * count, and the count alone would hand back the answer computed from the
   * wrong player.
   */
  const picks = request.completed
    .map((p) => `${p.pickNo}:${p.slot}:${p.position ?? 'x'}:${p.team ?? 'x'}:${p.adp ?? 'x'}`)
    .sort()
    .join(',');
  const parts = [
    request.draftId,
    request.currentPick,
    request.targetPick ?? 'none',
    request.mySlot ?? 'none',
    request.totalPicks,
    request.simulations ?? SIMULATION.default,
    request.completed.length,
    picks,
    /*
     * The local prior belongs in the fingerprint.
     *
     * It multiplies the hazard, so two boards identical in every other respect
     * but differing in which teams the room favours must not share an answer —
     * this is the one input that could change the numbers without changing a
     * pick, a roster or a price.
     */
    [...(request.localTeams ?? [])].sort().join('+') || 'no-local',
    rosters,
    board,
  ];
  return `${request.draftId}:${request.currentPick}:${hashString(parts.join('|')).toString(36)}`;
}

/**
 * Run the model, or return the identical answer it gave for this exact board.
 */
export function estimateNextPickAvailability(request: NextPickRequest): NextPickReport {
  const stateKey = draftStateKey(request);
  const hit = request.noCache ? undefined : cache.get(stateKey);

  const result =
    hit ??
    simulateNextPick({
      ...request,
      stateKey,
      room: readRoom({
        picks: request.completed,
        currentPick: request.currentPick,
        positions: positionsInPlay(request.shape),
        universe: request.universe,
      }),
      /*
       * What this room has done with the teams it is local to — measured from
       * the same pick stream the positional reads use, and falling back to a
       * bounded assumption only while there is too little of it to measure.
       */
      teamPrior: readTeamPrior({
        teams: request.localTeams ?? [],
        picks: request.completed.map((pick) => ({ ...pick, team: pick.team ?? null })),
        teamsInLeague: request.teamsInLeague ?? 12,
      }),
    });

  if (!hit && !request.noCache) {
    cache.set(stateKey, result);
    // Oldest first: `Map` preserves insertion order, so the first key is the
    // least recently computed.
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }

  const byPlayer = new Map<string, NextPickAvailability>();
  for (const candidate of request.candidates) {
    const availability = result.byPlayer.get(candidate.playerId);
    if (!availability) {
      byPlayer.set(candidate.playerId, {
        playerId: candidate.playerId,
        probability: null,
        marketBaseline: null,
        drivers: [],
        confidence: 'low',
        degraded: result.degraded.length > 0 ? result.degraded : ['not simulated'],
      });
      continue;
    }
    const explanation: NextPickExplanation = explainNextPick({
      position: candidate.position,
      adp: candidate.adp,
      currentPick: request.currentPick,
      availability,
      result,
      cliff: candidate.adp == null ? null : (request.tiers?.get(candidate.position)?.at(candidate.adp) ?? null),
      alternatives: request.alternatives?.get(candidate.position),
    });
    byPlayer.set(candidate.playerId, {
      playerId: candidate.playerId,
      probability: availability.probability,
      marketBaseline: availability.marketBaseline,
      drivers: explanation.drivers,
      confidence: explanation.confidence,
      degraded: explanation.degraded,
    });
  }

  return {
    byPlayer,
    targetPick: result.targetPick,
    picksSimulated: result.picksSimulated,
    simulations: result.simulations,
    slotsAhead: result.slotsAhead,
    needAhead: result.needAhead,
    room: result.room,
    teamPrior: result.teamPrior,
    marketOnly: result.marketOnly,
    degraded: result.degraded,
    elapsedMs: result.elapsedMs,
    cached: hit != null,
    stateKey,
  };
}
