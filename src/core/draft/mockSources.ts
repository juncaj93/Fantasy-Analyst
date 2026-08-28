/**
 * A mock draft, as a third source of facts.
 *
 * `boardBuilder.ts` is handed everything it knows through `DraftBoardSources`,
 * and that is the entire mechanism this lane needed. Live Sleeper is one
 * implementation of that interface; Demo Mode's fixtures are a second; a
 * rehearsal is a third. The board, the grid, the tiers, `Next%`, the survival
 * model and every screen above them are untouched, because from where they sit
 * a mock draft *is* a draft — it just has a different pick stream in it.
 *
 * So there is deliberately no mock ranking, no mock scorer and no second
 * assembly here. This file is a decorator: one method is answered differently
 * and every other read passes straight through to the real sources.
 *
 * ## The one method that changes
 *
 * `leagues.listPicks(draftId)` returns the rehearsal's picks instead of
 * Sleeper's. That single substitution is what makes a player unavailable in a
 * mock, fills the reader's mock roster, moves the pick on the clock, and feeds
 * the survival model a room that is drafting.
 *
 * ## The methods that deliberately do not
 *
 * Everything else — the player dictionary, the ADP snapshots, the newsletter
 * evidence, the injury states, the season markets, the ★ queue — is read from
 * the reader's own live data, because a rehearsal against fixtures would be
 * rehearsing somebody else's league. All of them are reads. `DraftBoardSources`
 * has no write on it, so "a mock cannot change anything through this object" is
 * a property of the type rather than a promise, which is the same argument
 * Demo Mode rests on.
 *
 * ## Isolation
 *
 * The mock's own state never comes from here and never goes back. It arrives
 * from the browser, is used to answer one request, and is dropped. Nothing in
 * this module writes, stores, caches or returns anything a later real read
 * could pick up — see `mockGuard.ts` for the two refusals that hold the rest of
 * the app to the same rule.
 */

import {
  byMarketThenSearch,
  simulationEligible,
  type DraftBoardSources,
} from './boardBuilder.ts';
import { isVoidedByRealPicks, mockPickRecords, type MockDraftState, type MockRoom } from './mockDraft.ts';
import type { MockCandidate } from './mockManager.ts';
import { buildRosterShape, startablePositions } from '../sleeper/scoring.ts';
import type { ManagerTendencies } from '../managers/managerTendencies.ts';

/** Raised when a mock is asked for on a draft that has started for real. */
export class MockDraftVoidError extends Error {
  readonly status = 409;
  constructor(readonly draftId: string) {
    super(
      'The real draft has started, so this mock draft no longer exists. ' +
        'A rehearsal for a draft that is underway would be a second board for the same league, showing different players.',
    );
    this.name = 'MockDraftVoidError';
  }
}

/**
 * Read the room a mock is drafted in, from the reader's own league.
 *
 * Refuses — rather than returning an empty room — when the real draft has made
 * a pick. That is the server half of the lifecycle rule: the browser deletes
 * its stored state when it sees a real pick, and this makes a client that has
 * not noticed yet unable to get a board anyway.
 */
