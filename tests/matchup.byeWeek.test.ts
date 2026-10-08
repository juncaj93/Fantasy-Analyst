/**
 * A player on a bye scores nothing, and Matchup must know it.
 *
 * Found in the October 2026 audit, on the live week-5 forecast: Best move read
 * `Start K. Walker over M. Andrews · +6.6 projected pts · 62% → 70%`. Kansas
 * City had no game that week. With no market and no published week (because
 * there was no game to price), Walker fell through to the preseason tier and
 * was projected 11.6 from his August season total. The opponent's Chuba
 * Hubbard (Carolina, also on a bye) was projected 8.9 the same way, so the
 * win probability was wrong as well as the advice.
 *
 * Three layers, each tested here:
 *
 *  1. **Who is on a bye**, read off the fixture list only when that list is
 *     whole enough to say so. A thin or missing list must mark nobody, or a gap
 *     in this app's data becomes a zero on somebody's lineup.
 *  2. **The inputs** carry it from the stored schedule.
 *  3. **The forecast** projects a resting player at zero, never asks the
 *     preseason tier about him, and never recommends starting him.
 */

import { describe, expect, it } from 'vitest';
import { buildMatchupResponse, type MatchupSources } from '../src/core/matchup/build.ts';
import { isOnBye, MIN_TEAMS_FOR_BYE, playingTeams, type ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';
import { buildStartSitContext, startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SettingsRepo, SETTING_KEYS } from '../src/server/repos/settings.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { pricedCandidate as candidate } from './helpers/startsit.ts';
import { createTestDb } from './helpers/db.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { LeagueRecord, RosterRecord, SleeperMatchup } from '../src/core/sleeper/types.ts';

const TEAMS = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];

/** A week's fixture rows: every team but `resting` plays, paired off in order. */
function weekOf(week: number, resting: string[]): ScheduleTeamWeek[] {
  const playing = TEAMS.filter((t) => !resting.includes(t));
  const rows: ScheduleTeamWeek[] = [];
  for (let i = 0; i < playing.length; i += 2) {
    const [a, b] = [playing[i]!, playing[i + 1]!];
    const kickoff = '2026-10-11T17:00:00.000Z';
    rows.push({ season: '2026', week, team: a, opponent: b, home: true, kickoff, roof: null });
    rows.push({ season: '2026', week, team: b, opponent: a, home: false, kickoff, roof: null });
  }
  return rows;
}

describe('who is on a bye', () => {
  it('reads a club missing from a whole fixture list as resting', () => {
    const playing = playingTeams(weekOf(5, ['KC', 'CAR']));
    expect(playing?.size).toBe(30);
    expect(isOnBye('KC', playing)).toBe(true);
    expect(isOnBye('car', playing)).toBe(true);
    expect(isOnBye('BAL', playing)).toBe(false);
  });

  it('marks nobody when the list is too thin to say who rests', () => {
    const thin = weekOf(5, []).slice(0, MIN_TEAMS_FOR_BYE - 2);
    expect(playingTeams(thin)).toBeNull();
    expect(isOnBye('KC', playingTeams(thin))).toBe(false);
    expect(playingTeams([])).toBeNull();
  });

  it('never calls a player with no club on a bye', () => {
    const playing = playingTeams(weekOf(5, ['KC']));
    expect(isOnBye(null, playing)).toBe(false);
    expect(isOnBye('', playing)).toBe(false);
  });

  it('does not count a row with no opponent as a game', () => {
    const rows = weekOf(5, ['KC']);
    rows.push({ season: '2026', week: 5, team: 'KC', opponent: null, home: false, kickoff: null, roof: null });
    expect(isOnBye('KC', playingTeams(rows))).toBe(true);
  });
});

describe('the inputs carry the bye from the stored schedule', () => {
  async function seeded(fixtures: ScheduleTeamWeek[]) {
    const db = await createTestDb();
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 5 });
    await new NflScheduleRepo(db).save(fixtures, '2026-10-01T00:00:00.000Z');
    await new PlayerRepo(db).upsertMany([
      { id: 'walker', sleeperPlayerId: 'walker', fullName: 'Kenneth Walker', firstName: 'Kenneth', lastName: 'Walker', team: 'KC', position: 'RB', status: 'Active', active: true, normalizedName: 'kenneth walker', aliases: [], externalIds: {} } as never,
      { id: 'andrews', sleeperPlayerId: 'andrews', fullName: 'Mark Andrews', firstName: 'Mark', lastName: 'Andrews', team: 'BAL', position: 'TE', status: 'Active', active: true, normalizedName: 'mark andrews', aliases: [], externalIds: {} } as never,
    ]);
    return db;
  }

  it('flags the resting player and nobody else', async () => {
    const db = await seeded(weekOf(5, ['KC', 'CAR']));
    const now = new Date('2026-10-07T18:00:00.000Z');
    const context = await buildStartSitContext(db, undefined, now);
    const inputs = await startSitInputsFor(db, ['walker', 'andrews'], { context, now });
    const byId = new Map(inputs.map((i) => [i.player.id, i]));
    expect(byId.get('walker')?.onBye).toBe(true);
    expect(byId.get('andrews')?.onBye).toBeUndefined();
  });

  it('flags nobody when the week has no fixture list', async () => {
    const db = await seeded([]);
    const now = new Date('2026-10-07T18:00:00.000Z');
    const context = await buildStartSitContext(db, undefined, now);
    const inputs = await startSitInputsFor(db, ['walker', 'andrews'], { context, now });
    expect(inputs.every((i) => i.onBye === undefined)).toBe(true);
  });
});

