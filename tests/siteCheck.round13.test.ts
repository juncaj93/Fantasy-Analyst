/**
 * Round 13 (whole-site check, 8 November 2026): each case is one place two
 * screens disagreed, or one of Alex's rules was skipped, before this round.
 * Every test here fails on 97d1a39.
 *
 *  1. Waivers in the playoffs: from week 15 (or week 14 once its games start)
 *     the season value and the 1.5 playoff weight switched off, NFL week 18
 *     counted, and a season starter could be the drop (Darnold for Love).
 *  2. The free-agent baseline counted a Doubtful player (Doubtful is Out).
 *  3. Team docked a Questionable player for late-swap risk (S7), so it
 *     benched the wrong man and hid a swap Compare calls a Start.
 *  4. Team gated a swap on the raw gap (S6): a priced 14 over a Sleeper-only
 *     14.5 (12.5 ranked) was nothing on Team and a toss-up on Compare.
 *  5. A locked starter in Sleeper's FLEX was re-seated in RB (S4), so Team
 *     asked for a receiver in an RB slot Sleeper cannot give him.
 *  6. Pick up and start measured its gain on raw numbers, skipping minus-2.
 *  7. A partial-market gap under 2 points: Team said toss-up, Compare said Start.
 *  8. Matchup filled a hole only from players the hole's slot accepts, where
 *     Team moves starters between slots and names somebody else.
 *  9. A played game worth zero was dropped from a player's bounce (spread).
 */

import { describe, expect, it } from 'vitest';
import { buildTierInputs, type TierInputRequest } from '../src/core/waivers/tierInputs.ts';
import { planWaiverTiers } from '../src/core/waivers/tiers.ts';
import { tradeHorizon } from '../src/core/tradeValue/weeks.ts';
import { replacementLevels } from '../src/core/tradeValue/evaluate.ts';
import type { PlayerRate } from '../src/core/tradeValue/rate.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { compareStartSit, type StartSitInput } from '../src/core/startsit/engine.ts';
import { currentSlotsOf } from '../src/core/startsit/sleeperLineup.ts';
import { planPickupStart, type PickupPlayer } from '../src/core/waivers/pickupStart.ts';
import { assessLineupDecision } from '../src/core/matchup/decision.ts';
import { gamesPlayed, readSpread } from '../src/core/startsit/spread.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6, pass_int: -2, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

/* ---------------------------------------------------------------- 1. Waivers in the playoffs */

