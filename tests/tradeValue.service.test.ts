/**
 * The trade check through the real service, schema and router.
 *
 * `tradeValue.model.test.ts` pins the judgements without a database. This file
 * pins the wiring and three promises the brief makes about it:
 *
 *  - **Nothing here calls Sleeper.** The client handed to the app throws on any
 *    request.
 *  - **No N+1.** No statement runs more than a couple of times, whatever the size
 *    of the rosters, and the rows read stay inside a stated budget.
 *  - **Plain answers to bad input.** A roster that does not exist, a player who
 *    is on the other team, an empty trade: a 400 with a sentence, never a 500.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SettingsRepo, SETTING_KEYS } from '../src/server/repos/settings.ts';
import { TransactionRepo } from '../src/server/repos/transactions.ts';
import type { TradeCheckResponse, TradeReplayResponse, TradeTeamsResponse } from '../src/core/tradeValue/response.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { FETCHED_AT, LEAGUE, envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { countingDb } from './helpers/countingDb.ts';
import { forgetPlayerReads } from '../src/server/repos/players.ts';

async function get<T>(db: AppEnv['db'], path: string, client: SleeperClient): Promise<{ status: number; body: T }> {
  const res = await createApp()(new Request(`http://x${path}`), envFor(db, client));
  return { status: res.status, body: (await res.json()) as T };
}

const q = (a: number, b: number, give: string[], take: string[]) =>
  `/api/leagues/${LEAGUE}/trades/check?a=${a}&b=${b}&give=${give.join(',')}&get=${take.join(',')}`;

describe('the trade check', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    forgetPlayerReads(db);
    await seed(db);
  });

  it('lists the rosters for the pickers, Alex first, and never needs the market', async () => {
    const { client, calls } = forbiddenSleeper();
    const { status, body } = await get<TradeTeamsResponse>(db, `/api/leagues/${LEAGUE}/trades/check/teams`, client);
    expect(status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.teams![0]!).toMatchObject({ rosterId: 1, isMine: true, label: 'Alex' });
    expect(body.teams!.map((t) => t.label)).toContain('Roster 3');
    expect(body.teams![0]!.players[0]!.position).toBe('QB');
    expect(body.horizon).toMatchObject({ currentWeek: 5, lastWeek: 17, weeks: 13, deadlineWeek: 11, deadlinePassed: false });
    expect(calls).toEqual([]);
  });

  it('values a trade over the rest of the season, for both sides, with no Sleeper request', async () => {
    const { client, calls } = forbiddenSleeper();
    // Alex gives a receiver he is deep at for the back he is short of.
    const { status, body } = await get<TradeCheckResponse>(db, q(1, 2, ['m_wr5'], ['t_rb2']), client);
    expect(status).toBe(200);
    expect(calls).toEqual([]);
    const ev = body.evaluation!;
    expect(ev.status).toBe('ok');
    expect(ev.weeks).toEqual({ first: 5, last: 17, count: 13 });
    expect(ev.a!.isMine).toBe(true);
    expect(ev.a!.net).toBeGreaterThan(0);
    // Dermot is deep at back, so giving up a starting one for a receiver costs
    // him: the roster-aware answer, where a flat value swap would say even.
    expect(ev.b!.net).toBeLessThan(0);
    expect(ev.verdict!.kind).toMatch(/_a$/);
    expect(ev.a!.incoming[0]).toMatchObject({ playerId: 't_rb2', basis: 'market' });
    expect(ev.verdict!.headline.length).toBeGreaterThan(10);
    expect(body.advisory).toMatch(/does not make a trade for anyone/);
    expect(body.notes!.join(' ')).toMatch(/does not trade draft picks/);
    expect(body.notes!.join(' ')).toMatch(/FAAB/);
  });

  it('reads the bye from the fixture list and counts it', async () => {
    const { client } = forbiddenSleeper();
    const { body } = await get<TradeCheckResponse>(db, q(1, 2, ['m_wr3'], ['t_rb1']), client);
    // Dallas is off in week 9, so Alex's DAL receiver plays twelve of thirteen weeks.
    const out = body.evaluation!.a!.outgoing[0]!;
    expect(out.byeWeek).toBe(9);
    expect(out.games).toBe(12);
  });

  it('is roster aware: a free-agent-level player is worth nothing to the team that gets him', async () => {
    const { client } = forbiddenSleeper();
    // Alex gives his best receiver for Dermot's third-string back: bad for Alex.
    const { body } = await get<TradeCheckResponse>(db, q(1, 2, ['m_wr1'], ['t_bn1']), client);
    expect(body.evaluation!.a!.lineupChange).toBeLessThan(0);
    expect(body.evaluation!.verdict!.kind).toMatch(/b$/);
  });

  it('refuses a verdict, in words, when a player has nothing to be priced on', async () => {
    const { client } = forbiddenSleeper();
    await new PlayerRepo(db).upsertMany([player({ id: 'm_ghost', fullName: 'M_GHOST', position: 'WR', team: 'NE' })]);
    const leagues = new LeagueRepo(db);
    const roster = (await leagues.listRosters(LEAGUE)).find((r) => r.isMine)!;
    await leagues.replaceRosters(LEAGUE, [
      { ...roster, playerIds: [...roster.playerIds, 'm_ghost'] },
      ...(await leagues.listRosters(LEAGUE)).filter((r) => !r.isMine),
    ]);
    const { status, body } = await get<TradeCheckResponse>(db, q(1, 2, ['m_ghost'], ['t_rb1']), client);
    expect(status).toBe(200);
    expect(body.evaluation!.status).toBe('insufficient');
    expect(body.evaluation!.verdict).toBeNull();
    expect(body.evaluation!.insufficientReason).toMatch(/M_GHOST/);
  });

  it('reviews a trade between two other teams with none of Alex\u2019s preferences, and the same math', async () => {
    const { client } = forbiddenSleeper();
    const leagues = new LeagueRepo(db);
    const rosters = await leagues.listRosters(LEAGUE);
    await leagues.replaceRosters(LEAGUE, [
      ...rosters.filter((r) => r.rosterId !== 3),
      {
        ...rosters.find((r) => r.rosterId === 3)!,
        ownerName: 'Kim',
        playerIds: ['f_qb0', 'f_wr0', 'f_wr1', 'f_rb0'],
        starterIds: ['f_qb0', 'f_wr0', 'f_wr1', 'f_rb0'],
      },
    ]);
    const { status, body } = await get<TradeCheckResponse>(db, q(2, 3, ['t_qb'], ['f_qb0']), client);
    expect(status).toBe(200);
    const ev = body.evaluation!;
    expect(ev.status).toBe('ok');
    expect(ev.a!.isMine || ev.b!.isMine).toBe(false);
    expect(ev.a!.adjustments).toEqual([]);
    expect(ev.b!.adjustments).toEqual([]);
    expect(body.sides!.b.label).toBe('Kim');
    // Asked from the other chair, each team keeps its own number.
    const back = await get<TradeCheckResponse>(db, q(3, 2, ['f_qb0'], ['t_qb']), client);
    expect(back.body.evaluation!.a!.net).toBe(ev.b!.net);
    expect(back.body.evaluation!.b!.net).toBe(ev.a!.net);
  });

  it('answers bad input with a sentence and a 4xx', async () => {
    const { client } = forbiddenSleeper();
    const base = `/api/leagues/${LEAGUE}/trades/check`;
    expect((await get<{ error: string }>(db, `${base}?a=x&b=2&give=m_wr1&get=t_rb1`, client)).status).toBe(400);
    expect((await get<{ error: string }>(db, `${base}?a=1&b=1&give=m_wr1&get=t_rb1`, client)).status).toBe(400);
    expect((await get<{ error: string }>(db, `${base}?a=1&b=9&give=m_wr1&get=t_rb1`, client)).status).toBe(400);
    expect((await get<{ error: string }>(db, `${base}?a=1&b=2&give=&get=`, client)).status).toBe(400);
    expect((await get<{ error: string }>(db, `${base}?a=1&b=2&give=t_rb1&get=m_wr1`, client)).status).toBe(400);
    expect((await get<{ error: string }>(db, `/api/leagues/nope/trades/check?a=1&b=2&give=m_wr1&get=t_rb1`, client)).status).toBe(404);
    const tooMany = await get<{ error: string }>(db, `${base}?a=1&b=2&give=m_wr1,m_wr2,m_wr3,m_wr4,m_wr5&get=t_rb1`, client);
    expect(tooMany.status).toBe(400);
  });

  it('says so when the deadline has passed', async () => {
    const late = await createTestDb();
    forgetPlayerReads(late);
    await seed(late);
    await new SettingsRepo(late).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 12, fetchedAt: FETCHED_AT });
    const { client } = forbiddenSleeper();
    const { body } = await get<TradeCheckResponse>(late, q(1, 2, ['m_wr5'], ['t_rb2']), client);
    expect(body.horizon!.deadlinePassed).toBe(true);
    expect(body.evaluation!.caveats.join(' ')).toMatch(/deadline was week 11/);
  });
});

describe('what a trade check costs the database', () => {
  it('runs no statement more than a couple of times and reads a bounded number of rows', async () => {
    const real = await createTestDb();
    forgetPlayerReads(real);
    await seed(real);
    const counting = countingDb(real);
    const { client } = forbiddenSleeper();

    const res = await createApp()(new Request(`http://x${q(1, 2, ['m_wr5'], ['t_rb2'])}`), envFor(counting.db, client));
    expect(res.status).toBe(200);

    const tallies = counting.tallies();
    const rows = tallies.reduce((sum, t) => sum + t.rows, 0);
    const statements = tallies.reduce((sum, t) => sum + t.calls, 0);
    const worst = Math.max(...tallies.map((t) => t.calls));

    // Printed so the number in the report is a measurement and not a memory.
    // eslint-disable-next-line no-console
    console.log(`trade check: ${statements} statements, ${rows} rows returned, worst statement ran ${worst}x`);
    for (const t of tallies.slice(0, 6)) {
      // eslint-disable-next-line no-console
      console.log(`  ${String(t.rows).padStart(5)} rows  ${t.calls}x  ${t.sql.slice(0, 90)}`);
    }

    expect(worst).toBeLessThanOrEqual(2);
    // Two rosters, a free-agent shortlist and a fixture list: hundreds of rows,
    // never the league's whole player table or a whole stored week.
    expect(rows).toBeLessThan(1500);
  });

  it('reads the published week by key and never the whole stored week', async () => {
    const real = await createTestDb();
    forgetPlayerReads(real);
    await seed(real);
    const counting = countingDb(real);
    const { client } = forbiddenSleeper();
    await createApp()(new Request(`http://x${q(1, 2, ['m_wr5'], ['t_rb2'])}`), envFor(counting.db, client));
    const reads = counting.tallies().filter((t) => t.sql.includes('sleeper_weekly_projections'));
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const read of reads) expect(read.sql).toContain('and player_id in');
  });
});

describe('replaying past trades', () => {
  it('rebuilds both rosters from their current state and reverses the deal', async () => {
    const db = await createTestDb();
    forgetPlayerReads(db);
    await seed(db);
    // Dermot now holds m_wr5 and Alex holds t_rb2: the trade the check above prices, already made.
    const leagues = new LeagueRepo(db);
    const rosters = await leagues.listRosters(LEAGUE);
    const mine = rosters.find((r) => r.rosterId === 1)!;
    const theirs = rosters.find((r) => r.rosterId === 2)!;
    await leagues.replaceRosters(LEAGUE, [
      { ...mine, playerIds: [...mine.playerIds.filter((id) => id !== 'm_wr5'), 't_rb2'] },
      { ...theirs, playerIds: [...theirs.playerIds.filter((id) => id !== 't_rb2'), 'm_wr5'] },
      ...rosters.filter((r) => r.rosterId > 2),
    ]);
    await new TransactionRepo(db).saveWeek({
      leagueId: LEAGUE,
      season: '2026',
      week: 4,
      settled: true,
      transactions: [
        {
          transaction_id: 'trade-1',
          type: 'trade',
          status: 'complete',
          created: Date.now() - 86_400_000,
          leg: 4,
          roster_ids: [1, 2],
          adds: { t_rb2: 1, m_wr5: 2 },
          drops: { t_rb2: 2, m_wr5: 1 },
          draft_picks: [],
          waiver_budget: [{ sender: 2, receiver: 1, amount: 3 }],
        },
      ],
    });
    // And one from last season, whose players cannot be rebuilt.
    await new TransactionRepo(db).saveWeek({
      leagueId: LEAGUE,
      season: '2025',
      week: 6,
      settled: true,
      sleeperLeagueId: 'old',
      transactions: [
        {
          transaction_id: 'trade-old',
          type: 'trade',
          status: 'complete',
          created: Date.now() - 400 * 86_400_000,
          leg: 6,
          roster_ids: [1, 2],
          adds: { m_wr4: 2, t_rb3: 1 },
          drops: { m_wr4: 1, t_rb3: 2 },
          draft_picks: [{ season: '2026', round: 2, roster_id: 1, owner_id: 2 }],
          waiver_budget: [],
        },
      ],
    });

    const { client, calls } = forbiddenSleeper();
    const { status, body } = await get<TradeReplayResponse>(db, '/api/diagnostics/trade-values', client);
    expect(status).toBe(200);
    expect(calls).toEqual([]);
    expect(body.considered).toBe(2);

    const current = body.replays.find((r) => r.id === 'trade-1')!;
    expect(current.mode).toBe('roster_aware');
    expect(current.evaluation!.status).toBe('ok');
    expect(current.faabMoved).toBe(3);
    expect(current.notes.join(' ')).toMatch(/\$3 of waiver money/);
    // The reversed deal is the one the check prices, so the two must agree.
    const direct = await get<TradeCheckResponse>(
      (await (async () => {
        const fresh = await createTestDb();
        forgetPlayerReads(fresh);
        await seed(fresh);
        return fresh;
      })()),
      q(1, 2, ['m_wr5'], ['t_rb2']),
      client,
    );
    expect(current.evaluation!.a!.net).toBe(direct.body.evaluation!.a!.net);
    expect(current.evaluation!.b!.net).toBe(direct.body.evaluation!.b!.net);

    const old = body.replays.find((r) => r.id === 'trade-old')!;
    expect(old.mode).toBe('bundles');
    expect(old.evaluation).toBeNull();
    expect(old.picksMoved).toBe(1);
    expect(old.notes.join(' ')).toMatch(/earlier season/);
    expect(old.bundles!.length).toBe(2);
  });

  it('says so when there are no trades', async () => {
    const db = await createTestDb();
    forgetPlayerReads(db);
    await seed(db);
    const { client } = forbiddenSleeper();
    const { body } = await get<TradeReplayResponse>(db, '/api/diagnostics/trade-values', client);
    expect(body.considered).toBe(0);
    expect(body.notes[0]).toMatch(/No completed trades/);
  });
});
