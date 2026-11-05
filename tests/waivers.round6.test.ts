/**
 * Round 6, Waivers on rest-of-season value (review register
 * `docs/REVIEW_2026-11.md`, W3, W4, W9, W10; 4 November 2026). Each test
 * fails on the code before this round:
 *
 *  - Pickups and drops are judged on the whole season (playoff weeks 1.5
 *    times), on the rate Trades uses, through the real input builder.
 *  - Jordan Love is never dropped for Sam Darnold: the live card of 4
 *    November ("Do this: Darnold, $17, drop Jordan Love").
 *  - A QB bye is covered by a free QB, never by cutting the starter.
 *  - A real dead roster spot is the drop; an IR stash is protected.
 *  - Bids keep $20 for the playoffs.
 *  - Sleeper's trending adds are scanned.
 *  - One shared rest-of-season function for Trades and Waivers.
 */

import { describe, expect, it } from 'vitest';
import { buildTierInputs, type TierInputRequest } from '../src/core/waivers/tierInputs.ts';
import { planWaiverTiers, type TierPlayer, type WaiverTierPlan } from '../src/core/waivers/tiers.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { tradeHorizon } from '../src/core/tradeValue/weeks.ts';
import { buildPlayerRate } from '../src/core/tradeValue/rate.ts';
import * as tradeRos from '../src/core/tradeValue/restOfSeason.ts';
import * as sharedRos from '../src/core/value/restOfSeason.ts';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { playoffReserve, PLAYOFF_RESERVE, type LeagueBudgetState } from '../src/core/faab/budget.ts';
import { recommendBid } from '../src/core/faab/strategy.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';
import { trendingFreeAgentIds } from '../src/core/roster/freeAgents.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';
import { pricedCandidate } from './helpers/startsit.ts';
import { player } from './helpers/players.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench, 2 IR. Half PPR. */
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'IR', 'IR'];
const SHAPE = buildRosterShape(POSITIONS);
const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, POSITIONS);
const LEAGUE_SETTINGS = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11 };
const WEEK = 9;
/* Wednesday 4 November, 10:00 AM ET: week 9's games are all ahead. */
const NOW = new Date('2026-11-04T15:00:00.000Z');
const KICKOFF = '2026-11-08T18:00:00.000Z';
const HORIZON = tradeHorizon({ leagueSettings: LEAGUE_SETTINGS, currentWeek: WEEK });

const TEAMS = ['GB', 'SEA', 'PHI', 'DAL', 'MIA', 'BUF', 'KC', 'DET', 'CHI', 'NYJ', 'LAR', 'ATL', 'DEN', 'HOU', 'PIT', 'MIN'];

/** Every club plays weeks 9 to 17, except on its bye. */
function fixtures(byes: Record<string, number>): ScheduleTeamWeek[] {
  const rows: ScheduleTeamWeek[] = [];
  for (const team of TEAMS) {
    for (let week = WEEK; week <= 17; week++) {
      if (byes[team] === week) continue;
      rows.push({ season: '2026', week, team, opponent: 'OPP', home: true, kickoff: KICKOFF, roof: null });
    }
  }
  return rows;
}

const fa = (id: string, position: string, points: number | null, team: string): StartSitInput =>
  pricedCandidate(id, id, position, points, { team, kickoff: KICKOFF });

/**
 * Alex's roster on 4 November, close enough: Love at QB, a full bench, one
 * dead spot (Makai Lemon, a receiver who never starts).
 */
function roster(over: Partial<Record<string, number | null>> = {}): StartSitInput[] {
  const points = (id: string, base: number | null) => (id in over ? (over[id] ?? null) : base);
  return [
    fa('Love', 'QB', points('Love', 16.88), 'GB'),
    fa('Bijan', 'RB', points('Bijan', 18), 'ATL'),
    fa('Walker', 'RB', points('Walker', 14), 'DAL'),
    fa('JSN', 'WR', points('JSN', 16), 'SEA'),
    fa('McConkey', 'WR', points('McConkey', 12), 'MIA'),
    fa('Worthy', 'WR', points('Worthy', 10), 'KC'),
    fa('LaPorta', 'TE', points('LaPorta', 10), 'DET'),
    fa('Allen', 'RB', points('Allen', 11), 'NYJ'),
    fa('Concepcion', 'WR', points('Concepcion', 9.5), 'BUF'),
    fa('Coleman', 'RB', points('Coleman', 8), 'DEN'),
    fa('EJohnson', 'RB', points('EJohnson', 7), 'CHI'),
    fa('Cooper', 'WR', points('Cooper', 7.5), 'LAR'),
    fa('AWilliams', 'WR', points('AWilliams', 6), 'HOU'),
    fa('Higbee2', 'TE', points('Higbee2', 6), 'MIN'),
    fa('Robinson', 'RB', points('Robinson', 6.5), 'ATL'),
    fa('Lemon', 'WR', points('Lemon', 2), 'PHI'),
  ];
}