describe('Waivers keeps season value through the playoffs', () => {
  const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'IR', 'IR'];
  const SHAPE = buildRosterShape(POSITIONS);
  const LEAGUE = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11 };
  const NOW = new Date('2026-12-16T15:00:00.000Z');
  const KICKOFF = '2026-12-20T18:00:00.000Z';
  const TEAMS = ['GB', 'SEA', 'PHI', 'DAL', 'MIA', 'BUF', 'KC', 'DET', 'CHI', 'NYJ', 'LAR', 'ATL', 'DEN', 'HOU', 'PIT', 'MIN'];
  const fixtures = (from: number): ScheduleTeamWeek[] =>
    TEAMS.flatMap((team) =>
      Array.from({ length: 19 - from }, (_, k) => ({ season: '2026', week: from + k, team, opponent: 'OPP', home: true, kickoff: KICKOFF, roof: null })),
    );
  const p = (id: string, pos: string, pts: number | null, team: string): StartSitInput => pricedCandidate(id, id, pos, pts, { team, kickoff: KICKOFF });
  const roster = (): StartSitInput[] => [
    p('Love', 'QB', 16.88, 'GB'), p('Bijan', 'RB', 18, 'ATL'), p('Walker', 'RB', 14, 'DAL'), p('JSN', 'WR', 16, 'SEA'),
    p('McConkey', 'WR', 12, 'MIA'), p('Worthy', 'WR', 10, 'KC'), p('LaPorta', 'TE', 10, 'DET'), p('Allen', 'RB', 11, 'NYJ'),
    p('Concepcion', 'WR', 9.5, 'BUF'), p('Coleman', 'RB', 8, 'DEN'), p('EJohnson', 'RB', 7, 'CHI'), p('Cooper', 'WR', 7.5, 'LAR'),
    p('AWilliams', 'WR', 6, 'HOU'), p('Higbee2', 'TE', 6, 'MIN'), p('Robinson', 'RB', 6.5, 'ATL'), p('Lemon', 'WR', 2, 'PHI'),
  ];
  const wire = [
    p('FaRB1', 'RB', 7, 'KC'), p('FaRB2', 'RB', 6.5, 'BUF'), p('FaRB3', 'RB', 6, 'DET'), p('FaWR1', 'WR', 7, 'CHI'),
    p('FaWR2', 'WR', 6.5, 'NYJ'), p('FaWR3', 'WR', 6, 'LAR'), p('FaTE1', 'TE', 6, 'ATL'), p('FaTE2', 'TE', 5.5, 'DEN'), p('FaTE3', 'TE', 5, 'HOU'),
  ];
  const held = ['Coleman', 'EJohnson', 'Cooper', 'AWilliams', 'Higbee2', 'Robinson'];
  const perGame: Record<string, number> = { Love: 23.6, Darnold: 17.2, Lemon: 6.5, Bijan: 18, JSN: 16 };

  function request(week: number, now: Date = NOW): TierInputRequest {
    const mine = roster();
    const cands = [p('Darnold', 'QB', 23.51, 'SEA'), ...wire];
    const all = [...mine, ...cands];
    const horizon = tradeHorizon({ leagueSettings: LEAGUE, currentWeek: week });
    return {
      shape: SHAPE,
      profile: PROFILE,
      week,
      now,
      rosterInputs: mine,
      candidateInputs: cands,
      rosteredIds: new Set(mine.map((i) => i.player.id)),
      reserveIds: [],
      fixtures: fixtures(week),
      pickup: Object.fromEntries(cands.map((x) => [x.player.id, { state: 'free' as const, reason: null, until: null }])),
      held: new Map(held.map((id) => [id, 'kept'] as const)),
      reserveSlots: 2,
      excludedPositions: new Set(['DEF']),
      ahead: {
        sleeper: new Map([
          [week + 1, new Map([['Love', 22.5], ['Darnold', 18]])],
          [week + 2, new Map([['Love', 22.5], ['Darnold', 18]])],
        ]),
      },
      seasonPoints: new Map(Object.entries(perGame).map(([id, pg]) => [id, Array.from({ length: week - 1 }, () => pg)] as const)),
      seasonPointsThrough: week - 1,
      teamOf: (id) => all.find((i) => i.player.id === id)?.player.team ?? null,
      positionOf: (id) => all.find((i) => i.player.id === id)?.player.position ?? null,
      currentStarterIds: ['Love', 'Bijan', 'Walker', 'JSN', 'McConkey', 'Worthy', 'LaPorta', 'Allen', 'Concepcion'],
      season: { weeks: horizon.weeks, playoffWeeks: horizon.playoffWeeks },
    };
  }

  it('values week 15 on the season, every playoff week at 1.5', () => {
    const built = buildTierInputs(request(15)).request;
    expect(built.weeks).toEqual([15, 16, 17]);
    expect(built.weights).toEqual([1.5, 1.5, 1.5]);
    expect(built.season).toBeDefined();
  });

  it('never counts NFL week 18, which has no fantasy game', () => {
    expect(buildTierInputs(request(16)).request.weeks).toEqual([16, 17]);
    expect(buildTierInputs(request(17)).request.weeks).toEqual([17]);
  });

  it('keeps the season once week 14 has kicked off', () => {
    const afterKickoff = new Date('2026-12-20T20:00:00.000Z');
    const built = buildTierInputs(request(14, afterKickoff)).request;
    expect(built.weeks).toEqual([15, 16, 17]);
    expect(built.weights).toEqual([1.5, 1.5, 1.5]);
  });

  it('does not drop Love (about 22 a game) for Darnold in week 15', () => {
    /* The live wire: three free QBs, Sleeper's next weeks as the review read them. */
    const base = request(15);
    const qbs = [p('Darnold', 'QB', 23.51, 'SEA'), p('Willis', 'QB', 19.66, 'MIA'), p('Rodgers', 'QB', null, 'PIT')];
    const cands = [...qbs, ...wire];
    const req: TierInputRequest = {
      ...base,
      candidateInputs: cands,
      pickup: Object.fromEntries(cands.map((x) => [x.player.id, { state: 'free' as const, reason: null, until: null }])),
      ahead: {
        sleeper: new Map([
          [16, new Map([['Love', 17.23], ['Darnold', 19.79], ['Willis', 16.12], ['Rodgers', 18]])],
          [17, new Map([['Love', 22.5], ['Darnold', 18], ['Willis', 15.5], ['Rodgers', 17]])],
        ]),
      },
      seasonPoints: new Map(
        Object.entries({ ...perGame, Willis: 15, Rodgers: 16.5 }).map(([id, pg]) => [id, Array.from({ length: 14 }, () => pg)] as const),
      ),
      teamOf: (id) => [...base.rosterInputs, ...cands].find((i) => i.player.id === id)?.player.team ?? null,
      positionOf: (id) => [...base.rosterInputs, ...cands].find((i) => i.player.id === id)?.player.position ?? null,
    };
    const plan = planWaiverTiers(buildTierInputs(req).request);
    const darnold = plan.all.find((m) => m.name === 'Darnold');
    expect(darnold?.drop?.name ?? null).not.toBe('Love');
  });
});

