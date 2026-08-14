/**
 * Slot-aware lineup recommendation for the whole roster at once.
 *
 * The head-to-head comparison answers "A or B?". This answers the question that
 * actually gets asked on a Sunday morning: "given everyone I own and the slots
 * this league starts, who should be in the lineup?"
 *
 * Safety: this module recommends. It never edits a lineup, and it never sends
 * anything to Sleeper. The output is a suggestion the user applies by hand.
 *
 * Unknown stays unknown. A player the engine cannot score is not quietly
 * benched — they are listed separately as undecidable, and if one is currently
 * starting, no swap is proposed against them.
 */

import type { RosterShape } from '../sleeper/scoring.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from './engine.ts';

export interface LineupSlot {
  /** Slot label as the league defines it: 'QB', 'RB', 'FLEX', 'SUPER_FLEX'. */
  slot: string;
  /** Positions this slot accepts. */
  accepts: string[];
  /** Null when no eligible player could be scored for this slot. */
  playerId: string | null;
  name: string | null;
  position: string | null;
  score: number | null;
  /** True when the player already occupies a starting spot in Sleeper. */
  alreadyStarting: boolean;
  /** True when this player's game has kicked off and the slot is now fixed. */
  locked: boolean;
}

export interface LineupSwap {
  slot: string;
  inPlayerId: string;
  inName: string;
  outPlayerId: string;
  outName: string;
  /** Points gained by making this change. Always positive. */
  gain: number;
  reason: string;
}

export interface LineupRecommendation {
  slots: LineupSlot[];
  /** Players not in the recommended lineup, best first. */
  bench: StartSitEvaluation[];
  /** Players with no usable data — never auto-benched, never auto-started. */
  undecidable: StartSitEvaluation[];
  /** Changes from the current Sleeper lineup, biggest gain first. */
  swaps: LineupSwap[];
  /** Total recommended points, and the current lineup's total for comparison. */
  recommendedPoints: number;
  currentPoints: number | null;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  notes: string[];
}

/** A swap has to be worth this many points before it is worth suggesting. */
export const MIN_SWAP_GAIN = 0.75;

