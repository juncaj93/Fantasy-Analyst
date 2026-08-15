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
import { assessReplacement, type ReplacementAssessment } from './replacement.ts';
import type { StartSitMode } from './mode.ts';

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
  /**
   * The two to four things that decided this player, biggest first.
   *
   * Carried on the slot rather than left in the evaluation because the Team
   * screen draws starters from the slots and never sees the evaluations — and a
   * recommendation whose reasoning is one request away is a recommendation
   * nobody reads.
   */
  drivers: string[];
  /** Where the evidence points different ways, for the same reason. */
  conflicts: string[];
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
  /** Which question this lineup answers. */
  mode: StartSitMode;
  /**
   * Availability risks that depend on the bench rather than on the player.
   *
   * Listed separately from the warnings because they are a different kind of
   * statement: a warning says something is wrong now, and these say what would
   * happen if a coin lands the other way on Sunday morning.
   */
  lateSwapRisks: {
    playerId: string;
    name: string;
    verdict: ReplacementAssessment['verdict'];
    detail: string;
    starting: boolean;
  }[];
}

/** A swap has to be worth this many points before it is worth suggesting. */
export const MIN_SWAP_GAIN = 0.75;

/**
 * How much projection a lineup-level preference may spend.
 *
 * The whole of the second-order reasoning below — correlation in Ceiling,
 * diversification in Floor — is only ever allowed to choose between players who
 * are already within this much of each other. That is what "bounded, and never
 * overpowering player quality" means in code: below the tolerance the players
 * are a coin flip and the shape of the lineup is a reasonable way to break the
 * tie; above it, the better player starts, and no amount of stacking changes
 * that.
 */
export const LINEUP_PREFERENCE_TOLERANCE = 0.6;

