/**
 * The contradiction reported on 8 September 2026, in the three places it lived.
 *
 * Setup's Data Health said `Vegas lines: Current · 8h ago`. On the same
 * afternoon, in the same app, a rostered starter's card said "no betting market
 * has priced him" and the Team screen recommended benching him — a 19.4-point
 * back — for two players projected 9.8 and 5.5. Both statements were produced
 * by code doing exactly what it had been written to do, which is why neither
 * looked broken on its own.
 *
 * Three separate faults, held apart here so a regression in one is legible:
 *
 *   1. the health row counted stored *envelopes* rather than priced players, so
 *      a refresh that landed two games and zero usable quotes read as healthy;
 *   2. discovery bought a bounded number of teams per run and stamped its
 *      "asked" marker anyway, so a roster spanning more teams than one run can
 *      reach starved the same tail for ever;
 *   3. the lineup's "no market, no ranking" guard was asked of the whole roster
 *      instead of of each player, so one priced player anywhere switched it off
 *      and the rest were ranked against each other on news tallies.
 */

import { describe, expect, it } from 'vitest';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import { MockVegasProvider, type MockRoster } from '../src/core/vegas/mockProvider.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const NOW = new Date('2026-09-08T12:00:00.000Z');

/** An envelope with no player quotes in it — a fetch that landed and taught nothing. */
async function storeEmptySnapshot(db: Awaited<ReturnType<typeof createTestDb>>, eventId: string, fetchedAt: string) {
  await new PropsRepo(db).put({
    provider: 'sportsgameodds',
    eventId,
    gameStart: '2026-09-13T17:00:00.000Z',
    fetchedAt,
    raw: { provider: 'sportsgameodds', eventId, gameStart: '', fetchedAt: '', quotes: [], raw: null } as never,
  });
}

describe('Data Health reports the market, not the fetch', () => {
  it('does not call a market current when no player in it has a line', async () => {
    const db = await createTestDb();
    await storeEmptySnapshot(db, 'evt-1', new Date(NOW.getTime() - 8 * 3_600_000).toISOString());
    await storeEmptySnapshot(db, 'evt-2', new Date(NOW.getTime() - 9 * 3_600_000).toISOString());

    const props = new PropsRepo(db);
    // The fetch genuinely landed, and recently. That was the whole of the old
    // reading, and on its own it is not a market.
    expect((await props.freshness()).events).toBe(2);
    expect(await props.pricedPlayerCount()).toBe(0);

    const vegas = (await new DataHealthService(db, { now: () => NOW }).view()).sources.find((s) => s.id === 'vegas')!;
    expect(vegas.state).toBe('degraded');
    expect(vegas.note).toMatch(/no player has a usable line/i);
  });

  it('reports the newest snapshot rather than an arbitrary one', async () => {
    const db = await createTestDb();
    // Stored oldest last, which a re-fetch of an earlier event produces.
    await storeEmptySnapshot(db, 'evt-new', '2026-09-08T11:00:00.000Z');
    await storeEmptySnapshot(db, 'evt-old', '2026-08-31T04:00:00.000Z');

    const freshness = await new PropsRepo(db).freshness();
    expect(freshness.fetchedAt).toBe('2026-09-08T11:00:00.000Z');
    expect(freshness.provider).toBe('sportsgameodds');
  });
});

/** Alex's roster, at its real size: fifteen players across twelve NFL teams. */
const ROSTER = [
  { id: 'p01', name: 'Passer One', pos: 'QB', team: 'CIN' },
  { id: 'p02', name: 'Runner Two', pos: 'RB', team: 'ATL' },
  { id: 'p03', name: 'Runner Three', pos: 'RB', team: 'BUF' },
  { id: 'p04', name: 'Catcher Four', pos: 'WR', team: 'LAR' },
  { id: 'p05', name: 'Catcher Five', pos: 'WR', team: 'NYJ' },
  { id: 'p06', name: 'Catcher Six', pos: 'WR', team: 'MIA' },
  { id: 'p07', name: 'Runner Seven', pos: 'RB', team: 'SEA' },
  { id: 'p08', name: 'Ender Eight', pos: 'TE', team: 'BAL' },
  { id: 'p09', name: 'Runner Nine', pos: 'RB', team: 'DEN' },
  { id: 'p10', name: 'Passer Ten', pos: 'QB', team: 'GB' },
  { id: 'p11', name: 'Catcher Eleven', pos: 'WR', team: 'CHI' },
  { id: 'p12', name: 'Ender Twelve', pos: 'TE', team: 'TEN' },
  { id: 'p13', name: 'Runner Thirteen', pos: 'RB', team: 'CLE' },
  { id: 'p14', name: 'Catcher Fourteen', pos: 'WR', team: 'SF' },
  { id: 'p15', name: 'Catcher Fifteen', pos: 'WR', team: 'ARI' },
];

