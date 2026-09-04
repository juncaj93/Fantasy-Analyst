/**
 * What Sleeper's own add list is allowed to do to this board, and what it is not.
 *
 * `core/market/trending.ts` draws the line in its own header: attention may
 * surface a player and may price him, and may never score him. Half a million
 * people adding somebody says the wire is about to get expensive, not that he
 * is good, and feeding that into a projection would launder the crowd's opinion
 * into the app's own numbers.
 *
 * So these tests assert both halves. Trending decides which unscorable players
 * are worth naming at all — the one job nothing else can do, because a player
 * with no market and no usage has nothing else to recommend him. And it moves
 * no score, no gain and no ordering among the players the app *can* rate.
 */

import { describe, expect, it } from 'vitest';
import { assembleWaiverPlan, type WaiverAssemblyRequest } from '../src/core/waivers/assemble.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { TrendingVelocity } from '../src/core/market/trending.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN']);

function roster() {
  return [
    candidate('qb1', 'Passer One', 'QB', 20),
    candidate('rb1', 'Runner One', 'RB', 15),
    candidate('rb2', 'Runner Two', 'RB', 13),
    candidate('wr1', 'Catcher One', 'WR', 14),
    candidate('wr2', 'Catcher Two', 'WR', 12),
    candidate('te1', 'End One', 'TE', 9),
    candidate('rb3', 'Runner Three', 'RB', 11),
    /* The last man on the bench: priced, playable, and plainly beatable. */
    candidate('wr3', 'Fourth Catcher', 'WR', 4),
  ];
}
const MINE = ['qb1', 'rb1', 'rb2', 'rb3', 'wr1', 'wr2', 'te1', 'wr3'];

function velocity(overrides: Partial<TrendingVelocity> & { playerId: string }): TrendingVelocity {
  return {
    rank: 3,
    count: 18400,
    addsPerHour: 766,
    rankMovement: null,
    acceleration: null,
    entered: false,
    heat: 0.94,
    ...overrides,
  };
}

function request(over: Partial<WaiverAssemblyRequest> = {}): WaiverAssemblyRequest {
  return {
    shape: SHAPE,
    profile: HALF_PPR,
    rosterInputs: roster(),
    candidateInputs: [],
    rosteredIds: new Set(MINE),
    currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'],
    reserveIds: [],
    rosters: [],
    players: [],
    week: 7,
    season: '2026',
    strategy: null,
    budgets: null,
    prices: null,
    observations: [],
    /* Null, so the DEF row is the generic scan's to offer unless a test says otherwise. */
    dstSources: null,
    bestBall: false,
    draftComplete: true,
    playoff: { weeks: [15, 16, 17], emphasis: 0 },
    now: new Date('2026-10-14T02:30:00.000Z'),
    ...over,
  };
}

describe('the unscorable half of the wire', () => {
  it('names the one the room is adding, and not the one nobody is', async () => {
    /*
     * Both are equally unreadable to this app: no market, no usage, no news.
     * The only thing separating them is that eighteen thousand people have
     * added one of them, which is precisely the fact a reader needs and the
     * one the old board could never show.
     */
    const plan = await assembleWaiverPlan(
      request({
        candidateInputs: [
          candidate('fa-chased', 'Chased Rookie', 'RB', null),
          candidate('fa-ignored', 'Ignored Rookie', 'RB', null),
        ],
        trending: new Map([['fa-chased', velocity({ playerId: 'fa-chased' })]]),
      }),
    );

    expect(plan.unknowns.map((u) => u.name)).toEqual(['Chased Rookie']);
    expect(plan.unknowns[0]!.adds).toBe(18400);
    expect(plan.unknowns[0]!.trending).toContain('#3 trending add');
  });

  it('says nothing at all when no capture has been taken', async () => {
    const plan = await assembleWaiverPlan(
      request({ candidateInputs: [candidate('fa-chased', 'Chased Rookie', 'RB', null)] }),
    );

    /*
     * No trending data is a state, not a failure. The tier is empty and the
     * sentence under the board still accounts for him — see `emptyBoardHeadline`.
     */
    expect(plan.unknowns).toEqual([]);
  });

  it('orders them by Sleeper\'s own published rank', async () => {
    const plan = await assembleWaiverPlan(
      request({
        candidateInputs: [
          candidate('fa-a', 'Fourth Most Added', 'RB', null),
          candidate('fa-b', 'Top Add', 'RB', null),
        ],
        trending: new Map([
          ['fa-a', velocity({ playerId: 'fa-a', rank: 4, count: 900 })],
          ['fa-b', velocity({ playerId: 'fa-b', rank: 1, count: 40000 })],
        ]),
      }),
    );

    expect(plan.unknowns.map((u) => u.name)).toEqual(['Top Add', 'Fourth Most Added']);
  });
});

describe('what attention may not do', () => {
  it('moves no score and no gain on a player the app can actually rate', async () => {
    const inputs = [candidate('fa-wr', 'Free Catcher', 'WR', 8)];
    const without = await assembleWaiverPlan(request({ candidateInputs: inputs }));
    const with_ = await assembleWaiverPlan(
      request({
        candidateInputs: inputs,
        trending: new Map([['fa-wr', velocity({ playerId: 'fa-wr', rank: 1, count: 99000 })]]),
      }),
    );

    const gainOf = (p: typeof without) => p.valueAdds.map((v) => [v.name, v.score, v.gain]);
    expect(gainOf(with_)).toEqual(gainOf(without));
  });

  it('adds its line to a row that had already earned its place', async () => {
    const plan = await assembleWaiverPlan(
      request({
        candidateInputs: [candidate('fa-wr', 'Free Catcher', 'WR', 8)],
        trending: new Map([['fa-wr', velocity({ playerId: 'fa-wr', rank: 2, count: 31000 })]]),
      }),
    );

    expect(plan.valueAdds).toHaveLength(1);
    expect(plan.valueAdds[0]!.reasons.join(' · ')).toContain('#2 trending add');
  });
});
