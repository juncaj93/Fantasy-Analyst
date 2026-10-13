/**
 * Which week it is, and whose lineup, across the week's turning points
 * (13 October 2026).
 *
 * Alex's report: on Tuesday after Monday night's game his Sleeper app showed his
 * Week 6 lineup while Team still drew Week 5's slots, and refreshing changed
 * nothing. The app's week comes from Sleeper's `/state/nfl`, so each case
 * below is "what Sleeper answers at that moment", and the test holds every
 * screen to it. The Tuesday-afternoon state is measured (19:47 UTC: `week 6,
 * leg 6, display_week 5`); the others follow the same rule.
 *
 * The lineup case that broke: `/rosters` still holding Week 5's starters while
 * the Week 6 matchup row holds the lineup Alex set. The refresh must store the
 * matchup's lineup, and Team, the lineup, Compare and Matchup must agree.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { currentWeek } from '../src/core/sleeper/currentWeek.ts';
import { resolveWeek } from '../src/core/matchup/build.ts';
import { currentWeekOf } from '../src/server/services/tradeValueService.ts';
import { withWeekLineup } from '../src/core/sleeper/weekLineup.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';

/* Demo roster: 1001 Vance RB, 1004 Sotelo TE, 1009 Kowalski TE, 1011 Whitfield WR, 1030 Jacksonville DEF. */
/* Slots: QB RB RB WR WR TE FLEX DEF. `"0"` is an empty slot. */
const WEEK5 = ['0', '1001', '0', '0', '0', '1009', '1004', '1030'];
const WEEK6 = ['0', '1001', '0', '1011', '0', '1004', '0', '1030'];

interface Moment {
  label: string;
  /** What Sleeper's `/state/nfl` says then. */
  state: { week: number; leg: number; display_week: number; season_type: string };
  /** `/rosters` `starters` for Alex's team then. */
  rosterStarters: string[];
  /** `/matchups/:week` `starters` for Alex's team then, by week. Null: not set since the roll-over. */
  matchupStarters: Record<number, string[] | null>;
  /** The lineup every screen must show. */
  expect: { week: number; lineup: string[] };
}

const MOMENTS: Moment[] = [
  {
    label: 'Monday evening, Week 5 game on',
    state: { week: 5, leg: 5, display_week: 5, season_type: 'regular' },
    rosterStarters: WEEK5,
    matchupStarters: { 5: WEEK5, 6: null },
    expect: { week: 5, lineup: WEEK5 },
  },
  {
    label: 'Tuesday 1 AM ET, after Monday night, before the roll-over',
    state: { week: 5, leg: 5, display_week: 5, season_type: 'regular' },
    rosterStarters: WEEK5,
    matchupStarters: { 5: WEEK5, 6: null },
    expect: { week: 5, lineup: WEEK5 },
  },
  {
    label: 'Tuesday afternoon, Sleeper on week 6, Alex has set Week 6, /rosters still on Week 5',
    state: { week: 6, leg: 6, display_week: 5, season_type: 'regular' },
    rosterStarters: WEEK5,
    matchupStarters: { 5: WEEK5, 6: WEEK6 },
    expect: { week: 6, lineup: WEEK6 },
  },
  {
    label: 'Tuesday afternoon, Sleeper on week 6, nothing touched yet: the roster carries over',
    state: { week: 6, leg: 6, display_week: 5, season_type: 'regular' },
    rosterStarters: WEEK5,
    matchupStarters: { 5: WEEK5, 6: null },
    expect: { week: 6, lineup: WEEK5 },
  },
  {
    label: 'Thursday before kickoff',
    state: { week: 6, leg: 6, display_week: 6, season_type: 'regular' },
    rosterStarters: WEEK5,
    matchupStarters: { 5: WEEK5, 6: WEEK6 },
    expect: { week: 6, lineup: WEEK6 },
  },
  {
    label: 'Sunday morning',
    state: { week: 6, leg: 6, display_week: 6, season_type: 'regular' },
    rosterStarters: WEEK6,
    matchupStarters: { 5: WEEK5, 6: WEEK6 },
    expect: { week: 6, lineup: WEEK6 },
  },
];

