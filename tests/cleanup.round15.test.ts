/**
 * Round 15 (cleanup): Alex's answers to Rounds 13 and 14, one test group each.
 *
 *   1. A "ties this week" pickup that is worse over the season is not shown.
 *   2. A starter is protected from the drop by the toss-up bar (2.0), not 3.
 *   3. Build a trade no longer says "Built mostly on Sleeper's projection".
 *   4. Matchup refreshes once a minute while live, not every 30 seconds.
 *   5. The nflverse feeds write nothing when nothing changed.
 *   6. Old rows are trimmed slowly: cutoffs, a daily cap, a kill switch.
 *   7. Trades and Waivers average the same free agents.
 *   8. A support snapshot cut off for CPU is asked for again.
 *
 * Every group has at least one test that fails on the code before the round
 * (c83febf).
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideSeasonLosingTies, planPickupStart, type PickupPlayer, type PickupStartRequest } from '../src/core/waivers/pickupStart.ts';
import { planWaiverTiers, type TierCandidate, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { DROP_RULES, type DropSignals } from '../src/core/waivers/dropScore.ts';
import { TOSSUP_POINTS } from '../src/core/startsit/tossup.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { DepthChartRepo, IdentityCrosswalkRepo, SnapCountRepo, type StoredDepthEntry, type StoredSnapWeek } from '../src/server/repos/nflverse.ts';
import { NflverseService } from '../src/server/services/nflverseService.ts';
import { isHeavyWriteDay, trimEnabled, trimOldRows, TRIM_DAILY_CAP } from '../src/server/services/trimOldRows.ts';
import { wirePool } from '../src/core/roster/wirePool.ts';
import { gatherWaiverInputs, readWirePool } from '../src/server/services/decisionInputs.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { seasonPointsKey } from '../src/core/sleeper/weekPoints.ts';
import { createApp } from '../src/server/app.ts';
import { ApiError } from '../src/web/apiResponse.ts';
import { withCpuRetry } from '../src/web/supportRetry.ts';
import type { FetchLike } from '../src/core/source/conditional.ts';
import type { Database } from '../src/server/db.ts';
import worker from '../src/worker/index.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { LEAGUE, boardFor, envFor, forbiddenSleeper, seed, FETCHED_AT } from './helpers/tradeLeague.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);

// --------------------------------------------------------------- item 1 ---

describe('1. a "ties this week" pickup that is worse over the season is not shown', () => {
  const pp = (name: string, position: string, points: number): PickupPlayer => ({
    playerId: name,
    name,
    position,
    team: 'XX',
    points,
    basis: 'market',
    ruledOut: false,
    locked: false,
    designation: 'healthy',
  });
  const roster = [
    pp('Love', 'QB', 20.4),
    pp('Bijan', 'RB', 19.2),
    pp('Allen', 'RB', 12.1),
    pp('Collins', 'WR', 12.8),
    pp('Wilson', 'WR', 13.0),
    pp('Egbuka', 'WR', 6.7),
    pp('Higbee', 'TE', 6.4),
    pp('Pickens', 'WR', 12.8),
    pp('Walker', 'RB', 17.5),
    pp('KC', 'DEF', 9.9),
    pp('McConkey', 'WR', 7.6),
  ];
  const FREE = { state: 'free' as const, reason: null, until: null };
  const request = (candidates: PickupPlayer[]): PickupStartRequest => ({
    shape: SHAPE,
    roster,
    candidates,
    currentStarterIds: ['Love', 'Bijan', 'Allen', 'Collins', 'Wilson', 'Egbuka', 'Higbee', 'Pickens', 'Walker', 'KC'],
    pickup: Object.fromEntries(candidates.map((c) => [c.playerId, FREE])),
    openSpots: 1,
  });
  /* Two free agents who each tie McConkey this week (7.6). */
  const plan = planPickupStart(request([pp('McLaughlin', 'RB', 7.6), pp('Steady', 'WR', 7.6)]));

  it('both are ties this week before the season is asked', () => {
    expect(plan.start).toBeNull();
    expect(plan.consider.map((m) => m.playerId).sort()).toEqual(['McLaughlin', 'Steady']);
  });

  it('the one that loses over the season is dropped from Worth considering; the other stays', () => {
    const season = new Map([
      ['McLaughlin', -3.2],
      ['Steady', 1.4],
    ]);
    const shown = hideSeasonLosingTies(plan, (id) => season.get(id) ?? null);
    expect(shown.consider.map((m) => m.playerId)).toEqual(['Steady']);
    expect(shown.audit.find((a) => a.playerId === 'McLaughlin')?.status).toBe('worse_over_season');
    expect(shown.start).toBe(plan.start);
  });

  it('a season value of zero, or none at all, keeps the tie as before', () => {
    expect(hideSeasonLosingTies(plan, () => 0).consider).toHaveLength(2);
    expect(hideSeasonLosingTies(plan, () => null).consider).toHaveLength(2);
  });

  it('the Waivers tiers then never call him a tie: with no call, a losing move is not Worth considering', () => {
    const t = (id: string, position: string, rate: number): TierPlayer => ({
      playerId: id,
      name: id,
      position,
      team: 'XX',
      rate,
      weekly: [1, 1, 1],
      designation: 'healthy',
      byeWeek: null,
    });
    const base: TierRequest = {
      shape: SHAPE,
      weeks: [7, 8, 9],
      roster: roster.map((x) => t(x.playerId, x.position, x.points ?? 0)),
      candidates: [t('McLaughlin', 'RB', 4)],
      openSpots: 1,
      openReserve: 0,
      protections: new Map(),
      excludedPositions: new Set(['DEF']),
      replacement: new Map([
        ['RB', 5],
        ['WR', 5],
      ]),
    };
    const withTie = planWaiverTiers({ ...base, startNow: new Map([['McLaughlin', { verdict: 'consider' as const, gain: 0, displaces: 'McConkey' }]]) });
    expect(withTie.consider.map((m) => m.playerId)).toContain('McLaughlin');
    const hidden = planWaiverTiers(base);
    expect([...hidden.doThese, ...hidden.consider].map((m) => m.playerId)).not.toContain('McLaughlin');
  });

  it('the waiver assembly applies it to the call Team and Waivers both read', () => {
    const source = readFileSync('src/core/waivers/assemble.ts', 'utf8');
    expect(source).toMatch(/hideSeasonLosingTies\(decided/);
  });
});

