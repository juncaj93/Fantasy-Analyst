/**
 * What this particular room has actually been doing.
 *
 * The market says what twelve thousand drafts did. This says what these twelve
 * managers have done in the last hour, which is a much smaller sample and a much
 * more specific one. Both are worth something; they are not worth the same, and
 * everything here is bounded so that the market keeps the last word.
 *
 * Four things are read, all of them from picks that have already happened in
 * this draft and nothing else:
 *
 *   - **Runs.** Five of the last seven picks were receivers. Runs are real and
 *     runs end, so the effect is capped and measured against what the market
 *     expected over the same stretch rather than against a flat share.
 *   - **Positional bias.** This room has taken quarterbacks nine picks earlier
 *     than the market, all draft. That is a standing property of the room, not a
 *     burst, so it is measured over everything and shrunk toward zero by sample
 *     size.
 *   - **Adherence.** How closely the room has tracked ADP at all. A disciplined
 *     room makes the board more predictable — the distribution narrows. A room
 *     full of reaches makes it less — it widens.
 *   - **Manager tendencies.** Optional, small, and heavily shrunk: three picks
 *     is not a personality.
 *
 * Every one of these requires a minimum sample and returns exactly 1 — no
 * effect — below it. In the first two rounds this module says nothing at all,
 * which is correct: there is nothing to say yet.
 */

import { DISPERSION_BOUNDS, adpSpread } from '../survival.ts';

/** A pick that has already happened, with the market's opinion of it attached. */
export interface CompletedPick {
  pickNo: number;
  /** The draft slot that made it. */
  slot: number;
  position: string | null;
  /** The player's market ADP, when the snapshot has one. */
  adp: number | null;
}

/** A priced player, drafted or not — the market's own picture of the board. */
export interface UniversePlayer {
  position: string;
  adp: number;
}

export const ROOM = {
  /** How many recent picks count as "the room right now". */
  runWindow: 12,
  /** Fewer resolvable picks than this in the window and runs are not measured. */
  runMinSample: 8,
  /** How hard a run may push a position's demand. */
  runGain: 0.5,
  runBounds: { min: 0.85, max: 1.3 },
  /** A position needs this many picks before its bias means anything. */
  biasMinSample: 6,
  /** Shrinkage constant: at n picks the estimate keeps n/(n+k) of itself. */
  biasShrink: 8,
  biasGain: 0.35,
  biasBounds: { min: 0.85, max: 1.2 },
  /** Adherence needs a real stretch of draft behind it. */
  adherenceMinSample: 12,
  /** E|X-µ| for a normal is µ-free and about 0.8σ; our spread is σ-like. */
  meanAbsDeviationOfSpread: 0.8,
  /** A manager needs this many picks before he has a tendency. */
  managerMinSample: 4,
  managerShrink: 10,
  managerGain: 0.5,
  managerBounds: { min: 0.9, max: 1.15 },
} as const;

export interface RoomBehaviour {
  /** Completed picks the read is based on. */
  sample: number;
  /**
   * Multiplier on the market's spread. Below 1 the room is tighter than the
   * market, above 1 looser. Exactly 1 until there is enough draft to judge.
   */
  dispersion: number;
  /** Mean |pick - ADP| observed, and what the market predicted. Diagnostics. */
  adherence: { observed: number | null; expected: number | null; sample: number };
  /** Per position: a short-term run multiplier, centred on 1. */
  runs: Map<string, number>;
  /** Per position: a standing whole-draft bias multiplier, centred on 1. */
  bias: Map<string, number>;
  /** Per slot, per position: a small shrunk personal tendency, centred on 1. */
  managers: Map<number, Map<string, number>>;
  /** Positions whose recent share ran materially hot, for the explanation. */
  running: string[];
  /** Human-readable, only for positions where something was actually measured. */
  notes: string[];
}

export const NEUTRAL_ROOM: RoomBehaviour = {
  sample: 0,
  dispersion: 1,
  adherence: { observed: null, expected: null, sample: 0 },
  runs: new Map(),
  bias: new Map(),
  managers: new Map(),
  running: [],
  notes: [],
};

export interface RoomInput {
  picks: CompletedPick[];
  currentPick: number;
  /** Positions the league starts; nothing else is measured. */
  positions: string[];
  /** Every priced player, drafted or not. The market's expectation of the room. */
  universe: UniversePlayer[];
}

/**
 * Read the room. Pure, deterministic, and silent when the evidence is thin.
 */
export function readRoom(input: RoomInput): RoomBehaviour {
  const picks = input.picks.filter((p) => p.pickNo < input.currentPick).sort((a, b) => a.pickNo - b.pickNo);
  if (picks.length === 0) return { ...NEUTRAL_ROOM, runs: new Map(), bias: new Map(), managers: new Map() };

  const notes: string[] = [];
  const runs = runMultipliers(picks, input, notes);
  const bias = biasMultipliers(picks, input.positions, notes);
  const adherence = measureAdherence(picks);
  const dispersion = dispersionFrom(adherence, notes);
  const managers = managerTendencies(picks, input.positions);

  const running = [...runs.entries()]
    .filter(([, m]) => m >= 1.06)
    .sort((a, b) => b[1] - a[1])
    .map(([position]) => position);

  return { sample: picks.length, dispersion, adherence, runs, bias, managers, running, notes };
}

/**
 * Is a position going faster right now than the market says it should be?
 *
 * The comparison is against the market's own composition over the same stretch
 * of the board — the positions of the players whose ADP falls in the window —
 * rather than against a flat share. Round three is *supposed* to be mostly
 * backs and receivers; calling that a run would flag every draft ever played.
 */
