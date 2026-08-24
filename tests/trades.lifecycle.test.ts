/**
 * Smart Bilateral Trades across a league's actual lifecycle.
 *
 * The question this file exists to answer is not "does the engine work" —
 * `trades.bilateral.test.ts` covers that — but **"does it switch itself on?"**
 *
 * A feature that needs somebody to press something after a draft is a feature
 * that is off. So the sequence below is driven entirely through the paths a
 * normal user already travels: a league is synced, a draft is polled, the draft
 * finishes, a trade happens. **No Smart Trades method is called to activate
 * anything**, and the only Smart Trades call anywhere is a read of the board.
 *
 * The activation is not new machinery, and that is the point of testing it here
 * rather than building it. `SleeperSyncService.adoptCompletedDraftRosters`
 * already re-reads a league's rosters the moment a draft is seen complete —
 * written as a state check rather than an edge, so it heals on any later sync
 * too — and `SmartTradeService` reads `listRosters` on every request. Those two
 * facts compose into automatic activation, and these tests hold them together
 * so a change to either end cannot quietly break it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { MOCK_GAMES } from '../src/devserver/seed.ts';
import { SmartTradeService } from '../src/server/services/smartTradeService.ts';
import { SleeperSyncService } from '../src/server/services/sleeperSync.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { player } from './helpers/players.ts';
import { createTestDb } from './helpers/db.ts';

const LEAGUE = 'lifecycle-league';
const DRAFT = 'lifecycle-draft';
const ME = 'me-user';
const THEM = 'them-user';
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];

/** My squad: deep at receiver, a hole at the second running back. */
const MINE: [id: string, position: string, points: number][] = [
  ['m_qb', 'QB', 18],
  ['m_rb1', 'RB', 14],
  ['m_rb2', 'RB', 3],
  ['m_wr1', 'WR', 16],
  ['m_wr2', 'WR', 15],
  ['m_wr3', 'WR', 14],
  ['m_wr4', 'WR', 13],
  ['m_wr5', 'WR', 12],
  ['m_te', 'TE', 9],
];

/** Theirs: the mirror image. Backs to spare, nothing at receiver. */
const THEIRS: [id: string, position: string, points: number][] = [
  ['t_qb', 'QB', 17],
  ['t_rb1', 'RB', 15],
  ['t_rb2', 'RB', 14],
  ['t_rb3', 'RB', 13],
  ['t_rb4', 'RB', 12],
  ['t_wr1', 'WR', 4],
  ['t_wr2', 'WR', 3],
  ['t_te', 'TE', 8],
];

const ALL = [...MINE, ...THEIRS];

/**
 * A Sleeper that answers from a script and counts what it was asked.
 *
 * The counter is load-bearing twice over: it proves the read path adds no
 * requests, and it proves the *sync* path is the only thing that ever talks to
 * Sleeper — which is the whole shape of the activation being tested.
 */
function scriptedSleeper(state: { drafted: boolean; bestBall?: boolean; rosters?: () => unknown[] }) {
  const calls: string[] = [];
  const users = [
    { user_id: ME, display_name: 'You' },
    { user_id: THEM, display_name: 'Dermot' },
  ];

  const rosterPayload = () =>
    state.rosters?.() ?? [
      {
        roster_id: 1,
        owner_id: ME,
        players: state.drafted ? MINE.map((p) => p[0]) : [],
        starters: [],
        reserve: [],
        settings: {},
      },
      {
        roster_id: 2,
        owner_id: THEM,
        players: state.drafted ? THEIRS.map((p) => p[0]) : [],
        starters: [],
        reserve: [],
        settings: {},
      },
    ];

  const league = () => ({
    league_id: LEAGUE,
    name: 'Lifecycle League',
    season: '2026',
    total_rosters: 2,
    scoring_settings: { rec: 0.5, rec_yd: 0.1, pass_yd: 0.04, rush_yd: 0.1, pass_td: 4, rush_td: 6, rec_td: 6 },
    roster_positions: POSITIONS,
    settings: state.bestBall ? { best_ball: 1, playoff_week_start: 15 } : { playoff_week_start: 15 },
    draft_id: DRAFT,
    status: state.drafted ? 'in_season' : 'pre_draft',
    previous_league_id: null,
  });

  const draft = () => ({
    draft_id: DRAFT,
    league_id: LEAGUE,
    season: '2026',
    status: state.drafted ? 'complete' : 'pre_draft',
    settings: { teams: 2, rounds: 9 },
    metadata: {},
  });

  const client = new SleeperClient({
    fetch: async (url: string) => {
      calls.push(url);
      const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.endsWith(`/league/${LEAGUE}/rosters`)) return body(rosterPayload());
      if (url.endsWith(`/league/${LEAGUE}/users`)) return body(users);
      if (url.endsWith(`/league/${LEAGUE}/drafts`)) return body([draft()]);
      if (url.endsWith(`/league/${LEAGUE}`)) return body(league());
      if (url.endsWith(`/draft/${DRAFT}/picks`)) return body([]);
      if (url.endsWith(`/draft/${DRAFT}`)) return body(draft());
      if (url.includes('/state/nfl')) return body({ season: '2026', week: 1, season_type: 'regular' });
      return body(null);
    },
  });

  return { client, calls, state };
}