// --------------------------------------------------------------- item 2 ---

describe('2. a starter is protected from the drop by the toss-up bar, 2.0', () => {
  const t = (id: string, position: string, rate: number): TierPlayer => ({
    playerId: id,
    name: id,
    position,
    team: 'XX',
    rate,
    weekly: [1, 1, 1],
    designation: 'healthy',
    byeWeek: null,
  });
  /* Everybody but Allen is better than either add, so Allen (in Sleeper's lineup, at FLEX) is the only possible drop. */
  const roster = [
    t('Q', 'QB', 20),
    t('R1', 'RB', 18),
    t('R2', 'RB', 17),
    t('Allen', 'RB', 9),
    t('W1', 'WR', 15),
    t('W2', 'WR', 14),
    t('W3', 'WR', 13),
    t('W4', 'WR', 12),
    t('T', 'TE', 14),
  ];
  const allen: DropSignals = {
    playerId: 'Allen',
    name: 'Allen',
    position: 'RB',
    seasonPoints: 40,
    weeksPlayed: 5,
    recent: [8, 8, 8],
    projection: 8,
    role: null,
    heldWeeks: 3,
    drafted: false,
    handcuffOf: null,
    inLineup: true,
    unavailable: false,
  };
  const plan = (add: TierCandidate) =>
    planWaiverTiers({
      shape: SHAPE,
      weeks: [7, 8, 9],
      roster,
      candidates: [add],
      openSpots: 0,
      openReserve: 0,
      protections: new Map(),
      excludedPositions: new Set(['DEF']),
      replacement: new Map([['RB', 5]]),
      dropSignals: new Map([['Allen', allen]]),
    });

  it('an add 2.5 a game better may now replace the lineup back (under the old 3-point bar he was untouchable)', () => {
    const move = plan(t('Hot', 'RB', 11.5)).all.find((m) => m.playerId === 'Hot');
    expect(move?.drop?.playerId).toBe('Allen');
  });

  it('an add 1.9 a game better still may not', () => {
    const move = plan(t('Warm', 'RB', 10.9)).all.find((m) => m.playerId === 'Warm');
    expect(move?.drop?.playerId ?? null).not.toBe('Allen');
  });

  it('one shared number: the drop rules carry no second bar', () => {
    expect(TOSSUP_POINTS).toBe(2.0);
    expect('clearlyBetter' in DROP_RULES).toBe(false);
  });
});

