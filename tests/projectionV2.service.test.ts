/**
 * The three ingests and the side-by-side report, against a real database.
 *
 * The parsers are covered in `projectionV2.ingest.test.ts` and the modelling in
 * `projectionV2.model.test.ts`. What is checked here is the wiring between them:
 * that a fetched file becomes stored rows, that the crosswalk is what makes the
 * snap join possible, that a 404 is a fact about the calendar rather than an
 * alarm, and — the one that matters most for phase 1 — that with none of it
 * present the report still renders market-only projections rather than failing
 * or inventing zeroes.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { NflverseService, NFLVERSE_SOURCES } from '../src/server/services/nflverseService.ts';
import { ProjectionV2Service } from '../src/server/services/projectionV2Service.ts';
import {
  DepthChartRepo,
  IdentityCrosswalkRepo,
  NflverseRunRepo,
  SnapCountRepo,
} from '../src/server/repos/nflverse.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import type { Database } from '../src/server/db.ts';
import type { FetchLike } from '../src/core/source/conditional.ts';

const SEASON = '2026';

const ROSTER_HEADER =
  'season,team,position,depth_chart_position,jersey_number,status,full_name,first_name,last_name,' +
  'birth_date,height,weight,college,gsis_id,espn_id,sportradar_id,yahoo_id,rotowire_id,pff_id,pfr_id,' +
  'fantasy_data_id,sleeper_id,years_exp,headshot_url,ngs_position,week,game_type,status_description_abbr,' +
  'football_name,esb_id,gsis_it_id,smart_id,entry_year,rookie_year,draft_club,draft_number';

/**
 * Two players, and the difference between them is the whole point of the bridge.
 *
 * `sleeper-1` is in Sleeper's dictionary with a GSIS id of his own. `sleeper-2`
 * is not — Sleeper publishes no `gsis_id` for him, which is the ordinary state
 * for a sixth of skill-position players — and only the roster's `sleeper_id`
 * column can reach him.
 */
const ROSTER = [
  ROSTER_HEADER,
  `${SEASON},ARI,WR,WR,1,ACT,Direct Receiver,Direct,Receiver,2000-01-01,72,200,College,` +
    '00-0000001,111,,,,,DireRe00,,sleeper-1,3,' +
    '"https://static.www.nfl.com/image/upload/f_auto,q_auto/league/aaa",,1,REG,A01,Direct,' +
    'DIR000001,1,x,2023,2023,ARI,10',
  `${SEASON},ARI,RB,RB,2,ACT,Bridged Back,Bridged,Back,2001-01-01,70,210,College,` +
    '00-0000002,222,,,,,BridBa00,,sleeper-2,2,' +
    '"https://static.www.nfl.com/image/upload/f_auto,q_auto/league/bbb",,1,REG,A01,Bridged,' +
    'BRI000002,2,y,2024,2024,ARI,40',
].join('\n');

const DEPTH_HEADER =
  'dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank';

function depthFile(newest: string, older: string): string {
  return [
    DEPTH_HEADER,
    `${newest},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,1`,
    `${newest},ARI,Bridged Back,222,00-0000002,21,3WR 1TE,11,Running Back,RB,11,1`,
    `${older},ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,2`,
    `${older},ARI,Bridged Back,222,00-0000002,21,3WR 1TE,11,Running Back,RB,11,1`,
  ].join('\n');
}

const SNAP_HEADER =
  'game_id,pfr_game_id,season,game_type,week,player,pfr_player_id,position,team,opponent,' +
  'offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct';

const SNAPS = [
  SNAP_HEADER,
  `${SEASON}_01_ARI_SEA,x,${SEASON},REG,1,Direct Receiver,DireRe00,WR,ARI,SEA,50,0.72,0,0,0,0`,
  `${SEASON}_02_ARI_SEA,x,${SEASON},REG,2,Direct Receiver,DireRe00,WR,ARI,SEA,58,0.81,0,0,0,0`,
  `${SEASON}_02_ARI_SEA,x,${SEASON},REG,2,Bridged Back,BridBa00,RB,ARI,SEA,30,0.42,0,0,0,0`,
  `${SEASON}_02_ARI_SEA,x,${SEASON},REG,2,Nobody At All,NoboAt00,WR,ARI,SEA,10,0.14,0,0,0,0`,
].join('\n');

