/**
 * The daily cron, against Cloudflare's free-plan subrequest ceiling.
 *
 * The manager backfill has had a request budget since the day it was written,
 * and it was never enough, because Cloudflare counts subrequests per
 * *invocation* and the budget covered one subsystem inside it. The 09:00 tick
 * also syncs the player dictionary, last season's statistics, the injury
 * report, per-game usage, the season market, the schedule, the trending list,
 * the calibration ledger, the published projections and three nflverse files.
 * A healthy morning spent about forty-four of fifty. Every Sleeper read retries
 * twice, so a morning where Sleeper answered 500 spent about sixty-five — the
 * exact failure the backfill's own budget was built to prevent, recreated one
 * level up, with that budget reading a comfortable 24/24 throughout.
 *
 * So this file drives the real `scheduled()` handler over a real database and
 * counts what actually goes out.
 *
 * ## Counting the way Cloudflare counts
 *
 * Two things a naive counter gets wrong, and both are worth more than the
 * headroom they consume:
 *
 *   - **retries.** One logical Sleeper call is up to three subrequests, so the
 *     stub counts fetches rather than methods.
 *   - **redirects.** Every nflverse file is a GitHub release asset, and
 *     `github.com/nflverse/nflverse-data/releases/download/...` answers 302
 *     with a signed `release-assets.githubusercontent.com` URL that `fetch`
 *     follows itself. One call, two subrequests — before the conditional
 *     validator is even considered, so a 304 costs two as well. Seven
 *     nflverse-family reads on this tick are fourteen subrequests, and
 *     {@link cost} is where the test refuses to pretend otherwise.
 *
 * ## Why this is not a restatement of the backfill's own cap
 *
 * `managerIntel.backfill.test.ts` asserts the batch stays inside twenty-four.
 * That test passed every day the invocation was over the ceiling. What is
 * asserted here is the invocation total, that the batch yields to the feeds
 * above it rather than the other way round, and — in `retry storm` — that the
 * budget was *binding*: it refused work, which is only possible if demand
 * exceeded the limit, which is the pre-hardening architecture going over.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index.ts';
import {
  CLOUDFLARE_FREE_SUBREQUEST_CEILING,
  MAX_CRON_SUBREQUESTS,
  REDIRECTING_FETCH_COST,
} from '../src/core/sleeper/budget.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { ManagerLedgerRepo } from '../src/server/repos/managerLedger.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

/** A four-season league, which is what the history policy now admits. */
const CHAIN: Record<string, unknown> = {
  L2026: { league_id: 'L2026', name: 'Tony', season: '2026', status: 'in_season', previous_league_id: 'L2025' },
  L2025: { league_id: 'L2025', name: 'Tony', season: '2025', status: 'complete', previous_league_id: 'L2024' },
  L2024: { league_id: 'L2024', name: 'Tony', season: '2024', status: 'complete', previous_league_id: 'L2023' },
  L2023: { league_id: 'L2023', name: 'Tony', season: '2023', status: 'complete', previous_league_id: 'L2022' },
  L2022: { league_id: 'L2022', name: 'Tony', season: '2022', status: 'complete', previous_league_id: null },
};

const ROSTERS = [
  { roster_id: 1, owner_id: 'u-mine' },
  { roster_id: 4, owner_id: 'u-newcomer' },
  { roster_id: 5, owner_id: 'u-veteran' },
];

/**
 * What one call to this URL really costs Cloudflare.
 *
 * The stub cannot perform the redirect — it answers the request itself — so the
 * hop is charged here instead. Getting this wrong in the optimistic direction
 * is how a green test coexists with a failing cron.
 */
function cost(url: string): number {
  return url.includes('github.com') ? REDIRECTING_FETCH_COST : 1;
}

interface Run {
  /** Every URL a transport actually asked for, in order. */
  urls: string[];
  /** The same, counted the way Cloudflare counts. */
  subrequests: number;
  /** Everything `console.log`/`console.error` was given. */
  logs: string[];
}

interface StubOptions {
  /** Answer every request with a 500, so every retry path runs. */
  failEverything?: boolean;
  /** Fail only requests whose URL contains one of these fragments. */
  failMatching?: string[];
}

/**
 * The whole outside world, as one `fetch`.
 *
 * Deliberately global rather than injected: the point of this file is that
 * `scheduled()` wires its own budget correctly, and a stub handed in through a
 * seam the worker does not use would prove nothing about the worker.
 */