/**
 * Everything except the rosters: players, prices, the identified user.
 *
 * The rosters are deliberately left to the sync path, because "who is on which
 * roster" is exactly the state whose arrival this file is about.
 */
async function seedWorld(db: NodeSqliteDatabase): Promise<void> {
  await new PlayerRepo(db).upsertMany(
    ALL.map(([id, position]) => player({ id, fullName: id.toUpperCase(), position, team: 'NE' })),
  );

  const props: PlayerProp[] = ALL.map(([id, position, points]) => ({
    playerId: id,
    sourcePlayerName: id.toUpperCase(),
    market: position === 'QB' ? 'pass_yards' : 'receiving_yards',
    line: position === 'QB' ? points / 0.04 : points * 10,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: null,
  }));

  const repo = new PropsRepo(db);
  const fetchedAt = '2026-09-10T12:00:00.000Z';
  await repo.put({
    provider: 'lifecycle',
    eventId: 'e1',
    gameStart: '2026-09-13T17:00:00.000Z',
    fetchedAt,
    raw: { provider: 'lifecycle', eventId: 'e1', gameStart: '2026-09-13T17:00:00.000Z', fetchedAt, quotes: [], raw: null },
  });
  const snapshotId = await repo.snapshotId('lifecycle', 'e1', fetchedAt);
  if (snapshotId != null) await repo.saveConsensus(snapshotId, props);

  // The app knows which Sleeper user is the reader; that is what sets `isMine`.
  await new SettingsRepo(db).set(SETTING_KEYS.sleeperUser, {
    userId: ME,
    username: 'me',
    displayName: 'You',
  });
}

function env(db: NodeSqliteDatabase, sleeper: SleeperClient): AppEnv {
  return { db, sleeper, vegas: new MockVegasProvider(MOCK_GAMES), disableAuth: true };
}

describe('the league lifecycle, driven only through the sync paths', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedWorld(db);
  });

  it('says nothing, honestly, before the draft — and says it is about the draft', async () => {
    const sleeper = scriptedSleeper({ drafted: false });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    const board = await new SmartTradeService(db).build();

    expect(board.found).toBe(false);
    expect(board.offers).toEqual([]);
    /*
     * The wording is the assertion. A pre-draft league must not be told the
     * same thing as a league whose format has no trading — one of those
     * resolves itself on a date and the other never does.
     */
    expect(board.notes.join(' ')).toMatch(/draft/i);
    expect(board.capability.tradeable).toBe(true);
  });

  it('activates on its own when the draft completes, with no Smart Trades call in between', async () => {
    const sleeper = scriptedSleeper({ drafted: false });
    const sync = new SleeperSyncService(db, sleeper.client);

    await sync.syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);
    expect((await new SmartTradeService(db).build()).offers).toEqual([]);

    /*
     * The draft ends on Sleeper, and the app finds out the way it always does:
     * the Draft screen's poll. Nothing here mentions trades.
     */
    sleeper.state.drafted = true;
    const result = await sync.syncDraft(DRAFT);

    expect(result.status).toBe('complete');
    // The self-healing roster adoption is what carries the state across.
    expect(result.rostersAdopted).toBe(true);

    const board = await new SmartTradeService(db).build();
    expect(board.found).toBe(true);
    expect(board.offers.length).toBeGreaterThan(0);
  });

  it('offers the trade the two rosters actually imply', async () => {
    const sleeper = scriptedSleeper({ drafted: true });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    const board = await new SmartTradeService(db).build();
    const best = board.offers[0];

    expect(best).toBeDefined();
    // Receiver depth out, running back in — the shape both rosters are short of.
    expect(best!.give.some((p) => p.position === 'WR')).toBe(true);
    expect(best!.get.some((p) => p.position === 'RB')).toBe(true);
    expect(best!.user.starterGain).toBeGreaterThan(0);
  });

  it('picks up a later roster change through the ordinary sync, with no cache to clear', async () => {
    const sleeper = scriptedSleeper({ drafted: true });
    const sync = new SleeperSyncService(db, sleeper.client);
    await sync.syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    const before = await new SmartTradeService(db).build();
    const targeted = before.offers[0]?.get[0]?.playerId;
    expect(targeted).toBeDefined();

    /*
     * The player this board wanted leaves that roster — a trade, a drop, a
     * waiver claim; the app cannot tell and does not need to. Sleeper reports
     * the new squads and `syncLeague` replaces the rows wholesale.
     */
    sleeper.state.rosters = () => [
      { roster_id: 1, owner_id: ME, players: MINE.map((p) => p[0]), starters: [], reserve: [], settings: {} },
      {
        roster_id: 2,
        owner_id: THEM,
        players: THEIRS.map((p) => p[0]).filter((id) => id !== targeted),
        starters: [],
        reserve: [],
        settings: {},
      },
    ];
    await sync.syncLeague(LEAGUE);

    const after = await new SmartTradeService(db).build();
    // Nobody can be offered a player his manager no longer holds.
    expect(after.offers.some((o) => o.get.some((p) => p.playerId === targeted))).toBe(false);
  });
});

