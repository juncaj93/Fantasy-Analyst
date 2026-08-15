/**
 * The picks between now and your next one, played out five thousand times.
 *
 * `Next 18%` means: given the board exactly as it stands, and given that this
 * player is still on it, he survived every intervening selection in about
 * eighteen of every hundred simulated drafts. Nothing else. It is not an ADP
 * percentile, not a distance from ADP, and not a score — a player can be the
 * best value on the board and still be certain to be gone, and those two facts
 * belong in different columns.
 *
 * ## How one simulation runs
 *
 * Walk the picks from the clock up to (not including) the user's next owned
 * selection. For each one, ask who owns it, look at the roster that manager has
 * *at that moment in this simulation*, work out what they are likely to take,
 * sample a position, sample a player, and give them to that manager. Then the
 * next pick, from the board that pick left behind. A manager with two picks in a
 * row sees his own first pick before making his second; a player taken at 57
 * cannot be taken again at 61; the user's own picks are skipped, because your
 * selection is not competition for you.
 *
 * ## How one manager decides
 *
 * Two motives, mixed by how far into the draft it is:
 *
 *   - **Best available.** Weight every player by how ready the market is to take
 *     him at this exact pick — the hazard of the ADP distribution, saturating
 *     rather than exploding, so a player fifty picks past his ADP is very
 *     likely to be taken and never more than that.
 *   - **Need.** Weight every *position* by what this manager's starting slots
 *     still want, then split that weight among the players available at it.
 *
 * The split matters more than it looks, and it is where "how replaceable is he"
 * lives. A manager taking the best player available takes *this player*, and
 * seven similar receivers behind him do not protect him at all. A manager who
 * needs a receiver takes *a receiver*, and then seven alternatives mean he is
 * taken one time in eight. So alternative supply damps the need-driven share of
 * the risk and leaves the market-driven share alone — which is both the right
 * shape and a natural bound on the effect. The same arithmetic is why the last
 * tight end in a tier facing three tight-end-needy teams is in far more danger
 * than a receiver with the same ADP and nine comparable alternatives, without
 * anything anywhere having to special-case tight ends.
 *
 * ## What is deliberately not in here
 *
 * The user's own preferences. `My Guy` is an input to *your* decision and says
 * nothing about what eleven other managers will do, so it is not passed to this
 * module and cannot reach it. Neither is the newsletter tally — that is this
 * app's private evidence, not something the room has read — nor the betting
 * market, which is excellent at "is he good" and unevidenced at "will somebody
 * else draft him". Public injury designations are the one exception, because
 * the room can see those too.
 */

import type { PositionTierMap } from '../tiers.ts';
import { conditionalMarketSurvival, marketPickWeight } from '../survival.ts';
import {
  buildDemandPlan,
  createDemandScratch,
  demandInto,
  positionsInPlay,
  UNKNOWN_MANAGER_NEED,
  type PositionCounts,
} from './demand.ts';
import { NEUTRAL_ROOM, type RoomBehaviour } from './room.ts';
import { hashString, mulberry32, sampleIndex } from './rng.ts';
import type { PickOwnership } from './ownership.ts';
import type { RosterShape } from '../../sleeper/scoring.ts';

