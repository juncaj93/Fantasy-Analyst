/**
 * The opponent had a lineup and the app said he did not.
 *
 * Alex, 16 September 2026, checking Sleeper's own app against this one: the
 * week 2 opponent has a complete lineup for this exact matchup, and the Matchup
 * screen said "Your opponent has not set a lineup for this week yet". That
 * sentence shipped in #269, replacing a confusing "Only 0% of your opponent's
 * starters could be projected" — so the fix made a false claim *louder*, which
 * is the worse of the two failures.
 *
 * `scripts/probe-opponent-starters.mjs` asked Sleeper directly. Week 2, this
 * league, verbatim:
 *
 *     roster=4  matchup=2  players=16  starters=NULL
 *         roster.starters: ["6904","9226", … ,"BAL"]
 *     roster=5  matchup=3  players=16  starters=NULL     <- the opponent
 *         roster.starters: ["11560","6813", … ,"PHI"]
 *
 * So Sleeper serves the same lineup from two endpoints and only one of them
 * has it before the week is played. `/matchups/:week` carries the lineup as it
 * *locked*, and returns null for a team that has not touched its lineup since
 * the week rolled over; `/rosters` carries the lineup as it stands. Sleeper's
 * own app reads the second. This app read only the first.
 */

import { describe, expect, it } from 'vitest';
import { buildMatchupResponse, type MatchupSources } from '../src/core/matchup/build.ts';
import { candidate } from './helpers/startsit.ts';
import type { LeagueRecord, RosterRecord, SleeperMatchup } from '../src/core/sleeper/types.ts';

const LEAGUE: LeagueRecord = {
  id: 'l1',
  sleeperLeagueId: 's1',
  name: 'Tony’s Pizza',
  season: '2026',
  scoringSettings: { rec: 0.5 },
  rosterPositions: ['QB', 'RB', 'WR', 'TE', 'BN', 'BN'],
  leagueSettings: {},
  draftId: null,
  totalRosters: 10,
  lastSyncedAt: '2026-09-16T02:00:00.000Z',
};

const MINE = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
const THEIRS = ['t1', 't2', 't3', 't4', 't5', 't6'];
/** Four starting slots, so two of each roster sit on the bench. */
const MINE_LINEUP = ['m1', 'm2', 'm3', 'm4'];
const THEIRS_LINEUP = ['t1', 't2', 't3', 't4'];

function roster(rosterId: number, isMine: boolean, ids: string[], lineup: string[]): RosterRecord {
  return {
    leagueId: 'l1',
    rosterId,
    ownerId: `o${rosterId}`,
    ownerName: `Owner ${rosterId}`,
    playerIds: ids,
    starterIds: lineup,
    starterSlotIds: lineup,
    reserveIds: [],
    isMine,
  };
}

/**
 * The shape production actually returned: my row carries a lineup, the
 * opponent's row carries `starters: null`, and both rosters have one.
 */
function sources(opts: { theirsRowStarters: string[] | null; theirsRosterLineup?: string[] }): MatchupSources {
  return {
    leagues: {
      getLeague: async () => LEAGUE,
      listRosters: async () => [
        roster(1, true, MINE, MINE_LINEUP),
        roster(5, false, THEIRS, opts.theirsRosterLineup ?? THEIRS_LINEUP),
      ],
    },
    matchups: async () =>
      [
        { roster_id: 1, matchup_id: 3, points: 0, players: MINE, starters: MINE_LINEUP, players_points: {} },
        {
          roster_id: 5,
          matchup_id: 3,
          points: 0,
          players: THEIRS,
          starters: opts.theirsRowStarters,
          players_points: {},
        },
      ] as unknown as SleeperMatchup[],
    nflState: async () => ({ season: '2026', seasonType: 'regular', week: 2 }),
    startSitInputs: async (ids) => ids.map((id, i) => candidate(id, `Player ${id}`, 'WR', 10 + i)),
    previousForecast: async () => null,
    cached: () => null,
    remember: () => {},
    now: () => new Date('2026-09-16T02:00:00.000Z'),
  };
}

const sides = (response: Awaited<ReturnType<typeof buildMatchupResponse>>) => {
  const f = response.forecast!;
  const all = [
    ...f.slots.flatMap((r) => [r.mine, r.theirs]),
    ...f.bench.mine,
    ...f.bench.theirs,
  ].filter((p): p is NonNullable<typeof p> => p != null);
  return {
    mine: all.filter((p) => p.side === 'mine' && p.starting).length,
    theirs: all.filter((p) => p.side === 'theirs' && p.starting).length,
    theirsTotal: all.filter((p) => p.side === 'theirs').length,
  };
};

describe('a null starters array on the matchup row is not an empty lineup', () => {
  it('reads the roster’s lineup when the matchup row has none', async () => {
    const response = await buildMatchupResponse(sources({ theirsRowStarters: null }), 'l1');
    const counts = sides(response);

    // The regression, exactly: sixteen players arrived and none of them started.
    expect(counts.theirsTotal).toBe(6);
    expect(counts.theirs).toBe(4);
    expect(counts.mine).toBe(4);
  });

  it('forecasts the matchup instead of refusing it', async () => {
    const response = await buildMatchupResponse(sources({ theirsRowStarters: null }), 'l1');

    expect(response.forecast!.degraded).toBe(false);
    expect(response.forecast!.degradedReason).toBeNull();
    expect(response.forecast!.teams.theirs.projectedFinal).toBeGreaterThan(0);
  });

  it('never claims a lineup is unset while the roster holds one', async () => {
    /*
     * The sentence this test exists for. #269 was right that an empty side and
     * an unpriced one are different things; it was wrong that an empty side
     * means the manager has not picked anybody.
     */
    const response = await buildMatchupResponse(sources({ theirsRowStarters: null }), 'l1');
    expect(response.forecast!.degradedReason ?? '').not.toMatch(/has not set a lineup/i);
  });

  it('still prefers the matchup row once the week has locked one in', async () => {
    /*
     * The order matters and must not invert. Once a week is under way the
     * matchup row is the authority — it is the lineup as it locked, and the
     * roster keeps changing afterwards. A benched player who is swapped out on
     * Sunday evening must not retroactively leave the lineup he actually
     * played in.
     */
    const locked = ['t4', 't3', 't2', 't1'];
    const response = await buildMatchupResponse(
      sources({ theirsRowStarters: locked, theirsRosterLineup: ['t5', 't6', 't1', 't2'] }),
      'l1',
    );
    const f = response.forecast!;
    const startingIds = f.slots.map((r) => r.theirs?.playerId).filter(Boolean);

    expect(startingIds.sort()).toEqual(['t1', 't2', 't3', 't4']);
    // And emphatically not the roster's current one, which names t5 and t6.
    expect(startingIds).not.toContain('t5');
  });

  it('says the lineup is unset only when nobody has one anywhere', async () => {
    // The honest version of #269's sentence, kept for the case it is true of.
    const response = await buildMatchupResponse(
      sources({ theirsRowStarters: null, theirsRosterLineup: [] }),
      'l1',
    );

    expect(sides(response).theirs).toBe(0);
    expect(response.forecast!.degradedReason).toMatch(/has not set a lineup/i);
  });

  it('treats a row of zeroes the same as a null one', async () => {
    // Sleeper writes `"0"` into a slot nobody fills; an array of them is not a
    // lineup, it is the same absence wearing a different shape.
    const response = await buildMatchupResponse(
      sources({ theirsRowStarters: ['0', '0', '0', '0'] }),
      'l1',
    );

    expect(sides(response).theirs).toBe(4);
  });
});