/* ---------------------------------------------------------------- 2. Doubtful free agent baseline */

describe('the free-agent baseline', () => {
  const rate = (id: string, value: number, designation: string): PlayerRate =>
    ({ playerId: id, name: id, position: 'RB', team: 'X', rate: value, basis: 'market', rateNote: null, designation, games: 1, weekly: [0], injuryNote: null, byeWeek: null, byeKnown: true, byeInside: false, onReserve: false }) as unknown as PlayerRate;

  it('leaves out a Doubtful free agent, as it leaves out an Out one', () => {
    const levels = replacementLevels([rate('Doubtful', 15, 'doubtful'), rate('A', 7, 'healthy'), rate('B', 6, 'healthy'), rate('C', 5, 'healthy'), rate('Out', 15, 'out')]);
    expect(levels.get('RB')?.names).toEqual(['A', 'B', 'C']);
    expect(levels.get('RB')?.rate).toBe(6);
  });
});

/* ---------------------------------------------------------------- 3 to 5. Team against Compare */

describe('Team and Compare agree', () => {
  const POS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN'];
  const SHAPE = buildRosterShape(POS);
  const ONE_WR = buildRosterShape(['WR', 'BN', 'BN']);
  const ONE = '2026-09-13T17:00:00.000Z';
  const NIGHT = '2026-09-14T00:20:00.000Z';

  it('S7: a Questionable player is not docked, so Team makes the swap Compare calls a Start', () => {
    const NOW = '2026-09-13T15:00:00.000Z';
    const k = (kickoff: string, status?: string) => ({ kickoff, now: NOW, ...(status ? { status } : {}) });
    const inputs = [
      pricedCandidate('qb1', 'QB One', 'QB', 20, k(ONE)),
      pricedCandidate('rb1', 'RB One', 'RB', 15, k(ONE)),
      pricedCandidate('rb2', 'RB Two', 'RB', 14, k(ONE)),
      pricedCandidate('wr1', 'WR One', 'WR', 16, k(ONE)),
      pricedCandidate('qA', 'Q Receiver', 'WR', 12, k(NIGHT, 'Questionable')),
      pricedCandidate('wD', 'Flex Receiver', 'WR', 11.7, k(ONE)),
      pricedCandidate('wC', 'Bench Receiver', 'WR', 13.8, k(ONE)),
      pricedCandidate('te1', 'TE One', 'TE', 8, k(ONE)),
    ];
    const r = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'qA', 'te1', 'wD'], now: NOW });
    expect(r.slots.some((s) => s.playerId === 'qA')).toBe(true);
    expect(r.swaps.map((s) => [s.inPlayerId, s.outPlayerId])).toEqual([['wC', 'wD']]);
    expect(compareStartSit([inputs[6]!, inputs[5]!], PROFILE).recommendedPlayerId).toBe('wC');
  });

  it('S6: a priced 14 over a Sleeper-only 14.5 is a toss-up on both', () => {
    const inP = pricedCandidate('in', 'Priced Bench', 'WR', 14);
    const outP = candidate('out', 'Sleeper Starter', 'WR', 3);
    const published = new Map([['out', 14.5]]);
    const r = recommendLineup([inP, outP], ONE_WR, PROFILE, { currentStarterIds: ['out'], published });
    expect(r.swaps).toEqual([]);
    expect(r.tossUps?.map((t) => [t.inPlayerId, t.outPlayerId])).toEqual([['in', 'out']]);
    expect(compareStartSit([inP, outP], PROFILE, { published }).tossUp?.leanPlayerId).toBe('in');
  });

  it('S6: a priced number 1 above a Sleeper-only one clears the bar on ranking numbers (1 raw, 2 ranked)', () => {
    const published = new Map([['out', 13.5]]);
    const r = recommendLineup([pricedCandidate('in', 'Priced Bench', 'WR', 14.5), candidate('out', 'Sleeper Starter', 'WR', 3)], ONE_WR, PROFILE, {
      currentStarterIds: ['out'],
      published,
    });
    expect(r.swaps.map((s) => s.inPlayerId)).toEqual(['in']);
  });

  it('S4: a locked back in Sleeper\'s FLEX stays in FLEX, and no receiver is asked into an RB slot', () => {
    const NOW = '2026-09-13T18:00:00.000Z';
    const k = (kickoff: string) => ({ kickoff, now: NOW });
    const inputs = [
      pricedCandidate('qb1', 'QB One', 'QB', 20, k(NIGHT)),
      pricedCandidate('rb1', 'RB One', 'RB', 15, k(NIGHT)),
      pricedCandidate('rb2', 'RB Two', 'RB', 9, k(NIGHT)),
      pricedCandidate('rb3', 'RB Locked', 'RB', 11, k(ONE)),
      pricedCandidate('wr1', 'WR One', 'WR', 14, k(NIGHT)),
      pricedCandidate('wr2', 'WR Two', 'WR', 13, k(NIGHT)),
      pricedCandidate('wr3', 'WR Bench', 'WR', 15, k(NIGHT)),
      pricedCandidate('te1', 'TE One', 'TE', 8, k(NIGHT)),
    ];
    const slotIds = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'];
    const r = recommendLineup(inputs, SHAPE, PROFILE, { currentStarterIds: slotIds, now: NOW, currentSlotOf: currentSlotsOf(POS, slotIds) });
    expect(r.slots.find((s) => s.playerId === 'rb3')?.slot).toBe('FLEX');
    expect(r.swaps.some((s) => s.outPlayerId === 'rb2')).toBe(false);
    /* The legal move: the bench receiver over the weaker receiver, 2.0 better. */
    expect(r.swaps.map((s) => [s.inPlayerId, s.outPlayerId])).toEqual([['wr3', 'wr2']]);
  });

  it('reads Sleeper\'s slot for each starter from the stored order', () => {
    expect([...currentSlotsOf(POS, ['qb1', 'rb1', null, 'wr1', 'wr2', 'te1', 'rb3'])]).toEqual([
      ['qb1', 'QB'], ['rb1', 'RB'], ['wr1', 'WR'], ['wr2', 'WR'], ['te1', 'TE'], ['rb3', 'FLEX'],
    ]);
    expect(currentSlotsOf(POS, ['qb1']).size).toBe(0);
  });

  it('a partial-market gap under 2 points is a toss-up on Compare, as on Team', () => {
    const inP = candidate('in', 'Partial Guy', 'WR', 11.5);
    const outP = pricedCandidate('out', 'Starter Guy', 'WR', 10);
    const r = recommendLineup([inP, outP], ONE_WR, PROFILE, { currentStarterIds: ['out'] });
    expect(r.tossUps?.map((t) => t.inPlayerId)).toEqual(['in']);
    const c = compareStartSit([inP, outP], PROFILE);
    expect(c.recommendedPlayerId).toBeNull();
    expect(c.tossUp?.leanPlayerId).toBe('in');
  });
});