function fixtures(): MockRoster[] {
  return [...new Set(ROSTER.map((p) => p.team))].map((team, i) => ({
    eventId: `evt-${team}`,
    startTime: '2026-09-13T17:00:00.000Z',
    homeTeam: team,
    awayTeam: `OPP${i}`,
    players: ROSTER.filter((p) => p.team === team).map((p) => ({ name: p.name, position: p.pos, team: p.team })),
  }));
}

async function seedRoster(db: Awaited<ReturnType<typeof createTestDb>>) {
  await new PlayerRepo(db).upsertMany(
    ROSTER.map((p) => player({ id: p.id, fullName: p.name, position: p.pos, team: p.team })),
  );
  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'lg1', sleeperLeagueId: 'lg1', name: "Tony's Pizza Fantasy", season: '2026', totalRosters: 10,
    scoringSettings: {},
    rosterPositions: ['QB','RB','RB','WR','WR','WR','FLEX','FLEX','DEF','BN','BN','BN','BN','BN','BN'],
    leagueSettings: {}, draftId: null, status: 'in_season', lastSyncedAt: NOW.toISOString(),
  } as never);
  await leagues.replaceRosters('lg1', [
    { leagueId: 'lg1', rosterId: 1, ownerId: 'u1', ownerName: 'Alex',
      playerIds: ROSTER.map((p) => p.id), starterIds: ROSTER.slice(0, 9).map((p) => p.id),
      reserveIds: [], isMine: true, settings: {} } as never,
  ]);
  await leagues.selectLeague('lg1');
}

describe('discovery finishes a roster it cannot buy in one run', () => {
  it('reaches every roster team across scheduled runs instead of starving the same tail', async () => {
    const db = await createTestDb();
    await seedRoster(db);
    const teams = new Set(ROSTER.map((p) => p.team));
    // The premise: more teams than one run's entity ceiling allows.
    expect(teams.size).toBeGreaterThan(9);

    const service = new VegasRefreshService(db, new MockVegasProvider(fixtures()));
    const props = new PropsRepo(db);
    const pricedCount = async () =>
      [...(await props.latestForPlayers(ROSTER.map((p) => p.id))).values()].filter((v) => v.length > 0).length;

    await service.refresh({ now: NOW.getTime() });
    const afterFirst = await pricedCount();
    // One run buys what the budget allows and no more — that rule is unchanged.
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(ROSTER.length);

    // The next scheduled clock, sixteen hours later and well inside the
    // three-day politeness interval. This used to do no discovery at all.
    await service.refresh({ now: NOW.getTime() + 16 * 3_600_000 });
    expect(await pricedCount()).toBe(ROSTER.length);
  });

  it('leaves the interval alone once the whole roster has been asked about', async () => {
    const db = await createTestDb();
    await seedRoster(db);
    const service = new VegasRefreshService(db, new MockVegasProvider(fixtures()));
    await service.refresh({ now: NOW.getTime() });
    await service.refresh({ now: NOW.getTime() + 16 * 3_600_000 });

    // Everybody is mapped now, so a third run inside the interval buys nothing.
    const third = await service.refresh({ now: NOW.getTime() + 20 * 3_600_000 });
    expect(third.discovered).toBe(0);
  });
});

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, [],
);
const SHAPE = buildRosterShape(['QB','RB','RB','WR','WR','WR','FLEX','FLEX','DEF','BN','BN','BN','BN','BN','BN']);

function signal(net: number): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items: 3 };
  s.last30 = { ...s.raw };
  return s;
}
function unpriced(id: string, name: string, position: string, net: number): StartSitInput {
  return { player: player({ id, fullName: name, position, team: 'NE' }), props: [], signal: signal(net), injuryStatus: null, propsStale: false };
}
function priced(id: string, name: string, position: string, points: number): StartSitInput {
  return {
    player: player({ id, fullName: name, position, team: 'NE' }),
    props: [{ playerId: id, sourcePlayerName: name, market: position === 'QB' ? 'pass_yards' : 'receiving_yards',
      line: position === 'QB' ? points / 0.04 : points * 10, overPrice: -110, underPrice: -110,
      bookCount: 3, consensusMethod: 'median', books: ['a','b','c'], impliedProbability: null }],
    signal: null, injuryStatus: null, propsStale: false,
  };
}

