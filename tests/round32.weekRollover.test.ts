/**
 * Round 32, audit finding 6: from Tuesday 3 AM to Wednesday evening Sleeper
 * still says last week while every screen shows the app's week
 * (`core/season/appWeek.ts`). Two background jobs followed Sleeper:
 *
 *  - the odds refresh priced last week's opponent's starters, and
 *  - the three-hourly league read stored the three weeks after Sleeper's
 *    week, so the planner's third week ahead was missing on waiver night,
 *    and the season row stopped a week short.
 *
 * The worked example is week 11: its last game is Monday 16 November, 8:15 PM
 * ET; the app rolls to week 12 at 3 AM Tuesday 17 November. Sleeper keeps
 * saying 11 until Wednesday evening.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index.ts';
import { createTestDb } from './helpers/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { MatchupRepo } from '../src/server/repos/matchup.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { weekPointsKey } from '../src/core/sleeper/weekPoints.ts';
import { WeekPointsService } from '../src/server/services/weekPointsService.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

/** Monday 16 November 2026, 8:15 PM ET: week 11's last kickoff. */
const WEEK11_MNF = '2026-11-17T01:15:00.000Z';
/** Tuesday 17 November 2026, 10:15 AM ET: a three-hourly league read, the app on week 12, Sleeper on 11. */
const TUESDAY_READ = Date.UTC(2026, 10, 17, 15, 15);

function schedule(week: number, kickoff: string): ScheduleTeamWeek[] {
  return [
    { season: '2026', week, team: 'CIN', opponent: 'PIT', home: true, kickoff, roof: null },
    { season: '2026', week, team: 'PIT', opponent: 'CIN', home: false, kickoff, roof: null },
  ];
}

async function seed(db: NodeSqliteDatabase): Promise<void> {
  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'L2026',
    sleeperLeagueId: 'L2026',
    name: "Tony's Pizza",
    season: '2026',
    totalRosters: 3,
    scoringSettings: { rec: 0.5, pass_yd: 0.04 },
    rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN'],
    leagueSettings: {},
    draftId: null,
    lastSyncedAt: new Date(TUESDAY_READ).toISOString(),
  });
  const roster = (rosterId: number, ids: string[], isMine = false) => ({
    leagueId: 'L2026',
    rosterId,
    ownerId: `u-${rosterId}`,
    ownerName: `Team ${rosterId}`,
    playerIds: ids,
    starterIds: ids,
    reserveIds: [],
    isMine,
    settings: {},
  });
  /* Mine; last week's opponent (2); this week's opponent (3). */
  await leagues.replaceRosters('L2026', [roster(1, ['1000'], true), roster(2, ['2000']), roster(3, ['3000'])]);
  await leagues.selectLeague('L2026');
  const p = (id: string, team: string) => ({
    id, sleeperPlayerId: id, fullName: `Player ${id}`, firstName: 'Player', lastName: id,
    team, position: 'WR', status: 'Active', active: true, normalizedName: `player ${id}`, aliases: [],
  });
  await new PlayerRepo(db).upsertMany([p('1000', 'CIN'), p('2000', 'PIT'), p('3000', 'PIT')]);
  await new SettingsRepo(db).set(SETTING_KEYS.sleeperUser, { userId: 'u-1', username: 'alex', displayName: 'Alex' });
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, {
    season: '2026', seasonType: 'regular', week: 11, leg: 11, fetchedAt: new Date(TUESDAY_READ).toISOString(),
  });
  const fetchedAt = new Date(TUESDAY_READ).toISOString();
  await new NflScheduleRepo(db).save(schedule(11, WEEK11_MNF), fetchedAt);
  await new NflScheduleRepo(db).save(schedule(12, '2026-11-22T18:00:00.000Z'), fetchedAt);
}

async function forecast(db: NodeSqliteDatabase, week: number, opponentRosterId: number): Promise<void> {
  await new MatchupRepo(db).record({
    leagueId: 'L2026', season: '2026', week, rosterId: 1, matchupId: 1, opponentRosterId,
    modelVersion: 'test', phase: 'pre', winProbability: 0.5, projectedFinal: 100, actual: 0,
    confidence: 'medium', fingerprint: `w${week}`, at: new Date(TUESDAY_READ - 86_400_000).toISOString(),
  });
}

