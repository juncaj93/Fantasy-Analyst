/**
 * Round 18, Alex's decision of 11 November 2026: the app moves to next week on
 * Tuesday morning once the last game of the week is final, not when Sleeper
 * changes. Never before the last game is final, never before 3 AM Eastern on
 * the Tuesday. One shared function for Team, Matchup, Compare, Waivers and
 * Trades (`core/season/appWeek.ts`, read through `readAppNflState`).
 *
 * The real week: week 10's last game was Monday 9 November, 8:15 PM ET.
 * Sleeper still said week 10 at 7 PM ET on Wednesday 11 November, so the
 * screens showed week 10's byes (Denver, Philadelphia) beside week 11's lines.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appWeek, rolloverAt } from '../src/core/season/appWeek.ts';
import { createTestDb } from './helpers/db.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import { readAppNflState } from '../src/server/services/appWeek.ts';
import { player } from './helpers/players.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

/** Monday 9 November 2026, 8:15 PM ET: week 10's last kickoff. */
const MNF = '2026-11-10T01:15:00.000Z';
const at = (iso: string) => new Date(iso);
const week10 = (now: string, extra: Partial<Parameters<typeof appWeek>[0]> = {}) =>
  appWeek({ sleeperWeek: 10, seasonType: 'regular', lastKickoff: MNF, now: at(now), ...extra });

describe('the rule', () => {
  it('Monday night before the final: still week 10', () => {
    expect(week10('2026-11-10T03:30:00.000Z')).toBe(10); // 10:30 PM ET Monday, game on
    expect(week10('2026-11-10T07:59:00.000Z')).toBe(10); // 2:59 AM ET Tuesday
  });

  it('Tuesday 3 AM ET after the final: week 11, while Sleeper still says 10', () => {
    expect(week10('2026-11-10T08:00:00.000Z')).toBe(11); // 3:00 AM EST
    expect(week10('2026-11-11T19:00:00.000Z')).toBe(11); // Wednesday 2 PM, when Alex saw week 10 byes
  });

  it('never before the last game is final: a Tuesday night game holds the week until it ends', () => {
    const tuesdayGame = '2026-11-11T01:00:00.000Z'; // Tuesday 8 PM ET
    expect(week10('2026-11-10T08:00:00.000Z', { lastKickoff: tuesdayGame })).toBe(10);
    expect(week10('2026-11-11T05:00:00.000Z', { lastKickoff: tuesdayGame })).toBe(10); // midnight, game just ended
    expect(week10('2026-11-11T05:31:00.000Z', { lastKickoff: tuesdayGame })).toBe(11); // 4.5 hours after kickoff
  });

  it('3 AM Eastern in daylight time too (week 8, Monday 26 October)', () => {
    const r = rolloverAt({ sleeperWeek: 8, seasonType: 'regular', lastKickoff: '2026-10-27T00:15:00.000Z' });
    expect(new Date(r!).toISOString()).toBe('2026-10-27T07:00:00.000Z'); // 3:00 AM EDT
  });

  it('once Sleeper moves on, its week is the answer again', () => {
    expect(appWeek({ sleeperWeek: 11, seasonType: 'regular', lastKickoff: '2026-11-17T01:15:00.000Z', now: at('2026-11-12T15:00:00.000Z') })).toBe(11);
  });

  it('never guesses forward: no schedule, not the regular season, or the last week', () => {
    expect(week10('2026-11-11T19:00:00.000Z', { lastKickoff: null })).toBe(10);
    expect(week10('2026-11-11T19:00:00.000Z', { seasonType: 'post' })).toBe(10);
    expect(appWeek({ sleeperWeek: 18, seasonType: 'regular', lastKickoff: '2027-01-10T21:25:00.000Z', now: at('2027-01-14T12:00:00.000Z') })).toBe(18);
  });
});

/* ------------------------------------------------- byes for the right week */

const CLUBS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];