describe('formats that cannot trade', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedWorld(db);
  });

  it('stays empty in a fully drafted best-ball league, for a format reason', async () => {
    /*
     * The control the empty-roster path cannot provide: rosters are *full*, so
     * "nobody has any players" is unavailable as an excuse. The only thing that
     * can produce silence here is the format itself.
     */
    const sleeper = scriptedSleeper({ drafted: true, bestBall: true });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    const rosters = await new LeagueRepo(db).listRosters(LEAGUE);
    expect(rosters.every((r) => r.playerIds.length > 0)).toBe(true);

    const board = await new SmartTradeService(db).build();
    expect(board.found).toBe(false);
    expect(board.offers).toEqual([]);
    expect(board.capability.tradeable).toBe(false);
    expect(board.capability.basis).toBe('best_ball');
    expect(board.notes.join(' ')).toMatch(/best-ball/i);
    // And emphatically not the pre-draft sentence.
    expect(board.notes.join(' ')).not.toMatch(/draft/i);
  });

  it('stays empty when the commissioner has switched trading off', async () => {
    const sleeper = scriptedSleeper({ drafted: true });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    const leagues = new LeagueRepo(db);
    await leagues.selectLeague(LEAGUE);

    const league = (await leagues.getLeague(LEAGUE))!;
    await leagues.upsertLeague({ ...league, leagueSettings: { ...league.leagueSettings, disable_trades: 1 } });

    const board = await new SmartTradeService(db).build();
    expect(board.capability.tradeable).toBe(false);
    expect(board.capability.basis).toBe('trades_disabled');
    expect(board.offers).toEqual([]);
  });
});

describe('the history block tells the truth about itself', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedWorld(db);
  });

  it('reports the ledger as unmeasured only when there is no league to measure', async () => {
    const board = await new SmartTradeService(await createTestDb()).build();

    expect(board.league).toBeNull();
    expect(board.history.measured).toBe(false);
  });

  it('reports the ledger as read on every exit that has a league — pre-draft included', async () => {
    /*
     * The regression this pins. These paths used to return a hardcoded
     * `profiles: 0` before opening the ledger, and the production probe printed
     * it as a fact about a league holding eight profiles.
     */
    const sleeper = scriptedSleeper({ drafted: false });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    const board = await new SmartTradeService(db).build();
    expect(board.offers).toEqual([]);
    expect(board.history.measured).toBe(true);
  });

  it('reports it as read for a best-ball league too', async () => {
    const sleeper = scriptedSleeper({ drafted: true, bestBall: true });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    expect((await new SmartTradeService(db).build()).history.measured).toBe(true);
  });

  it('still produces offers with no history at all, contributing exactly zero', async () => {
    const sleeper = scriptedSleeper({ drafted: true });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    const board = await new SmartTradeService(db).build();
    expect(board.history.profiles).toBe(0);
    expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.managerFit.activity).toBe('unknown');
      expect(offer.managerFit.contribution).toBe(0);
    }
  });
});

describe('the read path never talks to Sleeper', () => {
  it('adds no requests once the league is drafted and synced', async () => {
    const db = await createTestDb();
    await seedWorld(db);

    const sleeper = scriptedSleeper({ drafted: true });
    await new SleeperSyncService(db, sleeper.client).syncLeague(LEAGUE);
    await new LeagueRepo(db).selectLeague(LEAGUE);

    /*
     * Everything up to here was allowed to fetch — that is the sync path doing
     * its job. From this line on, nothing may.
     */
    sleeper.calls.length = 0;
    const app = createApp();
    const appEnv = env(db, sleeper.client);

    const board = await app(new Request('http://x/api/trades/smart'), appEnv);
    const detail = await app(new Request('http://x/api/diagnostics/smart-trades'), appEnv);

    expect(board.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(sleeper.calls).toEqual([]);

    // And the board it produced was a real one, not an error shaped like a board.
    expect((await board.json()).offers.length).toBeGreaterThan(0);
  });
});