export const SIMULATION = {
  /**
   * How many drafts are played out per board state.
   *
   * Measured rather than assumed — `tests/nextpick.simulate.test.ts` compares
   * 1,000 / 2,500 / 5,000 on a representative board and then measures the
   * shipped count's own sampling error by re-running it under a different seed.
   *
   * Five thousand puts the standard error at 0.7 points in the worst case
   * (p = 0.5) and less at both ends, which is inside the whole number the card
   * shows. It costs about 50ms for three hundred candidates over fourteen
   * intervening picks — and costs that once per *board state*, not once per
   * player, because a simulation that plays out the interval has by then
   * decided every player's fate at the same time. A live draft recomputes only
   * when a pick actually lands; polling the same state is served from the
   * cache.
   *
   * The count bounds the error. It is not a source of jitter: the generator is
   * seeded from the draft state, so the same board returns the same number
   * every time, at any count.
   */
  default: 5000,
  /** Candidates considered per position per pick, in ADP order. */
  perPositionCandidates: 16,
  /**
   * Where the shortlist at a position stops, as a share of its best player's
   * weight.
   *
   * Not a performance hack with a quality cost: market weight falls strictly as
   * ADP rises at any fixed pick, so once one player is below the floor every
   * player behind him is too, and stopping there removes candidates whose
   * combined chance of being the pick is under a per cent.
   */
  shortlistFloor: 0.04,
  /**
   * How much of a manager's decision is need rather than market, early and late.
   *
   * Round one is a market — everyone's slots are empty and the best player is
   * the pick. By the middle rounds a starting hole is a real reason to take a
   * position over a better player at one you have filled.
   */
  needShareEarly: 0.15,
  needShareLate: 0.55,
  /** Share of the draft by which the need share has fully ramped. */
  needShareFullBy: 0.5,
  /**
   * How much a nearly-exhausted tier lifts its remaining members.
   *
   * Small, because most of the tier effect is already there without it: when a
   * tier empties, the players past the cliff have distant ADPs and low weight,
   * so the position's need-driven share concentrates on the few left. This is
   * the last-two-tight-ends premium on top of that, and it is capped.
   */
  tierScarcityGain: 0.3,
  /** Weight given to a candidate the market has never priced. */
  unpricedDamping: 0.5,
  /** Below this many resolvable picks the run/bias reads are ignored entirely. */
  minPicksForRoomEffects: 8,
} as const;

/** A player who could be taken in the simulation. */
export interface SimCandidate {
  playerId: string;
  position: string;
  /** Market ADP as an overall pick number, or null when unpriced. */
  adp: number | null;
  /**
   * Fallback ordering for unpriced players, ascending — Sleeper's search rank.
   *
   * Never used as ADP. It decides only which unpriced player a simulated
   * manager reaches for first, among players who all carry damped weight and
   * whose market probability is reported as unknown.
   */
  order: number;
}

export interface SimulationInput {
  /** Stable identity for the seed. */
  draftId: string;
  currentPick: number;
  /** The user's next owned selection, strictly after the clock. Null on their last. */
  targetPick: number | null;
  /** The user's draft slot, whose picks are skipped. Null when unknown. */
  mySlot: number | null;
  ownership: PickOwnership;
  shape: RosterShape;
  /** Every available player worth simulating, any order. */
  candidates: SimCandidate[];
  /** What each slot already holds, by position, from the pick stream. */
  rosters: Map<number, PositionCounts>;
  /** Slots whose roster could not be reconstructed. */
  unknownRosters?: Set<number>;
  totalPicks: number;
  room?: RoomBehaviour;
  /** Tier ladders per position, from the existing tier engine. Optional. */
  tiers?: Map<string, PositionTierMap>;
  simulations?: number;
  /** Folded into the seed so a changed board cannot reuse a cached answer. */
  stateKey?: string;
}

export interface PlayerAvailability {
  playerId: string;
  position: string;
  /** Share of simulations in which he was still there. Null when unpriced. */
  probability: number | null;
  /** The same question asked of the market alone — the baseline, for diagnostics. */
  marketBaseline: number | null;
  /** Simulations in which somebody took him. */
  timesTaken: number;
}

export interface SimulationResult {
  simulations: number;
  targetPick: number | null;
  /** Picks actually simulated: opposing selections only. */
  picksSimulated: number;
  /** Slots picking before the user's next selection, after trades. */
  slotsAhead: number[];
  byPlayer: Map<string, PlayerAvailability>;
  /**
   * Per position, how many managers picking before the user still have a
   * dedicated starting slot open. Measured from the real board, not simulated.
   */
  needAhead: Map<string, number>;
  room: RoomBehaviour;
  /** Why any part of this is less trustworthy than usual. Empty is good. */
  degraded: string[];
  /** Milliseconds spent in the simulation loop, for the performance probe. */
  elapsedMs: number;
  seed: number;
}