/** League points by week, weeks 1 to 8: what each has actually scored. */
function season(ids: Record<string, number>): Map<string, number[]> {
  return new Map(Object.entries(ids).map(([id, perGame]) => [id, Array.from({ length: 8 }, () => perGame)] as const));
}

/* The rest of the wire: replacement level at every position, as a real wire always has. */
const WIRE = [
  fa('FaRB1', 'RB', 7, 'KC'),
  fa('FaRB2', 'RB', 6.5, 'BUF'),
  fa('FaRB3', 'RB', 6, 'DET'),
  fa('FaWR1', 'WR', 7, 'CHI'),
  fa('FaWR2', 'WR', 6.5, 'NYJ'),
  fa('FaWR3', 'WR', 6, 'LAR'),
  fa('FaTE1', 'TE', 6, 'ATL'),
  fa('FaTE2', 'TE', 5.5, 'DEN'),
  fa('FaTE3', 'TE', 5, 'HOU'),
];

function inputs(opts: {
  roster?: StartSitInput[];
  candidates: StartSitInput[];
  byes: Record<string, number>;
  ahead?: Record<number, Record<string, number>>;
  points?: Record<string, number>;
  reserveIds?: string[];
  seasonOn?: boolean;
  /** Rostered players kept as holds (a high pick, a top Sleeper add): never the automatic drop. */
  held?: string[];
}): TierInputRequest {
  const rosterInputs = opts.roster ?? roster();
  opts = { ...opts, candidates: [...opts.candidates, ...WIRE] };
  const ahead = new Map(Object.entries(opts.ahead ?? {}).map(([w, m]) => [Number(w), new Map(Object.entries(m))] as const));
  return {
    shape: SHAPE,
    profile: PROFILE,
    week: WEEK,
    now: NOW,
    rosterInputs,
    candidateInputs: opts.candidates,
    rosteredIds: new Set(rosterInputs.map((i) => i.player.id)),
    reserveIds: opts.reserveIds ?? [],
    fixtures: fixtures(opts.byes),
    pickup: Object.fromEntries(opts.candidates.map((c) => [c.player.id, { state: 'free' as const, reason: null, until: null }])),
    held: new Map((opts.held ?? []).map((id) => [id, 'kept'] as const)),
    reserveSlots: 2,
    excludedPositions: new Set(['DEF']),
    ahead: { sleeper: ahead },
    seasonPoints: season(opts.points ?? {}),
    seasonPointsThrough: 8,
    teamOf: (id) => rosterInputs.concat(opts.candidates).find((i) => i.player.id === id)?.player.team ?? null,
    positionOf: (id) => rosterInputs.concat(opts.candidates).find((i) => i.player.id === id)?.player.position ?? null,
    currentStarterIds: ['Love', 'Bijan', 'Walker', 'JSN', 'McConkey', 'Worthy', 'LaPorta', 'Allen', 'Concepcion'],
    ...(opts.seasonOn === false ? {} : { season: { weeks: HORIZON.weeks, playoffWeeks: HORIZON.playoffWeeks } }),
  };
}

function plan(req: TierInputRequest): WaiverTierPlan {
  return planWaiverTiers(buildTierInputs(req).request);
}

const shown = (p: WaiverTierPlan) => [...p.doThese, ...p.consider, ...p.watch];
const dropsOf = (p: WaiverTierPlan) => [...p.doThese, ...p.consider, ...p.watch].map((m) => m.drop?.name ?? null);

/*
 * The live case: Love (GB) and Darnold (SEA) both have a week 11 bye. Darnold
 * has the better weeks 9 and 10 (23.51 and 19.79 against 16.88 and 17.23),
 * Love the better season (about 22 a game against about 17). Malik Willis is
 * the bye cover that also wants a drop.
 */
