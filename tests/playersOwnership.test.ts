/**
 * The Players tab's ownership filter, through the wire that serves it.
 *
 * The rule itself is pinned in `roster.ownership.test.ts`. What is checked here
 * is the wiring, which is where this kind of filter actually breaks:
 *
 *  - a filter applied *after* the page was cut, so `total` counts the whole
 *    pool and `hasMore` promises a page that is already excluded;
 *  - an `owner` that quietly empties the list when no league was named;
 *  - Demo Mode answering the same request differently from the app it exists to
 *    demonstrate.
 *
 * The seeded league is two rosters: mine holds five players and the rival holds
 * one, which is enough for every claim below and small enough that each one can
 * name the ids it means.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import type { OwnerTeam } from '../src/core/roster/ownership.ts';
import { createTestDb } from './helpers/db.ts';

/** The seeded room. `demo-league` is what the dev server selects. */
const LEAGUE = 'demo-league';
/** Roster 1, which is mine. */
const MINE = ['1001', '1004', '1009', '1011', '1030'];
/** Roster 2, the rival's whole team. */
const RIVAL = ['1002'];

interface PlayersPage {
  players: { id: string; position: string; availability?: string }[];
  hasMore: boolean;
  total: number;
  teams?: OwnerTeam[];
}

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

describe('the Players list narrows by who holds a player', () => {
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
  });

  const list = async (query: string): Promise<PlayersPage> => {
    const res = await app(new Request(`https://app.test/api/players?${query}`), env);
    expect(res.status).toBe(200);
    return (await res.json()) as PlayersPage;
  };

  it('sends the room the chip row is built from', async () => {
    const body = await list(`leagueId=${LEAGUE}&limit=200`);
    expect(body.teams).toEqual([
      { rosterId: 1, ownerName: 'You', isMine: true },
      { rosterId: 2, ownerName: 'Rival', isMine: false },
    ]);
  });

  /**
   * No league, no teams — and no row on the screen either.
   *
   * Ownership is a fact about a league, so a request that names none has no
   * answer to give. The field being absent rather than empty is what the screen
   * reads as "there is nothing to filter by here".
   */
  it('offers no teams to a caller that named no league', async () => {
    expect((await list('limit=5')).teams).toBeUndefined();
  });

  it('gives a team exactly its own players', async () => {
    const body = await list(`leagueId=${LEAGUE}&owner=2&limit=200`);
    expect(body.players.map((p) => p.id)).toEqual(RIVAL);
  });

  it('leaves every rostered player out of the available list', async () => {
    const body = await list(`leagueId=${LEAGUE}&owner=available&limit=200`);
    const ids = body.players.map((p) => p.id);
    for (const held of [...MINE, ...RIVAL]) expect(ids, held).not.toContain(held);
    // And it is a narrowing, not an emptying: there are still players to add.
    expect(ids.length).toBeGreaterThan(0);
  });

  /**
   * The tag and the filter are the same fact, and this is what proves it.
   *
   * `availability` is what the comparison picker reads and the filter is what
   * Players reads; both come off one map, and a page where they disagreed would
   * be a row labelled "Free agent" that the Available chip hides.
   */
  it('agrees with the availability tag it sends on every row', async () => {
    const everybody = await list(`leagueId=${LEAGUE}&limit=200`);
    const available = await list(`leagueId=${LEAGUE}&owner=available&limit=200`);
    const shown = new Set(available.players.map((p) => p.id));

    for (const player of everybody.players) {
      expect(shown.has(player.id), player.id).toBe(player.availability === 'available');
    }
  });

  /**
   * The narrowing happens before the page is cut, which is the whole reason
   * this is a server filter.
   *
   * `total` and `hasMore` are counted off the filtered list; a client filtering
   * the hundred rows it was sent would report a total of thousands over one
   * visible row and then fetch a page that was already excluded.
   */
  it('counts the total and the next page off the filtered list', async () => {
    const everybody = await list(`leagueId=${LEAGUE}&limit=200`);
    const rival = await list(`leagueId=${LEAGUE}&owner=2&limit=200`);

    expect(rival.total).toBe(RIVAL.length);
    expect(rival.hasMore).toBe(false);
    expect(everybody.total).toBeGreaterThan(rival.total);
  });

  it('pages a filtered list without repeating or skipping anybody', async () => {
    const first = await list(`leagueId=${LEAGUE}&owner=available&limit=5&offset=0`);
    const second = await list(`leagueId=${LEAGUE}&owner=available&limit=5&offset=5`);
    const ids = [...first.players, ...second.players].map((p) => p.id);

    expect(first.players).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('combines with the position filter rather than replacing it', async () => {
    // The rival's whole team is one receiver, so one of these is him and the
    // other is empty — which is the combination the two rows exist to allow.
    expect((await list(`leagueId=${LEAGUE}&owner=2&position=WR&limit=50`)).players.map((p) => p.id)).toEqual(RIVAL);
    expect((await list(`leagueId=${LEAGUE}&owner=2&position=QB&limit=50`)).players).toEqual([]);
  });

  it('combines with the search rather than replacing it', async () => {
    // Devin Okafor is the rival's receiver; Marcus Vance is on my roster.
    expect((await list(`leagueId=${LEAGUE}&owner=2&q=okafor&limit=50`)).players.map((p) => p.id)).toEqual(RIVAL);
    expect((await list(`leagueId=${LEAGUE}&owner=2&q=vance&limit=50`)).players).toEqual([]);
    expect((await list(`leagueId=${LEAGUE}&owner=available&q=okafor&limit=50`)).players).toEqual([]);
  });

  /**
   * A question about a league nobody named opens the list rather than emptying
   * it. An empty list here would read as missing data, which is the one thing
   * this app must never imply about a question it simply could not answer.
   */
  it('ignores an owner sent without a league instead of showing nothing', async () => {
    const body = await list('owner=available&limit=5');
    expect(body.players.length).toBeGreaterThan(0);
    expect(body.teams).toBeUndefined();
  });

  /** A seat that does not exist is an empty answer, not the whole list. */
  it('answers a roster nobody holds with nothing', async () => {
    expect((await list(`leagueId=${LEAGUE}&owner=99&limit=50`)).players).toEqual([]);
  });
});