export function recommendLineup(
  inputs: StartSitInput[],
  shape: RosterShape,
  profile: ScoringProfile,
  opts: { currentStarterIds?: string[]; minSwapGain?: number } = {},
): LineupRecommendation {
  const minGain = opts.minSwapGain ?? MIN_SWAP_GAIN;
  const currentStarters = new Set(opts.currentStarterIds ?? []);
  const evaluations = inputs.map((i) => evaluatePlayer(i, profile));

  /*
   * Locked players are removed from the optimisation entirely.
   *
   * Once a game has kicked off the decision is gone: a locked starter keeps
   * their slot whatever the numbers now say, and a locked bench player can no
   * longer be moved into one. Ranking them anyway would produce advice the user
   * physically cannot follow, which is worse than saying nothing — so the
   * remaining slots are filled from the players who can still be moved, which
   * is also what makes the board recalculate correctly as each window starts.
   */
  const lockedStarters = evaluations.filter((e) => e.lock.locked && currentStarters.has(e.playerId));
  const lockedIds = new Set(evaluations.filter((e) => e.lock.locked).map((e) => e.playerId));
  const movable = evaluations.filter((e) => !lockedIds.has(e.playerId));

  const scored = movable.filter((e) => e.score != null);
  const undecidable = movable.filter((e) => e.score == null);

  const slots = buildSlots(shape);
  const warnings: string[] = [];
  const notes: string[] = [];

  if (slots.length === 0) {
    return {
      slots: [],
      bench: scored,
      undecidable,
      swaps: [],
      recommendedPoints: 0,
      currentPoints: null,
      confidence: 'low',
      warnings: ['this league has no starting slots the app understands'],
      notes: [],
    };
  }

  // Locked starters hold their slot first; the optimiser then fills what is
  // left from the players who can still be moved.
  const reserved = reserveLockedSlots(lockedStarters, slots);
  const openSlots = slots.map((s, index) => ({ spec: s, index })).filter(({ index }) => !reserved.has(index));
  const openAssignment = assignBest(scored, openSlots.map((o) => o.spec));

  const assignment = new Map<number, StartSitEvaluation>(reserved);
  for (const [openIndex, player] of openAssignment) {
    assignment.set(openSlots[openIndex]!.index, player);
  }

  const filled: LineupSlot[] = slots.map((s, index) => {
    const player = assignment.get(index) ?? null;
    return {
      slot: s.slot,
      accepts: s.accepts,
      playerId: player?.playerId ?? null,
      name: player?.name ?? null,
      position: player?.position ?? null,
      score: player?.score ?? null,
      alreadyStarting: player ? currentStarters.has(player.playerId) : false,
      locked: player ? lockedIds.has(player.playerId) : false,
    };
  });

  const chosenIds = new Set([...assignment.values()].map((e) => e.playerId));
  const bench = scored
    .filter((e) => !chosenIds.has(e.playerId))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));

  const recommendedPoints = round2(
    [...assignment.values()].reduce((total, e) => total + (e.score ?? 0), 0),
  );

  const swaps = buildSwaps(filled, bench, currentStarters, evaluations, minGain);

  // The current total is only meaningful when every current starter could be
  // scored; otherwise the comparison would silently treat unknown as zero.
  const currentEvaluations = evaluations.filter((e) => currentStarters.has(e.playerId));
  const currentScorable = currentEvaluations.every((e) => e.score != null);
  const currentPoints =
    currentStarters.size === 0 || !currentScorable
      ? null
      : round2(currentEvaluations.reduce((total, e) => total + (e.score ?? 0), 0));

  const emptySlots = filled.filter((s) => s.playerId == null);
  if (emptySlots.length > 0) {
    warnings.push(
      `no scorable player available for: ${emptySlots.map((s) => s.slot).join(', ')}`,
    );
  }
  if (undecidable.length > 0) {
    notes.push(
      `${undecidable.length} player(s) could not be scored and were left out of the comparison rather than assumed bad`,
    );
  }
  const startingUndecidable = undecidable.filter((e) => currentStarters.has(e.playerId));
  if (startingUndecidable.length > 0) {
    warnings.push(
      `${startingUndecidable.map((e) => e.name).join(', ')} ${startingUndecidable.length === 1 ? 'is' : 'are'} currently starting but could not be scored — no change is suggested there`,
    );
  }

  if (lockedIds.size > 0) {
    const lockedNames = evaluations.filter((e) => lockedIds.has(e.playerId)).map((e) => e.name);
    notes.push(
      `${lockedNames.join(', ')} ${lockedNames.length === 1 ? 'has' : 'have'} already kicked off. ` +
        `${lockedNames.length === 1 ? 'That spot is' : 'Those spots are'} fixed, and the rest of the lineup is worked out around ${lockedNames.length === 1 ? 'it' : 'them'}.`,
    );
  }

  const chosen = [...assignment.values()];
  const confidence = worstConfidence(chosen);
  for (const e of chosen) {
    if (e.statusFlag) warnings.push(`${e.name} is listed ${e.statusFlag}`);
  }

  return {
    slots: filled,
    bench,
    undecidable,
    swaps,
    recommendedPoints,
    currentPoints,
    confidence,
    warnings,
    notes,
  };
}

interface SlotSpec {
  slot: string;
  accepts: string[];
}

/**
 * Hold a slot for each locked starter.
 *
 * Most specific slot first: a locked running back should occupy RB and leave
 * FLEX open for somebody who can still be moved, rather than taking the slot
 * with the widest eligibility and narrowing everyone else's options.
 */
function reserveLockedSlots(
  lockedStarters: StartSitEvaluation[],
  slots: SlotSpec[],
): Map<number, StartSitEvaluation> {
  const reserved = new Map<number, StartSitEvaluation>();
  const order = [...lockedStarters].sort((a, b) => a.name.localeCompare(b.name));
  for (const player of order) {
    const candidates = slots
      .map((spec, index) => ({ spec, index }))
      .filter(({ spec, index }) => !reserved.has(index) && spec.accepts.includes(player.position))
      .sort((a, b) => a.spec.accepts.length - b.spec.accepts.length || a.index - b.index);
    const pick = candidates[0];
    if (pick) reserved.set(pick.index, player);
  }
  return reserved;
}

function buildSlots(shape: RosterShape): SlotSpec[] {
  const slots: SlotSpec[] = [];
  for (const [position, count] of Object.entries(shape.starters)) {
    for (let i = 0; i < count; i++) slots.push({ slot: position, accepts: [position] });
  }
  for (const f of shape.flex) slots.push({ slot: f.slot, accepts: [...f.positions] });
  return slots;
}

/**
 * Choose the highest-scoring legal set of starters.
 *
 * Players are considered best-first; each is admitted if the whole admitted set
 * can still be assigned to distinct slots, tested by looking for an augmenting
 * path. Sets of simultaneously-assignable players form a transversal matroid,
 * and greedy selection over a matroid is exactly optimal — so this is not a
 * heuristic that "usually" gets the flex right. It is the best lineup, which
 * matters in leagues that mix FLEX (RB/WR/TE) with REC_FLEX (WR/TE), where
 * filling slots naively leaves points on the bench.
 */