function fakeSleeper(moment: Moment): SleeperClient {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  return new SleeperClient({
    retries: 0,
    fetch: async (url: string) => {
      if (url.includes('/state/nfl')) return json({ season: '2026', ...moment.state, season_start_date: '2026-09-09' });
      const matchup = /\/league\/demo-league\/matchups\/(\d+)/.exec(url);
      if (matchup) {
        const week = Number(matchup[1]);
        return json([
          { roster_id: 1, matchup_id: 1, players: ['1001', '1004', '1009', '1011', '1030'], starters: moment.matchupStarters[week] ?? null, points: 0 },
          { roster_id: 2, matchup_id: 1, players: ['1002'], starters: null, points: 0 },
        ]);
      }
      if (url.includes('/league/demo-league/rosters')) {
        return json([
          { roster_id: 1, owner_id: 'demo-user', league_id: 'demo-league', players: ['1001', '1004', '1009', '1011', '1030'], starters: moment.rosterStarters, settings: {} },
          { roster_id: 2, owner_id: 'rival', league_id: 'demo-league', players: ['1002'], starters: ['1002'], settings: {} },
        ]);
      }
      if (url.includes('/league/demo-league/users')) {
        return json([
          { user_id: 'demo-user', username: 'you', display_name: 'You' },
          { user_id: 'rival', username: 'rival', display_name: 'Rival' },
        ]);
      }
      if (url.includes('/league/demo-league/drafts')) return json([]);
      if (url.includes('/league/demo-league')) {
        return json({
          league_id: 'demo-league',
          name: 'Demo Dynasty',
          season: '2026',
          status: 'in_season',
          total_rosters: 2,
          roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN'],
          scoring_settings: { rec: 0.5, pass_td: 4 },
          settings: { waiver_type: 2, waiver_budget: 100, playoff_week_start: 15 },
        });
      }
      return json(null);
    },
  });
}

describe('one current week, from Sleeper', () => {
  it('maps Sleeper’s state the same way for every caller', () => {
    for (const m of MOMENTS) {
      const state = { week: m.state.week, seasonType: m.state.season_type };
      expect(currentWeek(state), m.label).toBe(m.expect.week);
      expect(resolveWeek(null, state.week, state.seasonType), m.label).toBe(m.expect.week);
      expect(currentWeekOf({ ...state, season: '2026', seasonStartDate: null, leg: m.state.leg, fetchedAt: '' }), m.label).toBe(m.expect.week);
    }
    // Uses `week`, never `display_week` (which lags on Tuesday).
    expect(currentWeek({ week: 6, seasonType: 'regular' })).toBe(6);
    // Out of season: week one, and the trade horizon stays empty after the season.
    expect(currentWeek({ week: 3, seasonType: 'pre' })).toBe(1);
    expect(currentWeek(null)).toBe(1);
    expect(currentWeekOf({ week: 18, seasonType: 'off', season: '2026', seasonStartDate: null, leg: 18, fetchedAt: '' })).toBe(19);
  });

  it('takes a team’s lineup from the week’s matchup row, and the roster where the row has none', () => {
    const rosters = [{ roster_id: 1, owner_id: 'a', league_id: 'l', players: [], starters: WEEK5 }];
    expect(withWeekLineup(rosters, [{ roster_id: 1, matchup_id: 1, starters: WEEK6 }])[0]!.starters).toEqual(WEEK6);
    expect(withWeekLineup(rosters, [{ roster_id: 1, matchup_id: 1, starters: null }])[0]!.starters).toEqual(WEEK5);
    expect(withWeekLineup(rosters, [{ roster_id: 1, matchup_id: 1, starters: ['0', '0'] }])[0]!.starters).toEqual(WEEK5);
    expect(withWeekLineup(rosters, [])[0]!.starters).toEqual(WEEK5);
  });
});

describe.each(MOMENTS)('$label', (moment) => {
  let env: AppEnv;
  const app = createApp();
  const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await app(new Request(`https://app.test${path}`, init), env);
    if (res.status !== 200) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  beforeEach(async () => {
    const db = await createTestDb();
    await seedDemoData(db);
    env = { db, sleeper: fakeSleeper(moment), vegas: new MockVegasProvider(MOCK_GAMES), disableAuth: true };
  });

  it('refresh re-reads Sleeper, and every screen agrees on the week and the lineup', async () => {
    // The button on Team.
    const report = await call<{ sources: { source: string; outcome: string }[] }>('/api/startsit/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(report.sources.find((s) => s.source === 'sleeper')?.outcome).toBe('updated');

    // Team's slots.
    const roster = await call<{ starterSlotIds?: (string | null)[]; starters: { playerId: string }[] }>('/api/leagues/demo-league/roster');
    const expected = moment.expect.lineup.map((id) => (id === '0' ? null : id));
    expect(roster.starterSlotIds).toEqual(expected);

    // The lineup the optimiser starts from (Best move's "current").
    const lineup = await call<{ starters: { playerId: string }[]; bench: { playerId: string }[]; slots: { playerId: string | null }[] }>(
      '/api/leagues/demo-league/lineup',
    );
    const everyone = [...lineup.starters, ...lineup.bench].map((e) => e.playerId).sort();
    // The defence is scored on its own path; every other rostered player is here.
    expect(everyone).toEqual(['1001', '1004', '1009', '1011']);

    // Matchup and Compare name the same week.
    const matchup = await call<{ week: number; me?: { starters?: { playerId: string }[] } }>('/api/leagues/demo-league/matchup');
    expect(matchup.week).toBe(moment.expect.week);
    const compare = await call<{ week?: number | null }>('/api/startsit/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leagueId: 'demo-league', playerIds: ['1001', '1004'] }),
    });
    expect(compare.week).toBe(moment.expect.week);
  });
});