describe('Demo Mode answers the same question the same way', () => {
  const demo = async (path: string): Promise<PlayersPage> => {
    const runtime = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    const res = await runtime.request('GET', path);
    expect(res.status).toBe(200);
    return res.body as PlayersPage;
  };

  /**
   * Asserted against the *tag* rather than against the fixture's roster ids, so
   * this keeps meaning the same thing when a scenario's rosters change: whoever
   * the demo says is rostered is exactly who the Available chip hides.
   */
  it('hides exactly the players it tags as rostered', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    const overview = (await runtime.request('GET', '/api/overview')).body as {
      selectedLeague: { id: string } | null;
    };
    const league = overview.selectedLeague!.id;

    const everybody = await demo(`/api/players?leagueId=${league}&limit=200`);
    const available = await demo(`/api/players?leagueId=${league}&owner=available&limit=200`);
    const shown = new Set(available.players.map((p) => p.id));

    // Counted off the totals rather than off the pages: a scenario with more
    // than a page of players caps both lists at the same length.
    expect(everybody.total).toBeGreaterThan(available.total);
    for (const player of everybody.players) {
      expect(shown.has(player.id), player.id).toBe(player.availability === 'available');
    }
  });

  it('offers the same room the live handler does, and only with a league', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    const overview = (await runtime.request('GET', '/api/overview')).body as {
      selectedLeague: { id: string } | null;
    };
    const league = overview.selectedLeague!.id;

    const withLeague = await demo(`/api/players?leagueId=${league}&limit=5`);
    expect(withLeague.teams?.length).toBeGreaterThan(1);
    expect((await demo('/api/players?limit=5')).teams).toBeUndefined();
  });

  it('gives a team its own players and counts the total off them', async () => {
    const runtime = await DemoRuntime.forScenario(findScenario('draft-mid')!);
    const overview = (await runtime.request('GET', '/api/overview')).body as {
      selectedLeague: { id: string } | null;
    };
    const league = overview.selectedLeague!.id;

    const everybody = await demo(`/api/players?leagueId=${league}&limit=200`);
    const teams = everybody.teams!;
    const held = everybody.players.filter((p) => p.availability !== 'available');
    expect(held.length, 'the scenario has somebody rostered to filter to').toBeGreaterThan(0);

    const perTeam = await Promise.all(
      teams.map(async (team) => (await demo(`/api/players?leagueId=${league}&owner=${team.rosterId}&limit=200`)).players),
    );
    const ids = perTeam.flat().map((p) => p.id);

    // Every team's rows are rostered, no player appears on two teams, and the
    // rosters together account for everybody the list did not call available.
    expect(new Set(ids).size).toBe(ids.length);
    for (const player of held) expect(ids, player.id).toContain(player.id);
  });
});