export function recommendLineup(
  inputs: StartSitInput[],
  shape: RosterShape,
  profile: ScoringProfile,
  opts: {
    currentStarterIds?: string[];
    minSwapGain?: number;
    /** Floor, Balanced or Ceiling. Applied to every evaluation. */
    mode?: StartSitMode;
    /** Reference time, injected so tests are deterministic. */
    now?: string | Date;
  } = {},
): LineupRecommendation {
  const minGain = opts.minSwapGain ?? MIN_SWAP_GAIN;
  const mode = opts.mode ?? 'balanced';
  const now = opts.now ?? new Date();
  const currentStarters = new Set(opts.currentStarterIds ?? []);
  const evaluations = inputs.map((i) => evaluatePlayer({ ...i, mode: i.mode ?? mode, now: i.now ?? now }, profile));

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
      mode,
      lateSwapRisks: [],
    };
  }

  /*
   * A player who is Out does not go in a starting slot. At all.
   *
   * The availability penalty already made him last by a mile, which is enough
   * when there is anybody else — and is not enough in the case that matters,
   * where a thin bench means the arithmetic still puts him somewhere. "Start
   * your injured-reserve tight end" is not a recommendation, it is a bug, and
   * an empty slot with a warning is the honest version of the same situation.
   *
   * Doubtful is deliberately not gated here: it is a strong penalty and a real
   * decision, and a doubtful player is sometimes genuinely the best available.
   */
  const ruledOut = scored.filter((e) => e.ruledOut);
  const playable = scored.filter((e) => !e.ruledOut);

  /*
   * Availability risk, priced against the bench that would have to cover it.
   *
   * This can only be done here and not in `evaluatePlayer`: whether a
   * questionable player is a problem depends entirely on who else you own and
   * when their games start, and a single-player evaluation cannot see either.
   * Applied before the assignment so the optimiser is choosing between scores
   * that already contain the risk, rather than choosing a lineup and then being
   * told about it.
   */
  const replacementRisk = applyReplacementRisk(playable, slots, now);

  // Locked starters hold their slot first; the optimiser then fills what is
  // left from the players who can still be moved.
  const reserved = reserveLockedSlots(lockedStarters, slots);
  const openSlots = slots.map((s, index) => ({ spec: s, index })).filter(({ index }) => !reserved.has(index));
  const openAssignment = assignBest(playable, openSlots.map((o) => o.spec));

  const assignment = new Map<number, StartSitEvaluation>(reserved);
  for (const [openIndex, player] of openAssignment) {
    assignment.set(openSlots[openIndex]!.index, player);
  }

  /*
   * Two passes over a lineup that is already chosen, in this order.
   *
   * The preference pass may change *who* starts, but only between players
   * inside {@link LINEUP_PREFERENCE_TOLERANCE} of each other. The placement
   * pass never changes who starts at all — it only decides which slot each of
   * them occupies, which is free and is worth real money on a Sunday.
   */
  const preferenceNotes = applyLineupPreferences(assignment, slots, playable, mode, lockedIds);
  const placementNotes = optimiseSlotPlacement(assignment, slots, lockedIds);
  notes.push(...preferenceNotes, ...placementNotes);

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
      drivers: player?.drivers ?? [],
      conflicts: player?.conflicts ?? [],
    };
  });

  const chosenIds = new Set([...assignment.values()].map((e) => e.playerId));
  // The ruled-out stay on the bench list — they are still on the roster, and a
  // player who has silently vanished from the screen is its own confusion.
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
  // Said once, plainly: these were held out of the lineup rather than ranked
  // low in it, and a currently-starting one is a lineup the user should change.
  for (const e of ruledOut) {
    warnings.push(
      `${e.name} is ${e.injury.designation === 'ir' ? 'on injured reserve' : e.injury.designation}` +
        `${currentStarters.has(e.playerId) ? ' and is currently in your lineup' : ''} — not a playable starter`,
    );
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
    mode,
    lateSwapRisks: [...replacementRisk.entries()]
      .filter(([, risk]) => risk.verdict !== 'no_risk' && risk.verdict !== 'covered')
      .map(([playerId, risk]) => ({
        playerId,
        name: evaluations.find((e) => e.playerId === playerId)?.name ?? playerId,
        verdict: risk.verdict,
        detail: risk.display,
        starting: chosenIds.has(playerId),
      }))
      .sort((a, b) => Number(b.starting) - Number(a.starting) || a.name.localeCompare(b.name)),
  };
}

interface SlotSpec {
  slot: string;
  accepts: string[];
}

/**
 * Charge each risky player for the bench that would have to cover him.
 *
 * The alternatives considered are the players who could legally take one of his
 * slots — not the whole roster — because a tight end being questionable is not
 * made safer by owning four running backs.
 *
 * Mutates the evaluations: a component is appended and the score re-summed from
 * the components, so the invariant that a score is the sum of its parts holds
 * afterwards exactly as it did before.
 */
function applyReplacementRisk(
  playable: StartSitEvaluation[],
  slots: SlotSpec[],
  now: string | Date,
): Map<string, ReplacementAssessment> {
  const out = new Map<string, ReplacementAssessment>();

  for (const player of playable) {
    if (!player.availability.risky) continue;
    const eligibleSlots = slots.filter((s) => s.accepts.includes(player.position));
    if (eligibleSlots.length === 0) continue;
    const accepts = new Set(eligibleSlots.flatMap((s) => s.accepts));

    const alternatives = playable
      .filter((e) => e.playerId !== player.playerId && accepts.has(e.position))
      .map((e) => ({ playerId: e.playerId, name: e.name, kickoff: e.lock.kickoff, score: e.score }));

    const assessment = assessReplacement({
      player: {
        name: player.name,
        kickoff: player.lock.kickoff,
        score: player.score,
        availability: player.availability.state,
      },
      alternatives,
      now,
    });
    out.set(player.playerId, assessment);
    if (assessment.points === 0) continue;

    player.components.push({
      key: 'replacement_risk',
      label: 'Cover if he sits',
      display: assessment.display,
      value: assessment.points,
      baseValue: assessment.points,
      modeWeight: 1,
      unknown: false,
    });
    player.score = round2(
      player.components.filter((c) => !c.unknown).reduce((total, c) => total + c.value, 0),
    );
    if (assessment.driver) player.drivers = [assessment.driver, ...player.drivers].slice(0, 4);
  }

  return out;
}

