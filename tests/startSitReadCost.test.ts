/**
 * What one start/sit assembly costs in rows, and why that number is the one
 * worth guarding.
 *
 * Every quota incident this app has had was the same shape: a correct query on
 * a path that runs far more often than anybody counted. The assembly in
 * `startSitInputsFor` is now the most-run read path in the app — Matchup
 * re-reads itself every thirty seconds while games are live, the trade board
 * runs one per roster in the league, and Team, Compare and Waivers each run one
 * or two a visit — so it is the path where a careless extra read is most
 * expensive.
 *
 * Measured against a week-10-shaped store (450 skill players a week, ten weeks
 * of them), one assembly for a 30-player matchup used to cost:
 *
 *     4,500 rows   coverage(), walked to produce one integer
 *     3,600 rows   leagueWeeksSince(), the defence model's eight-week window
 *       600 rows   weeksFor(), the same 300 rows fetched twice
 *        30 rows   the players themselves
 *
 *  8,730 rows a poll, 120 polls an hour with the screen open on a Sunday: a
 *  fifth of the whole daily allowance per hour, to rebuild a table whose only
 *  input changes once a day.
 *
 * These tests assert the *reads*, not the answers. An assertion about the
 * returned lineup passed before every one of those fixes and would pass again
 * if they were undone.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { UsageRepo, type StoredUsageWeek } from '../src/server/repos/usage.ts';
import { UsageService, forgetUsageDerivations } from '../src/server/services/usageService.ts';
import { startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import type { Database } from '../src/server/db.ts';

const SEASON = String(new Date().getUTCFullYear());
const TEAMS = ['KC', 'BUF', 'SF', 'DAL', 'PHI', 'MIA', 'BAL', 'CIN'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** A store shaped like week 10 of a real season, at a size tests can hold. */
async function seasonInProgress(weeks = 10, perWeek = 60): Promise<Database> {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany(
    Array.from({ length: perWeek }, (_, i) =>
      player({
        id: `p${i}`,
        fullName: `Player ${i}`,
        team: TEAMS[i % TEAMS.length]!,
        position: POSITIONS[i % POSITIONS.length]!,
      }),
    ),
  );
  const rows: StoredUsageWeek[] = [];
  for (let week = 1; week <= weeks; week++) {
    for (let p = 0; p < perWeek; p++) {
      rows.push({
        playerId: `p${p}`,
        season: SEASON,
        week,
        seasonType: 'REG',
        team: TEAMS[p % TEAMS.length]!,
        position: POSITIONS[p % POSITIONS.length]!,
        opponent: TEAMS[(p + 1) % TEAMS.length]!,
        passAttempts: 10,
        carries: 5,
        targets: 6,
        receptions: 4,
        targetShare: 0.2,
        wopr: 0.4,
        passYards: 100,
        passTds: 1,
        rushYards: 20,
        rushTds: 0,
        recYards: 50,
        recTds: 0,
        receivingAirYards: 60,
        airYardsShare: 0.3,
        gsisId: null,
        source: 'nflverse',
        publishedAt: null,
        fetchedAt: new Date().toISOString(),
      } as StoredUsageWeek);
    }
  }
  await new UsageRepo(db).saveWeeks(rows);
  return db;
}

const IDS = Array.from({ length: 30 }, (_, i) => `p${i}`);

describe('one start/sit assembly', () => {
  it('reads a player set of usage weeks once, not twice', async () => {
    const counted = countingDb(await seasonInProgress());
    await startSitInputsFor(counted.db, IDS);

    expect(
      counted.callsMatching('FROM player_usage_weeks WHERE season = ? AND player_id IN'),
      'the role trend and the raw rows are two consumers of one read, not two reads',
    ).toBe(1);
  });

  it('finds the newest week by seek, never by counting the season', async () => {
    const counted = countingDb(await seasonInProgress());
    await startSitInputsFor(counted.db, IDS);

    expect(counted.callsMatching('SELECT MAX(week) AS week FROM player_usage_weeks')).toBe(1);
    expect(
      counted.callsMatching('COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT week)'),
      'coverage() answers this and three other numbers, and walks every row of the season to do it',
    ).toBe(0);
  });

  it('does not rebuild the defence table for the second poll', async () => {
    const db = await seasonInProgress();
    const counted = countingDb(db);
    await startSitInputsFor(counted.db, IDS);
    const firstBuild = counted.callsMatching('FROM player_usage_weeks WHERE season = ? AND season_type');
    counted.reset();

    await startSitInputsFor(counted.db, IDS);

    expect(firstBuild, 'the first assembly builds it').toBe(1);
    expect(
      counted.callsMatching('FROM player_usage_weeks WHERE season = ? AND season_type'),
      'a poll thirty seconds later reads the same eight weeks again',
    ).toBe(0);
    expect(
      counted.callsMatching('SELECT MAX(week) AS week FROM player_usage_weeks'),
      'and does not re-ask which week it is either',
    ).toBe(0);
  });

  it('a poll costs the roster and nothing league-wide once the table is built', async () => {
    const counted = countingDb(await seasonInProgress());
    await startSitInputsFor(counted.db, IDS);
    counted.reset();
    await startSitInputsFor(counted.db, IDS);

    const rows = counted.tallies().reduce((total, t) => total + t.rows, 0);
    expect(rows, `a repeat assembly read ${rows} rows; it should be the 30 players and their weeks`).toBeLessThan(400);
  });
});

describe('the defence table', () => {
  it('is rebuilt after an ingest, not held for the window', async () => {
    const db = await seasonInProgress();
    const counted = countingDb(db);
    const service = new UsageService(counted.db);

    await service.defenseTendencies(SEASON);
    counted.reset();
    await service.defenseTendencies(SEASON);
    expect(counted.callsMatching('FROM player_usage_weeks WHERE season = ? AND season_type')).toBe(0);

    // What an ingest does on its way out.
    forgetUsageDerivations(counted.db);
    await service.defenseTendencies(SEASON);
    expect(
      counted.callsMatching('FROM player_usage_weeks WHERE season = ? AND season_type'),
      'a new week of usage must be visible on the next read, not six hours later',
    ).toBe(1);
  });

  it('still answers with the same table it did before the memo', async () => {
    const db = await seasonInProgress();
    const service = new UsageService(db);
    const built = await service.defenseTendencies(SEASON);
    forgetUsageDerivations(db);
    const rebuilt = await service.defenseTendencies(SEASON);
    expect([...rebuilt.keys()].sort()).toEqual([...built.keys()].sort());
    expect(rebuilt.size, 'a season this far in has tendencies to report').toBeGreaterThan(0);
  });

  it('says nothing before there are enough weeks to say it with', async () => {
    const db = await seasonInProgress(2);
    expect((await new UsageService(db).defenseTendencies(SEASON)).size).toBe(0);
  });
});
