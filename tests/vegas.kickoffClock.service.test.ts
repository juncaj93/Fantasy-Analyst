/**
 * The odds job, end to end against a real database.
 *
 * `vegas.kickoffClock.test.ts` proves the arithmetic. This proves the wiring:
 * that a tick with nothing due costs one row and no provider call, that a pass
 * at a checkpoint buys only the games that are stale, that a game the schedule
 * moved is on its new clock at once, and that every refusal leaves the job
 * somewhere it can recover from.
 *
 * Time is passed in, never read, so each case names the instant it is about.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { VegasProviderError, type MarketKey, type RawPropSet } from '../src/core/vegas/types.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { VegasUsageRepo } from '../src/server/repos/vegasUsage.ts';
import {
  CLOCK_MAX_RETRIES,
  CLOCK_RETRY_MINUTES,
  VegasKickoffClock,
  type ClockState,
} from '../src/server/services/vegasKickoffClock.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { ScheduleService } from '../src/server/services/scheduleService.ts';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';

const H = 3_600_000;
const M = 60_000;

/** A provider that counts what was asked of it, and can be told to refuse. */
class CountingProvider extends MockVegasProvider {
  readonly asked: string[] = [];
  readonly teamCalls: string[][] = [];
  refuse = false;
  configured = true;
  /** The instant the provider stamps on what it sells, so tests can move time. */
  now = Date.now();

  constructor() {
    super(MOCK_GAMES);
  }

  override isConfigured(): boolean {
    return this.configured;
  }

  override async getPlayerProps(eventId: string, markets?: MarketKey[]): Promise<RawPropSet> {
    this.asked.push(eventId);
    if (this.refuse) throw new VegasProviderError('rate limited', 'mock', 'quota', 429);
    const raw = await super.getPlayerProps(eventId, markets);
    return { ...raw, fetchedAt: new Date(this.now).toISOString() };
  }

  override async getPropsForTeams(
    teamIds: string[],
    opts: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number } = {},
  ) {
    this.teamCalls.push(teamIds);
    return super.getPropsForTeams(teamIds, opts);
  }

  async getAccountUsage(): Promise<unknown> {
    return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': 0 } } };
  }
}

/*
 * The two games the demo roster is actually in: Kansas City's, and the
 * Jacksonville defence's. The schedule is told the second starts three hours
 * after the first, which is what gives the job two different clocks to keep.
 */
const GAME_1 = MOCK_GAMES[0]!.eventId;
const GAME_2 = 'demo-game-def';
const KICKOFF_1 = Date.parse(MOCK_GAMES[0]!.startTime);
const KICKOFF_2 = KICKOFF_1 + 3 * H;

/**
 * The demo league's roster teams, learned the way production learns them, and
 * the stored schedule that says when each plays.
 *
 * `kickoffs` is what the schedule file says; the provider's event rows keep
 * whatever the discovery stored, which is how a flex is staged: the two
 * disagree.
 */
async function learnWeek(
  db: NodeSqliteDatabase,
  provider: CountingProvider,
  kickoffs: Record<string, number> = {},
): Promise<{ teamToGame: Map<string, string> }> {
  // Learn the games through the ordinary path, once, with no clock involved.
  const service = new VegasRefreshService(db, provider);
  await service.refresh({ manual: true });
  const preview = await service.preview();

  // The defence's game has a stored envelope and no player lines, as in
  // production: its number is the game's total and spread.
  await new PropsRepo(db).put({
    provider: provider.name,
    eventId: GAME_2,
    gameStart: new Date(KICKOFF_1).toISOString(),
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    raw: {
      provider: provider.name,
      eventId: GAME_2,
      gameStart: new Date(KICKOFF_1).toISOString(),
      fetchedAt: new Date(Date.now() - 1_000).toISOString(),
      quotes: [],
    } as never,
  });

  const rows = new Map<string, { team: string; kickoff: number; eventId: string }>();
  for (const p of preview.players as (typeof preview.players[number] & { team: string | null })[]) {
    if (!p.team) continue;
    const code = p.team.toUpperCase() === 'LAR' ? 'LA' : p.team.toUpperCase();
    if (!p.eventId || !p.kickoff) {
      // Teams with no game mapped yet still have a stored fixture, nine days out:
      // beyond the first checkpoint for the whole of the week these tests cover.
      rows.set(code, { team: code, kickoff: Date.now() + 9 * 24 * H, eventId: '' });
      continue;
    }
    const kickoff = kickoffs[p.eventId] ?? (p.eventId === GAME_2 ? KICKOFF_2 : Date.parse(p.kickoff));
    rows.set(code, { team: code, kickoff, eventId: p.eventId });
  }
  await new NflScheduleRepo(db).save(
    [...rows.values()].map((r) => ({
      season: '2026',
      week: 5,
      team: r.team,
      opponent: 'OPP',
      home: true,
      kickoff: new Date(r.kickoff).toISOString(),
      roof: null,
    })),
    new Date().toISOString(),
  );
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, {
    season: '2026',
    seasonType: 'regular',
    week: 5,
    leg: 5,
    fetchedAt: new Date().toISOString(),
  });
  return { teamToGame: new Map([...rows.values()].map((r) => [r.team, r.eventId])) };
}

