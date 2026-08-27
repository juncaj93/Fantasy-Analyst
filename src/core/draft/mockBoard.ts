/**
 * One request against a practice draft, start to finish.
 *
 * The state of a mock lives in the reader's browser. It arrives here in the
 * body of a read, an action is applied to it, a board is built from the result,
 * and the new state goes back for the browser to keep. **Nothing is stored on
 * this side of the wire.** That is not an optimisation — it is the isolation
 * requirement, discharged by not having a place to violate it: there is no mock
 * table, so there is nothing for a real read to accidentally join to, nothing
 * for a migration to have to clean up, and nothing that can outlive the
 * rehearsal it belongs to.
 *
 * The whole of the substitution is `mockSources.ts`. Everything downstream —
 * the board assembly, the ranking, the tiers, `Next%`, the survival model, the
 * screens — is the production code path, unmodified and unaware. A mock is a
 * different pick stream, not a different app.
 *
 * Pure, and handed its clock and its randomness. `seed` and `startedAt` come
 * from the caller for the reason everything else in `core/` does: a module that
 * reached for `Date.now()` could not be replayed, and a mock that cannot be
 * replayed cannot produce a support snapshot.
 */

import { buildDraftBoard, type DraftBoardSources, type DraftBoardState } from './boardBuilder.ts';
import {
  advanceMockDraft,
  createMockDraft,
  isMockComplete,
  isMyMockTurn,
  isUsableMockState,
  resetMockDraft,
  slotOnTheClock,
  takeMockPick,
  type MockDraftPick,
  type MockDraftState,
} from './mockDraft.ts';
import { mockCandidatePool, mockDraftBoardSources, readMockRoom } from './mockSources.ts';
import { hashString } from './nextpick/rng.ts';

/**
 * What the reader just did.
 *
 * `start` covers both starting and resetting, deliberately: they are the same
 * act — a new seed and an empty board — and giving them two names would invite
 * a reset that tried to keep something. `resume` is the reload case, where the
 * state is already right and only a board is wanted.
 */
export type MockAction =
  | { kind: 'start'; seed: number; startedAt: string }
  | { kind: 'resume' }
  | { kind: 'take'; playerId: string };

export interface MockBoardRequest {
  draftId: string;
  /** The browser's stored state, or null when there is nothing to resume. */
  state: unknown;
  action: MockAction;
  limit?: number;
  position?: string | null;
  queuedOnly?: boolean;
}

export interface MockBoardResult {
  /** The state to keep. The browser stores exactly this and nothing else. */
  state: MockDraftState;
  board: DraftBoardState;
  /** Whose turn it is now, by seat. Null once the mock is over. */
  onTheClock: number | null;
  yourTurn: boolean;
  complete: boolean;
  /** The picks this request produced, in order. */
  made: MockDraftPick[];
  /** Why a pick was not accepted, or null. The screen shows this. */
  refused: string | null;
  /** The bots' workings. Diagnostics; nothing on screen reads them. */
  notes: string[];
}

/**
 * Apply an action, then build the board the reader should see.
 *
 * The board is built through the mock's sources, so `currentPick`, who is
 * available, the reader's roster, the roster alerts and every survival estimate
 * on it are about the rehearsal. Everything they are computed *from* — the
 * player dictionary, the market, the evidence, the injury states — is the
 * reader's own live data, because a rehearsal against fixtures would be a
 * rehearsal of somebody else's league.
 */
export async function buildMockBoard(
  sources: DraftBoardSources,
  request: MockBoardRequest,
): Promise<MockBoardResult> {
  const { room, myRosterId, myUserId } = await readMockRoom(sources, request.draftId);

  const stored = isUsableMockState(request.state, request.draftId) ? request.state : null;
  const notes: string[] = [];
  let refused: string | null = null;
  let made: MockDraftPick[] = [];

  let state: MockDraftState;
  if (request.action.kind === 'start' || stored == null) {
    /*
     * A missing or unreadable state starts a fresh mock rather than failing.
     *
     * The three ways it can be missing — never started, a version this build
     * does not read, a state filed under another draft — are all one situation
     * from the reader's side, and a mock is a tap to recreate. `isUsableMockState`
     * is where the distinctions live and where they are deliberately collapsed.
     */
    const seed = request.action.kind === 'start' ? request.action.seed : deriveSeed(request.draftId);
    const startedAt = request.action.kind === 'start' ? request.action.startedAt : sources.now().toISOString();
    /*
     * A reset and a first start are the same act, and are written as the same
     * act: same draft, new seed, nothing carried. `resetMockDraft` is the one
     * that says so out loud, and it is reached whenever there was something to
     * reset.
     */
    state = stored
      ? resetMockDraft(stored, seed, startedAt)
      : createMockDraft({ draftId: request.draftId, seed, startedAt });
  } else {
    state = stored;
  }

  /*
   * The pool is read once, before anything is applied.
   *
   * `advanceMockDraft` removes what the rehearsal has taken as it goes, so a
   * pool that was current at the start of the call stays correct through every
   * pick in it — and reading it once is what keeps a request that advances
   * eleven seats to one player-dictionary read rather than eleven.
   */
  const pool = await mockCandidatePool(sources, request.draftId);

  if (request.action.kind === 'take') {
    const taken = takeMockPick(state, room, pool, request.action.playerId);
    state = taken.state;
    made = taken.made;
    refused = taken.refused;
    notes.push(...taken.notes);
  } else {
    /*
     * Run the room up to the reader's turn.
     *
     * On a fresh mock this is what happens between "start" and the reader's
     * first pick; on a resume it is a no-op, because the state was already left
     * on the reader's clock. Either way the invariant the screen relies on is
     * established here: when this function returns, it is the reader's turn or
     * the mock is over.
     */
    const advanced = advanceMockDraft(state, room, pool);
    state = advanced.state;
    made = advanced.made;
    notes.push(...advanced.notes);
  }

  const board = await buildDraftBoard(
    mockDraftBoardSources(sources, state, room, { myRosterId, myUserId }),
    request.draftId,
    {
      ...(request.limit != null ? { limit: request.limit } : {}),
      position: request.position ?? null,
      queuedOnly: request.queuedOnly === true,
    },
  );

  return {
    state,
    board,
    onTheClock: slotOnTheClock(state, room),
    yourTurn: isMyMockTurn(state, room),
    complete: isMockComplete(state, room),
    made,
    refused,
    notes,
  };
}

/**
 * The sources a capture should be taken through, for a mock.
 *
 * Exported rather than folded into `buildMockBoard` because a snapshot is a
 * second, independent read of the same state — `captureDraftSnapshot` builds
 * its own board through a recording proxy, at its own depth, and handing it a
 * board somebody else already built would defeat the recorder that makes a
 * snapshot honest.
 */
export async function mockSnapshotSources(
  sources: DraftBoardSources,
  draftId: string,
  state: MockDraftState,
): Promise<DraftBoardSources> {
  const { room, myRosterId, myUserId } = await readMockRoom(sources, draftId);
  return mockDraftBoardSources(sources, state, room, { myRosterId, myUserId });
}

/**
 * A seed for a mock nobody asked to start.
 *
 * Only reached when a board is asked for with no stored state and no explicit
 * start — a reload against a browser that lost its storage, in practice. Two
 * such recoveries of the same draft produce the same rehearsal, which is the
 * least surprising thing available: the alternative is a clock read inside a
 * pure module.
 */
function deriveSeed(draftId: string): number {
  return hashString(`mock:${draftId}`);
}