/**
 * Lineup-shaped preferences, worth at most a tie.
 *
 * Ceiling mode likes correlation: a quarterback and one of his own
 * pass-catchers double up on the same touchdown, which is what a week you win
 * by forty looks like. Floor mode likes the opposite — two starters whose
 * afternoon depends on the same game is one weather delay away from a lost
 * week.
 *
 * Both are expressed as the *same* mechanism: consider swapping a starter for a
 * bench player who is within {@link LINEUP_PREFERENCE_TOLERANCE} points, and
 * take the swap only when the shape improves. Nothing here can start a worse
 * player by any margin that matters, and nothing here forces a stack: with no
 * near-equal alternative, no swap happens at all.
 */
function applyLineupPreferences(
  assignment: Map<number, StartSitEvaluation>,
  slots: SlotSpec[],
  playable: StartSitEvaluation[],
  mode: StartSitMode,
  lockedIds: Set<string>,
): string[] {
  if (mode === 'balanced') return [];
  const notes: string[] = [];
  const started = new Set([...assignment.values()].map((e) => e.playerId));
  const bench = playable.filter((e) => !started.has(e.playerId) && !lockedIds.has(e.playerId));
  if (bench.length === 0) return notes;

  for (const [index, current] of [...assignment.entries()]) {
    if (lockedIds.has(current.playerId)) continue;
    const spec = slots[index]!;
    const candidates = bench
      .filter((e) => spec.accepts.includes(e.position))
      .filter((e) => (current.score ?? 0) - (e.score ?? 0) <= LINEUP_PREFERENCE_TOLERANCE)
      .filter((e) => !started.has(e.playerId));
    if (candidates.length === 0) continue;

    const lineup = [...assignment.values()];
    const currentShape = shapeScore(lineup, mode);
    let best: { player: StartSitEvaluation; gain: number } | null = null;

    for (const candidate of candidates) {
      const swapped = lineup.map((e) => (e.playerId === current.playerId ? candidate : e));
      // The projection given up, against the shape gained. Both in points, so
      // the comparison is not between a number and a preference.
      const cost = (current.score ?? 0) - (candidate.score ?? 0);
      const gain = shapeScore(swapped, mode) - currentShape - cost;
      if (gain > 0.01 && (!best || gain > best.gain)) best = { player: candidate, gain: round2(gain) };
    }

    if (best) {
      assignment.set(index, best.player);
      started.delete(current.playerId);
      started.add(best.player.playerId);
      notes.push(
        mode === 'ceiling'
          ? `Ceiling mode: ${best.player.name} starts over ${current.name}, who projects within ${LINEUP_PREFERENCE_TOLERANCE} points, because his game correlates with the rest of the lineup.`
          : `Floor mode: ${best.player.name} starts over ${current.name}, who projects within ${LINEUP_PREFERENCE_TOLERANCE} points, to avoid leaning the lineup on one game.`,
      );
    }
  }
  return notes;
}

/**
 * The shape of a lineup, in points, for the mode being asked about.
 *
 * Ceiling counts quarterback-to-pass-catcher pairs on the same NFL team, and
 * pass-catchers on both sides of one game — the two correlations that
 * genuinely compound. Floor counts the opposite: how concentrated the lineup is
 * in a single game.
 *
 * Deliberately tiny numbers. This is a tie-breaker measured on the same scale
 * as the projection it is competing with, and it is meant to lose every fair
 * fight.
 */
