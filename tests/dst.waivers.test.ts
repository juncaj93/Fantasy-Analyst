/**
 * Where the defence answer surfaces, and the one thing it must never do there.
 *
 * Team and Waivers draw the same recommendation from the same response, so the
 * failure this file exists to prevent is two of them: a board offering `Add
 * Pittsburgh` while the planner says `Wait — no DST needed yet`, or a defence
 * ranked on a board with no sense of what the roster spot costs.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildWaiverBoard, offeredPositions, rowMatches, type WaiverAdviceLike } from '../src/core/waivers/board.ts';
import { planDst, type DstPlan, type DstPlanInput } from '../src/core/dst/planner.ts';
import { buildDstPlan, playoffContextFor } from '../src/server/services/dstPlanService.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { buildStartSitContext } from '../src/server/services/startSitInputs.ts';
import { SettingsRepo, SETTING_KEYS } from '../src/server/repos/settings.ts';
import { VegasEventsRepo } from '../src/server/repos/vegasEvents.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { candidate, defence } from './helpers/startsit.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING } from '../src/core/demo/fixtures/dst.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

const SHAPE = buildRosterShape(DST_ROSTER_POSITIONS);
const PROFILE = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);

/* ------------------------------------------------------------ the board */

function planFor(over: Partial<DstPlanInput> = {}): DstPlan {
  return planDst({
    now: '2026-09-10T12:00:00.000Z',
    currentWeek: 3,
    shape: SHAPE,
    bestBall: false,
    draftComplete: true,
    nextKickoff: '2026-09-11T00:20:00.000Z',
    rostered: [],
    available: [],
    streaming: null,
    roster: { openSpots: 1, dropCandidate: null },
    playoff: { weeks: [15, 16, 17], emphasis: 0 },
    ...over,
  });
}

function option(team: string, thisWeek: number) {
  return {
    playerId: team.toLowerCase(),
    name: `${team} Defense`,
    team,
    thisWeek,
    confidence: 'high' as const,
    unavailable: false,
    unavailableReason: null,
    locked: false,
    opponent: 'OPP',
    opponentImpliedTotal: 18,
    forward: null,
    playoff: null,
  };
}

function advice(over: Partial<WaiverAdviceLike> = {}): WaiverAdviceLike {
  return { upgrades: [], headline: null, notes: [], considered: 4, ...over };
}

describe('a defence on the waiver board', () => {
  it('appears as a row when the planner names one', () => {
    const board = buildWaiverBoard(advice({ dst: planFor({ available: [option('PIT', 9)] }) }));
    const row = board.rows.find((r) => r.position === 'DEF');

    expect(row).toBeDefined();
    expect(row!.team).toBe('PIT');
    expect(row!.dst?.decision).toBe('add');
  });

  it('carries the club rather than a player, which is what the identity cluster draws', () => {
    const board = buildWaiverBoard(advice({ dst: planFor({ available: [option('PIT', 9)] }) }));
    const row = board.rows.find((r) => r.position === 'DEF')!;

    /*
     * `PlayerIdentity` renders a `TeamLogo` from `row.team` and never a
     * headshot — the row has no field a headshot could come from. What has to
     * be true here is that the club is populated, because a defence row with a
     * blank team would draw the position pill and nothing beside it.
     */
    expect(row.team).toMatch(/^[A-Z]{2,3}$/);
    expect(row.name).not.toBe(row.team);
  });

  it('earns a DEF filter chip, and only when there is a defence to filter to', () => {
    const withDefence = buildWaiverBoard(advice({ dst: planFor({ available: [option('PIT', 9)] }) }));
    const without = buildWaiverBoard(advice({ dst: planFor({ rostered: [option('BUF', 12)], available: [option('PIT', 9)] }) }));

    expect(offeredPositions(withDefence.rows)).toContain('DEF');
    expect(offeredPositions(without.rows)).not.toContain('DEF');
    expect(rowMatches(withDefence.rows.find((r) => r.position === 'DEF')!, 'DEF')).toBe(true);
  });

  it('is never a flex row, whatever else is on the board', () => {
    const board = buildWaiverBoard(advice({ dst: planFor({ available: [option('PIT', 9)] }) }));
    const row = board.rows.find((r) => r.position === 'DEF')!;

    expect(rowMatches(row, 'FLEX')).toBe(false);
  });

  it('draws no row for a hold or a wait, and still carries the answer', () => {
    const hold = buildWaiverBoard(advice({ dst: planFor({ rostered: [option('BUF', 12)], available: [option('PIT', 8)] }) }));

    expect(hold.rows.filter((r) => r.position === 'DEF')).toEqual([]);
    expect(hold.dst?.decision).toBe('hold');
  });

  it('does not promise a FAAB column that is never coming for it', () => {
    const board = buildWaiverBoard(advice({ dst: planFor({ available: [option('PIT', 9)] }) }));

    expect(board.rows.some((r) => r.position === 'DEF')).toBe(true);
    expect(board.pending).toEqual([]);
  });

  it('carries the plan whole, so Team and Waivers cannot diverge', () => {
    const plan = planFor({ available: [option('PIT', 9)] });
    const board = buildWaiverBoard(advice({ dst: plan }));

    expect(board.dst).toBe(plan);
    expect(board.rows.find((r) => r.position === 'DEF')!.why).toBe(plan.headline);
  });

  it('stays empty when the league does not start a defence', () => {
    const board = buildWaiverBoard(advice({ dst: null }));

    expect(board.dst).toBeNull();
    expect(board.rows.filter((r) => r.position === 'DEF')).toEqual([]);
  });
});