function assignBest(
  players: StartSitEvaluation[],
  slots: SlotSpec[],
): Map<number, StartSitEvaluation> {
  const order = [...players].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name),
  );
  // slot index -> player
  const bySlot = new Map<number, StartSitEvaluation>();

  for (const player of order) {
    tryAssign(player, slots, bySlot, new Set<number>());
  }
  return bySlot;
}

function tryAssign(
  player: StartSitEvaluation,
  slots: SlotSpec[],
  bySlot: Map<number, StartSitEvaluation>,
  visited: Set<number>,
): boolean {
  // Prefer a free slot before displacing anyone. Both routes produce a lineup
  // worth the same points, but this one keeps the labels natural: the third
  // running back lands in FLEX instead of shuffling the other two around.
  for (let i = 0; i < slots.length; i++) {
    if (visited.has(i) || bySlot.has(i)) continue;
    if (!slots[i]!.accepts.includes(player.position)) continue;
    visited.add(i);
    bySlot.set(i, player);
    return true;
  }
  for (let i = 0; i < slots.length; i++) {
    if (visited.has(i)) continue;
    if (!slots[i]!.accepts.includes(player.position)) continue;
    visited.add(i);
    const occupant = bySlot.get(i);
    if (!occupant || tryAssign(occupant, slots, bySlot, visited)) {
      bySlot.set(i, player);
      return true;
    }
  }
  return false;
}

/**
 * Describe the difference between the recommended lineup and the current one.
 *
 * Only slots whose recommended player is not already starting produce a swap,
 * and only when the gain clears the threshold — a lineup churned for a tenth of
 * a point is worse advice than leaving it alone.
 */
function buildSwaps(
  filled: LineupSlot[],
  bench: StartSitEvaluation[],
  currentStarters: Set<string>,
  evaluations: StartSitEvaluation[],
  minGain: number,
): LineupSwap[] {
  const byId = new Map(evaluations.map((e) => [e.playerId, e]));
  const recommendedIds = new Set(filled.map((s) => s.playerId).filter((id): id is string => id != null));

  // Anyone starting now who is not in the recommendation is a candidate to sit.
  // Undecidable players are excluded: their score is unknown, so a swap against
  // them would be a guess dressed up as arithmetic.
  const sitting = [...currentStarters]
    .filter((id) => !recommendedIds.has(id))
    .map((id) => byId.get(id))
    .filter((e): e is StartSitEvaluation => e != null && e.score != null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  const swaps: LineupSwap[] = [];
  const used = new Set<string>();

  for (const slot of filled) {
    if (slot.playerId == null || slot.alreadyStarting) continue;
    const incoming = byId.get(slot.playerId);
    if (!incoming) continue;

    const outgoing = sitting.find(
      (e) => !used.has(e.playerId) && slot.accepts.includes(e.position),
    ) ?? sitting.find((e) => !used.has(e.playerId));
    if (!outgoing) continue;

    const gain = round2((incoming.score ?? 0) - (outgoing.score ?? 0));
    if (gain < minGain) continue;
    used.add(outgoing.playerId);

    swaps.push({
      slot: slot.slot,
      inPlayerId: incoming.playerId,
      inName: incoming.name,
      outPlayerId: outgoing.playerId,
      outName: outgoing.name,
      gain,
      reason: swapReason(incoming, outgoing),
    });
  }

  void bench;
  return swaps.sort((a, b) => b.gain - a.gain);
}

function swapReason(incoming: StartSitEvaluation, outgoing: StartSitEvaluation): string {
  if (outgoing.statusFlag) return `${outgoing.name} is listed ${outgoing.statusFlag}`;
  const inNews = incoming.components.find((c) => c.key === 'news_recent');
  const outNews = outgoing.components.find((c) => c.key === 'news_recent');
  if (outNews && !outNews.unknown && outNews.value < 0) {
    return `${outgoing.name} has a negative recent signal (${outNews.display})`;
  }
  if (inNews && !inNews.unknown && inNews.value > 0) {
    return `${incoming.name} has a positive recent signal (${inNews.display})`;
  }
  if (incoming.expectation.points != null && outgoing.expectation.points != null) {
    return `${incoming.name} carries the higher market expectation (${incoming.expectation.points.toFixed(1)} vs ${outgoing.expectation.points.toFixed(1)} pts)`;
  }
  return `${incoming.name} scores higher on the evidence available`;
}

function worstConfidence(evaluations: StartSitEvaluation[]): 'high' | 'medium' | 'low' {
  if (evaluations.length === 0) return 'low';
  if (evaluations.some((e) => e.confidence === 'low')) return 'low';
  if (evaluations.some((e) => e.confidence === 'medium')) return 'medium';
  return 'high';
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