export async function readMockRoom(
  sources: DraftBoardSources,
  draftId: string,
  /**
   * The seat to rehearse from, when the reader has chosen one.
   *
   * Null or absent is the reader's own seat, which is every mock that predates
   * the choice. Out of range is treated as absent rather than refused: a stored
   * state naming seat 14 of a twelve-team league is a league that shrank, and
   * dropping the reader back into their own seat is the answer that still gives
   * them a rehearsal.
   */
  opts: { slot?: number | null } = {},
): Promise<{
  room: MockRoom;
  myRosterId: number | null;
  myUserId: string | null;
  realPicksMade: number;
  /** What `slotToRosterId` the board must be shown, once a seat is chosen. */
  slotToRosterId: Record<string, number> | undefined;
}> {
  const draft = await sources.leagues.getDraft(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  const league = await sources.leagues.getLeague(draft.leagueId);
  if (!league) throw new Error(`league ${draft.leagueId} not found`);

  const realPicks = await sources.leagues.listPicks(draftId);
  const realPicksMade = realPicks.filter((p) => p.playerId).length;
  if (isVoidedByRealPicks(realPicksMade)) throw new MockDraftVoidError(draftId);

  const rosters = await sources.leagues.listRosters(league.id);
  const mine = rosters.find((r) => r.isMine) ?? null;
  const teams = draft.teams || league.totalRosters || 12;
  const realSlot = slotForRoster(draft.slotToRosterId ?? undefined, mine?.rosterId ?? null);

  /*
   * Sitting somewhere else is a swap, not a relabelling.
   *
   * The reader takes the chosen seat and the manager who had it takes the
   * reader's — so the room still has exactly the twelve managers the league
   * has, each of them once, and the draft order screen still names a real
   * person in every chair. Doing it here, on `slotToRosterId`, is what makes
   * everything downstream follow for free: the tendencies below are keyed off
   * this map, `mockPickRecords` files each pick under the roster this map
   * names, and the board's own manager list is built from the same map handed
   * back through `getDraft`. One transform, applied once.
   */
  const chosen =
    opts.slot != null && Number.isInteger(opts.slot) && opts.slot >= 1 && opts.slot <= teams ? opts.slot : null;
  const slotToRosterId = swapSeats(draft.slotToRosterId ?? undefined, realSlot, chosen);
  const mySlot = chosen ?? realSlot;

  /*
   * Tendencies arrive keyed by *current roster id* and are wanted by *seat*.
   *
   * The two are not the same thing and the difference is exactly what
   * `draftProfile.ts` warns about: a roster id is a label on this season's
   * table, and the seat is where the manager is sitting in this draft. The map
   * is turned once, here, so `mockManager.ts` is only ever handed a manager's
   * own history for the manager whose turn it is.
   */
  const byRoster = (await sources.managerTendencies?.(league.id)) ?? new Map<number, ManagerTendencies>();
  const tendenciesBySlot = new Map<number, ManagerTendencies>();
  for (const [rosterId, tendencies] of byRoster) {
    const slot = slotForRoster(slotToRosterId, rosterId);
    if (slot != null) tendenciesBySlot.set(slot, tendencies);
  }

  const room: MockRoom = {
    teams,
    rounds: draft.rounds || 15,
    type: draft.type ?? 'snake',
    ...(slotToRosterId ? { slotToRosterId } : {}),
    mySlot,
    shape: buildRosterShape(league.rosterPositions),
    tendenciesBySlot,
  };

  return {
    room,
    myRosterId: mine?.rosterId ?? null,
    myUserId: mine?.ownerId ?? null,
    realPicksMade,
    slotToRosterId,
  };
}

/**
 * Two seats trade places, or nothing does.
 *
 * A no-op whenever the reader is staying put, whenever their real seat cannot
 * be identified, and whenever the chosen seat is not in the map — the last of
 * which is a league whose `slot_to_roster_id` does not cover every chair, and
 * where inventing an entry would be inventing a manager.
 */
function swapSeats(
  slotToRosterId: Record<string, number> | undefined,
  from: number | null,
  to: number | null,
): Record<string, number> | undefined {
  if (!slotToRosterId || from == null || to == null || from === to) return slotToRosterId;
  const a = slotToRosterId[String(from)];
  const b = slotToRosterId[String(to)];
  if (a == null || b == null) return slotToRosterId;
  return { ...slotToRosterId, [String(from)]: b, [String(to)]: a };
}

/**
 * Everybody a mock can draft, in the market order the bots read.
 *
 * The same pool the survival model already drafts from — `simulationEligible`
 * and `byMarketThenSearch`, both exported by the board for exactly this kind of
 * reuse — so a rehearsal and the `Next%` estimate on the live board disagree
 * about nobody. Notably it is *not* the reader's filtered board: a mock in
 * which the room only drafts quarterbacks because the reader tapped QB would be
 * a different failure with the same shape as the one that comment warns about.
 */
export async function mockCandidatePool(
  sources: DraftBoardSources,
  draftId: string,
): Promise<MockCandidate[]> {
  const draft = await sources.leagues.getDraft(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  const league = await sources.leagues.getLeague(draft.leagueId);
  if (!league) throw new Error(`league ${draft.leagueId} not found`);

  const snapshot = draft.adpSnapshotId
    ? await sources.adp.get(draft.adpSnapshotId)
    : await sources.adp.latestPlatformSnapshot();
  const values = snapshot ? await sources.adp.valuesByPlayer(snapshot.id) : new Map();
  const rankOf = (id: string): number | null => values.get(id)?.adp ?? null;

  /*
   * Taken by the *real* draft, which is empty or the mock would not exist.
   *
   * Read anyway rather than assumed, and through the same rule the board uses —
   * `takenIds` there is the pick stream and nothing else — so the rehearsal
   * cannot end up drafting from a pool the live board would have cut
   * differently. Who is gone in the *mock* is `advanceMockDraft`'s business and
   * is applied per pick, which is what keeps one pool read per request.
   */
  const taken = new Set(
    (await sources.leagues.listPicks(draftId)).map((p) => p.playerId).filter((id): id is string => !!id),
  );
  const startable = startablePositions(buildRosterShape(league.rosterPositions));
  const players = await sources.players.listAll();

  return players
    .filter((p) => simulationEligible(p, taken, startable))
    .sort(byMarketThenSearch((p) => rankOf(p.id)))
    .map((p) => ({ playerId: p.id, position: p.position, marketRank: rankOf(p.id) }));
}

/**
 * The reader's own sources, with the rehearsal's picks in place of Sleeper's.
 *
 * Everything not named here is the same object the live board reads, passed
 * through by reference rather than copied — a mock that quietly served slightly
 * different evidence, injuries or market data would be rehearsing a league that
 * does not exist.
 */
export function mockDraftBoardSources(
  inner: DraftBoardSources,
  state: MockDraftState,
  room: MockRoom,
  ids: {
    myRosterId?: number | null;
    myUserId?: string | null;
    /** The seating the room was built with; see `readMockRoom`. */
    slotToRosterId?: Record<string, number> | undefined;
  } = {},
): DraftBoardSources {
  const records = mockPickRecords(state, room, ids);
  return {
    ...inner,
    leagues: {
      ...inner.leagues,
      /*
       * The substitution, and the whole of it.
       *
       * Scoped to the draft this mock is for. A request for any other draft's
       * picks — which nothing on this path makes, but which a future component
       * might — gets the real answer rather than a rehearsal's, so one league's
       * mock can never be read as another league's draft.
       */
      listPicks: async (id: string) => (id === state.draftId ? records : inner.leagues.listPicks(id)),
      /*
       * The second substitution, and it exists only because a seat can be
       * chosen.
       *
       * The board builds its grid, its manager names and its ownership from the
       * draft's own `slot_to_roster_id`, not from `MockRoom` — so a rehearsal
       * run from seat 7 would have put the reader on the clock at 7 while the
       * board went on drawing them at their real chair. Handing back the same
       * draft with the swapped seating is what keeps the two halves telling one
       * story. It is byte-identical to the real draft whenever no seat was
       * chosen, which is every mock that does not use this feature.
       */
      getDraft: async (id: string) => {
        const draft = await inner.leagues.getDraft(id);
        if (id !== state.draftId || !draft || !ids.slotToRosterId) return draft;
        return { ...draft, slotToRosterId: ids.slotToRosterId };
      },
    },
  };
}

function slotForRoster(slotToRosterId: Record<string, number> | undefined, rosterId: number | null): number | null {
  if (rosterId == null) return null;
  for (const [slot, id] of Object.entries(slotToRosterId ?? {})) {
    if (Number(id) === rosterId) return Number(slot);
  }
  return null;
}
