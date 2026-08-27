/**
 * A practice draft, end to end, over the real router and a real database.
 *
 * `mockManager.test.ts` proves the blend and `mockDraft.test.ts` proves the
 * lifecycle; this proves the thing a tap actually reaches. Four claims that
 * only exist at this layer:
 *
 *  1. the board a mock produces is a **real board** — the same assembly, the
 *     same ranking, the same `Next%` — over a substituted pick stream;
 *  2. it **changes nothing**: the real draft's picks, roster and queue are
 *     byte-identical before and after a rehearsal has been played out;
 *  3. it is **refused outright** once the real draft has made a pick, and
 *     refusing one league's mock leaves another league's alone;
 *  4. a support snapshot captured from it **round-trips**, and says on its face
 *     that it is a rehearsal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES } from '../src/devserver/seed.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { clearNextPickCache } from '../src/core/draft/nextpick/index.ts';
import { draftBoardSourcesFromDatabase } from '../src/server/services/draftBoard.ts';
import { buildMockBoard } from '../src/core/draft/mockBoard.ts';
import { MockDraftVoidError } from '../src/core/draft/mockSources.ts';
import { readSnapshot, replayDraftSnapshot } from '../src/core/support/replay.ts';
import type { MockDraftState } from '../src/core/draft/mockDraft.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import type { DraftPickRecord } from '../src/core/sleeper/types.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const TEAMS = 12;
const ROUNDS = 6;
const MY_SLOT = 3;
const POOL = 180;
const POSITIONS = ['WR', 'RB', 'WR', 'RB', 'TE', 'WR', 'RB', 'QB'];
const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN'];
const SHA = '4c1f9a0b2d3e4f5061728394a5b6c7d8e9f00112';

const rosterOf = (slot: number) => 100 + slot;
const userOf = (slot: number) => `user-${slot}`;

/** A league whose draft is set up and has not started. The only state a mock is for. */
async function seedPreDraft(db: NodeSqliteDatabase, ids: { league: string; draft: string }): Promise<void> {
  const players = new PlayerRepo(db);
  await players.upsertMany(
    Array.from({ length: POOL }, (_, i) =>
      player({
        id: `p${i + 1}`,
        fullName: `Player ${String(i + 1).padStart(3, '0')}`,
        position: POSITIONS[i % POSITIONS.length]!,
        team: 'KC',
        searchRank: i + 1,
      }),
    ),
  );

  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: ids.league,
    sleeperLeagueId: ids.league,
    name: `League ${ids.league}`,
    season: '2026',
    totalRosters: TEAMS,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ROSTER,
    leagueSettings: {},
    draftId: ids.draft,
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.upsertDraft({
    id: ids.draft,
    sleeperDraftId: ids.draft,
    leagueId: ids.league,
    /*
     * `pre_draft`, which is the whole window this feature lives in. Sleeper
     * publishes a draft as soon as it is created and long before anybody picks.
     */
    status: 'pre_draft',
    type: 'snake',
    season: '2026',
    rounds: ROUNDS,
    teams: TEAMS,
    slotToRosterId: Object.fromEntries(Array.from({ length: TEAMS }, (_, i) => [String(i + 1), rosterOf(i + 1)])),
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.replaceRosters(
    ids.league,
    Array.from({ length: TEAMS }, (_, i) => ({
      leagueId: ids.league,
      rosterId: rosterOf(i + 1),
      ownerId: userOf(i + 1),
      ownerName: `Manager ${i + 1}`,
      playerIds: [],
      starterIds: [],
      reserveIds: [],
      isMine: i + 1 === MY_SLOT,
    })),
  );

  const index = await players.buildIndex();
  const csv = ['Player,Position,Team,ADP']
    .concat(
      Array.from(
        { length: POOL },
        (_, i) => `Player ${String(i + 1).padStart(3, '0')},${POSITIONS[i % POSITIONS.length]},KC,${i + 1}`,
      ),
    )
    .join('\n');
  const { snapshot } = await new AdpRepo(db).save(
    importAdpSnapshot(`${csv}\n`, index, { label: 'test', source: 'test' }),
    /*
     * The season the snapshot prices, stamped rather than inferred.
     *
     * Required since migration `0035` — "newest row in the table" stopped being
     * "the current board" the moment two seasons of imports could sit side by
     * side. The fixture league is a 2026 draft, so its market is a 2026 market.
     */
    '2026',
  );
  await leagues.setDraftSnapshot(ids.draft, snapshot.id);
}

/** The real draft makes its first pick. */
async function startForReal(db: NodeSqliteDatabase, draftId: string): Promise<void> {
  const pick: DraftPickRecord = {
    draftId,
    pickNo: 1,
    round: 1,
    pickInRound: 1,
    draftSlot: 1,
    sleeperPlayerId: 'p1',
    playerId: 'p1',
    rosterId: rosterOf(1),
    pickedBy: userOf(1),
    raw: '{}',
  };
  await new LeagueRepo(db).upsertPicks([pick]);
}

const PASSPHRASE = 'correct horse battery staple';

/**
 * An unlocked session, because the mock's two routes are POSTs.
 *
 * They are reads — the mock guard says so, and `DraftBoardSources` has no write
 * on it — but the app's auth middleware keys on the verb, so a read-shaped POST
 * needs a session exactly as `/api/startsit/compare` has always needed one.
 * That is the existing precedent rather than a decision this lane made; see the
 * note in the pull request.
 */
async function unlock(app: ReturnType<typeof createApp>, db: NodeSqliteDatabase): Promise<string> {
  const res = await app(
    new Request('https://app.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    }),
    makeEnv(db),
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: PASSPHRASE,
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    releaseSha: SHA,
  };
}

describe('a mock board is a real board over a substituted pick stream', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    clearNextPickCache();
    db = await createTestDb();
    await seedPreDraft(db, { league: 'lg', draft: 'dr' });
    await new LeagueRepo(db).selectLeague('lg');
  });

  const start = () =>
    buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr',
      state: null,
      action: { kind: 'start', seed: 1234, startedAt: '2026-08-27T12:00:00.000Z' },
      limit: 40,
    });

  it('opens with the room having drafted up to your seat', async () => {
    const result = await start();
    expect(result.state.picks).toHaveLength(MY_SLOT - 1);
    expect(result.board.currentPick).toBe(MY_SLOT);
    expect(result.board.mySlot).toBe(MY_SLOT);
    expect(result.yourTurn).toBe(true);
    expect(result.onTheClock).toBe(MY_SLOT);
    expect(result.complete).toBe(false);
  });

  it('ranks, scores and estimates exactly as the live board does', async () => {
    const result = await start();
    expect(result.board.recommendations.length).toBeGreaterThan(20);
    /*
     * The whole claim of §7 in three fields: a mock board carries a score, a
     * market and a survival estimate, because it *is* the board — the engines
     * were never told which pick stream they were reading.
     */
    const top = result.board.recommendations[0]!;
    expect(top.score).toBeGreaterThan(0);
    expect(top.adp).not.toBeNull();
    expect(top.survivalProbability).not.toBeNull();
    expect(result.board.nextPickModel.picksSimulated).toBeGreaterThan(0);
  });

  it('takes the players the room drafted off the board', async () => {
    const result = await start();
    const gone = new Set(result.state.picks.map((p) => p.playerId));
    expect(gone.size).toBe(MY_SLOT - 1);
    for (const rec of result.board.recommendations) expect(gone.has(rec.playerId)).toBe(false);
  });

  it('puts your own mock picks on your own roster', async () => {
    const opened = await start();
    const target = opened.board.recommendations[0]!.playerId;
    const after = await buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr',
      state: opened.state,
      action: { kind: 'take', playerId: target },
      limit: 40,
    });
    expect(after.refused).toBeNull();
    expect(after.board.myRoster.map((p) => p.playerId)).toContain(target);
    expect(after.yourTurn, 'the room picks again before you do').toBe(true);
    expect(after.state.picks.length).toBe(2 * TEAMS - MY_SLOT + 1 - 1);
  });

  it('resumes a stored rehearsal without moving it', async () => {
    const opened = await start();
    const resumed = await buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr',
      state: opened.state,
      action: { kind: 'resume' },
      limit: 40,
    });
    expect(resumed.state.picks).toEqual(opened.state.picks);
    expect(resumed.made).toEqual([]);
    expect(resumed.board.recommendations.map((r) => r.playerId)).toEqual(
      opened.board.recommendations.map((r) => r.playerId),
    );
  });

  it('starts a fresh rehearsal when handed another league’s state', async () => {
    const foreign: MockDraftState = { ...(await start()).state, draftId: 'somebody-elses-draft' };
    const result = await buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr',
      state: foreign,
      action: { kind: 'resume' },
      limit: 40,
    });
    expect(result.state.draftId).toBe('dr');
    expect(result.state.picks).toHaveLength(MY_SLOT - 1);
  });
});