/** Nothing to simulate: no later pick of the user's exists. */
function emptyResult(input: SimulationInput, degraded: string[]): SimulationResult {
  return {
    simulations: 0,
    targetPick: input.targetPick,
    picksSimulated: 0,
    slotsAhead: [],
    byPlayer: new Map(),
    needAhead: new Map(),
    room: input.room ?? NEUTRAL_ROOM,
    degraded,
    elapsedMs: 0,
    seed: 0,
  };
}

export function simulateNextPick(input: SimulationInput): SimulationResult {
  const degraded: string[] = [];
  if (input.targetPick == null) {
    return emptyResult(input, ['you have no selection after this one, so there is nothing to survive to']);
  }
  if (input.mySlot == null) {
    degraded.push('your draft slot is unknown, so which picks are yours had to be inferred');
  }

  const room = input.room ?? NEUTRAL_ROOM;
  const positions = positionsInPlay(input.shape);
  const simulations = Math.max(1, Math.floor(input.simulations ?? SIMULATION.default));

  /*
   * The picks that actually stand between you and him.
   *
   * Ownership decides, not the snake, and your own picks are dropped — the one
   * you are making now, and any you own inside the interval. Everything else in
   * this file operates on this list, so "only managers picking before the user's
   * next pick influence the path" is true by construction rather than by
   * remembering to check.
   */
  const interveningPicks: number[] = [];
  for (let pickNo = input.currentPick; pickNo < input.targetPick; pickNo++) {
    const owner = input.ownership.ownerAt(pickNo);
    if (owner != null && owner === input.mySlot) continue;
    interveningPicks.push(pickNo);
  }

  const candidates = input.candidates;
  const count = candidates.length;
  const slotsAhead = [
    ...new Set(interveningPicks.map((p) => input.ownership.ownerAt(p)).filter((s): s is number => s != null)),
  ].sort((a, b) => a - b);

  const needAhead = countNeedAhead(slotsAhead, input, positions);

  // Nobody picks between now and your next selection — back-to-back picks, or a
  // draft where every pick in the gap is yours. Everyone survives, and that is a
  // fact about the pick order rather than an estimate.
  if (interveningPicks.length === 0 || count === 0) {
    const byPlayer = new Map<string, PlayerAvailability>();
    for (const c of candidates) {
      byPlayer.set(c.playerId, {
        playerId: c.playerId,
        position: c.position,
        probability: 1,
        marketBaseline: c.adp == null ? null : 1,
        timesTaken: 0,
      });
    }
    return {
      simulations,
      targetPick: input.targetPick,
      picksSimulated: 0,
      slotsAhead,
      byPlayer,
      needAhead,
      room,
      degraded,
      elapsedMs: 0,
      seed: 0,
    };
  }

  const startedAt = Date.now();

  // ------------------------------------------------------------------ setup

  /*
   * Unpriced players get an ordering, never a price.
   *
   * They sit behind the deepest player the market has priced, in search-rank
   * order, and carry damped weight. That is enough for a simulated manager in
   * round fourteen to take *somebody* rather than run out of board — without
   * inventing an ADP, which would then be indistinguishable from a real one.
   */
  const deepestAdp = candidates.reduce((deep, c) => (c.adp == null ? deep : Math.max(deep, c.adp)), 0);
  const unpricedFloor = Math.max(deepestAdp, input.currentPick) + 1;
  const unpricedOrder = candidates
    .filter((c) => c.adp == null)
    .sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId))
    .map((c) => c.playerId);
  const pseudoAdpOf = new Map<string, number>();
  unpricedOrder.forEach((playerId, i) => pseudoAdpOf.set(playerId, unpricedFloor + i));
  if (unpricedOrder.length > 0) {
    degraded.push(`${unpricedOrder.length} candidates have no market ADP and were simulated on a damped fallback`);
  }

  /*
   * A weight per candidate per simulated pick, computed once.
   *
   * The market's readiness to take a player depends on the pick number and on
   * nothing that happens inside a simulation, so a table of
   * `picks × candidates` doubles replaces roughly six million `Math.exp` calls
   * with six million array reads. It is the single reason five thousand
   * simulations of fifteen picks over three hundred players costs milliseconds.
   */
  const horizon = interveningPicks.length;
  const weightAt = new Float64Array(horizon * count);
  const tierBonus = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    tierBonus[i] = tierScarcityBonus(candidates[i]!, input.tiers);
  }
  for (let step = 0; step < horizon; step++) {
    const pickNo = interveningPicks[step]!;
    const base = step * count;
    for (let i = 0; i < count; i++) {
      const candidate = candidates[i]!;
      const adp = candidate.adp ?? pseudoAdpOf.get(candidate.playerId)!;
      const damping = candidate.adp == null ? SIMULATION.unpricedDamping : 1;
      weightAt[base + i] = marketPickWeight(adp, pickNo, room.dispersion) * damping * tierBonus[i]!;
    }
  }

  // Candidates grouped by position, in ADP order, so a simulation can walk the
  // front of each position and stop after `perPositionCandidates` live ones.
  const byPosition = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const candidate = candidates[i]!;
    const list = byPosition.get(candidate.position);
    if (list) list.push(i);
    else byPosition.set(candidate.position, [i]);
  }
  for (const list of byPosition.values()) {
    list.sort((a, b) => {
      const ca = candidates[a]!;
      const cb = candidates[b]!;
      const aa = ca.adp ?? pseudoAdpOf.get(ca.playerId)!;
      const ab = cb.adp ?? pseudoAdpOf.get(cb.playerId)!;
      return aa - ab || ca.playerId.localeCompare(cb.playerId);
    });
  }
  const activePositions = positions.filter((p) => (byPosition.get(p)?.length ?? 0) > 0);
  // A position the league starts but has nobody left at simply cannot be taken.
  for (const [position, list] of byPosition) {
    if (list.length > 0 && !activePositions.includes(position)) activePositions.push(position);
  }

  const ownerOf = interveningPicks.map((p) => input.ownership.ownerAt(p));
  const unknownRosters = input.unknownRosters ?? new Set<number>();
  if (ownerOf.some((s) => s == null)) {
    degraded.push('some intervening picks have no published owner and were simulated on the market baseline');
  }
  if (slotsAhead.some((slot) => unknownRosters.has(slot) || !input.rosters.has(slot))) {
    degraded.push('a manager picking before you has no readable roster, so their need fell back to the market');
  }
  if (room.sample < SIMULATION.minPicksForRoomEffects) {
    degraded.push('too few picks so far to read this room, so only the market and roster needs are in play');
  }

  // Which positions each manager is personally inclined toward, resolved once.
  const managerLean = new Map<number, Map<string, number>>();
  for (const slot of slotsAhead) {
    const lean = room.managers.get(slot);
    if (lean) managerLean.set(slot, lean);
  }

  // ------------------------------------------------------- the simulation

  const seed = hashString(
    [
      input.draftId,
      input.currentPick,
      input.targetPick,
      input.mySlot ?? 'no-slot',
      simulations,
      horizon,
      input.stateKey ?? '',
    ].join('|'),
  );
  const random = mulberry32(seed);

  /*
   * `taken` is stamped with the simulation number rather than cleared.
   *
   * Clearing three hundred flags between simulations costs more than the
   * simulation does; comparing a stamp is free and cannot leak state across
   * runs, because the stamp is different every run by construction.
   */
  const takenStamp = new Int32Array(count).fill(-1);
  const goneCount = new Int32Array(count);

  const positionCount = activePositions.length;
  const positionIndex = new Map(activePositions.map((position, i) => [position, i]));
  const positionOfCandidate = new Int32Array(count);
  for (let i = 0; i < count; i++) positionOfCandidate[i] = positionIndex.get(candidates[i]!.position) ?? -1;

  /*
   * How much market weight each position carries at each simulated pick, over
   * the whole board — computed once, before any simulation runs.
   *
   * This table is what makes the loop affordable. The obvious implementation
   * re-adds every position's live players at every pick of every simulation:
   * four positions, sixteen players, fourteen picks, three thousand times, and
   * roughly three million additions that mostly re-derive the same sums. Here
   * the full sums are known up front and a simulation only tracks its own
   * *deficit* — the weight of the players it has taken — which is at most one
   * subtraction per remaining pick per selection. Fourteen selections cost a
   * couple of hundred operations instead of tens of thousands.
   */
  const fullMass = new Float64Array(horizon * positionCount);
  for (let step = 0; step < horizon; step++) {
    const weightBase = step * count;
    const massBase = step * positionCount;
    for (let i = 0; i < count; i++) {
      const pi = positionOfCandidate[i]!;
      if (pi < 0) continue;
      fullMass[massBase + pi] = fullMass[massBase + pi]! + weightAt[weightBase + i]!;
    }
  }
  /** This simulation's running deficit against `fullMass`. Reset per simulation. */
  const takenMass = new Float64Array(horizon * positionCount);

  const posNeed = new Float64Array(positionCount);
  const posMass = new Float64Array(positionCount);
  const posMult = new Float64Array(positionCount);
  // Scratch for the chosen position's candidates only. One position per pick is
  // gathered, not all of them — the mass table already answered the question the
  // other three were being gathered for.
  const pickIds = new Int32Array(SIMULATION.perPositionCandidates);
  const posWeightList: number[] = new Array(positionCount).fill(0);
  const playerWeightList: number[] = new Array(SIMULATION.perPositionCandidates).fill(0);

  /*
   * The room's standing opinion of each position, resolved once per manager.
   *
   * Runs, bias and personal lean depend on the manager and the position and on
   * nothing that happens inside a simulation, so the product of the three is a
   * small table rather than three map lookups per position per pick.
   */
  const slotIndex = new Map(slotsAhead.map((slot, i) => [slot, i]));
  const roomMult = new Float64Array(Math.max(1, slotsAhead.length) * positionCount);
  slotsAhead.forEach((slot, si) => {
    const lean = managerLean.get(slot);
    for (let pi = 0; pi < positionCount; pi++) {
      const position = activePositions[pi]!;
      roomMult[si * positionCount + pi] =
        (room.runs.get(position) ?? 1) * (room.bias.get(position) ?? 1) * (lean?.get(position) ?? 1);
    }
  });
  /** For a pick with no published owner: the room, without a personal lean. */
  const roomMultDefault = new Float64Array(positionCount);
  for (let pi = 0; pi < positionCount; pi++) {
    const position = activePositions[pi]!;
    roomMultDefault[pi] = (room.runs.get(position) ?? 1) * (room.bias.get(position) ?? 1);
  }

  // Every manager's roster in one flat array: `slot index × position index`.
  // Copied wholesale at the start of each simulation, which is one typed-array
  // write rather than a map of freshly allocated objects.
  const rosterBase = new Float64Array(Math.max(1, slotsAhead.length) * positionCount);
  slotsAhead.forEach((slot, si) => {
    const counts = input.rosters.get(slot);
    if (!counts) return;
    for (let pi = 0; pi < positionCount; pi++) rosterBase[si * positionCount + pi] = counts[activePositions[pi]!] ?? 0;
  });
  const rosterState = new Float64Array(rosterBase.length);

  const plan = buildDemandPlan(input.shape, activePositions);
  const demandScratch = createDemandScratch(positionCount);
  const demandMult = new Float64Array(positionCount);
  const demandNeed = new Float64Array(positionCount);
  // A manager whose roster could not be read: the market alone, no invented need.
  const unknownMult = new Float64Array(positionCount).fill(1);
  const unknownNeed = new Float64Array(positionCount).fill(UNKNOWN_MANAGER_NEED);

  for (let sim = 0; sim < simulations; sim++) {
    // Every simulation starts from the live board — never from where a previous
    // simulation left it.
    rosterState.set(rosterBase);
    takenMass.fill(0);

    for (let step = 0; step < horizon; step++) {
      const slot = ownerOf[step];
      const weightBase = step * count;
      const massBase = step * positionCount;
      const progress = clamp((interveningPicks[step]! - 1) / Math.max(1, input.totalPicks - 1), 0, 1);
      const needShare = needShareAt(progress);

      const si = slot == null ? -1 : (slotIndex.get(slot) ?? -1);
      const readable = si >= 0 && !(slot != null && unknownRosters.has(slot));
      if (readable) {
        demandInto(rosterState, si * positionCount, plan, progress, demandScratch, demandMult, demandNeed);
      }
      const mult = readable ? demandMult : unknownMult;
      const need = readable ? demandNeed : unknownNeed;
      const roomBase = si >= 0 ? si * positionCount : -1;

      // --- what each position is worth to this manager, at this pick --------
      let massTotal = 0;
      let needTotal = 0;
      for (let pi = 0; pi < positionCount; pi++) {
        const mass = Math.max(0, fullMass[massBase + pi]! - takenMass[massBase + pi]!);
        posMass[pi] = mass;

        const multiplier =
          mult[pi]! * (roomBase >= 0 ? roomMult[roomBase + pi]! : roomMultDefault[pi]!);
        posMult[pi] = multiplier;
        /*
         * `presence` keeps a need from conjuring a player out of nothing.
         *
         * A manager who needs a tight end takes a tight end — unless the only
         * ones left are forty picks below where the board is, in which case he
         * waits. It saturates, so two credible options and nine credible
         * options both count as "there is somebody to take", which is what
         * makes the need term independent of how deep the position is.
         */
        const presence = mass > 0 ? 1 - Math.exp(-mass) : 0;
        const weighted = need[pi]! * presence * multiplier;
        posNeed[pi] = weighted;
        massTotal += mass * multiplier;
        needTotal += weighted;
      }

      if (massTotal <= 0 && needTotal <= 0) continue; // board exhausted

      // --- position, then player ------------------------------------------
      let weightTotal = 0;
      for (let pi = 0; pi < positionCount; pi++) {
        if (posMass[pi]! <= 0) {
          posWeightList[pi] = 0;
          continue;
        }
        const bpa = massTotal > 0 ? (posMass[pi]! * posMult[pi]!) / massTotal : 0;
        const needed = needTotal > 0 ? posNeed[pi]! / needTotal : 0;
        const w = (1 - needShare) * bpa + needShare * needed;
        posWeightList[pi] = w;
        weightTotal += w;
      }
      if (weightTotal <= 0) continue;

      const chosen = sampleIndex(posWeightList, positionCount, weightTotal, random());
      if (chosen < 0) continue;

      /*
       * The shortlist at the chosen position.
       *
       * Walked in ADP order and cut short twice: after `perPositionCandidates`
       * live players, and as soon as a player's weight has fallen to a fraction
       * of the best one's. The second cut is exact rather than an
       * approximation — market weight is strictly decreasing in ADP at a fixed
       * pick, so everyone behind the first player under the floor is under it
       * too. In the middle rounds that ends the walk after three or four names;
       * in the last rounds, where every weight is much the same and the board
       * really is a lottery, it does not fire and the full shortlist is used.
       */
      const list = byPosition.get(activePositions[chosen]!)!;
      let length = 0;
      let playerTotal = 0;
      let floor = 0;
      for (let k = 0; k < list.length && length < SIMULATION.perPositionCandidates; k++) {
        const idx = list[k]!;
        if (takenStamp[idx] === sim) continue;
        const w = weightAt[weightBase + idx]!;
        if (length === 0) floor = w * SIMULATION.shortlistFloor;
        else if (w < floor) break;
        pickIds[length] = idx;
        playerWeightList[length] = w;
        playerTotal += w;
        length++;
      }
      if (length === 0) continue;

      const offset =
        playerTotal > 0
          ? sampleIndex(playerWeightList, length, playerTotal, random())
          : // Every remaining player at this position is priced far below the
            // board. Somebody still has to be taken, and it is the best of them.
            0;
      const takenIdx = pickIds[Math.max(0, offset)]!;

      takenStamp[takenIdx] = sim;
      goneCount[takenIdx] = goneCount[takenIdx]! + 1;
      // He is off the board for the rest of this simulation, so every later
      // pick sees a position that much lighter.
      const takenPi = positionOfCandidate[takenIdx]!;
      for (let later = step; later < horizon; later++) {
        takenMass[later * positionCount + takenPi] =
          takenMass[later * positionCount + takenPi]! + weightAt[later * count + takenIdx]!;
      }
      // And he is on that manager's roster, which is what makes his next pick a
      // different decision from this one.
      if (si >= 0) rosterState[si * positionCount + takenPi] = rosterState[si * positionCount + takenPi]! + 1;
    }
  }

  // ------------------------------------------------------------- the answer

  const byPlayer = new Map<string, PlayerAvailability>();
  for (let i = 0; i < count; i++) {
    const candidate = candidates[i]!;
    const taken = goneCount[i]!;
    byPlayer.set(candidate.playerId, {
      playerId: candidate.playerId,
      position: candidate.position,
      /*
       * Unpriced players are simulated so the board they are on is realistic,
       * and then reported as unknown. A percentage derived from a made-up draft
       * position is a made-up percentage, and the one thing worse than "—" is a
       * confident number nobody can check.
       */
      probability: candidate.adp == null ? null : round4((simulations - taken) / simulations),
      marketBaseline:
        candidate.adp == null
          ? null
          : round4(conditionalMarketSurvival(candidate.adp, input.currentPick, input.targetPick, room.dispersion)),
      timesTaken: taken,
    });
  }

  return {
    simulations,
    targetPick: input.targetPick,
    picksSimulated: horizon,
    slotsAhead,
    byPlayer,
    needAhead,
    room,
    degraded,
    elapsedMs: Date.now() - startedAt,
    seed,
  };
}