/** One tick of the job at a chosen instant, with the provider on the same clock. */
function tick(clock: VegasKickoffClock, provider: CountingProvider, now: number) {
  provider.now = now;
  return clock.runIfDue(now);
}

describe('the odds job on the five-minute tick', () => {
  let db: NodeSqliteDatabase;
  let provider: CountingProvider;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    provider = new CountingProvider();
    await learnWeek(db, provider);
    provider.asked.length = 0;
    provider.teamCalls.length = 0;
  });

  it('knows both games and when they start', () => {
    expect(KICKOFF_2).toBeGreaterThan(KICKOFF_1);
  });

  it('costs one row on a tick with nothing due, and calls the provider zero times', async () => {
    const clock = new VegasKickoffClock(db, provider);
    // Hours after the games were bought and days before the first checkpoint.
    const first = Date.now() + 1 * H;
    await tick(clock, provider, first);
    provider.asked.length = 0;

    const counted = countingDb(db);
    const idle = new VegasKickoffClock(counted.db, provider);
    counted.reset();
    expect(await idle.runIfDue(first + 5 * M)).toBeNull();

    const rows = counted.tallies().reduce((a, t) => a + t.rows, 0);
    expect(rows, 'one settings row, nothing else').toBeLessThanOrEqual(1);
    expect(provider.asked).toEqual([]);
    expect(provider.teamCalls).toEqual([]);
  });

  it('a first pass with nothing stale buys nothing and says when to wake', async () => {
    const clock = new VegasKickoffClock(db, provider);
    const now = Date.now() + 1 * H;
    const run = await tick(clock, provider, now);

    expect(run?.outcome).toBe('ran');
    expect(run?.report?.spent).toBe(0);
    expect(provider.asked).toEqual([]);

    const state = await clock.state();
    // The first checkpoint is a day out, so the gate sleeps for its ceiling.
    expect(Date.parse(state.next!)).toBe(now + 6 * H);
    expect(KICKOFF_1 - 48 * H).toBeGreaterThan(now + 6 * H);
  });

  it('buys the games whose checkpoint has arrived, and only those', async () => {
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);

    // Just past the 48-hour mark of the first game. The second game starts
    // three hours later, so its own mark is still ahead.
    const now = KICKOFF_1 - 48 * H + 3 * M;
    const run = await tick(clock, provider, now);

    expect(run?.outcome).toBe('ran');
    expect(provider.asked).toContain(GAME_1);
    expect(provider.asked).not.toContain(GAME_2);

    const ledger = await new VegasUsageRepo(db).recent(10);
    const bought = ledger.filter((l) => l.outcome === 'fetched' && l.source === 'weekly');
    expect(bought.length).toBeGreaterThan(0);
    expect(bought[0]!.reason).toContain('kickoff clock');
  });

  it('does not buy the same game twice for one checkpoint', async () => {
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);
    const now = KICKOFF_1 - 48 * H + 3 * M;
    await tick(clock, provider, now);
    const after = provider.asked.length;

    // The next tick, and a deliberate direct pass at the same instant that
    // bypasses the gate: the per-game rule must hold on its own.
    expect(await tick(clock, provider, now + 5 * M)).toBeNull();
    await new VegasRefreshService(db, provider).refresh({ clock: true, now: now + 5 * M });
    expect(provider.asked.length).toBe(after);
  });

  it('then buys the second game at its own checkpoint, three hours on', async () => {
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);
    await tick(clock, provider, KICKOFF_1 - 48 * H + 3 * M);
    provider.asked.length = 0;

    await tick(clock, provider, KICKOFF_2 - 48 * H + 3 * M);
    expect(provider.asked).toContain(GAME_2);
    expect(provider.asked).not.toContain(GAME_1);
  });

  it('goes quiet once the games have started', async () => {
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);
    provider.asked.length = 0;

    const after = KICKOFF_2 + 1 * H;
    const run = await tick(clock, provider, after);
    // A pass may run to find that, but it buys nothing and calls nothing.
    expect(run === null || run.report?.spent === 0).toBe(true);
    expect(provider.asked).toEqual([]);
    expect(provider.teamCalls).toEqual([]);

    // And sleeps for the ceiling rather than waking every five minutes.
    const state = await clock.state();
    expect(Date.parse(state.next!)).toBeGreaterThan(after);
  });

  it('is on the new clock at once when the schedule moves a game earlier', async () => {
    // The provider's event rows still say KICKOFF_1. The schedule file has just
    // moved the game five hours earlier.
    await learnWeek(db, provider, { [GAME_1]: KICKOFF_1 - 5 * H });
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);
    provider.asked.length = 0;

    // The new time's six-hour mark: the old time's is still five hours away.
    const now = KICKOFF_1 - 5 * H - 6 * H + 3 * M;
    const run = await tick(clock, provider, now);
    expect(run?.outcome).toBe('ran');
    expect(provider.asked).toContain(GAME_1);
  });

  it('does not buy a game at its old time once the schedule has moved it later', async () => {
    await learnWeek(db, provider, { [GAME_1]: KICKOFF_1 + 30 * H });
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);
    provider.asked.length = 0;

    // The old time's 48-hour mark: nothing is due, because the game is not
    // where the provider's row says.
    await new VegasRefreshService(db, provider).refresh({ clock: true, now: KICKOFF_1 - 48 * H + 3 * M });
    expect(provider.asked).not.toContain(GAME_1);
  });

  it('does nothing and says so when the provider has no key', async () => {
    provider.configured = false;
    const clock = new VegasKickoffClock(db, provider);
    const run = await tick(clock, provider, Date.now() + 1 * H);
    expect(run?.outcome).toBe('skipped');
    expect(run?.note).toContain('not configured');
    expect(provider.asked).toEqual([]);
    expect((await clock.state()).last?.outcome).toBe('skipped');
  });

  it('wakes itself again when the stored gate cannot be read', async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.vegasClock, 'not an object');
    const clock = new VegasKickoffClock(db, provider);
    const run = await tick(clock, provider, Date.now() + 1 * H);
    expect(run?.outcome).toBe('ran');
  });

  it('never leaves the gate asleep for more than six hours', async () => {
    const clock = new VegasKickoffClock(db, provider);
    const now = Date.now() + 1 * H;
    await tick(clock, provider, now);
    // Past the games, nothing left to wait for.
    const later = KICKOFF_2 + 2 * H;
    await tick(clock, provider, later);
    const state = await clock.state();
    expect(Date.parse(state.next!) - later).toBeLessThanOrEqual(6 * H);
  });
});

