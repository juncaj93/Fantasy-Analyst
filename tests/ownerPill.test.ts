/**
 * The pill that replaced the heart on a player's card.
 *
 * The heart cycled ♡ → ♥ → ♥♥ → ♥♥♥ and nudged a player up the **draft
 * board**. It was the right control for August; this league drafted months
 * ago, and a thumb-sized target next to Done whose only effect is on a board
 * nobody will open again is the most valuable corner of the card spent on
 * nothing. What a reader asks of a card in October is *can I have him?*
 *
 * Two halves are asserted here and they are different claims:
 *
 *   1. **the wire carries the seat**, from the same map the ownership filter
 *      is already computed from, so the pill costs no read that was not
 *      already being paid for — and Demo Mode answers it identically, because
 *      a demo that disagrees with the app is worse than no demo;
 *   2. **the label rule**, which has three answers and one silence.
 *
 * And the thing that must *not* have changed: the heart's data. Nothing was
 * migrated and nothing was dropped — `/api/players/:id/my-guy` still writes,
 * `myGuy` still rides on every row, and the control is still on the list row.
 * A future draft has to find its board exactly as this one left it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { ownerPillLabel } from '../src/web/playerFilters.ts';
import type { OwnerTeam } from '../src/core/roster/ownership.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const LEAGUE = 'demo-league';
/** Roster 1 is mine; roster 2 is the rival. Seeded by `seedDemoData`. */
const ONE_OF_MINE = '1001';
const THE_RIVALS = '1002';

const TEAMS: OwnerTeam[] = [
  { rosterId: 1, ownerName: 'You', isMine: true },
  { rosterId: 2, ownerName: 'Rival', isMine: false },
];

describe('what the pill says', () => {
  it('names the manager who holds him', () => {
    expect(ownerPillLabel(2, TEAMS)).toBe('Rival');
  });

  it('says You on your own player rather than your own name', () => {
    /*
     * The second person is what a reader is looking for on their own card.
     * Their own manager name is a moment of working out that it means them.
     */
    expect(ownerPillLabel(1, TEAMS)).toBe('You');
  });

  it('says Available for a free agent', () => {
    expect(ownerPillLabel(null, TEAMS)).toBe('Available');
  });

  it('draws nothing at all when no league is selected', () => {
    /*
     * The silence, and it is the important one. Ownership is a fact about a
     * league — `core/roster/ownership.ts` opens with that — so with no league
     * there is no answer. An empty pill would read as "owned by nobody",
     * which is `Available`, which is exactly the claim that cannot be made.
     */
    expect(ownerPillLabel(null, [])).toBeNull();
    expect(ownerPillLabel(undefined, [])).toBeNull();
  });

  it('names a seat by number rather than guessing when the room does not list it', () => {
    // A roster that arrived on the player but not in `teams`: say which seat,
    // never invent whose.
    expect(ownerPillLabel(7, TEAMS)).toBe('Team 7');
  });

  it('names a seat by number when Sleeper never published a manager name', () => {
    const nameless: OwnerTeam[] = [{ rosterId: 3, ownerName: null, isMine: false }];
    expect(ownerPillLabel(3, nameless)).toBe('Team 3');
  });
});

interface PlayersPage {
  players: { id: string; ownerRosterId?: number | null; myGuy?: unknown }[];
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

describe('the seat the pill is drawn from rides on the list', () => {
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

  const find = (page: PlayersPage, id: string) => page.players.find((p) => p.id === id);

  it('gives my own player my roster id', async () => {
    const page = await list(`leagueId=${LEAGUE}&limit=200`);
    expect(find(page, ONE_OF_MINE)?.ownerRosterId).toBe(1);
  });

  it('gives a rival’s player the rival’s roster id', async () => {
    const page = await list(`leagueId=${LEAGUE}&limit=200`);
    expect(find(page, THE_RIVALS)?.ownerRosterId).toBe(2);
  });

  it('gives a free agent null rather than leaving the key off', async () => {
    /*
     * The distinction the screen reads. Null is "nobody has him"; a missing
     * key is "this app was not asked about a league". Only the first is
     * `Available`.
     */
    const page = await list(`leagueId=${LEAGUE}&limit=200`);
    const freeAgent = page.players.find((p) => p.ownerRosterId == null);
    expect(freeAgent, 'the seeded pool holds more players than the two rosters').toBeDefined();
    expect(freeAgent).toHaveProperty('ownerRosterId', null);
  });

  it('leaves the key off entirely when no league was named', async () => {
    const page = await list('limit=5');
    for (const player of page.players) expect(player).not.toHaveProperty('ownerRosterId');
  });

  it('still carries the heart’s own data, which was not migrated or dropped', async () => {
    /*
     * The pill took the heart's *place on one card*, not its feature. The
     * flag still rides on every row, the list row still renders the control,
     * and the write endpoint is untouched — so a future draft finds the board
     * exactly as this one left it.
     */
    const page = await list(`leagueId=${LEAGUE}&limit=200`);
    expect(find(page, ONE_OF_MINE)).toHaveProperty('myGuy');

    // A write is a write, so it needs the session a reader would have.
    const login = await app(
      new Request('https://app.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
      }),
      env,
    );
    const session = login.headers.get('set-cookie')!.split(';')[0]!;

    const wrote = await app(
      new Request(`https://app.test/api/players/${ONE_OF_MINE}/my-guy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: session },
        body: JSON.stringify({ level: 2 }),
      }),
      env,
    );
    expect(wrote.status, 'the heart still writes').toBe(200);

    const after = await list(`leagueId=${LEAGUE}&limit=200`);
    expect((find(after, ONE_OF_MINE)?.myGuy as { level: number }).level).toBe(2);
  });
});