/** A fetch that answers each URL from a table, with the headers a real asset sends. */
function fakeFetch(bodies: Record<string, string | number>): FetchLike {
  return async (url) => {
    for (const [fragment, body] of Object.entries(bodies)) {
      if (!url.includes(fragment)) continue;
      if (typeof body === 'number') return new Response(null, { status: body });
      return new Response(body, {
        status: 200,
        headers: {
          etag: `"${fragment}"`,
          'last-modified': 'Sun, 23 Aug 2026 07:00:00 GMT',
          'content-type': 'text/csv',
        },
      });
    }
    return new Response(null, { status: 404 });
  };
}

async function seedPlayers(db: Database): Promise<void> {
  await new PlayerRepo(db).upsertMany([
    player({
      id: 'sleeper-1',
      fullName: 'Direct Receiver',
      position: 'WR',
      team: 'ARI',
      externalIds: { gsis: '00-0000001' },
    }),
    // Deliberately no `gsis` — this is the player the roster bridge exists for.
    player({ id: 'sleeper-2', fullName: 'Bridged Back', position: 'RB', team: 'ARI', externalIds: {} }),
  ]);
}

describe('ingesting the three feeds', () => {
  it('stores the crosswalk with every identifier the roster carries', async () => {
    const db = await createTestDb();
    const service = new NflverseService(db, {
      fetch: fakeFetch({ 'roster_': ROSTER }),
      log: () => {},
    });
    const run = await service.refreshRoster(SEASON);
    expect(run.outcome).toBe('ok');
    expect(run.rowsWritten).toBe(2);

    const stored = await new IdentityCrosswalkRepo(db).forSeason(SEASON);
    expect(stored).toHaveLength(2);
    const bridged = stored.find((s) => s.gsisId === '00-0000002')!;
    expect(bridged.sleeperId).toBe('sleeper-2');
    expect(bridged.pfrId).toBe('BridBa00');
    expect(bridged.status).toBe('ACT');
    // Provenance is the file's publish time, not the moment we read it.
    expect(bridged.asOf).toBe('2026-08-23T07:00:00.000Z');
  });

  it('stores one depth capture and keeps only the two newest', async () => {
    const db = await createTestDb();
    const depth = new DepthChartRepo(db);
    const fetchOne = (newest: string, older: string) =>
      new NflverseService(db, { fetch: fakeFetch({ depth_charts_: depthFile(newest, older) }), log: () => {} });

    expect((await fetchOne('2026-08-21T07:00:00Z', '2026-08-20T07:00:00Z').refreshDepthChart(SEASON)).outcome).toBe(
      'ok',
    );
    expect((await fetchOne('2026-08-22T07:00:00Z', '2026-08-21T07:00:00Z').refreshDepthChart(SEASON)).outcome).toBe(
      'ok',
    );
    expect((await fetchOne('2026-08-23T07:00:00Z', '2026-08-22T07:00:00Z').refreshDepthChart(SEASON)).outcome).toBe(
      'ok',
    );

    const captures = await depth.captures(SEASON);
    expect(captures).toEqual(['2026-08-23T07:00:00Z', '2026-08-22T07:00:00Z']);

    const roles = await depth.rolesAt(SEASON, captures[0]!);
    expect(roles.get('00-0000001')!.rank).toBe(1);
    expect(roles.get('00-0000001')!.starterSlots).toBe(1);
  });

  it('refuses to store a depth read that did not reach the end of a capture', async () => {
    const db = await createTestDb();
    const onlyOneBlock = [
      DEPTH_HEADER,
      '2026-08-23T07:00:00Z,ARI,Direct Receiver,111,00-0000001,21,3WR 1TE,1,Wide Receiver,WR,1,1',
    ].join('\n');
    const service = new NflverseService(db, {
      fetch: fakeFetch({ depth_charts_: onlyOneBlock }),
      log: () => {},
    });
    const run = await service.refreshDepthChart(SEASON);
    expect(run.outcome).toBe('failed');
    expect(run.rowsWritten).toBe(0);
    expect(await new DepthChartRepo(db).captures(SEASON)).toEqual([]);
  });

  it('joins snap counts through the crosswalk and drops what it cannot resolve', async () => {
    const db = await createTestDb();
    await seedPlayers(db);
    const service = new NflverseService(db, {
      fetch: fakeFetch({ 'roster_': ROSTER, snap_counts_: SNAPS }),
      log: () => {},
    });
    await service.refreshRoster(SEASON);
    const run = await service.refreshSnapCounts(SEASON);

    expect(run.outcome).toBe('ok');
    // Week 2 only — the latest — and the third row has no crosswalk entry.
    expect(run.rowsWritten).toBe(2);
    expect(run.unmatched).toBe(1);

    const stored = await new SnapCountRepo(db).weeksFor(['sleeper-1', 'sleeper-2'], SEASON);
    expect(stored.get('sleeper-1')![0]!.offenseShare).toBe(0.81);
    // The bridged player is reachable only because the roster carried his
    // Sleeper id; without the crosswalk this row would be `unmatched`.
    expect(stored.get('sleeper-2')![0]!.offenseSnaps).toBe(30);
    expect(stored.get('sleeper-2')![0]!.pfrId).toBe('BridBa00');
  });

  it('will not write a snap row for a player the dictionary has never heard of', async () => {
    /*
     * nflverse carries plenty of players Sleeper's dictionary does not —
     * practice-squad bodies, players who retired before this app existed. The
     * crosswalk gives every one of them a `sleeper_id`, and trusting that
     * without a lookup would store usage against an id no `players` row has:
     * unreadable forever, counted as written, and invisible in `unmatched`. A
     * pipeline that reports success for rows nobody can read is precisely what
     * the match counts exist to catch.
     */
    const db = await createTestDb();
    // Only the first player is in the dictionary. The second is in the roster
    // file and the snap file and nowhere else.
    await new PlayerRepo(db).upsertMany([
      player({
        id: 'sleeper-1',
        fullName: 'Direct Receiver',
        position: 'WR',
        team: 'ARI',
        externalIds: { gsis: '00-0000001' },
      }),
    ]);
    const service = new NflverseService(db, {
      fetch: fakeFetch({ 'roster_': ROSTER, snap_counts_: SNAPS }),
      log: () => {},
    });
    await service.refreshRoster(SEASON);
    const run = await service.refreshSnapCounts(SEASON);

    expect(run.outcome).toBe('ok');
    expect(run.rowsWritten).toBe(1);
    // The bridged player and the wholly unknown one, both counted rather than
    // written.
    expect(run.unmatched).toBe(2);
    const stored = await new SnapCountRepo(db).weeksFor(['sleeper-1', 'sleeper-2'], SEASON);
    expect(stored.has('sleeper-2')).toBe(false);
  });

  it('cannot join the snaps at all without the roster first', async () => {
    const db = await createTestDb();
    await seedPlayers(db);
    const service = new NflverseService(db, { fetch: fakeFetch({ snap_counts_: SNAPS }), log: () => {} });
    const run = await service.refreshSnapCounts(SEASON);
    /*
     * `sleeper-1` still resolves — Sleeper published his GSIS id — but the row
     * is keyed by `pfr_player_id`, and without the crosswalk there is nothing
     * to turn that into a GSIS id. Every row is unmatched, and the ingest
     * refuses rather than storing a third of a week.
     */
    expect(run.outcome).toBe('failed');
    expect(run.note).toMatch(/no snap rows mapped/);
  });

  it('treats a season that has not started as a fact, not a failure', async () => {
    const db = await createTestDb();
    const service = new NflverseService(db, { fetch: fakeFetch({ snap_counts_: 404 }), log: () => {} });
    const run = await service.refreshSnapCounts(SEASON);
    expect(run.outcome).toBe('not_published');
    expect(run.note).toMatch(/has not published/);
    const recorded = await new NflverseRunRepo(db).latest(NFLVERSE_SOURCES.snaps);
    expect(recorded?.outcome).toBe('not_published');
  });

  it('costs nothing on the ordinary tick, when the file has not changed', async () => {
    const db = await createTestDb();
    let bodiesSent = 0;
    const counting: FetchLike = async (_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      if (headers.get('if-none-match')) return new Response(null, { status: 304 });
      bodiesSent++;
      return new Response(ROSTER, {
        status: 200,
        headers: { etag: '"v1"', 'last-modified': 'Sun, 23 Aug 2026 07:00:00 GMT' },
      });
    };
    const service = new NflverseService(db, { fetch: counting, log: () => {} });
    expect((await service.refreshRoster(SEASON)).outcome).toBe('ok');
    const second = await service.refreshRoster(SEASON);
    expect(second.outcome).toBe('not_modified');
    expect(second.rowsWritten).toBe(0);
    expect(bodiesSent).toBe(1);
  });

  it('asks for a ranged read of the depth chart and a whole read of the others', async () => {
    const db = await createTestDb();
    const ranges: Record<string, string | null> = {};
    const recording: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const key = url.includes('depth_charts_') ? 'depth' : url.includes('roster_') ? 'roster' : 'snaps';
      ranges[key] = headers.get('range');
      return new Response(null, { status: 404 });
    };
    const service = new NflverseService(db, { fetch: recording, log: () => {} });
    await service.refreshAll(SEASON);
    expect(ranges['depth']).toMatch(/^bytes=0-\d+$/);
    expect(ranges['roster']).toBeNull();
    expect(ranges['snaps']).toBeNull();
  });

  it('reports what it holds without pretending anything is fresher than it is', async () => {
    const db = await createTestDb();
    await seedPlayers(db);
    const service = new NflverseService(db, {
      fetch: fakeFetch({ 'roster_': ROSTER, snap_counts_: SNAPS, depth_charts_: 404 }),
      log: () => {},
    });
    await service.refreshAll(SEASON);
    const health = await service.health(SEASON);
    expect(health.identity.rows).toBe(2);
    expect(health.identity.withPfr).toBe(2);
    expect(health.snaps.latestWeek).toBe(2);
    expect(health.depth.latest).toBeNull();
    expect(health.dataHealth).toMatch(/no depth chart stored/);
  });
});

