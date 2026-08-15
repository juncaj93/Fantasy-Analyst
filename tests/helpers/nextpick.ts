/**
 * A controlled draft board for the next-pick simulator.
 *
 * Every directional test in this feature is of the form "change one thing, the
 * probability should move this way", which is only meaningful if everything
 * else is genuinely held still. So the board is built from parameters rather
 * than from a captured fixture: the pool is regular, the ADPs are exact, and
 * two boards differing in one argument differ in nothing else.
 *
 * The default is the brief's canonical example — a 12-team snake, the user on
 * pick 53 with their next selection at 68, so picks 54 to 67 are simulated.
 */

import { buildPickOwnership, type PickOwnership } from '../../src/core/draft/nextpick/ownership.ts';
import type { CompletedPick, UniversePlayer } from '../../src/core/draft/nextpick/room.ts';
import type { SimCandidate, SimulationInput } from '../../src/core/draft/nextpick/simulate.ts';
import type { PositionCounts } from '../../src/core/draft/nextpick/demand.ts';
import { buildPositionTierMap, type PositionTierMap } from '../../src/core/draft/tiers.ts';
import { buildRosterShape, type RosterShape } from '../../src/core/sleeper/scoring.ts';

export const TEAMS = 12;
export const ROUNDS = 15;
/** Slot 5 in a 12-team snake owns picks 5, 20, 29, 44, 53, 68, ... */
export const MY_SLOT = 5;

export const STANDARD_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

export interface BoardOptions {
  currentPick?: number;
  targetPick?: number | null;
  mySlot?: number | null;
  rosterPositions?: string[];
  /** Players available, in the order given. */
  candidates?: SimCandidate[];
  /** What each slot ahead already holds. Slots not listed hold nothing. */
  rosters?: Record<number, PositionCounts>;
  completed?: CompletedPick[];
  universe?: UniversePlayer[];
  simulations?: number;
  tiers?: boolean;
  ownership?: PickOwnership;
  unknownRosters?: Set<number>;
}

/**
 * A pool with one player every `spacing` picks at each position, so "how many
 * comparable alternatives are there" is a number the test sets rather than an
 * accident of the fixture.
 */
export function pool(spec: { position: string; from: number; count: number; spacing?: number }[]): SimCandidate[] {
  const out: SimCandidate[] = [];
  for (const group of spec) {
    const spacing = group.spacing ?? 6;
    for (let i = 0; i < group.count; i++) {
      const adp = group.from + i * spacing;
      out.push({
        playerId: `${group.position}-${adp}`,
        position: group.position,
        adp,
        order: adp,
      });
    }
  }
  return out;
}

/**
 * The default pool: every position represented, evenly spaced, from pick 50 on.
 *
 * The *density* is the part that matters and the part that is easy to get
 * wrong. A real board has roughly one available player per pick of ADP around
 * the clock — that is what ADP means — and the simulator is self-normalising:
 * fourteen picks take fourteen players, so halving the number of players on the
 * board doubles everyone's risk. A sparse fixture therefore does not merely
 * look unrealistic, it silently recalibrates every probability in the suite.
 *
 * These spacings sum to about 1.08 players per pick, which is a board.
 */
export function defaultPool(): SimCandidate[] {
  return pool([
    { position: 'RB', from: 52, count: 48, spacing: 3 },
    { position: 'WR', from: 50, count: 60, spacing: 2 },
    { position: 'TE', from: 55, count: 18, spacing: 8 },
    { position: 'QB', from: 58, count: 18, spacing: 8 },
  ]);
}

/** Full rosters for every slot: nobody ahead needs anything. */
export function filledRosters(shape: RosterShape, slots: number[] = allSlots()): Record<number, PositionCounts> {
  const counts: PositionCounts = {};
  for (const [position, required] of Object.entries(shape.starters)) counts[position] = required;
  const out: Record<number, PositionCounts> = {};
  for (const slot of slots) out[slot] = { ...counts };
  return out;
}

export function allSlots(): number[] {
  return Array.from({ length: TEAMS }, (_, i) => i + 1);
}

export function buildBoard(opts: BoardOptions = {}): SimulationInput & { shape: RosterShape } {
  const shape = buildRosterShape(opts.rosterPositions ?? STANDARD_ROSTER);
  const candidates = opts.candidates ?? defaultPool();
  const currentPick = opts.currentPick ?? 53;
  const ownership =
    opts.ownership ?? buildPickOwnership({ teams: TEAMS, rounds: ROUNDS, type: 'snake' });
  const mySlot = opts.mySlot === undefined ? MY_SLOT : opts.mySlot;
  const targetPick =
    opts.targetPick === undefined
      ? mySlot == null
        ? null
        : ownership.nextOwnedPickAfter(mySlot, currentPick)
      : opts.targetPick;

  const rosters = new Map<number, PositionCounts>();
  const given = opts.rosters ?? {};
  for (const slot of allSlots()) rosters.set(slot, { ...(given[slot] ?? {}) });

  const tiers = opts.tiers === false ? undefined : tierMapsFor(candidates, targetPick, currentPick);

  return {
    draftId: 'draft-fixture',
    currentPick,
    targetPick,
    mySlot,
    ownership,
    shape,
    candidates,
    rosters,
    unknownRosters: opts.unknownRosters,
    totalPicks: TEAMS * ROUNDS,
    tiers,
    simulations: opts.simulations ?? 2000,
  };
}

export function tierMapsFor(
  candidates: SimCandidate[],
  targetPick: number | null,
  currentPick: number,
): Map<string, PositionTierMap> {
  const byPosition = new Map<string, number[]>();
  for (const c of candidates) {
    if (c.adp == null) continue;
    const list = byPosition.get(c.position);
    if (list) list.push(c.adp);
    else byPosition.set(c.position, [c.adp]);
  }
  const picksUntilNext = targetPick == null ? 0 : Math.max(0, targetPick - currentPick);
  const out = new Map<string, PositionTierMap>();
  for (const [position, adps] of byPosition) {
    out.set(position, buildPositionTierMap(position, adps, { picksUntilNext }));
  }
  return out;
}

/**
 * Picks already made, laid out so the room reads as ordinary.
 *
 * Positions cycle in market proportions and every pick lands on its ADP, so a
 * test that wants a run or a bias creates it explicitly rather than fighting a
 * fixture that already had one.
 */
export function neutralHistory(upToPick: number, teams = TEAMS): CompletedPick[] {
  const cycle = ['RB', 'WR', 'WR', 'RB', 'WR', 'TE', 'RB', 'WR', 'QB', 'WR', 'RB', 'WR'];
  const out: CompletedPick[] = [];
  for (let pickNo = 1; pickNo < upToPick; pickNo++) {
    out.push({
      pickNo,
      slot: slotOf(pickNo, teams),
      position: cycle[(pickNo - 1) % cycle.length]!,
      adp: pickNo,
    });
  }
  return out;
}

function slotOf(pickNo: number, teams: number): number {
  const round = Math.ceil(pickNo / teams);
  const indexInRound = ((pickNo - 1) % teams) + 1;
  return round % 2 === 0 ? teams - indexInRound + 1 : indexInRound;
}

/** The market's own view of the board, matching a neutral history. */
export function neutralUniverse(upToPick: number, candidates: SimCandidate[]): UniversePlayer[] {
  const drafted = neutralHistory(upToPick).map((p) => ({ position: p.position!, adp: p.adp! }));
  const available = candidates
    .filter((c) => c.adp != null)
    .map((c) => ({ position: c.position, adp: c.adp! }));
  return [...drafted, ...available];
}