/* ---------------------------------------------------------- the assembly */

describe('the planner’s inputs, assembled from what is stored', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  function fixtures(team: string, weeks: { week: number; opponent: string | null; home?: boolean }[]): ScheduleTeamWeek[] {
    return weeks.map((w) => ({
      season: '2026',
      week: w.week,
      team,
      opponent: w.opponent,
      home: w.home ?? true,
      kickoff: `2026-09-${String(6 + w.week).padStart(2, '0')}T17:00:00.000Z`,
      roof: null,
    }));
  }

  it('reads a bounded slice of the fixture list rather than the whole season', async () => {
    const repo = new NflScheduleRepo(db);
    await repo.save(
      [...fixtures('BUF', [{ week: 3, opponent: 'NYJ' }, { week: 4, opponent: 'MIA' }, { week: 9, opponent: 'NE' }]),
       ...fixtures('DEN', [{ week: 3, opponent: 'KC' }])],
      '2026-09-01T00:00:00.000Z',
    );

    const slice = await repo.forTeams('2026', ['BUF'], { from: 3, to: 4 });

    expect(slice.map((r) => r.week)).toEqual([3, 4]);
    expect(slice.every((r) => r.team === 'BUF')).toBe(true);
  });

  it('reads one week for every team, which is where home and away come from', async () => {
    await new NflScheduleRepo(db).save(
      [...fixtures('BUF', [{ week: 3, opponent: 'NYJ', home: true }]), ...fixtures('NYJ', [{ week: 3, opponent: 'BUF', home: false }])],
      '2026-09-01T00:00:00.000Z',
    );

    const week = await new NflScheduleRepo(db).forWeek('2026', 3);

    expect(week.find((r) => r.team === 'BUF')?.home).toBe(true);
    expect(week.find((r) => r.team === 'NYJ')?.home).toBe(false);
  });

  it('measures an offence from the games the market actually priced', async () => {
    await new VegasEventsRepo(db).upsertMany([
      { eventId: 'e1', provider: 'mock', kickoff: '2026-09-14T17:00:00.000Z', homeTeam: 'BUF', awayTeam: 'NYJ', total: 44, spread: -8, spreadTeam: 'BUF' },
      { eventId: 'e2', provider: 'mock', kickoff: '2026-09-21T17:00:00.000Z', homeTeam: 'MIA', awayTeam: 'BUF', total: 46, spread: -4, spreadTeam: 'BUF' },
    ]);

    const form = await new VegasEventsRepo(db).impliedTotalsByTeam('2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');

    /* BUF favoured by 8 in a 44 implies 26 for BUF and 18 for NYJ. */
    expect(form.get('NYJ')).toEqual({ impliedTotal: 18, games: 1 });
    expect(form.get('BUF')!.games).toBe(2);
    expect(form.get('BUF')!.impliedTotal).toBeCloseTo((26 + 25) / 2, 2);
  });

  it('drops a row whose spread belongs to neither side rather than guessing', async () => {
    await new VegasEventsRepo(db).upsertMany([
      { eventId: 'e3', provider: 'mock', kickoff: '2026-09-14T17:00:00.000Z', homeTeam: 'BUF', awayTeam: 'NYJ', total: 44, spread: -8, spreadTeam: 'SEA' },
    ]);

    const form = await new VegasEventsRepo(db).impliedTotalsByTeam('2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');

    expect(form.size).toBe(0);
  });

  it('charges the bench spot the drop list would charge, and names the player', async () => {
    const roster = [
      candidate('qb1', 'Quarterback One', 'QB', 19),
      candidate('rb1', 'Back One', 'RB', 15),
      candidate('rb2', 'Back Two', 'RB', 12),
      candidate('wr1', 'Receiver One', 'WR', 16),
      candidate('wr2', 'Receiver Two', 'WR', 13),
      candidate('wr3', 'Receiver Three', 'WR', 11),
      candidate('te1', 'Tight End One', 'TE', 9),
      candidate('fx1', 'Flex One', 'WR', 10),
      /*
       * Six bench bodies, which fills the roster exactly: nine starting slots
       * and five bench ones is fourteen, and fourteen held players means an add
       * has to displace somebody. One short of that and the cost is an open
       * spot, which is a different test.
       */
      candidate('bn1', 'Bench One', 'WR', 8),
      candidate('bn2', 'Bench Two', 'WR', 7),
      candidate('bn3', 'Bench Three', 'WR', 6),
      candidate('bn4', 'Bench Four', 'WR', 5),
      candidate('bn5', 'Bench Five', 'WR', 4),
      candidate('bn6', 'Spare Body', 'WR', 1),
    ];
    const wire = [defence('free1', 'Pittsburgh', { spread: -9, total: 40, opponent: 'CLE' }, { team: 'PIT' })];
    const lineup = recommendLineup(roster, SHAPE, PROFILE, { currentStarterIds: roster.slice(0, 8).map((r) => r.player.id) });

    const plan = await buildDstPlan(db, {
      season: '2026',
      week: 3,
      shape: SHAPE,
      profile: PROFILE,
      bestBall: false,
      draftComplete: true,
      rosterInputs: roster,
      candidateInputs: wire,
      lineup,
      reserveIds: [],
      playoff: { weeks: [15, 16, 17], emphasis: 0 },
      now: new Date('2026-09-10T12:00:00.000Z'),
    });

    expect(plan).not.toBeNull();
    expect(plan!.cost.needsDrop).toBe(true);
    expect(plan!.cost.dropCandidate?.name).toBe('Spare Body');
    /* And it is never a defence being charged for the defence's own spot. */
    expect(plan!.cost.dropCandidate?.position).not.toBe('DEF');
  });

  it('puts home and away in the shared context, so every screen reads one number', async () => {
    await new NflScheduleRepo(db).save(
      [...fixtures('BUF', [{ week: 3, opponent: 'NYJ', home: true }]), ...fixtures('NYJ', [{ week: 3, opponent: 'BUF', home: false }])],
      '2026-09-01T00:00:00.000Z',
    );
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 3 });

    const context = await buildStartSitContext(db);

    /*
     * The whole point of it living on the context rather than on each route: a
     * defence worth 8.4 on Team and 8.1 on Waivers is not a rounding
     * difference, it is two answers to one question.
     */
    expect(context.home.get('BUF')).toBe(true);
    expect(context.home.get('NYJ')).toBe(false);
  });

  it('leaves the home map empty rather than guessing when no schedule is stored', async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 3 });

    const context = await buildStartSitContext(db);

    expect(context.home.size).toBe(0);
  });

  it('says nothing, and reads nothing, in a league that starts no defence', async () => {
    const noDef = buildRosterShape(DST_ROSTER_POSITIONS.filter((p) => p !== 'DEF'));
    const plan = await buildDstPlan(db, {
      season: '2026',
      week: 3,
      shape: noDef,
      profile: PROFILE,
      bestBall: false,
      draftComplete: true,
      rosterInputs: [],
      candidateInputs: [],
      lineup: recommendLineup([], noDef, PROFILE, {}),
      reserveIds: [],
      playoff: { weeks: [], emphasis: 0 },
    });

    expect(plan!.activation).toBe('no_def_slot');
    expect(plan!.surface).toBe(false);
  });
});