const LOVE_CASE = {
  candidates: [fa('Darnold', 'QB', 23.51, 'SEA'), fa('Willis', 'QB', 19.66, 'MIA'), fa('Rodgers', 'QB', null, 'PIT')],
  byes: { GB: 11, SEA: 11, PHI: 10, DEN: 10, PIT: 9 },
  ahead: {
    10: { Love: 17.23, Darnold: 19.79, Willis: 16.12, Rodgers: 18 },
    11: { Willis: 16.56, Rodgers: 16.69 },
    12: { Love: 22.5, Darnold: 18, Willis: 15.5, Rodgers: 17 },
  },
  points: { Love: 23.6, Darnold: 17.2, Willis: 15, Rodgers: 16.5, Lemon: 6.5, Bijan: 18, JSN: 16 },
  /* On 4 November only Lemon was a free drop: the rest of the bench was kept or taken. */
  held: ['Coleman', 'EJohnson', 'Cooper', 'AWilliams', 'Higbee2', 'Robinson'],
};

describe('Love is never dropped for Darnold (the live card of 4 November)', () => {
  it('the three-week window drops Love: the bug, as production had it', () => {
    const before = plan(inputs({ ...LOVE_CASE, seasonOn: false }));
    const darnold = shown(before).find((m) => m.name === 'Darnold');
    expect(darnold?.drop?.name).toBe('Love');
  });

  it('on the season, no move drops Love, and Darnold is no "Do this"', () => {
    const after = plan(inputs(LOVE_CASE));
    expect(dropsOf(after)).not.toContain('Love');
    expect(after.doThese.map((m) => m.name)).not.toContain('Darnold');
    for (const m of after.all) expect(m.drop?.name).not.toBe('Love');
    /* The gain counts every week to 17; the playoffs count 1.5 times. */
    expect(after.season?.weeks).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(after.season?.weights).toEqual([1, 1, 1, 1, 1, 1, 1.5, 1.5, 1.5]);
  });

  it('a better QB for the season than Love may replace him; a better week never does', () => {
    /* Darnold better than Love all season: then Love is the backup, and may be the drop. */
    const flipped = plan(
      inputs({
        ...LOVE_CASE,
        candidates: [fa('Darnold', 'QB', 26, 'SEA')],
        ahead: { 10: { Love: 15, Darnold: 26 }, 12: { Love: 15, Darnold: 26 } },
        points: { ...LOVE_CASE.points, Love: 14, Darnold: 27 },
      }),
    );
    expect(flipped.all.find((m) => m.name === 'Darnold')).toBeTruthy();
    const love = plan(inputs(LOVE_CASE)).all.find((m) => m.name === 'Darnold');
    expect(love?.drop?.name ?? null).not.toBe('Love');
  });
});

describe('a QB bye is covered by a free QB, not by a drop', () => {
  it('Love on bye in week 13: no claim for it now, and Love is never cut', () => {
    const p = plan(
      inputs({
        candidates: [fa('Willis', 'QB', 15, 'MIA'), fa('Rodgers', 'QB', 15.5, 'PIT'), fa('Murray', 'QB', 15.2, 'LAR')],
        byes: { GB: 13 },
        ahead: { 10: { Love: 18, Willis: 15, Rodgers: 15.5, Murray: 15.2 }, 12: { Love: 22, Willis: 15, Rodgers: 15.5, Murray: 15.2 } },
        points: { Love: 23.6, Willis: 15, Rodgers: 15.5, Murray: 15 },
      }),
    );
    expect(dropsOf(p)).not.toContain('Love');
    /* The week-13 hole is filled by a free agent at replacement level, so a backup QB adds next to nothing. */
    expect([...p.doThese, ...p.consider].filter((m) => m.position === 'QB')).toEqual([]);
  });
});

