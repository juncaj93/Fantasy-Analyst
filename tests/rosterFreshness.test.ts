/**
 * The roster, on a clock, and visible when it is not.
 *
 * ## What went wrong
 *
 * A defence claimed off waivers on the morning of 1 September 2026 was still
 * missing from the Team page two days later — not as a starter, not on the
 * bench, nowhere. The Waivers screen went on advising an empty DEF slot the
 * owner had already filled, which is worse than an unhelpful screen: it is a
 * confident, specific, wrong instruction.
 *
 * Nothing in the roster path was broken. `syncLeague` is the only thing that
 * replaces roster rows and it was reachable from three places — selecting a
 * league, pulling down on Team or Waivers, and the one-shot adoption after a
 * draft completes — and from no clock at all. The daily 09:00 tick synced the
 * player dictionary, the NFL's week, last season's statistics, injuries, usage,
 * season markets, the schedule, trending adds, the calibration ledger, the
 * published projections, three nflverse files and the manager backfill. It did
 * not sync a league.
 *
 * The second half is why it went unnoticed for two days. `SOURCE_POLICIES` had
 * no roster entry, so the Data Health screen reported eleven feeds as Current
 * and said nothing at all about the one fact all eleven describe. The screen
 * built to answer "could this simply be using old data?" could not see the
 * oldest data in the app.
 *
 * ## What is asserted here
 *
 * That the daily tick re-reads the selected league, that a squad which changed
 * in Sleeper is the squad the app then holds, and that the roster is a source
 * Data Health reports on — including when it has gone stale.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index.ts';
import { SOURCE_POLICIES, policyFor } from '../src/core/health/policy.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

/** The squad as this app last stored it: no defence. */
const STORED = ['1000', '1001'];

/**
 * The squad as Sleeper now has it, one waiver claim later.
 *
 * `PIT` rather than a numeric id on purpose: Sleeper keys team defences by
 * their abbreviation, and a sync that quietly dropped non-numeric ids would
 * reproduce the reported symptom exactly while every other player synced fine.
 */
const IN_SLEEPER = ['1000', '1001', 'PIT'];

const DAILY = { cron: '0 9 * * *' };

function stubWorld(): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);

    if (/\/league\/[^/]+\/rosters$/.test(url)) {
      return new Response(
        JSON.stringify([
          { roster_id: 1, owner_id: 'u-mine', players: IN_SLEEPER, starters: ['1000', '1001'], reserve: [] },
        ]),
        { status: 200 },
      );
    }
    if (/\/league\/[^/]+\/users$/.test(url)) {
      return new Response(JSON.stringify([{ user_id: 'u-mine', display_name: 'You' }]), { status: 200 });
    }
    if (/\/league\/[^/]+\/drafts$/.test(url)) return new Response('[]', { status: 200 });
    if (/\/league\/[^/]+$/.test(url)) {
      return new Response(
        JSON.stringify({
          league_id: 'L2026',
          name: "Tony's Pizza",
          season: '2026',
          total_rosters: 1,
          scoring_settings: { rec: 0.5 },
          roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN'],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/state/nfl')) {
      return new Response(JSON.stringify({ season: '2026', season_type: 'regular', week: 1, leg: 1 }), { status: 200 });
    }
    if (url.includes('/players/nfl')) return new Response('{}', { status: 200 });
    if (url.includes('github.com')) return new Response(null, { status: 304 });
    return new Response('null', { status: 200 });
  }) as typeof fetch;
  return { urls };
}

async function seed(db: NodeSqliteDatabase): Promise<void> {
  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    /*
     * The Sleeper id, because that is what the app stores.
     *
     * `toLeagueRecord` sets `id` to `league_id`, so a fixture that invented a
     * separate internal key would be a state production cannot reach — and one
     * that fails the unique index on `sleeper_league_id` the moment a real sync
     * writes the league back.
     */
    id: 'L2026',
    sleeperLeagueId: 'L2026',
    name: "Tony's Pizza",
    season: '2026',
    totalRosters: 1,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN'],
    leagueSettings: {},
    draftId: null,
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.replaceRosters('L2026', [
    {
      leagueId: 'L2026',
      rosterId: 1,
      ownerId: 'u-mine',
      ownerName: 'You',
      playerIds: STORED,
      starterIds: ['1000', '1001'],
      reserveIds: [],
      isMine: true,
      settings: {},
    },
  ]);
  await leagues.selectLeague('L2026');
  await new PlayerRepo(db).upsertMany([
    {
      id: '1000', sleeperPlayerId: '1000', fullName: 'A Quarterback', firstName: 'A', lastName: 'Quarterback',
      team: 'CIN', position: 'QB', status: 'Active', active: true, normalizedName: 'a quarterback', aliases: [],
    },
  ]);
  await new SettingsRepo(db).set(SETTING_KEYS.sleeperUser, {
    userId: 'u-mine',
    username: 'alex',
    displayName: 'Alex',
  });
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, {
    season: '2026', seasonType: 'regular', week: 1, leg: 1, fetchedAt: new Date().toISOString(),
  });
}

