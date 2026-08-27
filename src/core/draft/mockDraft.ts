/**
 * A practice draft: its state, its lifecycle, and the one rule that ends it.
 *
 * The whole of Mock Draft's state is the object in this file — a draft id, a
 * seed, and a list of picks. It is small enough to live in the browser, which
 * is the point: **nothing about a rehearsal is stored anywhere the real board
 * can read.** There is no mock table, no mock column, no row keyed to a real
 * draft that a later query might join back in. The one thing the server ever
 * sees is a state posted to it, used to build a board, and forgotten.
 *
 * ## Scoped to one real draft, and keyed like the queue
 *
 * A mock exists for exactly one Sleeper `draft_id`. That is not a detail — it
 * is the lesson of migration `0029`, where a shortlist keyed by player alone
 * turned out to be one global list and a finished draft's queue surfaced in the
 * next league's board. The failure was in the key, so the key is the fix: a
 * mock is filed under the draft it is a rehearsal for, one league's mock cannot
 * be reached from another's, and deleting one leaves the other exactly as it
 * was.
 *
 * ## The moment it stops existing
 *
 * **The first real pick for that `draft_id` deletes the mock outright.** Not
 * archived, not flagged, not greyed out — gone. A rehearsal for a draft that
 * has started is not a rehearsal, it is a second board showing a different set
 * of players for the same league on the one afternoon of the year when
 * confusing those two would be most expensive. `isVoidedByRealPicks` is the
 * rule, stated once, and both the browser and the server apply it — the browser
 * so the state is dropped from storage, the server so it refuses to build a
 * board for a draft that is underway even if a stale client asks.
 *
 * ## Re-runs
 *
 * Unlimited, and a reset is a new seed rather than an edit. There is one active
 * mock per draft at a time and no history of past runs; see
 * `docs/brief/10_MOCK_DRAFT.md` §3, where that is flagged as a recommendation
 * rather than a decision the owner made.
 *
 * Everything here is pure. The seed arrives from the caller for the same reason
 * `sources.now()` does everywhere else in this app: a module that reached for a
 * clock or a random number could not be replayed, and a mock that cannot be
 * replayed cannot produce a support snapshot.
 */

import { buildPickOwnership, type PickOwnership, type TradedPick } from './nextpick/ownership.ts';
import { hashString, mulberry32 } from './nextpick/rng.ts';
import { pickForMockManager, type MockCandidate } from './mockManager.ts';
import type { PositionCounts } from './nextpick/demand.ts';
import type { ManagerTendencies } from '../managers/managerTendencies.ts';
import type { RosterShape } from '../sleeper/scoring.ts';

/** The schema of a stored mock. Bumping it discards states this build cannot read. */
export const MOCK_DRAFT_VERSION = 1;

export interface MockDraftPick {
  pickNo: number;
  /** The seat that made it, after any published trade. */
  slot: number;
  playerId: string;
  /** Whose decision it was. The reader's own picks are the point of the exercise. */
  by: 'you' | 'bot';
}

/**
 * One rehearsal, in full.
 *
 * `seed` is what makes two runs of the same board two different drafts, and
 * what makes one run reproducible from its own state. It is supplied at
 * creation and never changes; a reset produces a new state with a new seed
 * rather than mutating this one.
 */
export interface MockDraftState {
  version: number;
  /** The real Sleeper draft this rehearses. The key, and the whole of the scope. */
  draftId: string;
  seed: number;
  /** ISO-8601, from the caller's clock. Shown as "started at"; never compared. */
  startedAt: string;
  picks: MockDraftPick[];
}

export function createMockDraft(input: { draftId: string; seed: number; startedAt: string }): MockDraftState {
  return {
    version: MOCK_DRAFT_VERSION,
    draftId: input.draftId,
    seed: input.seed >>> 0,
    startedAt: input.startedAt,
    picks: [],
  };
}

/**
 * Is this stored state one this build can use, for this draft?
 *
 * Three ways it is not, and they are deliberately not distinguished to the
 * caller: a version this build does not read, a state for a different draft,
 * and a shape that is not a state at all. All three mean the same thing —
 * start again — and a mock is one tap to recreate.
 */
export function isUsableMockState(value: unknown, draftId: string): value is MockDraftState {
  if (value == null || typeof value !== 'object') return false;
  const state = value as Partial<MockDraftState>;
  return (
    state.version === MOCK_DRAFT_VERSION &&
    state.draftId === draftId &&
    typeof state.seed === 'number' &&
    Array.isArray(state.picks)
  );
}

/**
 * Has the real draft started?
 *
 * The one rule that deletes a mock. `realPicksMade` is the count of picks
 * Sleeper has published for this `draft_id` that actually name a player — an
 * empty slot in the pick list is a draft that has been *set up*, which is the
 * normal state of every draft this feature is for.
 */