describe('the odds refresh prices the app week’s opponent', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    await forecast(db, 11, 2);
    await forecast(db, 12, 3);
  });

  it('on Tuesday morning, this week’s opponent (week 12), not last week’s (week 11)', async () => {
    const preview = await new VegasRefreshService(db, new MockVegasProvider([])).preview(TUESDAY_READ);
    const opponent = preview.players.filter((pl) => pl.tier === 'opponent').map((pl) => pl.playerId);
    expect(opponent).toEqual(['3000']);
  });

  it('on Monday night, before the week rolls, still week 11’s opponent', async () => {
    const mondayNight = Date.UTC(2026, 10, 17, 3, 0); // 10 PM ET Monday, the game on
    const preview = await new VegasRefreshService(db, new MockVegasProvider([])).preview(mondayNight);
    const opponent = preview.players.filter((pl) => pl.tier === 'opponent').map((pl) => pl.playerId);
    expect(opponent).toEqual(['2000']);
  });
});

describe('the three-hourly league read plans on the app week', () => {
  let db: NodeSqliteDatabase;
  let realFetch: typeof fetch;
  let realLog: typeof console.log;
  let realError: typeof console.error;
  let urls: string[];

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    /* Weeks 1 to 9 already stored, so the season row only needs 10 and 11. */
    for (let w = 1; w <= 9; w++) {
      await new SettingsRepo(db).set(weekPointsKey('2026', w), {
        season: '2026', week: w, fetchedAt: new Date(TUESDAY_READ - 7 * 86_400_000).toISOString(), points: { '1000': 10 },
      });
    }
    realFetch = globalThis.fetch;
    realLog = console.log;
    realError = console.error;
    console.log = () => {};
    console.error = () => {};
    urls = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (/\/league\/[^/]+\/rosters$/.test(url)) {
        return new Response(JSON.stringify([
          { roster_id: 1, owner_id: 'u-1', players: ['1000'], starters: ['1000'], reserve: [] },
        ]), { status: 200 });
      }
      if (/\/league\/[^/]+\/users$/.test(url)) return new Response(JSON.stringify([{ user_id: 'u-1', display_name: 'Alex' }]), { status: 200 });
      if (/\/league\/[^/]+\/drafts$/.test(url)) return new Response('[]', { status: 200 });
      if (/\/league\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({
          league_id: 'L2026', name: "Tony's Pizza", season: '2026', total_rosters: 3,
          scoring_settings: { rec: 0.5, pass_yd: 0.04 }, roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN'],
        }), { status: 200 });
      }
      /* Sleeper still says week 11 on Tuesday morning. */
      if (url.includes('/state/nfl')) return new Response(JSON.stringify({ season: '2026', season_type: 'regular', week: 11, leg: 11 }), { status: 200 });
      if (url.includes('/stats/nfl/')) return new Response(JSON.stringify({ '1000': { rec: 5, rec_yd: 60 } }), { status: 200 });
      if (url.includes('/projections/nfl/')) {
        return new Response(JSON.stringify([{ player_id: '1000', player: { position: 'WR' }, stats: { rec: 5, rec_yd: 60 } }]), { status: 200 });
      }
      if (url.includes('github.com')) return new Response(null, { status: 304 });
      return new Response('null', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  });

  it('stores weeks 13, 14 and 15 on Tuesday (the three after week 12), so the third week ahead is there', async () => {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: TUESDAY_READ }, { DB: db } as never);
    const ahead = await new WeekPointsService(db, new SleeperClient()).readAhead('2026', [12, 13, 14, 15]);
    expect([...ahead.keys()].sort((a, b) => a - b)).toEqual([13, 14, 15]);
  });

  it('builds the season row through week 11, the week just played', async () => {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: TUESDAY_READ }, { DB: db } as never);
    const season = await new WeekPointsService(db, new SleeperClient()).readSeason('2026');
    expect(season?.through).toBe(11);
  });

  it('still asks Sleeper about its own week for the transactions', async () => {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: TUESDAY_READ }, { DB: db } as never);
    expect(urls.some((u) => /\/league\/L2026\/transactions\/11$/.test(u))).toBe(true);
    expect(urls.some((u) => /\/league\/L2026\/transactions\/12$/.test(u))).toBe(false);
  });
});