function stubWorld(opts: StubOptions = {}): Run {
  const run: Run = { urls: [], subrequests: 0, logs: [] };

  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    run.urls.push(url);
    run.subrequests += cost(url);

    if (opts.failEverything) return new Response('boom', { status: 500 });
    if (opts.failMatching?.some((f) => url.includes(f))) return new Response('boom', { status: 500 });

    // ---- Sleeper ----
    const league = /\/league\/([^/]+)$/.exec(url);
    if (league) {
      const found = CHAIN[league[1]!];
      return new Response(JSON.stringify(found ?? null), { status: found ? 200 : 404 });
    }
    if (/\/league\/[^/]+\/rosters$/.test(url)) return new Response(JSON.stringify(ROSTERS), { status: 200 });
    const drafts = /\/league\/([^/]+)\/drafts$/.exec(url);
    if (drafts) {
      const id = drafts[1]!;
      return new Response(
        JSON.stringify([{ draft_id: `D${id.slice(1)}`, league_id: id, status: 'complete', season: id.slice(1), type: 'snake' }]),
        { status: 200 },
      );
    }
    if (/\/draft\/[^/]+\/picks$/.test(url)) return new Response('[]', { status: 200 });
    if (/\/transactions\/\d+$/.test(url)) return new Response('[]', { status: 200 });
    if (/\/matchups\/\d+$/.test(url)) return new Response('[]', { status: 200 });
    if (url.includes('/players/nfl/trending/')) return new Response('[]', { status: 200 });
    if (url.includes('/state/nfl')) {
      return new Response(JSON.stringify({ season: '2026', season_type: 'regular', week: 5, leg: 5 }), { status: 200 });
    }
    if (url.includes('/players/nfl')) return new Response('{}', { status: 200 });
    if (url.includes('/stats/nfl/')) return new Response('{}', { status: 200 });

    // ---- nflverse (a GitHub release asset; see `cost`) ----
    if (url.includes('github.com')) return new Response(null, { status: 304 });

    // ---- the Vegas provider ----
    if (url.includes('sportsgameodds')) return new Response(JSON.stringify({ data: [] }), { status: 200 });

    return new Response('null', { status: 200 });
  }) as typeof fetch;

  return run;
}

/**
 * The largest normal feed set: a real Vegas provider rather than the mock, so
 * the season-market probe actually calls out.
 */
function cronEnv(db: NodeSqliteDatabase) {
  return { DB: db, VEGAS_PROVIDER: 'sportsgameodds', SPORTSGAMEODDS_API_KEY: 'test-key' } as never;
}

async function seedLeague(db: NodeSqliteDatabase): Promise<void> {
  await new LeagueRepo(db).upsertLeague({
    id: 'tony',
    sleeperLeagueId: 'L2026',
    name: "Tony's Pizza",
    season: '2026',
    totalRosters: 3,
    scoringSettings: { rec: 1 },
    rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'],
    leagueSettings: { waiver_type: 2, waiver_budget: 100, playoff_week_start: 15 },
    draftId: null,
    lastSyncedAt: new Date().toISOString(),
  });
  await new LeagueRepo(db).replaceRosters('tony', [
    { leagueId: 'tony', rosterId: 1, ownerId: 'u-mine', ownerName: 'You', playerIds: [], starterIds: [], reserveIds: [], isMine: true, settings: {} },
    { leagueId: 'tony', rosterId: 4, ownerId: 'u-newcomer', ownerName: 'New', playerIds: [], starterIds: [], reserveIds: [], isMine: false, settings: {} },
    { leagueId: 'tony', rosterId: 5, ownerId: 'u-veteran', ownerName: 'Vet', playerIds: [], starterIds: [], reserveIds: [], isMine: false, settings: {} },
  ]);
  await new LeagueRepo(db).selectLeague('tony');
  await new PlayerRepo(db).upsertMany([
    {
      id: '1000', sleeperPlayerId: '1000', fullName: 'Player 0', firstName: 'Player', lastName: '0',
      team: 'SF', position: 'QB', status: 'Active', active: true, normalizedName: 'player 0', aliases: [],
    },
  ]);
  await new SettingsRepo(db).set(SETTING_KEYS.nflState, {
    season: '2026', seasonType: 'regular', week: 5, leg: 5, fetchedAt: new Date().toISOString(),
  });
}