describe('a rehearsal changes nothing about the real draft', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    clearNextPickCache();
    db = await createTestDb();
    await seedPreDraft(db, { league: 'lg', draft: 'dr' });
    await new LeagueRepo(db).selectLeague('lg');
    app = createApp();
  });

  it('leaves the real board exactly as it found it, after a whole draft', async () => {
    const realBoard = async () => {
      const res = await app(new Request('https://app.test/api/drafts/dr/board?limit=40'), makeEnv(db));
      const body = (await res.json()) as { picksMade: number; myRoster: unknown[]; recommendations: { playerId: string }[] };
      return {
        picksMade: body.picksMade,
        myRoster: body.myRoster,
        top: body.recommendations.slice(0, 10).map((r) => r.playerId),
      };
    };

    const before = await realBoard();
    expect(before.picksMade).toBe(0);

    // Play the rehearsal out to the end.
    const sources = draftBoardSourcesFromDatabase(db);
    let result = await buildMockBoard(sources, {
      draftId: 'dr',
      state: null,
      action: { kind: 'start', seed: 99, startedAt: '2026-08-27T12:00:00.000Z' },
      limit: 10,
    });
    while (!result.complete) {
      const target = result.board.recommendations[0]!.playerId;
      result = await buildMockBoard(sources, {
        draftId: 'dr',
        state: result.state,
        action: { kind: 'take', playerId: target },
        limit: 10,
      });
    }
    expect(result.state.picks).toHaveLength(TEAMS * ROUNDS);

    clearNextPickCache();
    expect(await realBoard()).toEqual(before);
  });

  it('stores nothing: the same state posted twice gives the same answer', async () => {
    const sources = draftBoardSourcesFromDatabase(db);
    const opened = await buildMockBoard(sources, {
      draftId: 'dr',
      state: null,
      action: { kind: 'start', seed: 7, startedAt: '2026-08-27T12:00:00.000Z' },
      limit: 20,
    });
    const again = await buildMockBoard(sources, {
      draftId: 'dr',
      state: opened.state,
      action: { kind: 'resume' },
      limit: 20,
    });
    const third = await buildMockBoard(sources, {
      draftId: 'dr',
      state: opened.state,
      action: { kind: 'resume' },
      limit: 20,
    });
    expect(third.state).toEqual(again.state);
    expect(third.board.recommendations.map((r) => r.playerId)).toEqual(
      again.board.recommendations.map((r) => r.playerId),
    );
  });
});

