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
import { NEUTRAL_MANAGER_PRIOR, type ManagerPriorResult } from './managerPrior.ts';
import { hashString } from './rng.ts';
import { positionsInPlay } from './demand.ts';
import { SIMULATION, simulateNextPick, type SimulationInput, type SimulationResult } from './simulate.ts';

export type { SimCandidate, SimulationResult } from './simulate.ts';
export type { CompletedPick, RoomBehaviour, UniversePlayer } from './room.ts';
export type { NextPickExplanation } from './explain.ts';
export {
  buildPickOwnership,
  slotAtPick,
  interveningPicks,
  slotsAheadOf,
  type PickOwnership,
  type TradedPick,
} from './ownership.ts';
export { positionDemand, positionsInPlay, phaseWeight, DEMAND } from './demand.ts';
export { readRoom, ROOM, NEUTRAL_ROOM } from './room.ts';
export { readTeamPrior, teamMultiplier, TEAM_PRIOR, type TeamPriorResult } from './teamPrior.ts';
export {
  readManagerPrior,
  managerMultiplier,
  MANAGER_PRIOR,
  NEUTRAL_MANAGER_PRIOR,
  type ManagerPriorResult,
  type ManagerPriorEntry,
} from './managerPrior.ts';
export { SIMULATION, simulateNextPick, needShareAt, tierScarcityBonus } from './simulate.ts';
export { explainNextPick, driverLine } from './explain.ts';
export { hashString, mulberry32 } from './rng.ts';

/**
 * The most that historical manager behaviour may move a `Next%`, ever.
 *
 * Five percentage points on the final number, for all intervening managers
 * combined — not five per manager, and not five on a hazard that then compounds
 * into something larger over fourteen picks.
 *
 * ## Why the bound is enforced here and not on the multiplier
 *
 * The effect *belongs* in the hazard: a demand multiplier compounds across the
 * picks a player has to survive, so the same history produces a small effect
 * over three intervening picks and a larger one over eighteen, which is the
 * shape reality has. Bounding the multiplier alone would leave the resulting
 * movement in `Next%` unbounded and dependent on horizon length — the brief asks
 * for a ceiling on the *percentage points*, and that is a statement about the
 * output, so it is enforced on the output.
 *
 * In practice the raw movement is inside this for almost every player and the
 * clamp does nothing; it is a guarantee, not the mechanism. `historyCeilingHits`
 * on the report counts the exceptions, so a ceiling that has quietly become the
 * mechanism is visible rather than invisible.
 *
 * Justified against this league's own scale in `docs/NEXT_PICK.md`: the largest
 * raw movement measured across a full board of real historical profiles was
 * well under this, so the number is a guard rail placed above observed
 * behaviour rather than a cap that shapes it.
 */
export const MANAGER_HISTORY_CEILING = 0.05;