function runMultipliers(picks: CompletedPick[], input: RoomInput, notes: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const window = picks.slice(-ROOM.runWindow).filter((p) => p.position);
  if (window.length < ROOM.runMinSample) return out;

  const from = input.currentPick - window.length;
  const expectedPool = input.universe.filter((p) => p.adp > from && p.adp <= input.currentPick);
  if (expectedPool.length < ROOM.runMinSample) return out;

  for (const position of input.positions) {
    const observed = window.filter((p) => p.position === position).length / window.length;
    const expected = expectedPool.filter((p) => p.position === position).length / expectedPool.length;
    if (expected <= 0) continue;
    const multiplier = clamp(
      1 + (ROOM.runGain * (observed - expected)) / Math.max(expected, 0.08),
      ROOM.runBounds.min,
      ROOM.runBounds.max,
    );
    out.set(position, round3(multiplier));
    if (Math.abs(multiplier - 1) >= 0.06) {
      notes.push(
        `${position}: ${Math.round(observed * 100)}% of the last ${window.length} picks against ${Math.round(expected * 100)}% expected`,
      );
    }
  }
  return out;
}

/**
 * Does this room take a position earlier or later than the market does?
 *
 * A standing habit rather than a burst, so it uses the whole draft and is shrunk
 * toward "no habit" by how little of the draft that is. Scaled by the length of
 * a round, because being four picks early in a twelve-team league is a bigger
 * statement than being four picks early in a thirty-team one would be.
 */
function biasMultipliers(picks: CompletedPick[], positions: string[], notes: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const priced = picks.filter((p) => p.position && p.adp != null);
  if (priced.length === 0) return out;
  const scale = Math.max(8, Math.round(priced.length / Math.max(1, Math.ceil(priced.length / 12))));

  for (const position of positions) {
    const rows = priced.filter((p) => p.position === position);
    if (rows.length < ROOM.biasMinSample) continue;
    const meanDelta = rows.reduce((a, p) => a + (p.pickNo - p.adp!), 0) / rows.length;
    const shrunk = meanDelta * (rows.length / (rows.length + ROOM.biasShrink));
    // Negative delta = taken before the market expected = more demand.
    const multiplier = clamp(1 - (ROOM.biasGain * shrunk) / scale, ROOM.biasBounds.min, ROOM.biasBounds.max);
    out.set(position, round3(multiplier));
    if (Math.abs(multiplier - 1) >= 0.03) {
      notes.push(
        `${position}: this room takes them ${Math.abs(Math.round(meanDelta))} picks ${meanDelta < 0 ? 'earlier' : 'later'} than the market, over ${rows.length} picks`,
      );
    }
  }
  return out;
}

/** Mean |pick - ADP|, and what the market's own spread predicted for it. */
function measureAdherence(picks: CompletedPick[]): RoomBehaviour['adherence'] {
  const priced = picks.filter((p) => p.adp != null);
  if (priced.length < ROOM.adherenceMinSample) {
    return { observed: null, expected: null, sample: priced.length };
  }
  const observed = priced.reduce((a, p) => a + Math.abs(p.pickNo - p.adp!), 0) / priced.length;
  const expected =
    (priced.reduce((a, p) => a + adpSpread(p.adp!), 0) / priced.length) * ROOM.meanAbsDeviationOfSpread;
  return { observed: round3(observed), expected: round3(expected), sample: priced.length };
}

function dispersionFrom(adherence: RoomBehaviour['adherence'], notes: string[]): number {
  if (adherence.observed == null || !adherence.expected) return 1;
  const ratio = clamp(adherence.observed / adherence.expected, DISPERSION_BOUNDS.min, DISPERSION_BOUNDS.max);
  if (Math.abs(ratio - 1) >= 0.05) {
    notes.push(
      ratio < 1
        ? `this room has been tracking ADP tightly (${adherence.observed} picks off on average against ${adherence.expected} expected)`
        : `this room has been reaching (${adherence.observed} picks off on average against ${adherence.expected} expected)`,
    );
  }
  return round3(ratio);
}

/**
 * A small, heavily shrunk personal lean per manager.
 *
 * Deliberately the weakest signal in the file, and the first one that should be
 * suspected if the model ever looks overfitted. Four picks earns a manager a
 * tendency worth at most a few per cent; nothing here can override the room, and
 * the room cannot override the market.
 */
function managerTendencies(picks: CompletedPick[], positions: string[]): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  const resolvable = picks.filter((p) => p.position);
  if (resolvable.length === 0) return out;

  const roomShare = new Map<string, number>();
  for (const position of positions) {
    roomShare.set(position, resolvable.filter((p) => p.position === position).length / resolvable.length);
  }

  const bySlot = new Map<number, CompletedPick[]>();
  for (const pick of resolvable) {
    const list = bySlot.get(pick.slot);
    if (list) list.push(pick);
    else bySlot.set(pick.slot, [pick]);
  }

  for (const [slot, rows] of bySlot) {
    if (rows.length < ROOM.managerMinSample) continue;
    const shrink = rows.length / (rows.length + ROOM.managerShrink);
    const lean = new Map<string, number>();
    for (const position of positions) {
      const expected = roomShare.get(position) ?? 0;
      if (expected <= 0) continue;
      const mine = rows.filter((p) => p.position === position).length / rows.length;
      const multiplier = clamp(
        1 + (ROOM.managerGain * shrink * (mine - expected)) / Math.max(expected, 0.1),
        ROOM.managerBounds.min,
        ROOM.managerBounds.max,
      );
      lean.set(position, round3(multiplier));
    }
    out.set(slot, lean);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