// --------------------------------------------------------------- item 3 ---

describe('3. Build a trade no longer says "Built mostly on Sleeper\'s projection, not Vegas"', () => {
  it('the sheet has no such line', () => {
    const source = readFileSync('src/web/components/tradeBuilder.tsx', 'utf8');
    expect(source).not.toMatch(/Built mostly on Sleeper/);
    expect(source).not.toMatch(/data-testid="builder-basis"/);
  });
});

// --------------------------------------------------------------- item 4 ---

describe('4. Matchup refreshes once a minute while live', () => {
  it('the live refresh is 60 seconds', async () => {
    const source = readFileSync('src/web/screens/MatchupScreen.tsx', 'utf8');
    expect(source).toMatch(/export const LIVE_POLL_MS = 60_000;/);
    /* The pause in the background and the read on return stay (e2e/matchup-poll-visibility.spec.ts). */
    expect(source).toMatch(/visibilityState === 'hidden'/);
  });
});

// --------------------------------------------------------------- item 5 ---

describe('5. the nflverse feeds write nothing when nothing changed', () => {
  const link = (gsis: string, over: Record<string, unknown> = {}) => ({
    gsisId: gsis,
    season: '2026',
    sleeperId: `s-${gsis}`,
    pfrId: `p-${gsis}`,
    espnId: null,
    yahooId: null,
    team: 'ARI',
    position: 'WR',
    fullName: `Player ${gsis}`,
    status: 'ACT',
    source: 'nflverse_roster',
    asOf: '2026-11-08T07:00:00.000Z',
    ...over,
  });

  it('the crosswalk: the same file again writes 0 rows; a real change is written', async () => {
    const db = await createTestDb();
    const repo = new IdentityCrosswalkRepo(db);
    const links = ['00-1', '00-2', '00-3'].map((g) => link(g));
    expect(await repo.save(links as never, '2026-11-08T09:30:00.000Z')).toBe(3);
    /* Republished the next day: new publish time, same people. */
    const again = links.map((l) => ({ ...l, asOf: '2026-11-09T07:00:00.000Z' }));
    expect(await repo.save(again as never, '2026-11-09T09:30:00.000Z')).toBe(0);
    /* One trade and one new player. */
    const changed = [{ ...again[0]!, team: 'BUF' }, again[1]!, again[2]!, link('00-4')];
    expect(await repo.save(changed as never, '2026-11-10T09:30:00.000Z')).toBe(2);
    const stored = await repo.forSeason('2026');
    expect(stored.find((s) => s.gsisId === '00-1')?.team).toBe('BUF');
    expect(stored).toHaveLength(4);
  });

  it('snap weeks: the same week again writes 0 rows; a corrected share is written', async () => {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany([player({ id: 'p1', fullName: 'P One', position: 'WR', team: 'ARI' })]);
    const repo = new SnapCountRepo(db);
    const week = (share: number, fetchedAt: string): StoredSnapWeek => ({
      playerId: 'p1',
      season: '2026',
      week: 9,
      gameType: 'REG',
      team: 'ARI',
      opponent: 'SEA',
      position: 'WR',
      offenseSnaps: 50,
      offenseShare: share,
      pfrId: 'PO00',
      gsisId: '00-1',
      source: 'nflverse_snaps',
      publishedAt: fetchedAt,
      fetchedAt,
    });
    expect(await repo.saveWeeks([week(0.7, '2026-11-10T09:40:00Z')])).toBe(1);
    expect(await repo.saveWeeks([week(0.7, '2026-11-11T09:40:00Z')])).toBe(0);
    expect(await repo.saveWeeks([week(0.72, '2026-11-12T09:40:00Z')])).toBe(1);
  });

  const DEPTH_HEADER = 'dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank';
  /* The newest chart, then the one before it (the parser needs the next capture to know the newest is whole). */
  const chart = (dt: string, older: string, backRank: number) =>
    [
      DEPTH_HEADER,
      `${dt},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,1`,
      `${dt},ARI,Bridged Back,222,00-0000002,21,3WR 1TE,11,Running Back,RB,11,${backRank}`,
      `${older},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,2`,
      `${older},ARI,Bridged Back,222,00-0000002,21,3WR 1TE,11,Running Back,RB,11,1`,
    ].join('\n');
  const fakeFetch =
    (body: string): FetchLike =>
    async () =>
      new Response(body, {
        status: 200,
        headers: { etag: `"depth_charts_"`, 'last-modified': 'Sun, 23 Aug 2026 07:00:00 GMT', 'content-type': 'text/csv' },
      });

  it('the depth chart: an unchanged chart with a new timestamp writes 0 rows; a moved player is a new capture', async () => {
    const db = await createTestDb();
    const depth = new DepthChartRepo(db);
    const run = (dt: string, backRank: number) =>
      new NflverseService(db, { fetch: fakeFetch(chart(dt, '2026-11-07T07:00:00Z', backRank)), log: () => {} }).refreshDepthChart('2026');

    const first = await run('2026-11-08T07:00:00Z', 1);
    expect(first.outcome).toBe('ok');
    expect(first.rowsWritten).toBe(2);
    const same = await run('2026-11-09T07:00:00Z', 1);
    expect(same.outcome).toBe('ok');
    expect(same.rowsWritten).toBe(0);
    expect(same.note).toMatch(/unchanged since/);
    expect(await depth.captures('2026')).toEqual(['2026-11-08T07:00:00Z']);

    const moved = await run('2026-11-10T07:00:00Z', 2);
    expect(moved.rowsWritten).toBe(2);
    expect(await depth.captures('2026')).toEqual(['2026-11-10T07:00:00Z', '2026-11-08T07:00:00Z']);
  });

  it('a chart that lists a player at two slots still matches the stored one (probe, 9 November: 5,184 depth writes)', async () => {
    const db = await createTestDb();
    const twice = (dt: string, older: string) =>
      [
        DEPTH_HEADER,
        `${dt},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,1`,
        `${dt},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,3,Wide Receiver,WR,3,2`,
        `${dt},ARI,Bridged Back,222,00-0000002,21,3WR 1TE,11,Running Back,RB,11,1`,
        `${older},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,2`,
        `${older},ARI,Bridged Back,222,00-0000002,21,3WR 1TE,11,Running Back,RB,11,1`,
      ].join('\n');
    const run = (dt: string) =>
      new NflverseService(db, { fetch: fakeFetch(twice(dt, '2026-11-07T07:00:00Z')), log: () => {} }).refreshDepthChart('2026');
    expect((await run('2026-11-08T07:00:00Z')).outcome).toBe('ok');
    const again = await run('2026-11-09T07:00:00Z');
    expect(again.outcome).toBe('ok');
    expect(again.rowsWritten).toBe(0);
    expect(await new DepthChartRepo(db).captures('2026')).toEqual(['2026-11-08T07:00:00Z']);
  });

  it('sameAsNewest: different length, or any field, is not the same', async () => {
    const db = await createTestDb();
    const depth = new DepthChartRepo(db);
    const row = (over: Partial<StoredDepthEntry> = {}): StoredDepthEntry => ({
      season: '2026',
      capturedAt: '2026-11-08T07:00:00Z',
      gsisId: '00-1',
      team: 'ARI',
      playerName: 'A',
      position: 'WR',
      posGroup: '3WR 1TE',
      posSlot: 1,
      posRank: 1,
      starterSlots: 3,
      schemaVersion: 'v2' as never,
      source: 'nflverse_depth',
      fetchedAt: '2026-11-08T09:35:00Z',
      ...over,
    });
    expect(await depth.sameAsNewest('2026', [row()])).toBeNull();
    await depth.saveSnapshot([row()]);
    expect(await depth.sameAsNewest('2026', [row({ capturedAt: 'later' })])).toBe('2026-11-08T07:00:00Z');
    expect(await depth.sameAsNewest('2026', [row({ posRank: 2 })])).toBeNull();
    expect(await depth.sameAsNewest('2026', [row(), row({ gsisId: '00-2' })])).toBeNull();
  });
});