export interface NextPickAvailability {
  playerId: string;
  /** The number the board shows, in [0,1]. Null when it cannot be known. */
  probability: number | null;
  /** The same question asked of ADP alone — what the old model would have said. */
  marketBaseline: number | null;
  /**
   * What this number would have been with no historical-manager input at all.
   *
   * Present only when history was actually applied. The pair is what makes the
   * effect auditable: `probability - historyBaseline` is exactly what history
   * did to this player, and nothing else in the model differs between the two
   * runs — they share a seed, so the difference carries no sampling noise.
   */
  historyBaseline?: number | null;
  /** The bounded adjustment actually applied, in probability units. */
  historyAdjustment?: number;
  /** What it would have been before the ceiling. Equal to the above when unclamped. */
  historyAdjustmentRaw?: number;
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
  /** The historical-manager appetite that was applied, if any. Diagnostics only. */
  managerPrior: ManagerPriorResult | null;
  /**
   * Players whose raw history adjustment was larger than the ceiling allows.
   *
   * Zero is the expected and healthy value. A number that climbs means the
   * ceiling has stopped being a guard rail and started being the model, which
   * is a reason to revisit the gain rather than the ceiling.
   */
  historyCeilingHits: number;
  /** The largest bounded movement history produced on this board, in points. */
  historyLargestMovePoints: number;
  /** True when the board was too thin to simulate and the ADP model answered. */
  marketOnly: boolean;
  degraded: string[];
  elapsedMs: number;
  /** True when this answer came from the cache rather than a fresh run. */
  cached: boolean;
  stateKey: string;
  /**
   * The number that drew every random sample in this run.
   *
   * Reported so that "the same board returns the same numbers" is checkable
   * rather than promised — two runs with the same seed and different answers is
   * a bug, and without this the only way to see it was to get different answers
   * and wonder. A support snapshot also carries it back into a replay; see
   * `SimulationInput.seed` for why an aliased draft id makes that necessary.
   */
  seed: number;
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
  /**
   * What the managers picking ahead have drafted in previous seasons.
   *
   * Absent — the usual case — and `Next%` is computed exactly as it was before
   * this existed. See `managerPrior.ts`, and `MANAGER_HISTORY_CEILING` for the
   * bound on what it may do.
   */
  managerPrior?: ManagerPriorResult;
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

/**
 * What one board state costs to remember.
 *
 * The adjusted run is the answer; `baseline` is the same board with history
 * switched off, kept so the bounded adjustment stays auditable on a cache hit
 * as well as on a fresh one. Null whenever no history applied, which is when
 * only one simulation was run at all.
 */
interface CachedRun {
  result: SimulationResult;
  baseline: Map<string, number | null> | null;
}

const cache = new Map<string, CachedRun>();

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
 * The cache key: the board, plus the history that was applied to it.
 *
 * Deliberately *not* the same string as `draftStateKey`, and the difference is
 * the whole reason the ceiling is enforceable.
 *
 * `draftStateKey` seeds the generator. If the historical prior fed into it, then
 * a board computed with history and the same board computed without it would
 * draw different random numbers, and the gap between them would be part
 * sampling noise — around a point either way at the shipped simulation count.
 * The ceiling is a claim about what history *did*, so history must not be able
 * to change the dice. Keeping the seed blind to it makes the with/without pair a
 * true counterfactual: same draws, same order, one input changed.
 *
 * The cache still has to notice, though — a league whose history sync lands
 * mid-draft must not be served the pre-sync answer — so the stored entry is
 * keyed by both.
 */
export function nextPickCacheKey(request: NextPickRequest): string {
  return `${draftStateKey(request)}|${historyFingerprint(request.managerPrior)}`;
}

/**
 * Run the model, or return the identical answer it gave for this exact board.
 */
/**
 * A short, stable fingerprint of the historical prior that was handed in.
 *
 * Only the numbers that can change an answer — slot, position, multiplier — so
 * a resynced profile that produced identical multipliers does not invalidate a
 * cache entry it would have reproduced exactly.
 */
function historyFingerprint(prior: ManagerPriorResult | undefined): string {
  if (!prior || prior.bySlot.size === 0) return 'no-history';
  const parts: string[] = [];
  for (const [slot, byPosition] of prior.bySlot) {
    const positions = [...byPosition.entries()].sort().map(([p, m]) => `${p}${m}`).join('');
    parts.push(`${slot}:${positions}`);
  }
  return parts.sort().join(',');
}

/**
 * Run the model, or return the identical answer it gave for this exact board.
 *
 * When a historical-manager prior is in play this runs the simulation **twice**:
 * once with it and once without. That is not defensive duplication — it is what
 * makes the ceiling a guarantee instead of a hope. The two runs share a state
 * key and therefore a seed, so they draw the same random numbers in the same
 * order and the difference between them is the effect of the history alone,
 * carrying none of the ±0.7-point sampling noise that two independent runs
 * would. The pair is then clamped to `MANAGER_HISTORY_CEILING`.
 *
 * The second run costs nothing in the leagues that have no history to apply,
 * because it is not performed there: one simulation, exactly as before.
 */
export function estimateNextPickAvailability(request: NextPickRequest): NextPickReport {
  // Two keys, on purpose: one seeds, one remembers. See `nextPickCacheKey`.
  const stateKey = draftStateKey(request);
  const cacheKey = nextPickCacheKey(request);
  const hit = request.noCache ? undefined : cache.get(cacheKey);

  const history = request.managerPrior ?? NEUTRAL_MANAGER_PRIOR;
  const historyApplies = history.bySlot.size > 0;

  const run = hit ?? computeRun(request, stateKey, historyApplies ? history : undefined);
  const result = run.result;

  if (!hit && !request.noCache) {
    cache.set(cacheKey, run);
    // Oldest first: `Map` preserves insertion order, so the first key is the
    // least recently computed.
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }

  const byPlayer = new Map<string, NextPickAvailability>();
  let historyCeilingHits = 0;
  let historyLargestMovePoints = 0;

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

    /*
     * The bounded adjustment.
     *
     * `baseline` is this same board with history switched off. Where either
     * number is unknown there is nothing to bound and the adjusted answer
     * stands as the model produced it.
     */
    let probability = availability.probability;
    let historyBaseline: number | null | undefined;
    let historyAdjustment: number | undefined;
    let historyAdjustmentRaw: number | undefined;

    const baseline = run.baseline?.get(candidate.playerId) ?? null;
    if (run.baseline && baseline != null && availability.probability != null) {
      const raw = availability.probability - baseline;
      const bounded = clamp(raw, -MANAGER_HISTORY_CEILING, MANAGER_HISTORY_CEILING);
      if (bounded !== raw) historyCeilingHits++;
      historyBaseline = baseline;
      historyAdjustmentRaw = round4(raw);
      historyAdjustment = round4(bounded);
      probability = round4(clamp(baseline + bounded, 0, 1));
      historyLargestMovePoints = Math.max(historyLargestMovePoints, Math.abs(bounded) * 100);
    }

    const explanation: NextPickExplanation = explainNextPick({
      position: candidate.position,
      adp: candidate.adp,
      currentPick: request.currentPick,
      // The explanation reads the number the board will actually show, so a
      // driver line can never describe a probability the reader is not seeing.
      availability: probability === availability.probability ? availability : { ...availability, probability },
      result,
      cliff: candidate.adp == null ? null : (request.tiers?.get(candidate.position)?.at(candidate.adp) ?? null),
      alternatives: request.alternatives?.get(candidate.position),
    });
    byPlayer.set(candidate.playerId, {
      playerId: candidate.playerId,
      probability,
      marketBaseline: availability.marketBaseline,
      ...(historyBaseline === undefined ? {} : { historyBaseline }),
      ...(historyAdjustment === undefined ? {} : { historyAdjustment }),
      ...(historyAdjustmentRaw === undefined ? {} : { historyAdjustmentRaw }),
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
    managerPrior: result.managerPrior,
    historyCeilingHits,
    historyLargestMovePoints: Math.round(historyLargestMovePoints * 10) / 10,
    marketOnly: result.marketOnly,
    degraded: result.degraded,
    elapsedMs: result.elapsedMs,
    cached: hit != null,
    stateKey,
    seed: result.seed,
  };
}

/**
 * One board state, simulated — twice when there is a history to isolate.
 *
 * Both runs are handed the identical `stateKey`, which is what seeds them, so
 * the baseline is the counterfactual of this exact simulation rather than an
 * independent estimate of a similar one.
 */
function computeRun(
  request: NextPickRequest,
  stateKey: string,
  history: ManagerPriorResult | undefined,
): CachedRun {
  const room = readRoom({
    picks: request.completed,
    currentPick: request.currentPick,
    positions: positionsInPlay(request.shape),
    universe: request.universe,
  });
  /*
   * What this room has done with the teams it is local to — measured from the
   * same pick stream the positional reads use, and falling back to a bounded
   * assumption only while there is too little of it to measure.
   */
  const teamPrior = readTeamPrior({
    teams: request.localTeams ?? [],
    picks: request.completed.map((pick) => ({ ...pick, team: pick.team ?? null })),
    teamsInLeague: request.teamsInLeague ?? 12,
  });

  const base = { ...request, stateKey, room, teamPrior };

  if (!history) return { result: simulateNextPick({ ...base, managerPrior: undefined }), baseline: null };

  const withHistory = simulateNextPick({ ...base, managerPrior: history });
  const without = simulateNextPick({ ...base, managerPrior: undefined });
  const baseline = new Map<string, number | null>();
  for (const [playerId, availability] of without.byPlayer) baseline.set(playerId, availability.probability);
  return { result: withHistory, baseline };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
