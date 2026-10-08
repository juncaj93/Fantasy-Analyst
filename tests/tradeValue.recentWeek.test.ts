/**
 * The trade check's stand-in for a player with no number this week.
 *
 * Found in the October 2026 audit: on a bye week, every Chiefs and Panthers
 * player had no rate, so any trade that moved one of them got no verdict at
 * all. This provider publishes no season lines, so the season-line rung never
 * fired. The fix reads the player's most recent earlier week of Sleeper's
 * published projection, through the same scoring gate as this week's.
 *
 * Pinned here over the production schema:
 *  - the read is one keyed statement however many weeks it looks back over;
 *  - the latest real week wins, and a zero for a game he missed is passed over;
 *  - a position this league's scoring refuses stays refused;
 *  - a trade that moves such a player gets a verdict, says why, and is not
 *    reported with high confidence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo, forgetPlayerReads } from '../src/server/repos/players.ts';
import { SleeperProjectionsRepo } from '../src/server/repos/sleeperProjections.ts';
import { SleeperProjectionService } from '../src/server/services/sleeperProjectionService.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { SleeperWeeklyProjection } from '../src/core/sleeper/weeklyProjections.ts';
import type { TradeCheckResponse } from '../src/core/tradeValue/response.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { LEAGUE, POSITIONS, envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { player } from './helpers/players.ts';

const AT = '2026-10-01T09:00:00Z';

function row(playerId: string, halfPpr: number): SleeperWeeklyProjection {
  return {
    playerId,
    publisher: 'rotowire',
    points: { pts_std: halfPpr - 1, pts_half_ppr: halfPpr, pts_ppr: halfPpr + 1 },
    defense: null,
  };
}

/** The owner's league: half PPR and six points a passing touchdown, which refuses published QB totals. */
const TONYS_PIZZA = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2 }, POSITIONS);

describe('the earlier-week read', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    const repo = new SleeperProjectionsRepo(db);
    await repo.save('2026', 2, [row('wr', 9), row('qb', 21), row('hurt', 8)], AT);
    await repo.save('2026', 3, [row('wr', 11), row('hurt', 10)], AT);
    await repo.save('2026', 4, [row('wr', 13), row('hurt', 0.2)], AT);
  });

  const positions = new Map([
    ['wr', 'WR'],
    ['qb', 'QB'],
    ['hurt', 'RB'],
    ['nobody', 'WR'],
  ]);

  async function recent() {
    return new SleeperProjectionService(db, forbiddenSleeper().client).publishedRecent({
      season: '2026',
      weeks: [4, 3, 2],
      playerIds: ['wr', 'qb', 'hurt', 'nobody'],
      profile: TONYS_PIZZA,
      positionOf: (id) => positions.get(id) ?? null,
      floor: 1,
    });
  }

  it('takes the latest week with a real figure', async () => {
    expect((await recent()).get('wr')).toEqual({ week: 4, points: 13 });
  });

  it('passes over a zero for a game he missed and takes the week before', async () => {
    expect((await recent()).get('hurt')).toEqual({ week: 3, points: 10 });
  });

  it('keeps refusing a quarterback this league’s scoring cannot read', async () => {
    expect((await recent()).has('qb')).toBe(false);
  });

  it('says nothing for a player with no earlier week', async () => {
    expect((await recent()).has('nobody')).toBe(false);
  });

  it('is one keyed statement, whatever the number of weeks', async () => {
    const counting = countingDb(db);
    await new SleeperProjectionService(counting.db, forbiddenSleeper().client).publishedRecent({
      season: '2026',
      weeks: [4, 3, 2],
      playerIds: ['wr', 'hurt'],
      profile: TONYS_PIZZA,
      positionOf: (id) => positions.get(id) ?? null,
      floor: 1,
    });
    const reads = counting.tallies().filter((t) => t.sql.includes('sleeper_weekly_projections'));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.calls).toBe(1);
    expect(reads[0]!.sql).toContain('and player_id in');
  });
});

describe('a trade that moves a player with no number this week', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    forgetPlayerReads(db);
    await seed(db);
    // A receiver on Alex's roster with nothing priced and nothing published this week.
    await new PlayerRepo(db).upsertMany([player({ id: 'm_idle', fullName: 'M_IDLE', position: 'WR', team: 'NE' })]);
    const leagues = new LeagueRepo(db);
    const rosters = await leagues.listRosters(LEAGUE);
    const mine = rosters.find((r) => r.isMine)!;
    await leagues.replaceRosters(LEAGUE, [
      { ...mine, playerIds: [...mine.playerIds, 'm_idle'] },
      ...rosters.filter((r) => !r.isMine),
    ]);
  });

  async function check() {
    const { client, calls } = forbiddenSleeper();
    const path = `/api/leagues/${LEAGUE}/trades/check?a=1&b=2&give=m_idle&get=t_rb4`;
    const res = await createApp()(new Request(`http://x${path}`), envFor(db, client));
    expect(calls).toEqual([]);
    return (await res.json()) as TradeCheckResponse;
  }

  it('gets no verdict when no week has a number for him, as before', async () => {
    const body = await check();
    expect(body.evaluation!.status).toBe('insufficient');
    expect(body.evaluation!.insufficientReason).toMatch(/M_IDLE/);
  });

  it('is valued on his most recent earlier week, says so, and is not reported as certain', async () => {
    await new SleeperProjectionsRepo(db).save('2026', 4, [row('m_idle', 10.5)], AT);
    const body = await check();
    const ev = body.evaluation!;
    expect(ev.status).toBe('ok');
    expect(ev.verdict).not.toBeNull();
    const out = ev.a!.outgoing.find((p) => p.playerId === 'm_idle')!;
    expect(out).toMatchObject({ basis: 'recent_week', rate: 10.5 });
    expect(out.rateNote).toMatch(/week 4 Sleeper projection/);
    expect(ev.confidence).not.toBe('high');
    expect(ev.confidenceReasons.join(' ')).toMatch(/earlier week/);
  });
});