describe('a pass the provider will not finish', () => {
  let db: NodeSqliteDatabase;
  let provider: CountingProvider;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    provider = new CountingProvider();
    await learnWeek(db, provider);
    provider.asked.length = 0;
  });

  it('comes back in ten minutes, six times, and then waits for the next checkpoint', async () => {
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);

    provider.refuse = true;
    let now = KICKOFF_1 - 48 * H + 3 * M;
    let state: ClockState = await clock.state();
    for (let i = 1; i <= CLOCK_MAX_RETRIES; i++) {
      await tick(clock, provider, now);
      state = await clock.state();
      expect(state.retries, `retry ${i}`).toBe(i);
      expect(Date.parse(state.next!) - now).toBe(CLOCK_RETRY_MINUTES * M);
      now = Date.parse(state.next!);
    }

    // The seventh refusal is not retried: it waits for the next checkpoint.
    await tick(clock, provider, now);
    state = await clock.state();
    expect(state.retries).toBe(0);
    expect(Date.parse(state.next!) - now).toBeGreaterThan(CLOCK_RETRY_MINUTES * M);
  });

  it('nothing refused was booked as spent', async () => {
    const clock = new VegasKickoffClock(db, provider);
    await tick(clock, provider, Date.now() + 1 * H);
    provider.refuse = true;
    const before = (await new VegasUsageRepo(db).view()).used;
    await tick(clock, provider, KICKOFF_1 - 48 * H + 3 * M);
    expect((await new VegasUsageRepo(db).view()).used).toBe(before);
  });
});