describe('the drop is the real dead spot, on season value', () => {
  it('a starter-grade upgrade at WR cuts Lemon, not a useful bench back', () => {
    const p = plan(
      inputs({
        candidates: [fa('Jefferson', 'WR', 17, 'MIN')],
        byes: {},
        ahead: { 10: { Jefferson: 17 }, 12: { Jefferson: 17 } },
        points: { Jefferson: 17, Lemon: 2, Coleman: 9, EJohnson: 8 },
      }),
    );
    const move = [...p.doThese, ...p.consider].find((m) => m.name === 'Jefferson');
    expect(move?.drop?.name).toBe('Lemon');
  });

  it('an IR stash is never the drop', () => {
    const base = roster();
    const hurt = { ...fa('Kittle', 'TE', 12, 'DAL'), injuryStatus: 'IR' };
    const p = plan(
      inputs({
        roster: [...base, hurt],
        reserveIds: ['Kittle'],
        candidates: [fa('Jefferson', 'WR', 17, 'MIN')],
        byes: {},
        ahead: { 10: { Jefferson: 17 }, 12: { Jefferson: 17 } },
        points: { Jefferson: 17, Kittle: 14, Lemon: 2 },
      }),
    );
    for (const m of p.all) expect(m.drop?.name).not.toBe('Kittle');
  });
});

describe('the bars scale with the season, so a small edge is still small', () => {
  it('Do this, Worth considering and the Watch list are the old per-week bars over 10.5 weighted weeks', () => {
    const p = plan(inputs({ candidates: [fa('Jefferson', 'WR', 17, 'MIN')], byes: {} }));
    /* 9 weeks left, three of them playoffs: 10.5 weighted weeks against the old window's 2.5. */
    expect(p.thresholds).toEqual({ doThis: 16.8, consider: 6.3, watch: 1.68 });
  });
});

describe('the $20 playoff reserve (D5)', () => {
  it('week 13 with $56 left caps a bid at $36; the playoffs free it', () => {
    expect(PLAYOFF_RESERVE).toBe(20);
    expect(playoffReserve(56, { week: 13, finalWeek: 14 })).toEqual({ spendable: 36, held: 20 });
    expect(playoffReserve(15, { week: 9, finalWeek: 14 })).toEqual({ spendable: 0, held: 15 });
    expect(playoffReserve(56, { week: 15, finalWeek: 14 })).toEqual({ spendable: 56, held: 0 });
  });

  it('no suggested bid takes Alex below $20 before the playoffs', () => {
    const budget = (remaining: number): LeagueBudgetState => ({
      rule: { usesFaab: true, total: 100, minBid: 0 } as unknown as LeagueBudgetState['rule'],
      rosters: [
        { rosterId: 1, isMine: true, remaining, spent: 100 - remaining } as unknown as LeagueBudgetState['rosters'][number],
        { rosterId: 2, isMine: false, remaining: 60, spent: 40 } as unknown as LeagueBudgetState['rosters'][number],
      ],
      notes: [],
    });
    const prices = { confidence: 'medium', observations: 40 } as unknown as PriceSummary;
    const rec = (remaining: number, week: number) =>
      recommendBid({
        inputs: {
          playerId: 'x',
          name: 'X',
          position: 'RB',
          weeklyGain: 9,
          gainOverReplacement: null,
          roleStability: 'rising',
          shelfLife: 'unknown',
          futureOpportunity: 'normal',
          marketHeat: null,
          rivalsWithNeed: null,
        },
        budgetState: budget(remaining),
        prices,
        season: { week, finalWeek: 14 },
      });
    const capped = rec(30, 10);
    expect(capped.recommended).toBeLessThanOrEqual(10);
    expect(capped.doNotExceed).toBeLessThanOrEqual(10);
    expect(capped.reasons.join(' ')).toContain('to keep $20 for the playoffs');
    const playoffs = rec(30, 15);
    expect(playoffs.recommended ?? 0).toBeGreaterThan(10);
  });
});

describe('W10: Sleeper trending adds are scanned', () => {
  it('the most-added free agents, best rank first, rostered and inactive players left out', () => {
    const players = [
      player({ id: 'a', fullName: 'A', position: 'RB', team: 'NE' }),
      player({ id: 'b', fullName: 'B', position: 'WR', team: 'NE' }),
      player({ id: 'c', fullName: 'C', position: 'RB', team: 'NE' }),
      player({ id: 'd', fullName: 'D', position: 'K', team: 'NE' }),
    ];
    const ids = trendingFreeAgentIds(players, {
      rosteredIds: new Set(['c']),
      startable: new Set(['QB', 'RB', 'WR', 'TE']),
      trending: new Map([
        ['b', { rank: 2 }],
        ['a', { rank: 5 }],
        ['c', { rank: 1 }],
        ['d', { rank: 3 }],
      ]),
      exclude: new Set(),
    });
    expect(ids).toEqual(['b', 'a']);
  });
});