/* -------------------------------------------------------- playoff weeks */

describe('the playoff weeks are the league’s own', () => {
  const rosters = [{ leagueId: 'l', rosterId: 1, ownerId: null, ownerName: null, playerIds: [], starterIds: [], reserveIds: [], isMine: true, settings: { wins: 6, losses: 2 } }];

  it('reads the published start week rather than assuming 15', () => {
    const context = playoffContextFor({
      leagueSettings: { playoff_week_start: 14, playoff_teams: 6 },
      rosters,
      mine: rosters[0]!,
      totalRosters: 12,
      currentWeek: 10,
    });

    expect(context.weeks).toEqual([14, 15, 16]);
    expect(context.startWeekPublished).toBe(true);
  });

  it('says when the week came from the fallback rather than from the league', () => {
    const context = playoffContextFor({
      leagueSettings: {},
      rosters,
      mine: rosters[0]!,
      totalRosters: 12,
      currentWeek: 10,
    });

    expect(context.startWeekPublished).toBe(false);
    expect(context.weeks.length).toBe(3);
  });

  it('weights the playoffs at nothing in September', () => {
    const context = playoffContextFor({
      leagueSettings: { playoff_week_start: 15 },
      rosters: [{ ...rosters[0]!, settings: { wins: 1, losses: 1 } }],
      mine: { ...rosters[0]!, settings: { wins: 1, losses: 1 } },
      totalRosters: 12,
      currentWeek: 2,
    });

    expect(context.emphasis).toBe(0);
  });
});