describe('what a pass reads', () => {
  it('stays small enough to run forty times a week', async () => {
    const inner = await createTestDb();
    await seedDemoData(inner);
    const provider = new CountingProvider();
    await learnWeek(inner, provider);

    const counted = countingDb(inner);
    const clock = new VegasKickoffClock(counted.db, provider);
    await tick(clock, provider, Date.now() + 1 * H);

    counted.reset();
    await clock.invalidate();
    await tick(clock, provider, KICKOFF_1 - 48 * H + 3 * M);
    const rows = counted.tallies().reduce((a, t) => a + t.rows, 0);

    /*
     * Forty-two passes in a week like 5 October is about 42 x this, against five
     * million rows a day. The ceiling here is deliberately generous: it exists
     * to catch a pass that starts scanning a table, not to pin a count.
     */
    expect(rows).toBeLessThan(2_000);
    expect(rows * 42 / 5_000_000, 'a week of passes, as a share of one day\'s allowance').toBeLessThan(0.02);
  });
});

// ------------------------------------------------- the schedule ingest, and a flex

/** One week of a schedule file, in the columns the parser reads. */
function csv(rows: { gameday: string; gametime: string; away: string; home: string }[]): string {
  const head = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,home_team,roof';
  const lines = rows.map(
    (r) => `2026_05_${r.away}_${r.home},2026,REG,5,${r.gameday},Sunday,${r.gametime},${r.away},${r.home},outdoors`,
  );
  return [head, ...lines].join('\n') + '\n';
}

describe('the schedule refresh and the odds job\'s gate', () => {
  const NOW = new Date('2026-10-07T20:00:00.000Z');

  async function fresh(): Promise<NodeSqliteDatabase> {
    const db = await createTestDb();
    await new NflScheduleRepo(db).save(
      [
        { season: '2026', week: 5, team: 'KC', opponent: 'CIN', home: true, kickoff: '2026-10-11T17:00:00.000Z', roof: null },
        { season: '2026', week: 5, team: 'CIN', opponent: 'KC', home: false, kickoff: '2026-10-11T17:00:00.000Z', roof: null },
      ],
      NOW.toISOString(),
    );
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 5, leg: 5 });
    await new SettingsRepo(db).set(SETTING_KEYS.vegasClock, {
      processedThrough: '2026-10-07T19:00:00.000Z',
      next: '2026-10-09T17:00:00.000Z',
      retries: 0,
      last: null,
    } satisfies ClockState);
    return db;
  }

  const serve = (body: string) =>
    (async () =>
      new Response(body, { status: 200, headers: { etag: `"${Math.random()}"` } })) as unknown as typeof fetch;

  it('clears the gate when a kickoff moved', async () => {
    const db = await fresh();
    // KC at CIN moved from 1:00pm Eastern to 4:25pm Eastern.
    const moved = csv([{ gameday: '2026-10-11', gametime: '16:25', away: 'CIN', home: 'KC' }]);
    const result = await new ScheduleService(db, { now: () => NOW, fetch: serve(moved) }).refresh('2026');
    expect(result.outcome).toBe('ok');

    const state = (await new SettingsRepo(db).get<ClockState>(SETTING_KEYS.vegasClock, null as never))!;
    expect(state.processedThrough).toBeNull();
    expect(state.next).toBeNull();
  });

  it('leaves the gate alone when the file changed and no kickoff did', async () => {
    const db = await fresh();
    // Same 1:00pm Eastern kickoff. The file is new (a score landed, say) and
    // says the same thing about when anybody plays.
    const same = csv([{ gameday: '2026-10-11', gametime: '13:00', away: 'CIN', home: 'KC' }]);
    const result = await new ScheduleService(db, { now: () => NOW, fetch: serve(same) }).refresh('2026');
    expect(result.outcome).toBe('ok');

    const state = (await new SettingsRepo(db).get<ClockState>(SETTING_KEYS.vegasClock, null as never))!;
    expect(state.processedThrough).toBe('2026-10-07T19:00:00.000Z');
    expect(state.next).toBe('2026-10-09T17:00:00.000Z');
  });

  it('treats a first ever load as moved, because there is nothing to compare', async () => {
    const db = await createTestDb();
    await new SettingsRepo(db).set(SETTING_KEYS.vegasClock, {
      processedThrough: 'x',
      next: '2026-10-09T17:00:00.000Z',
      retries: 0,
      last: null,
    });
    const body = csv([{ gameday: '2026-10-11', gametime: '13:00', away: 'CIN', home: 'KC' }]);
    await new ScheduleService(db, { now: () => NOW, fetch: serve(body) }).refresh('2026');
    const state = (await new SettingsRepo(db).get<ClockState>(SETTING_KEYS.vegasClock, null as never))!;
    expect(state.next).toBeNull();
  });
});