/**
 * How much of each manager's decision is need rather than best-available.
 *
 * Ramps from `needShareEarly` to `needShareLate` and then holds. The late
 * plateau rather than a continued climb is deliberate: by the bench rounds every
 * starting slot is filled, so the need model has already flattened itself and
 * pushing its share higher would only amplify a signal that is saying nothing.
 */
export function needShareAt(progress: number): number {
  const ramp = clamp(clamp(progress, 0, 1) / SIMULATION.needShareFullBy, 0, 1);
  return SIMULATION.needShareEarly + (SIMULATION.needShareLate - SIMULATION.needShareEarly) * ramp;
}

/**
 * The premium on the last players in a meaningful tier.
 *
 * Reads the existing tier engine and does not redefine it: if tier data is
 * missing the bonus is 1 and the model loses a nudge rather than breaking. Only
 * tiers that end at a real cliff count — the last group at a position is not
 * scarce, it is simply the end of the board.
 */
export function tierScarcityBonus(candidate: SimCandidate, tiers?: Map<string, PositionTierMap>): number {
  if (!tiers || candidate.adp == null) return 1;
  const cliff = tiers.get(candidate.position)?.at(candidate.adp);
  if (!cliff || !cliff.tierEndsAtCliff || cliff.remainingInTier <= 0) return 1;
  // Three or more left and the group is not under threat; one left and it is as
  // urgent as it gets.
  const urgency = clamp((3 - cliff.remainingInTier) / 2, 0, 1);
  return 1 + SIMULATION.tierScarcityGain * urgency;
}

/**
 * How many managers picking before you still have a dedicated slot open, per
 * position — read from the real board, before any simulation.
 *
 * This is what the explanation is allowed to say out loud ("3 teams ahead still
 * need TE"), so it counts the same thing a reader would count by looking at the
 * other rosters: an unfilled *dedicated* starting slot. Flex and bench appetite
 * move the model but do not get to claim a team "needs" a position.
 */
function countNeedAhead(slotsAhead: number[], input: SimulationInput, positions: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const position of positions) {
    const required = input.shape.starters[position] ?? 0;
    if (required <= 0) continue;
    let needing = 0;
    for (const slot of slotsAhead) {
      const counts = input.rosters.get(slot);
      if (!counts) continue;
      if ((counts[position] ?? 0) < required) needing++;
    }
    out.set(position, needing);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