export function isVoidedByRealPicks(realPicksMade: number): boolean {
  return realPicksMade > 0;
}

/** Everything the room is, as far as a mock is concerned. */
export interface MockRoom {
  teams: number;
  rounds: number;
  /** `snake` unless the draft is linear. Passed through to `ownership.ts`. */
  type: string;
  slotToRosterId?: Record<string, number>;
  tradedPicks?: TradedPick[];
  /** The reader's own seat. Null means nobody's turn is ever "yours". */
  mySlot: number | null;
  shape: RosterShape;
  /**
   * Each seat's real manager history, by draft slot.
   *
   * A slot with no entry, or one whose tendencies are not `usable`, drafts on
   * ADP and jitter alone. That is the majority of seats in most leagues and it
   * is not a degraded mode — see `mockManager.ts`.
   */
  tendenciesBySlot?: Map<number, ManagerTendencies>;
}

export interface MockAdvance {
  state: MockDraftState;
  /** The picks this call actually made, in order. Empty when nothing moved. */
  made: MockDraftPick[];
  /** Plain sentences about the bots' reasoning. Diagnostics, never user copy. */
  notes: string[];
}

/** The overall pick number the mock is on. One past the picks already made. */
export function currentMockPick(state: MockDraftState): number {
  return state.picks.length + 1;
}

/** Is the mock finished — every seat, every round? */
export function isMockComplete(state: MockDraftState, room: MockRoom): boolean {
  return state.picks.length >= Math.max(0, room.teams * room.rounds);
}

/** Whose turn is it? Null once the mock is over. */
export function slotOnTheClock(state: MockDraftState, room: MockRoom): number | null {
  return ownershipFor(room).ownerAt(currentMockPick(state));
}

/** Is the reader on the clock right now? */
export function isMyMockTurn(state: MockDraftState, room: MockRoom): boolean {
  return room.mySlot != null && slotOnTheClock(state, room) === room.mySlot;
}

/**
 * Run the bots until the reader is on the clock, or the mock is over.
 *
 * Every pick is drawn from a generator seeded by the state and the pick number,
 * so advancing one pick at a time and advancing ten in one call produce
 * identical drafts. That is what lets the board be rebuilt from a stored state
 * on a machine that never ran the simulation — which is the whole of how a mock
 * survives a page reload, and how a support snapshot replays.
 *
 * `pool` is every player who could be taken, priced or not. Players already
 * taken in this mock are removed here rather than by the caller, so a caller
 * cannot get the two lists out of step.
 */
export function advanceMockDraft(state: MockDraftState, room: MockRoom, pool: readonly MockCandidate[]): MockAdvance {
  const ownership = ownershipFor(room);
  const made: MockDraftPick[] = [];
  const notes: string[] = [];

  let picks = state.picks;
  const taken = new Set(picks.map((p) => p.playerId));
  const held = heldBySlot(picks, pool);

  for (;;) {
    const pickNo = picks.length + 1;
    if (pickNo > room.teams * room.rounds) break;
    const slot = ownership.ownerAt(pickNo);
    if (slot == null) break;
    if (room.mySlot != null && slot === room.mySlot) break;

    const available = pool.filter((c) => !taken.has(c.playerId));
    if (available.length === 0) break;

    const chosen = pickForMockManager({
      candidates: available,
      tendencies: room.tendenciesBySlot?.get(slot) ?? null,
      held: held.get(slot) ?? {},
      shape: room.shape,
      draw: drawFor(state.seed, pickNo),
    });
    if (!chosen) break;

    const pick: MockDraftPick = { pickNo, slot, playerId: chosen.playerId, by: 'bot' };
    picks = [...picks, pick];
    made.push(pick);
    taken.add(pick.playerId);
    countTowards(held, slot, positionOf(pool, pick.playerId));
    for (const note of chosen.notes) notes.push(`pick ${pickNo}, slot ${slot}: ${note}`);
  }

  return { state: { ...state, picks }, made, notes };
}

/**
 * The reader takes a player, and the room answers.
 *
 * Refuses rather than reorders when it is not the reader's turn or the player
 * is already gone: a mock that quietly accepted a pick out of turn would be
 * rehearsing a draft that cannot happen. The refusal carries a reason because
 * the screen shows it.
 */