/**
 * A backfill that is genuinely mid-flight, which is what §9 asks for.
 *
 * Four seasons already discovered and mapped, so the planner has a full queue
 * of draft indexes and transaction weeks waiting rather than the two or three
 * units a cold league can plan before it has to discover the next link. This is
 * the state an established league is in for its first week, and it is the state
 * in which the invocation has real demand to refuse.
 */
async function seedActiveBackfill(db: NodeSqliteDatabase): Promise<void> {
  const ledger = new ManagerLedgerRepo(db);
  for (const [id, league] of Object.entries(CHAIN)) {
    const row = league as { season: string; status: string; previous_league_id: string | null };
    if (row.season < '2023') continue;
    await ledger.saveSeasonLink({
      leagueId: 'tony',
      sleeperLeagueId: id,
      season: row.season,
      previousLeagueId: row.previous_league_id,
      status: row.status,
      resolved: true,
    });
    // Identity known, so the transaction weeks behind it become plannable.
    await ledger.recordSuccess({
      leagueId: 'tony',
      dataset: 'identity',
      sleeperLeagueId: id,
      season: row.season,
      cursor: null,
      completed: true,
      requestsUsed: 1,
    });
  }
}

/**
 * What the tick told the log it had spent.
 *
 * Compared against the stub's own count in every scenario, and the comparison
 * is the strongest assertion in this file: a path that fetched without being
 * handed the budget would show up as a wire count *above* the budget's, and
 * nothing else here would notice it. Equality is the proof that the metering is
 * complete rather than merely present.
 */
function budgetUsedFromLog(logs: string[]): number | null {
  for (const line of logs) {
    const found = /cron 09:00 subrequests (\d+)\/(\d+)/.exec(line);
    if (found) return Number(found[1]);
  }
  return null;
}

/** The manager backfill's own traffic, which is the traffic that must yield. */
/**
 * The backfill's own requests, told apart from the daily league sync above it.
 *
 * The two overlap in shape and no longer in subject, which is what this had to
 * be rewritten to notice. The daily tick now re-reads the *selected* league —
 * its settings, rosters, users and drafts, all under `/league/tony/…` — so a
 * pattern matching any `/rosters` or `/drafts` counted that read as history and
 * duly reported the backfill running before the feeds it is supposed to yield
 * to.
 *
 * What actually identifies the backfill is the season chain: it walks
 * `previous_league_id` back through `L2025`, `L2024` and so on, and it walks
 * transactions and draft picks. None of those is reachable from a sync of the
 * league the user has selected today.
 */