// --------------------------------------------------------------- item 6 ---

describe('6. old rows are trimmed slowly, from the 4 AM job', () => {
  /* Monday 9 November 2026, 4 AM Eastern. */
  const NOW = new Date('2026-11-16T09:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  async function seedOdds(db: Database, copies: { event: string; age: number; lines: number; scope?: string }[]) {
    const props = new PropsRepo(db);
    await new PlayerRepo(db).upsertMany([player({ id: 'p1', fullName: 'P One', position: 'WR', team: 'ARI' })]);
    for (const c of copies) {
      const fetchedAt = daysAgo(c.age);
      if ((c.scope ?? 'week') === 'week') {
        await props.put({ provider: 'test', eventId: c.event, gameStart: fetchedAt, fetchedAt, raw: { provider: 'test', eventId: c.event, gameStart: fetchedAt, fetchedAt, quotes: [], raw: null } });
      } else {
        await db
          .prepare("INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope, season) VALUES ('test', ?, ?, ?, '{}', 'season', '2026')")
          .bind(c.event, fetchedAt, fetchedAt)
          .run();
      }
      const { id } = (await db.prepare('SELECT id FROM prop_snapshots WHERE event_id = ? AND fetched_at = ?').bind(c.event, fetchedAt).first<{ id: number }>())!;
      for (let i = 0; i < c.lines; i++) {
        await db
          .prepare("INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, scope) VALUES (?, 'p1', 'P One', ?, 10, ?)")
          .bind(id, `m${i}`, c.scope ?? 'week')
          .run();
      }
    }
  }
  async function seedInjuryRuns(db: Database, ages: number[]) {
    for (const age of ages) {
      await db
        .prepare("INSERT INTO injury_source_runs (source, season, fetched_at, outcome) VALUES ('nflverse_injuries', '2026', ?, 'ok')")
        .bind(daysAgo(age))
        .run();
    }
  }
  const count = async (db: Database, sql: string) => Number((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);

  it('deletes only older than the cutoffs, and keeps each game\'s final odds copy and the newest injury run', async () => {
    const db = await createTestDb();
    await seedOdds(db, [
      { event: 'A', age: 30, lines: 3 }, // older, not A's final copy: goes
      { event: 'A', age: 25, lines: 3 }, // older, not final: goes
      { event: 'A', age: 10, lines: 3 }, // inside 21 days: stays
      { event: 'B', age: 40, lines: 2 }, // older, but B's final copy: stays
      { event: 'C', age: 22, lines: 2 }, // older, not final: goes
      { event: 'C', age: 21.5, lines: 2 }, // older, C's final copy: stays
      { event: 'S', age: 60, lines: 2, scope: 'season' }, // season scope: never touched
      { event: 'S', age: 50, lines: 2, scope: 'season' },
    ]);
    await seedInjuryRuns(db, [45, 40, 31, 29, 1]);
    const result = await trimOldRows(db, { now: NOW, enabled: true });
    expect(result.outcome).toBe('succeeded');
    expect(result.oddsCopies).toBe(3);
    expect(result.oddsLines).toBe(8);
    expect(result.injuryLog).toBe(3);
    expect(result.deleted).toBe(14);
    const left = await db.prepare('SELECT event_id, fetched_at, scope FROM prop_snapshots ORDER BY fetched_at').all<{ event_id: string; fetched_at: string; scope: string }>();
    expect(left.results.map((r) => r.event_id)).toEqual(['S', 'S', 'B', 'C', 'A']);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM player_props')).toBe(2 + 2 + 2 + 2 + 3);
    const runs = await db.prepare('SELECT fetched_at FROM injury_source_runs ORDER BY fetched_at').all<{ fetched_at: string }>();
    expect(runs.results.map((r) => r.fetched_at)).toEqual([daysAgo(29), daysAgo(1)]);
    /* Nothing newer than either cutoff was touched. */
    expect(await count(db, `SELECT COUNT(*) AS n FROM prop_snapshots WHERE scope = 'week' AND fetched_at >= '${daysAgo(21)}'`)).toBe(1);
  });

  it('a feed that stopped a month ago keeps its last run', async () => {
    const db = await createTestDb();
    await seedInjuryRuns(db, [50, 45, 40]);
    const result = await trimOldRows(db, { now: NOW, enabled: true });
    expect(result.injuryLog).toBe(2);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM injury_source_runs')).toBe(1);
  });

  it('never more than the daily cap, all tables together, oldest first', async () => {
    const db = await createTestDb();
    /* 40 old copies of one game with 60 lines each (2,440 rows) and 700 old injury runs. */
    await seedOdds(db, [...Array.from({ length: 40 }, (_, i) => ({ event: 'A', age: 70 - i, lines: 60 })), { event: 'A', age: 1, lines: 1 }]);
    await seedInjuryRuns(db, Array.from({ length: 700 }, (_, i) => 100 - i * 0.1));
    const result = await trimOldRows(db, { now: NOW, enabled: true });
    expect(TRIM_DAILY_CAP).toBe(2_000);
    expect(result.deleted).toBe(2_000);
    expect(result.injuryLog).toBeGreaterThanOrEqual(500);
    /* The oldest copies went first: what is left of the old ones is the newest of them. */
    const oldest = await db.prepare("SELECT MIN(fetched_at) AS at FROM prop_snapshots WHERE event_id = 'A'").first<{ at: string }>();
    expect(Date.parse(oldest!.at)).toBeGreaterThan(Date.parse(daysAgo(70)));
    const small = await trimOldRows(db, { now: NOW, enabled: true, cap: 25 });
    expect(small.deleted).toBeLessThanOrEqual(25);
  });

  it('the kill switch: "off" deletes nothing; anything else leaves it on', async () => {
    const db = await createTestDb();
    await seedInjuryRuns(db, [45, 40, 1]);
    const off = await trimOldRows(db, { now: NOW, enabled: trimEnabled('off') });
    expect(off).toMatchObject({ outcome: 'skipped', deleted: 0 });
    expect(await count(db, 'SELECT COUNT(*) AS n FROM injury_source_runs')).toBe(3);
    expect(trimEnabled(' OFF ')).toBe(false);
    expect(trimEnabled('on')).toBe(true);
    expect(trimEnabled(undefined)).toBe(true);
  });

  it('nothing on a Saturday or Sunday (Eastern), when the account already writes the most', async () => {
    expect(isHeavyWriteDay(new Date('2026-11-14T09:00:00Z'))).toBe(true); // Saturday 4 AM ET
    expect(isHeavyWriteDay(new Date('2026-11-15T09:00:00Z'))).toBe(true); // Sunday
    expect(isHeavyWriteDay(new Date('2026-11-16T09:00:00Z'))).toBe(false); // Monday
    const db = await createTestDb();
    await seedInjuryRuns(db, [45, 1]);
    expect((await trimOldRows(db, { now: new Date('2026-11-15T09:00:00Z'), enabled: true })).deleted).toBe(0);
  });

  describe('the 4 AM job records it in its run record', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('with how many rows went, and "off" from the setting', async () => {
      const db = await createTestDb();
      await seedInjuryRuns(db, [45, 40, 1]);
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response('null', { status: 404 })) as typeof fetch;
      try {
        await worker.scheduled({ cron: '0 9 * * *', scheduledTime: NOW.getTime() }, { DB: db } as never);
        const steps = async () =>
          JSON.parse(String((await db.prepare("SELECT steps_json FROM cron_run_state WHERE cron = '0 9 * * *'").first<{ steps_json: string }>())?.steps_json ?? '[]')) as {
            id: string;
            outcome: string;
            items: number | null;
            note: string | null;
          }[];
        const on = (await steps()).find((s) => s.id === 'trim-old-rows');
        expect(on).toMatchObject({ outcome: 'succeeded', items: 2 });
        expect(on?.note).toMatch(/injury log 2/);

        await worker.scheduled({ cron: '0 9 * * *', scheduledTime: NOW.getTime() }, { DB: db, TRIM_OLD_ROWS: 'off' } as never);
        const off = (await steps()).find((s) => s.id === 'trim-old-rows');
        expect(off).toMatchObject({ outcome: 'skipped', items: 0 });
      } finally {
        globalThis.fetch = realFetch;
      }
    }, 60_000);
  });

  it('the kill switch is one setting in wrangler.toml, on by default', () => {
    expect(readFileSync('wrangler.toml', 'utf8')).toMatch(/^TRIM_OLD_ROWS = "on"$/m);
  });
});