/* ------------------------------------------------------------- the route */

describe('the waivers endpoint', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = {
      db,
      sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
      vegas: new MockVegasProvider(MOCK_GAMES),
      APP_PASSPHRASE: 'correct horse battery staple',
      SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    };
    app = createApp();
  });

  it('carries a defence plan beside the board, or an honest null', async () => {
    const body = (await (
      await app(new Request('https://app.test/api/leagues/demo-league/waivers'), env)
    ).json()) as { found: boolean; dst: DstPlan | null; upgrades: { accepts: string[] }[] };

    expect(body.found).toBe(true);
    expect(body.dst).not.toBeUndefined();
    /*
     * The seeded league's draft is live, so the correct answer is silence —
     * pre-draft, from the draft's own status rather than from the date.
     */
    expect(body.dst!.activation).toBe('pre_draft');
    expect(body.dst!.surface).toBe(false);
  });

  it('never offers a DEF row through the generic scan once the planner has one', async () => {
    const body = (await (
      await app(new Request('https://app.test/api/leagues/demo-league/waivers'), env)
    ).json()) as { dst: DstPlan | null; upgrades: { accepts: string[] }[] };

    /*
     * One owner for the DEF row. With a plan present — even a silent one — the
     * generic `Fills DEF` upgrade is dropped, so the two can never contradict
     * each other on the same screen.
     */
    expect(body.dst).not.toBeNull();
    expect(body.upgrades.some((u) => u.accepts.every((p) => p === 'DEF'))).toBe(false);
  });
});