export function takeMockPick(
  state: MockDraftState,
  room: MockRoom,
  pool: readonly MockCandidate[],
  playerId: string,
): MockAdvance & { refused: string | null } {
  const empty = { state, made: [] as MockDraftPick[], notes: [] as string[] };
  if (isMockComplete(state, room)) return { ...empty, refused: 'this mock draft is over' };
  if (!isMyMockTurn(state, room)) return { ...empty, refused: 'it is not your pick' };
  if (state.picks.some((p) => p.playerId === playerId)) {
    return { ...empty, refused: 'that player has already been taken in this mock' };
  }
  if (!pool.some((c) => c.playerId === playerId)) {
    return { ...empty, refused: 'that player is not on this board' };
  }

  const pickNo = currentMockPick(state);
  const mine: MockDraftPick = { pickNo, slot: room.mySlot!, playerId, by: 'you' };
  const withMine: MockDraftState = { ...state, picks: [...state.picks, mine] };
  const advanced = advanceMockDraft(withMine, room, pool);
  return { ...advanced, made: [mine, ...advanced.made], refused: null };
}

/**
 * Start the same rehearsal again, from scratch.
 *
 * A new seed, so it is a different draft rather than a replay of the one just
 * abandoned — which is the only reason anybody resets. Unlimited, per the
 * brief: there is no counter here and nowhere to keep one.
 */
export function resetMockDraft(state: MockDraftState, seed: number, startedAt: string): MockDraftState {
  return createMockDraft({ draftId: state.draftId, seed, startedAt });
}

/**
 * The mock's picks as the pick records a board reads.
 *
 * This is the join between a rehearsal and every engine in the app: the board
 * is handed a pick stream, and it neither knows nor cares that this one was
 * produced by `mockManager.ts` rather than by Sleeper. See `mockSources.ts`.
 *
 * `rosterId` is resolved through the draft's own `slot_to_roster_id` so that
 * the reader's mock picks land on the reader's roster — `liveRoster.ts` matches
 * a pick to a manager by roster id, and a mock whose picks belonged to nobody
 * would show an empty roster beside a full board.
 */
export function mockPickRecords(
  state: MockDraftState,
  room: MockRoom,
  opts: { myRosterId?: number | null; myUserId?: string | null } = {},
): {
  draftId: string;
  pickNo: number;
  round: number;
  pickInRound: number;
  draftSlot: number;
  sleeperPlayerId: string | null;
  playerId: string | null;
  rosterId: number | null;
  pickedBy: string | null;
  raw: string;
}[] {
  const rosterBySlot = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(room.slotToRosterId ?? {})) {
    rosterBySlot.set(Number(slot), Number(rosterId));
  }
  const teams = Math.max(1, room.teams);

  return state.picks.map((pick) => {
    const mine = room.mySlot != null && pick.slot === room.mySlot;
    return {
      draftId: state.draftId,
      pickNo: pick.pickNo,
      round: Math.ceil(pick.pickNo / teams),
      pickInRound: ((pick.pickNo - 1) % teams) + 1,
      draftSlot: pick.slot,
      sleeperPlayerId: null,
      playerId: pick.playerId,
      rosterId: rosterBySlot.get(pick.slot) ?? (mine ? (opts.myRosterId ?? null) : null),
      pickedBy: mine ? (opts.myUserId ?? null) : null,
      /*
       * Named rather than empty.
       *
       * `raw` is Sleeper's own payload everywhere else, and a support snapshot
       * redacts it wholesale. Saying what this is means a file, a log line or a
       * debugger never shows a mock pick that looks like something Sleeper sent.
       */
      raw: JSON.stringify({ mock: true, by: pick.by }),
    };
  });
}

// ------------------------------------------------------------------ internals

function ownershipFor(room: MockRoom): PickOwnership {
  return buildPickOwnership({
    teams: room.teams,
    rounds: room.rounds,
    type: room.type,
    ...(room.slotToRosterId ? { slotToRosterId: room.slotToRosterId } : {}),
    ...(room.tradedPicks ? { tradedPicks: room.tradedPicks } : {}),
  });
}

/**
 * The draw for one pick.
 *
 * Seeded by the mock and the pick number together, so the tenth pick of a mock
 * draws the same number whether it was reached in one call or in ten. See
 * `nextpick/rng.ts` — `Math.random` is never called in this feature either.
 */
function drawFor(seed: number, pickNo: number): number {
  return mulberry32(hashString(`${seed}:${pickNo}`))();
}

function positionOf(pool: readonly MockCandidate[], playerId: string): string {
  return pool.find((c) => c.playerId === playerId)?.position ?? '';
}

function heldBySlot(picks: readonly MockDraftPick[], pool: readonly MockCandidate[]): Map<number, PositionCounts> {
  const byId = new Map(pool.map((c) => [c.playerId, c.position]));
  const out = new Map<number, PositionCounts>();
  for (const pick of picks) countTowards(out, pick.slot, byId.get(pick.playerId) ?? '');
  return out;
}

function countTowards(held: Map<number, PositionCounts>, slot: number, position: string): void {
  if (!position) return;
  const counts = held.get(slot) ?? {};
  counts[position] = (counts[position] ?? 0) + 1;
  held.set(slot, counts);
}