describe('finding a game on the clock', () => {
  /*
   * Discovery is how a game becomes known at all, and it is billed an entity per
   * event returned. The old pass asked about every roster team without a stored
   * game, over an eight-day window, once every three days: on a Sunday afternoon
   * that buys next Sunday's games a week before anybody can use them. The clock
   * asks about a team only when that team's own stored kickoff is inside its
   * first checkpoint, 48 hours, and for no longer than three days ahead.
   */
  async function worldWithFixtures(hoursOut: Record<string, number>) {
    const db = await createTestDb();
    await seedDemoData(db);
    const provider = new CountingProvider();
    const now = Date.now();
    await new NflScheduleRepo(db).save(
      Object.entries(hoursOut).map(([team, hours]) => ({
        season: '2026',
        week: 5,
        team,
        opponent: 'OPP',
        home: true,
        kickoff: new Date(now + hours * H).toISOString(),
        roof: null,
      })),
      new Date(now).toISOString(),
    );
    await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 5, leg: 5 });
    return { db, provider, now };
  }

  it('asks only about teams whose game is inside the first checkpoint', async () => {
    const { db, provider, now } = await worldWithFixtures({ KC: 20, DAL: 40, DET: 6 * 24, NYJ: 6 * 24, JAX: 6 * 24 });
    await new VegasRefreshService(db, provider).refresh({ clock: true, now });

    expect(provider.teamCalls).toHaveLength(1);
    expect([...provider.teamCalls[0]!].sort()).toEqual(['DAL', 'KC']);
  });

  it('asks about nobody when every game is further out than that', async () => {
    const { db, provider, now } = await worldWithFixtures({ KC: 4 * 24, DAL: 4 * 24, DET: 6 * 24, NYJ: 6 * 24, JAX: 6 * 24 });
    const report = await new VegasRefreshService(db, provider).refresh({ clock: true, now });
    expect(provider.teamCalls).toEqual([]);
    expect(report.discovered).toBe(0);
  });

  it('is not held off by the three-day stamp the old pass used', async () => {
    const { db, provider, now } = await worldWithFixtures({ KC: 20, DAL: 20, DET: 6 * 24, NYJ: 6 * 24, JAX: 6 * 24 });
    // A discovery an hour ago would have locked the old pass out until Friday.
    await new SettingsRepo(db).set(SETTING_KEYS.lastVegasSchedule, new Date(now - H).toISOString());

    await new VegasRefreshService(db, provider).refresh({ now });
    expect(provider.teamCalls, 'the ordinary pass is still held off').toEqual([]);

    await new VegasRefreshService(db, provider).refresh({ clock: true, now });
    expect(provider.teamCalls.length).toBe(1);
  });

  it('does not ask a team that is on a bye, which has no kickoff to be inside anything', async () => {
    const { db, provider, now } = await worldWithFixtures({ KC: 20, DAL: 20, DET: 6 * 24, NYJ: 6 * 24, JAX: 6 * 24 });
    await new NflScheduleRepo(db).save(
      [{ season: '2026', week: 5, team: 'DAL', opponent: null, home: true, kickoff: null, roof: null }],
      new Date(now).toISOString(),
    );
    await new VegasRefreshService(db, provider).refresh({ clock: true, now });
    expect(provider.teamCalls[0]).not.toContain('DAL');
  });
});