describe('the roster is refreshed by a clock, not only by a gesture', () => {
  let db: NodeSqliteDatabase;
  let realFetch: typeof fetch;
  let realLog: typeof console.log;
  let realError: typeof console.error;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    realFetch = globalThis.fetch;
    realLog = console.log;
    realError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  });

  it('re-reads the selected league on the daily tick', async () => {
    const run = stubWorld();
    await worker.scheduled(DAILY, { DB: db } as never);

    expect(
      run.urls.some((u) => /\/league\/L2026\/rosters$/.test(u)),
      'the daily tick must ask Sleeper for the roster',
    ).toBe(true);
  });

  it('adopts a waiver claim made in Sleeper, defence and all', async () => {
    stubWorld();
    const before = await new LeagueRepo(db).listRosters('L2026');
    expect(before[0]!.playerIds, 'the stored squad starts without the claim').toEqual(STORED);

    await worker.scheduled(DAILY, { DB: db } as never);

    const after = await new LeagueRepo(db).listRosters('L2026');
    expect(after[0]!.playerIds).toEqual(IN_SLEEPER);
    /*
     * On the bench specifically, which is the shape of the original report: the
     * claim was not in the lineup and it was not on the bench either, so a fix
     * that only put it somewhere would not have answered the complaint.
     */
    const bench = after[0]!.playerIds.filter((id) => !after[0]!.starterIds.includes(id));
    expect(bench, 'the claimed defence is on the bench').toContain('PIT');
  });

  it('does not fail the tick when no league is selected', async () => {
    await db.prepare('UPDATE leagues SET is_selected = 0').run();
    stubWorld();
    await expect(worker.scheduled(DAILY, { DB: db } as never)).resolves.toBeUndefined();
  });
});

describe('Data Health reports the roster', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  it('names it first, as a critical source', () => {
    const roster = SOURCE_POLICIES.find((p) => p.id === 'roster');
    expect(roster, 'the roster must be a source at all — it was not, and that is how this hid').toBeDefined();
    expect(SOURCE_POLICIES[0]!.id).toBe('roster');
    expect(roster!.severity).toBe('critical');
  });

  it('says a roster nobody has ever synced is missing', async () => {
    const view = await new DataHealthService(db).view();
    const roster = view.sources.find((s) => s.id === 'roster');
    expect(roster).toBeDefined();
    expect(roster!.state).toBe('missing');
  });

  it('says a roster read this morning is current, and counts the squad', async () => {
    await new SettingsRepo(db).logSync('league', 'ok', 'tony: 1 rosters', new Date().toISOString());

    const view = await new DataHealthService(db).view();
    const roster = view.sources.find((s) => s.id === 'roster');
    expect(roster!.state).toBe('current');
    /*
     * On `technical`, not on the row. The model drops a healthy source's note on
     * purpose — a sentence under every green row is a sentence nobody reads —
     * so the count survives where a support agent looks for it.
     */
    expect(roster!.technical.note).toContain(`${STORED.length} player(s)`);
  });

  it('goes stale rather than silent when the sync stops', async () => {
    /*
     * Written straight into the log rather than through `logSync`, which stamps
     * `finished_at` with its own clock — the whole point here is a sync that
     * finished three days ago.
     */
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    await db
      .prepare('INSERT INTO sync_log (kind, status, detail, started_at, finished_at) VALUES (?,?,?,?,?)')
      .bind('league', 'ok', 'tony: 1 rosters', threeDaysAgo, threeDaysAgo)
      .run();

    const view = await new DataHealthService(db).view();
    const roster = view.sources.find((s) => s.id === 'roster');
    /*
     * The whole point of the row. Two days of silence used to render as eleven
     * green ticks; it now renders as a row that says what it costs.
     */
    expect(roster!.state).not.toBe('current');
    /*
     * And the row says what being stale costs, which is the half that turns a
     * colour into something a reader can act on.
     */
    expect(policyFor('roster').impact).toContain('waiver claims');
  });
});
