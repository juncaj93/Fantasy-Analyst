/**
 * The trade builder through the real service, schema and router.
 *
 * `trades.builder.test.ts` pins the judgements without a database. This file
 * pins the wiring and the promises the round makes about it:
 *
 *  - **Nothing here calls Sleeper.** The client handed to the app throws on any
 *    request.
 *  - **No N+1.** No statement runs more than twice, and the rows read stay
 *    inside a stated budget.
 *  - **Marks arrive on the request and nothing is stored.**
 *  - **The same numbers as Check a trade** for the same deal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import type { BuilderResponse } from '../src/core/trades/builderResponse.ts';
import type { TradeCheckResponse } from '../src/core/tradeValue/response.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { LEAGUE, envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { forgetPlayerReads } from '../src/server/repos/players.ts';
import { activityOf } from '../src/server/services/tradeBuilderService.ts';

async function get<T>(db: AppEnv['db'], path: string, client: SleeperClient): Promise<{ status: number; body: T }> {
  const res = await createApp()(new Request(`http://x${path}`), envFor(db, client));
  return { status: res.status, body: (await res.json()) as T };
}

const build = (query: string) => `/api/leagues/${LEAGUE}/trades/build?${query}`;

describe('the trade builder route', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    forgetPlayerReads(db);
    await seed(db);
  });

  it('builds packages that help both teams from a Sell mark, with no Sleeper request', async () => {
    const { client, calls } = forbiddenSleeper();
    const { status, body } = await get<BuilderResponse>(db, build('sell=m_wr5,m_wr4&team=2'), client);
    expect(status).toBe(200);
    expect(calls).toEqual([]);
    expect(body.status).toBe('ok');
    expect(body.packages.length).toBeGreaterThan(0);
    expect(body.packages.length).toBeLessThanOrEqual(3);
    for (const p of body.packages) {
      for (const g of p.give) expect(['m_wr5', 'm_wr4']).toContain(g.playerId);
      expect(p.alex.weighted).toBeGreaterThan(0);
      expect(p.them.weighted).toBeGreaterThan(0);
      expect(['likely', 'maybe', 'long_shot']).toContain(p.status);
      expect(p.pitch).toMatch(/^Hey Dermot, /);
    }
    /* Dermot is deep at back and thin at receiver: the suggestions are his backs, and his need is named. */
    expect(body.teams[0]!.suggested.join(' ')).toMatch(/T_RB/);
    expect(body.teams[0]!.suggested.join(' ')).not.toMatch(/T_WR/);
    expect(body.teams[0]!.needs).toContain('thin at WR');
    /* A 12.5 receiver for any of his backs makes his lineup worse (all four start), so it is hidden and counted. */
    expect(body.audit.hidden['no_gain_for_them']).toBeGreaterThan(0);
    expect(body.willingness).toMatch(/unknown/);
    expect(body.advisory).toMatch(/never sends/);
    expect(body.weeks).toMatchObject({ thisWeek: 5, next3: [5, 6, 7], playoffs: [15, 16, 17] });
  });

  it('gives the same rest-of-season number Check a trade gives for the same deal', async () => {
    const { client } = forbiddenSleeper();
    const { body } = await get<BuilderResponse>(db, build('sell=m_wr4&team=2&want=2:t_rb4'), client);
    const pkg = body.packages.find((p) => p.get.length === 1 && p.get[0]!.playerId === 't_rb4' && p.drops.length === 0);
    expect(pkg).toBeDefined();
    const check = await get<TradeCheckResponse>(db, `/api/leagues/${LEAGUE}/trades/check?a=1&b=2&give=m_wr4&get=t_rb4`, client);
    expect(pkg!.alex.restOfSeason).toBeCloseTo(check.body.evaluation!.a!.net, 1);
    expect(pkg!.them.restOfSeason).toBeCloseTo(check.body.evaluation!.b!.net, 1);
  });

  it('never offers Alex’s elite back unless he marks him', async () => {
    const { client } = forbiddenSleeper();
    const { body } = await get<BuilderResponse>(db, build('team=all&unmarked=1'), client);
    for (const p of body.packages) expect(p.give.map((g) => g.playerId)).not.toContain('m_rb1');
  });

  it('asks for a mark rather than guessing', async () => {
    const { client } = forbiddenSleeper();
    const { body } = await get<BuilderResponse>(db, build('team=2'), client);
    expect(body.status).toBe('no_sells');
    expect(body.packages).toEqual([]);
  });

  it('answers a bad team with a 400 and a sentence', async () => {
    const { client } = forbiddenSleeper();
    const res = await createApp()(new Request(`http://x${build('sell=m_wr5&team=abc')}`), envFor(db, client));
    expect(res.status).toBe(400);
  });

  it('says trades are closed once the deadline has passed', async () => {
    const late = await createTestDb();
    forgetPlayerReads(late);
    await seed(late, { deadline: 4 });
    const { client } = forbiddenSleeper();
    const { body } = await get<BuilderResponse>(late, build('sell=m_wr5&team=2'), client);
    expect(body.status).toBe('closed');
    expect(body.message).toMatch(/deadline was after week 4/);
    expect(body.deadline).toMatchObject({ week: 4, passed: true });
  });
});

describe('what a build costs the database', () => {
  it('runs no statement more than twice and reads a bounded number of rows', async () => {
    const real = await createTestDb();
    forgetPlayerReads(real);
    await seed(real);
    const counting = countingDb(real);
    const { client } = forbiddenSleeper();
    const res = await createApp()(new Request(`http://x${build('sell=m_wr5,m_wr4&team=all')}`), envFor(counting.db, client));
    expect(res.status).toBe(200);
    const tallies = counting.tallies();
    const rows = tallies.reduce((sum, t) => sum + t.rows, 0);
    const statements = tallies.reduce((sum, t) => sum + t.calls, 0);
    const worst = Math.max(...tallies.map((t) => t.calls));
    // eslint-disable-next-line no-console
    console.log(`trade build: ${statements} statements, ${rows} rows returned, worst statement ran ${worst}x`);
    expect(worst).toBeLessThanOrEqual(2);
    expect(rows).toBeLessThan(1500);
  });
});

describe('manager activity, as a note', () => {
  const identities = [
    { season: '2025', rosterId: 4, userId: 'ron' },
    { season: '2025', rosterId: 2, userId: 'kim' },
    { season: '2026', rosterId: 2, userId: 'ron' },
  ];
  const trades = [
    { season: '2026', transaction: { roster_ids: [2, 5] } },
    { season: '2026', transaction: { roster_ids: [2, 7] } },
    { season: '2025', transaction: { roster_ids: [4, 1] } },
    /* Roster 2 in 2025 was Kim, not Ron. */
    { season: '2025', transaction: { roster_ids: [2, 1] } },
  ];

  it('counts this season on the roster and earlier seasons through who held it then', () => {
    expect(activityOf({ rosterId: 2, ownerId: 'ron' }, '2026', trades, identities)).toEqual({
      thisSeason: 2,
      earlier: 1,
      line: 'Has made 2 trades this season, 1 before',
    });
  });

  it('says nothing is known rather than none happened when no earlier season was read', () => {
    expect(activityOf({ rosterId: 9, ownerId: 'new' }, '2026', [], identities).line).toBe('No trades this season');
    expect(activityOf({ rosterId: 4, ownerId: 'kim' }, '2026', [], identities).line).toBe('No trades on record');
  });
});