function shapeScore(lineup: StartSitEvaluation[], mode: StartSitMode): number {
  if (mode === 'ceiling') {
    let bonus = 0;
    const quarterbacks = lineup.filter((e) => e.position === 'QB');
    for (const qb of quarterbacks) {
      const catchers = lineup.filter((e) => e.team === qb.team && (e.position === 'WR' || e.position === 'TE'));
      // The first pairing is the one worth having; a third body from the same
      // offence is variance without much extra correlation.
      bonus += Math.min(catchers.length, 2) * 0.25;
      // A pass-catcher on the other side of the quarterback's own game: the
      // shootout case, and worth less than owning both ends of a touchdown.
      const opposing = lineup.filter(
        (e) => qb.opponent != null && e.team === qb.opponent && (e.position === 'WR' || e.position === 'TE'),
      );
      bonus += Math.min(opposing.length, 1) * 0.15;
    }
    return round2(bonus);
  }

  // Floor: a small charge for every starter past the first in one game.
  const perGame = new Map<string, number>();
  for (const player of lineup) {
    const key = gameKey(player);
    if (!key) continue;
    perGame.set(key, (perGame.get(key) ?? 0) + 1);
  }
  let penalty = 0;
  for (const count of perGame.values()) if (count > 2) penalty += (count - 2) * 0.2;
  return round2(-penalty);
}

/** Both teams in one game, in a stable order, so two players match on it. */
function gameKey(player: StartSitEvaluation): string | null {
  if (!player.team || !player.opponent) return null;
  return [player.team, player.opponent].sort().join('@');
}

/**
 * The same starters, in better slots.
 *
 * Once the set of starters is fixed, which slot each occupies is free — and it
 * is not free of consequence. A running back who can only play RB should be in
 * the RB slot, leaving FLEX for somebody with a later kickoff, because a FLEX
 * that still has an option in it at four o'clock is worth having and a FLEX
 * filled by the one o'clock game is not.
 *
 * Only swaps that are legal both ways are considered, so the lineup's points
 * cannot change by a hundredth. Locked players never move.
 */
function optimiseSlotPlacement(
  assignment: Map<number, StartSitEvaluation>,
  slots: SlotSpec[],
  lockedIds: Set<string>,
): string[] {
  const notes: string[] = [];
  const indices = [...assignment.keys()].sort((a, b) => a - b);

  for (const a of indices) {
    for (const b of indices) {
      if (a >= b) continue;
      const playerA = assignment.get(a);
      const playerB = assignment.get(b);
      if (!playerA || !playerB) continue;
      if (lockedIds.has(playerA.playerId) || lockedIds.has(playerB.playerId)) continue;
      const specA = slots[a]!;
      const specB = slots[b]!;
      if (!specA.accepts.includes(playerB.position) || !specB.accepts.includes(playerA.position)) continue;
      // Only ever move optionality from the narrow slot to the wide one.
      if (specA.accepts.length === specB.accepts.length) continue;

      const wide = specA.accepts.length > specB.accepts.length ? a : b;
      const narrow = wide === a ? b : a;
      const inWide = assignment.get(wide)!;
      const inNarrow = assignment.get(narrow)!;
      const wideStart = kickoffMs(inWide);
      const narrowStart = kickoffMs(inNarrow);
      if (wideStart == null || narrowStart == null) continue;
      // The later kickoff belongs in the wider slot: that is the one still
      // worth swapping when the late news lands.
      if (narrowStart <= wideStart) continue;

      assignment.set(wide, inNarrow);
      assignment.set(narrow, inWide);
      notes.push(
        `${inNarrow.name} is placed in ${slots[wide]!.slot} rather than ${slots[narrow]!.slot}: same lineup, ` +
          'and it keeps the later kickoff in the slot with the most options.',
      );
    }
  }
  return notes;
}

function kickoffMs(player: StartSitEvaluation): number | null {
  if (!player.lock.kickoff) return null;
  const value = Date.parse(player.lock.kickoff);
  return Number.isFinite(value) ? value : null;
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