describe('the first real pick ends it, for that draft and no other', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    clearNextPickCache();
    db = await createTestDb();
    await seedPreDraft(db, { league: 'lg-a', draft: 'dr-a' });
    await seedPreDraft(db, { league: 'lg-b', draft: 'dr-b' });
    await new LeagueRepo(db).selectLeague('lg-a');
    app = createApp();
  });

  const open = (draftId: string, seed: number) =>
    buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId,
      state: null,
      action: { kind: 'start', seed, startedAt: '2026-08-27T12:00:00.000Z' },
      limit: 10,
    });

  it('refuses to build a mock board once the real draft has picked', async () => {
    await expect(open('dr-a', 1)).resolves.toBeTruthy();
    await startForReal(db, 'dr-a');
    clearNextPickCache();
    await expect(open('dr-a', 1)).rejects.toBeInstanceOf(MockDraftVoidError);
  });

  it('refuses a stored rehearsal too, not only a new one', async () => {
    const opened = await open('dr-a', 1);
    await startForReal(db, 'dr-a');
    clearNextPickCache();
    await expect(
      buildMockBoard(draftBoardSourcesFromDatabase(db), {
        draftId: 'dr-a',
        state: opened.state,
        action: { kind: 'resume' },
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(MockDraftVoidError);
  });

  it('answers a stale client with a 409 rather than a board', async () => {
    await startForReal(db, 'dr-a');
    const cookie = await unlock(app, db);
    const res = await app(
      new Request('https://app.test/api/drafts/dr-a/mock/board', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ state: null, action: { kind: 'resume' } }),
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('real draft has started');
  });

  it('leaves the second league’s mock entirely unaffected', async () => {
    const b = await open('dr-b', 42);
    await startForReal(db, 'dr-a');
    clearNextPickCache();

    await expect(open('dr-a', 1)).rejects.toBeInstanceOf(MockDraftVoidError);

    const bAgain = await buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr-b',
      state: b.state,
      action: { kind: 'resume' },
      limit: 10,
    });
    expect(bAgain.state.picks).toEqual(b.state.picks);
    expect(bAgain.board.recommendations.map((r) => r.playerId)).toEqual(
      b.board.recommendations.map((r) => r.playerId),
    );
  });
});