/* ---------------------------------------------------------------- 6. Pick up and start */

describe('Pick up and start', () => {
  it('measures the gain on ranking numbers, as Team does', () => {
    const shape = buildRosterShape(['WR', 'BN', 'BN']);
    const pp = (id: string, points: number, basis: PickupPlayer['basis']): PickupPlayer =>
      ({ playerId: id, name: id, position: 'WR', team: 'NE', points, basis, ruledOut: false, locked: false, designation: null }) as PickupPlayer;
    const plan = planPickupStart({
      shape,
      roster: [pp('Owned', 11, 'published')],
      candidates: [pp('FA', 12.5, 'market')],
      currentStarterIds: ['Owned'],
      pickup: { FA: { state: 'free', reason: null, until: null } } as never,
      openSpots: 1,
    });
    /* 12.5 against a Sleeper-only 11 (10 ranked): +2.5, a start. */
    expect(plan.start?.name).toBe('FA');
    expect(plan.start?.gain).toBeCloseTo(2.5, 2);
  });
});

/* ---------------------------------------------------------------- 8. Matchup's hole fill */

describe('Matchup fills a hole the way Team does', () => {
  it('a bench receiver fills an Out back\'s RB slot when the FLEX back slides over', () => {
    const shape = buildRosterShape(['RB', 'WR', 'FLEX', 'BN', 'BN', 'BN']);
    const inputs = [
      pricedCandidate('rbOut', 'RB Out', 'RB', 14, { status: 'Out' }),
      pricedCandidate('wr1', 'WR One', 'WR', 13),
      pricedCandidate('rbFlex', 'RB Flex', 'RB', 12),
      pricedCandidate('wrB', 'WR Bench', 'WR', 15),
      pricedCandidate('rbB', 'RB Bench', 'RB', 6),
    ];
    const team = recommendLineup(inputs, shape, PROFILE, { currentStarterIds: ['rbOut', 'wr1', 'rbFlex'] });
    const teamIn = team.swaps.find((s) => s.outPlayerId === 'rbOut')?.inPlayerId;
    expect(teamIn).toBe('wrB');

    const mk = (id: string, position: string, projection: number, starting: boolean, slot: string | null, ruledOut = false) =>
      ({ playerId: id, name: id, position, team: 'NE', opponent: null, slot, starting, side: 'mine', projection, actual: 0, kickoff: null, roleBucket: 'unclassified', availability: 'unknown', ruledOut }) as unknown as MatchupPlayerInput;
    const players = [mk('rbOut', 'RB', 14, true, 'RB#0', true), mk('wr1', 'WR', 13, true, 'WR#0'), mk('rbFlex', 'RB', 12, true, 'FLEX#0'), mk('wrB', 'WR', 15, false, null), mk('rbB', 'RB', 6, false, null)];
    const result = { winProbability: 0.5, draws: 1, mine: [40], theirs: [40], samples: new Map(), settledById: new Map() } as never;
    const decision = assessLineupDecision({
      result,
      players,
      distributions: players.map((x) => ({ playerId: x.playerId, phase: 'not_started' })) as never,
      slots: [
        { key: 'RB#0', slot: 'RB', accepts: ['RB'] },
        { key: 'WR#0', slot: 'WR', accepts: ['WR'] },
        { key: 'FLEX#0', slot: 'FLEX', accepts: ['RB', 'WR', 'TE'] },
      ],
    });
    expect(decision.fills.map((f) => f.inPlayerId)).toEqual([teamIn]);
  });
});