describe('a part-priced roster is not reordered on news tallies', () => {
  /*
   * The reported lineup: a quarterback and one back the books had quoted, and
   * seven starters they had not. The two priced players are what used to
   * switch the guard off for the other seven.
   */
  const roster = [
    priced('p01', 'Priced Passer', 'QB', 26.9),
    priced('p03', 'Priced Back', 'RB', 13.2),
    unpriced('p02', 'Bijan Robinson', 'RB', -1),
    unpriced('p07', 'Kenneth Walker', 'RB', 2),
    unpriced('p09', 'RJ Harvey', 'RB', 3),
    unpriced('p04', 'Catcher Four', 'WR', 0),
    unpriced('p05', 'Catcher Five', 'WR', 0),
    unpriced('p06', 'Catcher Six', 'WR', 0),
    unpriced('p08', 'Ender Eight', 'TE', 0),
  ];
  const current = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p08', 'p07'];

  it('keeps an unpriced starter the books have not priced against', () => {
    const out = recommendLineup(roster, SHAPE, HALF_PPR, { currentStarterIds: current });
    const started = new Set(out.slots.map((s) => s.playerId).filter(Boolean));

    // The headline: a bench player with a friendlier newsletter tally does not
    // take a starting slot off a player nobody has priced either.
    expect(started.has('p02')).toBe(true);
    expect(started.has('p09')).toBe(false);
    expect(out.slots.filter((s) => s.playerId && !s.alreadyStarting)).toEqual([]);
  });

  it('says out loud that most of the lineup was not ranked', () => {
    const out = recommendLineup(roster, SHAPE, HALF_PPR, { currentStarterIds: current });
    expect(out.notes.join(' ')).toMatch(/no betting market has priced 7 of your 9 players/i);
  });

  it('does not let Ceiling mode stack the unpriced remainder', () => {
    const out = recommendLineup(roster, SHAPE, HALF_PPR, { currentStarterIds: current, mode: 'ceiling' });
    expect(out.slots.filter((s) => s.playerId && !s.alreadyStarting)).toEqual([]);
  });

  it('still benches an unpriced starter for a player the books have quoted', () => {
    /*
     * The one-sidedness survives, and has to: a bye week is an unpriced
     * starter, and replacing him with somebody actually quoted is a real
     * comparison rather than a reordering of noise.
     */
    const mixed = [
      priced('q1', 'Priced Passer', 'QB', 20),
      priced('r1', 'Priced One', 'RB', 15),
      priced('r2', 'Priced Two', 'RB', 12),
      priced('w1', 'Priced Three', 'WR', 14),
      priced('w2', 'Priced Four', 'WR', 11),
      unpriced('w3', 'Bye Week Wideout', 'WR', 0),
      priced('w4', 'Priced Five', 'WR', 10),
      priced('t1', 'Priced Six', 'TE', 8),
      priced('r3', 'Priced Seven', 'RB', 9),
    ];
    const out = recommendLineup(mixed, SHAPE, HALF_PPR, {
      currentStarterIds: ['q1', 'r1', 'r2', 'w1', 'w2', 'w3', 't1', 'r3'],
    });
    expect(out.swaps.map((s) => s.outPlayerId)).toContain('w3');
    expect(out.swaps.every((s) => s.inPlayerId !== 'w3')).toBe(true);
  });

  it('ranks a fully priced lineup exactly as it always did', () => {
    const allPriced = [
      priced('q1', 'Priced Passer', 'QB', 20),
      priced('r1', 'Priced One', 'RB', 15),
      priced('r2', 'Priced Two', 'RB', 12),
      priced('w1', 'Priced Three', 'WR', 14),
      priced('w2', 'Priced Four', 'WR', 11),
      priced('w3', 'Priced Eight', 'WR', 13),
      priced('w4', 'Priced Five', 'WR', 10),
      priced('t1', 'Priced Six', 'TE', 8),
      priced('r3', 'Priced Seven', 'RB', 9),
    ];
    const out = recommendLineup(allPriced, SHAPE, HALF_PPR, {
      currentStarterIds: ['q1', 'r1', 'r2', 'w1', 'w2', 'w3', 't1', 'w4'],
    });
    // The best nine by market expectation, and no coverage note.
    expect(out.slots.find((s) => s.slot === 'QB')?.playerId).toBe('q1');
    expect(out.notes.join(' ')).not.toMatch(/no betting market has priced/i);
  });
});