function historyCalls(urls: string[]): string[] {
  return urls.filter((u) => /\/transactions\//.test(u) || /\/draft\//.test(u) || /\/league\/L20\d\d(\/|$)/.test(u));
}

const DAILY = { cron: '0 9 * * *' };

describe('the daily cron cannot exceed the free-plan subrequest ceiling', () => {
  let db: NodeSqliteDatabase;
  let realFetch: typeof fetch;
  let realLog: typeof console.log;
  let realError: typeof console.error;
  let captured: string[];

  beforeEach(async () => {
    db = await createTestDb();
    await seedLeague(db);
    realFetch = globalThis.fetch;
    realLog = console.log;
    realError = console.error;
    captured = [];
    console.log = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  });

  it('stays under fifty on a healthy morning with an active backfill', async () => {
    const run = stubWorld();
    await worker.scheduled(DAILY, cronEnv(db));
    run.logs = captured;

    expect(run.subrequests).toBeLessThanOrEqual(CLOUDFLARE_FREE_SUBREQUEST_CEILING);
    expect(run.subrequests).toBeLessThanOrEqual(MAX_CRON_SUBREQUESTS);

    // Nothing on the tick fetched outside the budget.
    expect(budgetUsedFromLog(captured)).toBe(run.subrequests);

    // The backfill did run: a healthy morning is when history is supposed to move.
    expect(historyCalls(run.urls).length).toBeGreaterThan(0);

    // And every critical feed was reached, rather than the total being small
    // because most of the tick never happened.
    for (const feed of ['/players/nfl', '/state/nfl', 'github.com', 'trending']) {
      expect(run.urls.some((u) => u.includes(feed)), `${feed} should have been fetched`).toBe(true);
    }
  });

  it('never attempts request fifty-one in a retry storm', async () => {
    /*
     * Every external call answers 500, so every retry-capable path spends its
     * full three attempts and every feed asks for its worst case. This is the
     * scenario that produced roughly sixty-five subrequests before the shared
     * budget existed.
     */
    await seedActiveBackfill(db);
    const run = stubWorld({ failEverything: true });
    await worker.scheduled(DAILY, cronEnv(db));

    expect(run.subrequests).toBeLessThanOrEqual(CLOUDFLARE_FREE_SUBREQUEST_CEILING);
    expect(run.subrequests).toBeLessThanOrEqual(MAX_CRON_SUBREQUESTS);

    /*
     * And the budget was *binding*, which is what makes this test more than a
     * restatement of the limit. The tick spent all but a request or two of what
     * it was allowed and then stopped, so what it wanted was more than 48 — and
     * what it wanted is what the pre-hardening tick would have put on the wire,
     * against a ceiling of 50.
     */
    expect(run.subrequests).toBeGreaterThan(MAX_CRON_SUBREQUESTS - REDIRECTING_FETCH_COST);
    expect(budgetUsedFromLog(captured)).toBe(run.subrequests);

    // The invocation completed rather than throwing: a provider having a bad
    // morning is a quiet tick, not an unhandled rejection.
  });

  it('yields the backfill first, and never the feeds above it', async () => {
    /*
     * Sleeper's bulk endpoints fail and retry, which is where the headroom goes
     * on a bad morning. What must survive is the freshness-sensitive work; what
     * must give way is history.
     */
    const run = stubWorld({ failMatching: ['/players/nfl', '/stats/nfl/', '/matchups/'] });
    await worker.scheduled(DAILY, cronEnv(db));

    expect(run.subrequests).toBeLessThanOrEqual(CLOUDFLARE_FREE_SUBREQUEST_CEILING);
    expect(budgetUsedFromLog(captured)).toBe(run.subrequests);

    // The freshness-sensitive feeds still ran, in spite of the retries above them.
    for (const feed of ['github.com', 'trending', '/state/nfl']) {
      expect(run.urls.some((u) => u.includes(feed)), `${feed} must not be crowded out`).toBe(true);
    }

    // Whatever the backfill got, it was the remainder — it is the last thing on
    // the tick, so nothing it spent could have been taken from a feed above it.
    const firstHistory = run.urls.findIndex((u) => historyCalls([u]).length > 0);
    if (firstHistory >= 0) {
      const nflverseAt = run.urls.findIndex((u) => u.includes('github.com'));
      expect(nflverseAt).toBeGreaterThan(-1);
      expect(nflverseAt, 'the backfill must come after the nflverse feeds').toBeLessThan(firstHistory);
    }
  });

  it('skips the backfill entirely, and cleanly, when nothing is left', async () => {
    /*
     * The nflverse feeds are the expensive half of the tick at two subrequests
     * each; failing the Sleeper bulk reads on top of them is a morning where
     * the budget is gone before history is reached. "Nothing left" must read as
     * a skip and a log line, not as an error and not as a partial unit.
     */
    const run = stubWorld({ failEverything: true });
    await worker.scheduled(DAILY, cronEnv(db));

    const log = captured.join('\n');
    expect(log).toContain('cron 09:00 subrequests');
    expect(run.subrequests).toBeLessThanOrEqual(CLOUDFLARE_FREE_SUBREQUEST_CEILING);

    // Nothing was checkpointed as done on a morning that fetched nothing usable.
    const checkpoints = await new ManagerLedgerRepo(db).checkpoints('tony');
    expect(checkpoints.every((c) => !c.completed)).toBe(true);
  });

  it('resumes the backfill on the next tick, and stays under the ceiling again', async () => {
    const first = stubWorld({ failEverything: true });
    await worker.scheduled(DAILY, cronEnv(db));
    expect(first.subrequests).toBeLessThanOrEqual(CLOUDFLARE_FREE_SUBREQUEST_CEILING);

    const second = stubWorld();
    await worker.scheduled(DAILY, cronEnv(db));
    expect(second.subrequests).toBeLessThanOrEqual(CLOUDFLARE_FREE_SUBREQUEST_CEILING);

    // The tick after a bad one does the history work the bad one could not.
    expect(historyCalls(second.urls).length).toBeGreaterThan(0);
  });

  it('leaves the five-minute tick alone', async () => {
    /*
     * Scope. The budget is the daily tick's, because the daily tick is the one
     * with forty-plus calls in it; the injury check makes two and would gain
     * nothing but a way to be refused.
     */
    const run = stubWorld();
    await worker.scheduled({ cron: '*/5 * * * *' }, cronEnv(db));
    expect(run.subrequests).toBeLessThan(CLOUDFLARE_FREE_SUBREQUEST_CEILING);
  });
});