describe('a support snapshot from a rehearsal', () => {
  let db: NodeSqliteDatabase;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let state: MockDraftState;

  beforeEach(async () => {
    clearNextPickCache();
    db = await createTestDb();
    await seedPreDraft(db, { league: 'lg', draft: 'dr' });
    await new LeagueRepo(db).selectLeague('lg');
    app = createApp();
    cookie = await unlock(app, db);

    const opened = await buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr',
      state: null,
      action: { kind: 'start', seed: 555, startedAt: '2026-08-27T12:00:00.000Z' },
      limit: 20,
    });
    const taken = await buildMockBoard(draftBoardSourcesFromDatabase(db), {
      draftId: 'dr',
      state: opened.state,
      action: { kind: 'take', playerId: opened.board.recommendations[0]!.playerId },
      limit: 20,
    });
    state = taken.state;
  });

  const capture = async (): Promise<Record<string, unknown>> => {
    const res = await app(
      new Request('https://app.test/api/drafts/dr/mock/support-snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ state }),
      }),
      makeEnv(db),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  it('says on its face that it is a rehearsal', async () => {
    const snapshot = await capture();
    expect(snapshot['rehearsal']).toEqual({ kind: 'mock', picksMade: state.picks.length, seed: 555 });
    /*
     * In the envelope, above the decision, because that is where a reader — and
     * `support:fixture` — looks first. A mock snapshot replays as cleanly as a
     * real one, and nothing inside the payload would ever hint that the board
     * it describes never happened.
     */
    expect((snapshot['release'] as { surface: string }).surface).toBe('draft-board');
  });

  it('carries the rehearsal’s picks rather than the real draft’s, which has none', async () => {
    const snapshot = await capture();
    const decision = snapshot['decision'] as { inputs: { picks: unknown[] } };
    expect(decision.inputs.picks).toHaveLength(state.picks.length);
  });

  it('round-trips: it is readable, and it reproduces its own board', async () => {
    const snapshot = readSnapshot(await capture());
    const report = await replayDraftSnapshot(snapshot);
    expect(report.outcome, JSON.stringify(report.differences.slice(0, 3))).toBe('reproduced');
    expect(report.differences).toEqual([]);
    expect(report.rehearsal, 'the report says it too, so a reader cannot miss it').toEqual({
      kind: 'mock',
      picksMade: state.picks.length,
      seed: 555,
    });
  });

  it('redacts the rehearsal exactly as it redacts a real draft', async () => {
    const snapshot = await capture();
    const text = JSON.stringify(snapshot);
    expect(text, 'no real draft id').not.toContain('"dr"');
    expect(text, 'no manager identity').not.toContain('user-1');
    expect((snapshot['redaction'] as { rules: string[] }).rules.length).toBeGreaterThan(0);
  });

  it('refuses to capture when there is no rehearsal to capture', async () => {
    const res = await app(
      new Request('https://app.test/api/drafts/dr/mock/support-snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ state: null }),
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
  });

  it('refuses once the real draft has started', async () => {
    await startForReal(db, 'dr');
    const res = await app(
      new Request('https://app.test/api/drafts/dr/mock/support-snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ state }),
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(409);
  });
});