// --------------------------------------------------------------- item 7 ---

describe('7. Trades and Waivers average the same free agents', () => {
  it('the season pool is the waiver scan without this week\'s published slice', () => {
    const players = [
      player({ id: 'draft1', fullName: 'Draft One', position: 'WR', team: 'ARI' }),
      player({ id: 'jump', fullName: 'Week Jump', position: 'WR', team: 'ARI' }),
      player({ id: 'hot', fullName: 'Hot Trend', position: 'WR', team: 'ARI' }),
    ];
    const pool = wirePool({
      players,
      rosteredIds: new Set(),
      startable: new Set(['WR']),
      ranks: new Map(),
      leagueDrops: [],
      published: new Map([['jump', 20]]),
      trending: new Map([['hot', { rank: 1 }]]),
      season: null,
    });
    expect(pool.ids.sort()).toEqual(['draft1', 'hot', 'jump']);
    /* `jump` sits in the draft slice here too (only three players), so ask with a full slice. */
    const many = Array.from({ length: 12 }, (_, i) => player({ id: `d${i}`, fullName: `D ${i}`, position: 'WR', team: 'ARI', searchRank: i + 1 }));
    const wide = wirePool({
      players: [...many, ...players.map((p) => ({ ...p, searchRank: 900 }))],
      rosteredIds: new Set(),
      startable: new Set(['WR']),
      ranks: new Map(),
      leagueDrops: [],
      published: new Map([['jump', 20]]),
      trending: new Map([['hot', { rank: 1 }]]),
      season: null,
    });
    expect(wide.ids).toContain('jump');
    expect(wide.seasonPool).not.toContain('jump');
    expect(wide.seasonPool).toContain('hot');
  });

  it('the season pool is the same whether or not this week is stored (probe, 9 November: 90 against 93)', () => {
    /* Twelve in the draft slice; eleven trending; the most-added one also jumped this week. */
    const draft = Array.from({ length: 12 }, (_, i) => player({ id: `d${i}`, fullName: `D ${i}`, position: 'WR', team: 'ARI', searchRank: i + 1 }));
    const trend = Array.from({ length: 11 }, (_, i) => player({ id: `t${i}`, fullName: `T ${i}`, position: 'WR', team: 'ARI', searchRank: 500 + i }));
    const input = {
      players: [...draft, ...trend],
      rosteredIds: new Set<string>(),
      startable: new Set(['WR']),
      ranks: new Map(),
      leagueDrops: [],
      trending: new Map(trend.map((p, i) => [p.id, { rank: i + 1 }] as const)),
      season: null,
    };
    const waivers = wirePool({ ...input, published: new Map([['t0', 20]]) });
    const trades = wirePool({ ...input, published: null });
    expect([...waivers.seasonPool].sort()).toEqual([...trades.seasonPool].sort());
    expect(waivers.seasonPool).toContain('t0');
    expect(waivers.seasonPool).not.toContain('t10');
    /* The season pool is inside the scan, so Waivers has a number for every one of them. */
    for (const id of waivers.seasonPool) expect(waivers.ids).toContain(id);
    /* The scan itself is as before: t0 by this week, then the next ten trending. */
    expect(waivers.ids).toContain('t10');
  });

  async function league() {
    const db = await createTestDb();
    await seed(db);
    /* Twelve WRs ahead by Sleeper's rank, all poor, and one breakout far down it who scored 25 last week. */
    await new PlayerRepo(db).upsertMany([
      ...Array.from({ length: 12 }, (_, i) => player({ id: `f_wx${i}`, fullName: `F_WX${i}`, position: 'WR', team: 'NE', searchRank: i + 1 })),
      player({ id: 'f_breakout', fullName: 'F_BREAKOUT', position: 'WR', team: 'NE', searchRank: 900 }),
    ]);
    const props = new PropsRepo(db);
    const snapshot = await props.snapshotId('test', 'evt-1', FETCHED_AT);
    const existing = await db.prepare('SELECT COUNT(*) AS n FROM player_props').first<{ n: number }>();
    expect(Number(existing?.n ?? 0)).toBeGreaterThan(0);
    for (const [id, points] of [...Array.from({ length: 12 }, (_, i) => [`f_wx${i}`, 3] as const), ['f_breakout', 11] as const]) {
      for (const prop of boardFor(id, 'WR', points)) {
        await db
          .prepare(
            `INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, over_price, under_price, book_count, books_json, consensus_method, implied_probability)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(snapshot, prop.playerId, prop.sourcePlayerName, prop.market, prop.line, prop.overPrice, prop.underPrice, prop.bookCount, JSON.stringify(prop.books), prop.consensusMethod, prop.impliedProbability)
          .run();
      }
    }
    await new SettingsRepo(db).set(seasonPointsKey('2026'), { points: { f_breakout: [2, 3, 4, 25] }, through: 4 });
    return db;
  }

  it('one pool: the waiver gathering and the Trades reader name the same free agents', async () => {
    const db = await league();
    const { client } = forbiddenSleeper();
    const waivers = await gatherWaiverInputs(db, client, LEAGUE);
    const leagueRow = (await new LeagueRepo(db).getLeague(LEAGUE))!;
    const rosters = await new LeagueRepo(db).listRosters(LEAGUE);
    const rosteredIds = new Set(rosters.flatMap((r) => r.playerIds));
    const players = await new PlayerRepo(db).listAll();
    const startable = new Set(['QB', 'RB', 'WR', 'TE', 'DEF']);
    const trades = await readWirePool(db, client, { league: leagueRow, week: 5, players, rosteredIds, startable });
    expect([...(waivers.request.replacementPool ?? [])].sort()).toEqual([...trades].sort());
    expect(trades).toContain('f_breakout');
  });

  it('Trades now averages the breakout the waiver scan always had (the old pool, top 10 by Sleeper rank, missed him)', async () => {
    const db = await league();
    const { client } = forbiddenSleeper();
    const res = await createApp()(
      new Request(`http://x/api/leagues/${LEAGUE}/trades/check?a=1&b=2&give=m_wr5&get=t_rb2`),
      envFor(db, client),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evaluation: { replacement: { position: string; names: string[] }[] } };
    const wr = body.evaluation.replacement.find((r) => r.position === 'WR');
    expect(wr?.names).toContain('F_BREAKOUT');
  });
});

// --------------------------------------------------------------- item 8 ---

describe('8. a support snapshot cut off for CPU is asked for again', () => {
  const busy = () => new ApiError('Service unavailable', 503, { kind: 'html' });

  it('a 503 is waited out and retried, and the second answer is returned', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withCpuRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw busy();
        return 'snapshot';
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe('snapshot');
    expect(calls).toBe(2);
    expect(waits).toEqual([3_000]);
  });

  it('twice at most, then the failure stands', async () => {
    let calls = 0;
    await expect(
      withCpuRetry(
        async () => {
          calls += 1;
          throw busy();
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('Service unavailable');
    expect(calls).toBe(3);
  });

  it('anything but a 503 fails at once', async () => {
    let calls = 0;
    await expect(
      withCpuRetry(
        async () => {
          calls += 1;
          throw new ApiError('no league', 404);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('no league');
    expect(calls).toBe(1);
  });

  it('Setup asks through it', () => {
    expect(readFileSync('src/web/screens/SetupScreen.tsx', 'utf8')).toMatch(/withCpuRetry\(\(\) => api\.get/);
  });
});