/** A whole week: every club but `resting` plays, the last game at `lastKickoff`. */
function slate(week: number, resting: string[], kickoff: string, lastKickoff: string): ScheduleTeamWeek[] {
  const playing = CLUBS.filter((c) => !resting.includes(c));
  return playing.map((team, i) => ({
    season: '2026',
    week,
    team,
    opponent: playing[i % 2 === 0 ? i + 1 : i - 1]!,
    home: i % 2 === 0,
    kickoff: i < 2 ? lastKickoff : kickoff,
    roof: null,
  }));
}

async function league() {
  const db = await createTestDb();
  await new PlayerRepo(db).upsertMany([
    player({ id: 'coleman', fullName: 'Jonah Coleman', team: 'DEN', position: 'RB' }),
    player({ id: 'lemon', fullName: 'Makai Lemon', team: 'PHI', position: 'WR' }),
    player({ id: 'evans', fullName: 'Week Eleven Bye', team: 'KC', position: 'WR' }),
  ]);
  /* Sleeper still says week 10, as it did on Wednesday 11 November. */
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 10 });
  await new NflScheduleRepo(db).save(
    [
      ...slate(10, ['CHI', 'DEN', 'PHI', 'TB'], '2026-11-08T18:00:00.000Z', MNF),
      ...slate(11, ['KC', 'LAC'], '2026-11-15T18:00:00.000Z', '2026-11-17T01:15:00.000Z'),
    ],
    '2026-11-01T00:00:00.000Z',
  );
  return db;
}

describe('a bye shown for the right week', () => {
  it('Monday night: week 10, so Denver and Philadelphia are on bye', async () => {
    const db = await league();
    const inputs = await startSitInputsFor(db, ['coleman', 'lemon', 'evans'], { now: at('2026-11-10T03:30:00.000Z') });
    const bye = Object.fromEntries(inputs.map((i) => [i.player.id, i.onBye === true]));
    expect(bye).toEqual({ coleman: true, lemon: true, evans: false });
  });

  it('Tuesday 3 AM ET: week 11, so Coleman and Lemon play and Kansas City rests', async () => {
    const db = await league();
    const inputs = await startSitInputsFor(db, ['coleman', 'lemon', 'evans'], { now: at('2026-11-10T08:00:00.000Z') });
    const bye = Object.fromEntries(inputs.map((i) => [i.player.id, i.onBye === true]));
    expect(bye).toEqual({ coleman: false, lemon: false, evans: true });
  });

  it('the shared read keeps Sleeper’s week beside the app’s', async () => {
    const db = await league();
    const state = await readAppNflState(db, at('2026-11-11T19:00:00.000Z'));
    expect(state?.week).toBe(11);
    expect(state?.sleeperWeek).toBe(10);
    /* The stored state itself is untouched. */
    expect((await new SettingsRepo(db).get<{ week: number }>(SETTING_KEYS.nflState, { week: 0 })).week).toBe(10);
  });
});

describe('one shared function', () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

  it('Team, Waivers, Matchup, Compare and Trades read the app week, not Sleeper’s state', () => {
    for (const file of [
      'server/services/decisionInputs.ts', // Team and Waivers
      'server/services/startSitInputs.ts', // fixtures and byes for every screen
      'server/services/matchupService.ts', // Matchup
      'server/services/comparePool.ts', // Compare
      'server/services/tradeValueService.ts', // Trades
      'server/services/smartTradeService.ts', // Trades
    ]) {
      expect(src(file), file).toMatch(/readAppNflState\(/);
    }
    for (const file of ['server/services/decisionInputs.ts', 'server/services/startSitInputs.ts', 'server/services/comparePool.ts', 'server/services/smartTradeService.ts']) {
      expect(src(file), file).not.toMatch(/SETTING_KEYS\.nflState/);
    }
    expect(src('server/services/matchupService.ts')).toMatch(/nflState: \(\) => readAppNflState/);
  });

  it('the week rule lives in one place', () => {
    expect(src('core/season/appWeek.ts')).toMatch(/export function appWeek/);
    expect(src('server/services/appWeek.ts')).toMatch(/appWeek\(\{/);
  });
});