/* ---------------------------------------------------------------- 9. Spread */

describe('a played game worth zero counts in his bounce', () => {
  it('keeps a zero the usage store has him playing, and drops a bye', () => {
    /* Week 2 he played and scored 0; week 3 was his bye. */
    expect(gamesPlayed([10, 0, 0, 12], new Set([1, 2, 4]))).toEqual([10, 0, 12]);
    expect(gamesPlayed([10, 0, 0, 12])).toEqual([10, 12]);
    const withZero = readSpread({ position: 'WR', seasonPoints: [10, 0, 0, 12, 11, 9], playedWeeks: new Set([1, 2, 4, 5, 6]) });
    const without = readSpread({ position: 'WR', seasonPoints: [10, 0, 0, 12, 11, 9] });
    expect(withZero.games).toBe(5);
    expect(without.games).toBe(4);
    expect(withZero.share).toBeGreaterThan(without.share);
  });
});

/* ---------------------------------------------------------------- 10. A locked starter in Pick up and start (production, 8 November) */

describe('Pick up and start never benches a starter whose game has kicked off', () => {
  const shape = buildRosterShape(['QB', 'WR', 'BN', 'BN']);
  const pp = (id: string, position: string, points: number, locked = false): PickupPlayer =>
    ({ playerId: id, name: id, position, team: 'NE', points, basis: 'market', ruledOut: false, locked, designation: null }) as PickupPlayer;
  const plan = (faPoints: number) =>
    planPickupStart({
      shape,
      roster: [pp('Love', 'QB', 19.02, true), pp('WR1', 'WR', 12, true)],
      candidates: [pp('Mayfield', 'QB', faPoints)],
      currentStarterIds: ['Love', 'WR1'],
      pickup: { Mayfield: { state: 'free', reason: null, until: null } } as never,
      openSpots: 1,
    });

  it('a Monday-night QB who ties a locked QB is no call at all', () => {
    const p = plan(19.45);
    expect(p.start).toBeNull();
    expect(p.consider).toEqual([]);
  });

  it('nor one who would clear the bar: the slot is locked', () => {
    expect(plan(25).start).toBeNull();
  });
});