describe('the forecast', () => {
  const LEAGUE: LeagueRecord = {
    id: 'l1',
    sleeperLeagueId: 's1',
    name: 'Tony’s Pizza',
    season: '2026',
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN', 'BN'],
    leagueSettings: {},
    draftId: null,
    totalRosters: 12,
    lastSyncedAt: '2026-10-07T14:00:00Z',
  };
  const MINE_STARTERS = ['qb1', 'rb1', 'wr1', 'te1', 'te9'];
  const MINE = [...MINE_STARTERS, 'rb7'];
  const THEIRS = ['qb2', 'rb2', 'wr2', 'te2', 'rb8'];
  const roster = (rosterId: number, isMine: boolean, ids: string[], starters: string[]): RosterRecord => ({
    leagueId: 'l1',
    rosterId,
    ownerId: `o${rosterId}`,
    ownerName: `Owner ${rosterId}`,
    playerIds: ids,
    starterIds: starters,
    reserveIds: [],
    isMine,
  });
  const MARKET = new Map<string, number | null>([
    ['qb1', 20], ['rb1', 12], ['wr1', 12], ['te1', 9], ['te9', 5],
    ['qb2', 20], ['rb2', 12], ['wr2', 12], ['te2', 9],
    ['rb7', null], ['rb8', null],
  ]);
  /** Season totals that would make both resting backs look like strong starters. */
  const PRESEASON = new Map([['rb7', 240], ['rb8', 200]]);

  function sources(resting: ReadonlySet<string>, asked: string[][] = []): MatchupSources {
    return {
      leagues: {
        getLeague: async () => LEAGUE,
        listRosters: async () => [roster(1, true, MINE, MINE_STARTERS), roster(2, false, THEIRS, THEIRS)],
      },
      matchups: async () =>
        [
          { roster_id: 1, matchup_id: 7, points: 0, players: MINE, starters: MINE_STARTERS, players_points: {} },
          { roster_id: 2, matchup_id: 7, points: 0, players: THEIRS, starters: THEIRS, players_points: {} },
        ] as SleeperMatchup[],
      nflState: async () => ({ season: '2026', seasonType: 'regular', week: 5 }),
      startSitInputs: async (ids) =>
        ids.map((id) => {
          const input: StartSitInput = candidate(id, `Player ${id}`, id.slice(0, 2).toUpperCase(), MARKET.get(id) ?? null);
          return resting.has(id) ? { ...input, onBye: true } : input;
        }),
      previousForecast: async () => null,
      publishedProjections: async () => new Map(),
      preseasonProjections: async ({ playerIds }) => {
        asked.push([...playerIds]);
        return new Map([...PRESEASON].filter(([id]) => playerIds.includes(id)));
      },
      cached: () => null,
      remember: () => {},
      now: () => new Date('2026-10-07T18:00:00Z'),
    };
  }

  const everyone = (response: Awaited<ReturnType<typeof buildMatchupResponse>>) => {
    const f = response.forecast!;
    return [...f.slots.flatMap((r) => [r.mine, r.theirs]), ...f.bench.mine, ...f.bench.theirs].filter(
      (p): p is NonNullable<typeof p> => p != null,
    );
  };

  it('recommends the resting back when nothing says he is resting (the control)', async () => {
    const response = await buildMatchupResponse(sources(new Set()), 'l1');
    expect(response.forecast?.decision?.best?.inPlayerId).toBe('rb7');
  });

  it('projects a resting player at zero, flags him, and never recommends him', async () => {
    const asked: string[][] = [];
    const response = await buildMatchupResponse(sources(new Set(['rb7', 'rb8']), asked), 'l1');
    const players = everyone(response);
    const walker = players.find((p) => p.playerId === 'rb7')!;
    const hubbard = players.find((p) => p.playerId === 'rb8')!;
    expect(walker.onBye).toBe(true);
    expect(walker.projectedFinal).toBe(0);
    expect(walker.projectionEstimated).toBeUndefined();
    expect(hubbard.onBye).toBe(true);
    expect(hubbard.projectedFinal).toBe(0);
    expect(response.forecast?.decision?.best?.inPlayerId).not.toBe('rb7');
    expect(asked.flat()).not.toContain('rb7');
    expect(asked.flat()).not.toContain('rb8');
  });

  it('takes the opponent’s resting starter out of his projected total', async () => {
    const control = await buildMatchupResponse(sources(new Set()), 'l1');
    const fixed = await buildMatchupResponse(sources(new Set(['rb8'])), 'l1');
    const theirs = (r: typeof control) => r.forecast!.teams.theirs.projectedFinal ?? 0;
    expect(theirs(control) - theirs(fixed)).toBeCloseTo(200 / 16, 0);
    const mine = (r: typeof control) => r.forecast!.teams.mine.winProbability ?? 0;
    expect(mine(fixed)).toBeGreaterThan(mine(control));
  });
});