describe('the side-by-side report degrades to market-only', () => {
  async function seedLeague(db: Database): Promise<void> {
    await seedPlayers(db);
    const leagues = new LeagueRepo(db);
    await leagues.upsertLeague({
      id: 'v2-league',
      sleeperLeagueId: 'v2-league',
      name: 'Evaluation League',
      season: SEASON,
      totalRosters: 10,
      scoringSettings: { rec: 1, pass_td: 4 },
      rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'],
      leagueSettings: {},
      draftId: null,
      lastSyncedAt: new Date().toISOString(),
    });
    await leagues.selectLeague('v2-league');
    await leagues.replaceRosters('v2-league', [
      {
        leagueId: 'v2-league',
        rosterId: 1,
        ownerId: 'me',
        ownerName: 'Me',
        isMine: true,
        reserveIds: [],
        playerIds: ['sleeper-1', 'sleeper-2'],
        starterIds: ['sleeper-1'],
        settings: {},
      },
    ]);
  }

  it('renders with no nflverse data at all, and projects nobody at zero', async () => {
    const db = await createTestDb();
    await seedLeague(db);
    const report = await new ProjectionV2Service(db).sideBySide({ leagueId: 'v2-league', week: 1 });

    expect(report.rows).toHaveLength(2);
    expect(report.inputs).toEqual({ crosswalk: false, snaps: false, depthCharts: 0 });
    for (const row of report.rows) {
      /*
       * No market has priced this fixture and no usage is stored, so the honest
       * answer is nothing. §26: "never return nonsense zero."
       */
      expect(row.v2Projection).toBeNull();
      expect(row.basis).toBe('none');
      expect(row.floor).toBeNull();
    }
    expect(report.summary.lostProjections).toBe(0);
    /*
     * And the ladder still works as far as it can: Sleeper published a GSIS id
     * for the first player, so he resolves with no crosswalk at all. The second
     * is the one the roster bridge exists for, and without it he is explicitly
     * unresolved rather than found by name.
     */
    expect(report.identity).toMatchObject({
      players: 2,
      sleeperDirect: 1,
      rosterBridge: 0,
      unresolved: 1,
      withPfr: 0,
    });
  });

  it('counts identity coverage over the players it actually reported on', async () => {
    const db = await createTestDb();
    await seedLeague(db);
    await new NflverseService(db, { fetch: fakeFetch({ 'roster_': ROSTER }), log: () => {} }).refreshRoster(SEASON);

    const report = await new ProjectionV2Service(db).sideBySide({ leagueId: 'v2-league', week: 1 });
    expect(report.inputs.crosswalk).toBe(true);
    expect(report.identity).toMatchObject({
      players: 2,
      sleeperDirect: 1,
      rosterBridge: 1,
      unresolved: 0,
      withPfr: 2,
    });
  });

  it('is empty rather than broken for a league with no roster', async () => {
    const db = await createTestDb();
    const leagues = new LeagueRepo(db);
    await leagues.upsertLeague({
      id: 'empty',
      sleeperLeagueId: 'empty',
      name: 'Empty',
      season: SEASON,
      totalRosters: 10,
      scoringSettings: {},
      rosterPositions: [],
      leagueSettings: {},
      draftId: null,
      lastSyncedAt: new Date().toISOString(),
    });
    const report = await new ProjectionV2Service(db).sideBySide({ leagueId: 'empty' });
    expect(report.rows).toEqual([]);
    expect(report.summary.players).toBe(0);
  });
});