describe('one rest-of-season function for Trades and Waivers', () => {
  it('the trade path and the shared module are the same functions', () => {
    expect(tradeRos.blendRate).toBe(sharedRos.blendRate);
    expect(tradeRos.seasonWeights).toBe(sharedRos.seasonWeights);
    expect(tradeRos.restOfSeasonBlend).toBe(sharedRos.restOfSeasonBlend);
  });

  it('a player has the same season rate on Waivers as on Trades', () => {
    const req = inputs(LOVE_CASE);
    const built = buildTierInputs(req);
    const love = built.request.roster.find((p) => p.playerId === 'Love')!;
    const input = req.rosterInputs.find((i) => i.player.id === 'Love')!;
    const trade = buildPlayerRate({
      evaluation: evaluatePlayer(input, PROFILE),
      seasonLine: null,
      recentWeek: null,
      weeks: HORIZON.weeks,
      byeWeek: 11,
      byeKnown: true,
      ahead: new Map([[10, 17.23], [12, 22.5]]),
      production: Array.from({ length: 8 }, () => 23.6),
    });
    expect(love.seasonRate).toBe(trade.rate);
    expect(trade.rate).toBeGreaterThan(20);
  });
});

describe('a bye-cover pickup counts the bye, not a toss-up (Kirk Cousins, 4 November)', () => {
  /*
   * The live card: Cousins covered Love's week 11 bye (+16.38) and was also
   * credited +1.59 to +1.80 in seven other weeks for "starting over" Love, all
   * under the 2.0 toss-up bar, for +30.89. Built here on the planner's own
   * rows: weeks 9 to 17, playoffs 1.5, Love on bye in week 11, Cousins in 13.
   */
  const weeks = [9, 10, 11, 12, 13, 14, 15, 16, 17];
  const weights = [1, 1, 1, 1, 1, 1, 1.5, 1.5, 1.5];
  const all = (v: number) => weeks.map(() => v);
  const row = (id: string, position: string, values: number[], weekly: number[] = all(1), byeWeek: number | null = null): TierPlayer => ({
    playerId: id, name: id, position, team: 'XX', rate: values[0]!, seasonRate: values[3]!, weekly, weekValues: values, designation: 'healthy', byeWeek,
  });
  const loveWeekly = weeks.map((w) => (w === 11 ? 0 : 1));
  const roster: TierPlayer[] = [
    row('Love', 'QB', [16.88, 17.23, 0, 21.24, 21.24, 21.24, 21.24, 21.24, 21.24], loveWeekly, 11),
    row('RB1', 'RB', all(16)), row('RB2', 'RB', all(13)), row('RB3', 'RB', all(10)),
    row('WR1', 'WR', all(15)), row('WR2', 'WR', all(13)), row('WR3', 'WR', all(11)), row('WR4', 'WR', all(9)),
    row('TE1', 'TE', all(9)), row('DEF1', 'DEF', all(7)),
    row('RB4', 'RB', all(8)), row('WR5', 'WR', all(8)), row('TE2', 'TE', all(7)), row('RB5', 'RB', all(6)), row('WR6', 'WR', all(6)),
    row('Lemon', 'WR', all(2)),
  ];
  const cousinsWeekly = weeks.map((w) => (w === 13 ? 0 : 1));
  const cousins = row('Cousins', 'QB', [18.68, 18.82, 18.38, 22.95, 22.95, 22.95, 22.95, 22.95, 22.95], cousinsWeekly, 13);
  const replacement = new Map([['QB', 17], ['RB', 7], ['WR', 7], ['TE', 6]]);

  it('counts only week 11, never the sub-2-point weeks over Love', () => {
    const p = planWaiverTiers({
      shape: SHAPE, weeks, weights, leadWeeks: 2, roster, candidates: [cousins], openSpots: 0, openReserve: 0,
      protections: new Map(), excludedPositions: new Set(['DEF']), replacement,
      season: { near: 3, replacement, scale: 4.2 },
    });
    const m = p.all.find((x) => x.name === 'Cousins')!;
    expect(m.reasonCode).toBe('bye_depth');
    expect(m.drop?.name).toBe('Lemon');
    /* The week-by-week changes are still shown as they are... */
    expect(m.byWeek.map((w) => w.change)).toEqual([1.8, 1.59, 18.38, 1.71, 0, 1.71, 1.71, 1.71, 1.71]);
    /* ...but the gain is the bye week alone: 18.38, not 18.38 + 14.51. */
    expect(m.lineupGain).toBe(18.38);
    /* The chip: that, plus the small backup-depth credit Trades also counts. Before the fix, 32.9 and more. */
    expect(m.gain).toBeCloseTo(m.lineupGain + m.insurance, 2);
    expect(m.gain).toBeLessThan(21);
  });

  it('a week he beats Love by 2.0 or more still counts', () => {
    const big = { ...cousins, weekValues: [19.0, 18.82, 18.38, 22.95, 22.95, 22.95, 22.95, 22.95, 22.95] };
    const p = planWaiverTiers({
      shape: SHAPE, weeks, weights, leadWeeks: 2, roster, candidates: [big], openSpots: 0, openReserve: 0,
      protections: new Map(), excludedPositions: new Set(['DEF']), replacement,
      season: { near: 3, replacement, scale: 4.2 },
    });
    const m = p.all.find((x) => x.name === 'Cousins')!;
    expect(m.byWeek[0]!.change).toBe(2.12);
    expect(m.lineupGain).toBe(20.5);
  });

  /*
   * A season starter is protected against a toss-up. Only Love is a free
   * drop here: every bench player is held (a hold is cut only when nobody
   * else can be), so the old code cut Love for a QB 1.71 a week better.
   */
  const held = new Map(roster.filter((x) => x.playerId !== 'Love').map((x) => [x.playerId, { kind: 'market_hold' as const, note: 'kept' }] as const));
  const plan = (add: TierPlayer) =>
    planWaiverTiers({
      shape: SHAPE, weeks, weights, leadWeeks: 2, roster, candidates: [add], openSpots: 0, openReserve: 0,
      protections: held, excludedPositions: new Set(['DEF']), replacement,
      season: { near: 3, replacement, scale: 4.2 },
    });

  it('within 2.0 of Love on season value: Love stays protected, is not the drop, and is not "replaced"', () => {
    const m = plan(cousins).all.find((x) => x.name === 'Cousins')!;
    expect(m.drop?.name).not.toBe('Love');
    /* The weeks Cousins only edges Love (1.59 to 1.80) count for nothing: the bye week is the gain. */
    expect(m.lineupGain).toBe(18.38);
    expect(m.reason).not.toMatch(/Starts over Love/);
  });

  it('a QB 1.71 a week better than Love, with no bye to cover, is no move at all', () => {
    const steady = { ...cousins, weekly: all(1), byeWeek: null, weekValues: [18.59, 18.94, 22.95, 22.95, 22.95, 22.95, 22.95, 22.95, 22.95] };
    const noBye = roster.map((x) => (x.playerId === 'Love' ? { ...x, weekly: all(1), byeWeek: null, weekValues: [16.88, 17.23, 21.24, 21.24, 21.24, 21.24, 21.24, 21.24, 21.24] } : x));
    const p = planWaiverTiers({
      shape: SHAPE, weeks, weights, leadWeeks: 2, roster: noBye, candidates: [steady], openSpots: 0, openReserve: 0,
      protections: held, excludedPositions: new Set(['DEF']), replacement,
      season: { near: 3, replacement, scale: 4.2 },
    });
    const m = p.all.find((x) => x.name === 'Cousins')!;
    expect(m.drop?.name).not.toBe('Love');
    expect(m.lineupGain).toBe(0);
    expect([...p.doThese, ...p.consider].map((x) => x.name)).not.toContain('Cousins');
  });

  it('2.0 or more better than Love on season value: Love may be replaced and cut', () => {
    const better = { ...cousins, seasonRate: 23.3, weekValues: [18.68, 18.82, 18.38, 23.3, 23.3, 23.3, 23.3, 23.3, 23.3] };
    const m = plan(better).all.find((x) => x.name === 'Cousins')!;
    expect(m.drop?.name).toBe('Love');
  });
});
