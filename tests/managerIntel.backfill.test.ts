/**
 * The resumable backfill, against the real schema and a counting Sleeper.
 *
 * Three claims are being pinned here and they are the ones the free plan
 * depends on:
 *
 *   1. **no invocation exceeds its request budget**, retries included — the
 *      failure that took the previous implementation down in production;
 *   2. **a completed unit is never fetched twice**, so years of history cost
 *      one pass and then nothing;
 *   3. **an interrupted batch resumes exactly where it stopped**, without
 *      duplicating a row or marking anything complete that is not.
 *
 * The Sleeper stub counts URLs rather than logical calls, because that is what
 * Cloudflare counts. A test that asserted on method calls would pass with a
 * client retrying three times into a ceiling.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MAX_SLEEPER_SUBREQUESTS_PER_BATCH, RequestBudget } from '../src/core/sleeper/budget.ts';
import { ManagerIntelService } from '../src/server/services/managerIntelService.ts';
import { ManagerLedgerRepo } from '../src/server/repos/managerLedger.ts';
import { TransactionRepo } from '../src/server/repos/transactions.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

/**
 * A three-season league: 2026 current, 2025 and 2024 behind it.
 *
 * Roster 4 changes hands every season, which is the case the identity rule
 * exists for and the one a roster-keyed history gets wrong.
 */
const CHAIN = {
  L2026: { league_id: 'L2026', name: 'Tony', season: '2026', status: 'in_season', previous_league_id: 'L2025' },
  L2025: { league_id: 'L2025', name: 'Tony', season: '2025', status: 'complete', previous_league_id: 'L2024' },
  L2024: { league_id: 'L2024', name: 'Tony', season: '2024', status: 'complete', previous_league_id: null },
} as const;

const ROSTERS: Record<string, { roster_id: number; owner_id: string | null }[]> = {
  L2026: [
    { roster_id: 1, owner_id: 'u-mine' },
    { roster_id: 4, owner_id: 'u-newcomer' },
    { roster_id: 5, owner_id: 'u-veteran' },
  ],
  L2025: [
    { roster_id: 1, owner_id: 'u-mine' },
    { roster_id: 4, owner_id: 'u-veteran' },
    { roster_id: 5, owner_id: 'u-departed' },
  ],
  L2024: [
    { roster_id: 1, owner_id: 'u-mine' },
    { roster_id: 4, owner_id: 'u-departed' },
    { roster_id: 5, owner_id: 'u-veteran' },
  ],
};

const DRAFTS: Record<string, { draft_id: string; league_id: string; status: string; season: string; type: string }[]> = {
  L2026: [{ draft_id: 'D2026', league_id: 'L2026', status: 'pre_draft', season: '2026', type: 'snake' }],
  L2025: [{ draft_id: 'D2025', league_id: 'L2025', status: 'complete', season: '2025', type: 'snake' }],
  L2024: [{ draft_id: 'D2024', league_id: 'L2024', status: 'complete', season: '2024', type: 'snake' }],
};

/** Sixteen picks: four managers, four rounds, deterministic positions. */
function picksFor(draftId: string, seed: number) {
  const owners = draftId === 'D2025' ? ROSTERS.L2025! : ROSTERS.L2024!;
  const out = [];
  let pickNo = 1;
  for (let round = 1; round <= 4; round++) {
    for (const roster of owners) {
      out.push({
        draft_id: draftId,
        pick_no: pickNo,
        round,
        draft_slot: roster.roster_id,
        player_id: String(1000 + ((pickNo + seed) % 8)),
        picked_by: roster.owner_id,
        roster_id: roster.roster_id,
        metadata: { position: ['QB', 'RB', 'WR', 'TE'][round - 1], years_exp: '2' },
      });
      pickNo += 1;
    }
  }
  return out;
}

interface StubOptions {
  /** URLs that should fail, and how many times each before succeeding. */
  failures?: Map<string, number>;
  /** Transactions to serve, by `<leagueId>:<week>`. */
  transactions?: Record<string, unknown[]>;
}

function stubSleeper(opts: StubOptions = {}) {
  const calls: string[] = [];
  const failures = opts.failures ?? new Map<string, number>();

  const client = new SleeperClient({
    retries: 2,
    fetch: async (url: string) => {
      calls.push(url);

      for (const [fragment, remaining] of failures) {
        if (url.includes(fragment) && remaining > 0) {
          failures.set(fragment, remaining - 1);
          return new Response('boom', { status: 500 });
        }
      }

      const league = /\/league\/([^/]+)$/.exec(url);
      if (league) {
        const found = (CHAIN as Record<string, unknown>)[league[1]!];
        return new Response(JSON.stringify(found ?? null), { status: found ? 200 : 404 });
      }
      const rosters = /\/league\/([^/]+)\/rosters$/.exec(url);
      if (rosters) return new Response(JSON.stringify(ROSTERS[rosters[1]!] ?? []), { status: 200 });

      const drafts = /\/league\/([^/]+)\/drafts$/.exec(url);
      if (drafts) return new Response(JSON.stringify(DRAFTS[drafts[1]!] ?? []), { status: 200 });

      const draftPicks = /\/draft\/([^/]+)\/picks$/.exec(url);
      if (draftPicks) {
        const id = draftPicks[1]!;
        return new Response(JSON.stringify(id === 'D2026' ? [] : picksFor(id, id === 'D2025' ? 0 : 3)), {
          status: 200,
        });
      }

      const txn = /\/league\/([^/]+)\/transactions\/(\d+)$/.exec(url);
      if (txn) {
        return new Response(JSON.stringify(opts.transactions?.[`${txn[1]}:${txn[2]}`] ?? []), { status: 200 });
      }

      return new Response('null', { status: 200 });
    },
  });

  return { client, calls };
}

async function seedLeague(db: NodeSqliteDatabase): Promise<void> {
  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
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
  await leagues.replaceRosters('tony', [
    { leagueId: 'tony', rosterId: 1, ownerId: 'u-mine', ownerName: 'You', playerIds: [], starterIds: [], reserveIds: [], isMine: true, settings: {} },
    { leagueId: 'tony', rosterId: 4, ownerId: 'u-newcomer', ownerName: 'Newcomer', playerIds: [], starterIds: [], reserveIds: [], isMine: false, settings: {} },
    { leagueId: 'tony', rosterId: 5, ownerId: 'u-veteran', ownerName: 'Veteran', playerIds: [], starterIds: [], reserveIds: [], isMine: false, settings: {} },
  ]);

  await new PlayerRepo(db).upsertMany(
    Array.from({ length: 8 }, (_, i) => ({
      id: String(1000 + i),
      sleeperPlayerId: String(1000 + i),
      fullName: `Player ${i}`,
      firstName: 'Player',
      lastName: String(i),
      team: 'SF',
      position: ['QB', 'RB', 'WR', 'TE'][i % 4]!,
      status: 'Active',
      active: true,
      normalizedName: `player ${i}`,
      aliases: [],
    })),
  );
}

const RUN = { leagueId: 'tony', sleeperLeagueId: 'L2026', season: '2026', week: 5 } as const;

describe('the backfill respects the free-plan request budget', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedLeague(db);
  });

  it('never makes more requests than the budget allows, however much work there is', async () => {
    const { client, calls } = stubSleeper();
    const service = new ManagerIntelService(db, { sleeper: client });

    const report = await service.advance({ ...RUN, budget: new RequestBudget(6) });

    expect(calls.length).toBeLessThanOrEqual(6);
    expect(report.requestsUsed).toBe(calls.length);
    expect(report.requestBudget).toBe(6);
    expect(report.budgetBound).toBe(true);
    expect(report.complete).toBe(false);
  });

  it('counts retries against the budget, because Cloudflare does', async () => {
    // Two 500s on the rosters call: the client retries, and all three attempts
    // are real subrequests.
    const { client, calls } = stubSleeper({ failures: new Map([['/rosters', 2]]) });
    const service = new ManagerIntelService(db, { sleeper: client });

    await service.advance({ ...RUN, budget: new RequestBudget(5) });

    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.filter((u) => u.includes('/rosters')).length).toBeGreaterThan(1);
  });

  it('defaults to a budget with real headroom under the fifty-subrequest ceiling', async () => {
    expect(MAX_SLEEPER_SUBREQUESTS_PER_BATCH).toBeLessThanOrEqual(30);
    const { client, calls } = stubSleeper();
    await new ManagerIntelService(db, { sleeper: client }).advance(RUN);
    expect(calls.length).toBeLessThanOrEqual(MAX_SLEEPER_SUBREQUESTS_PER_BATCH);
  });

  it('finishes a three-season league across several batches and then stops asking', async () => {
    const { client, calls } = stubSleeper();
    const service = new ManagerIntelService(db, { sleeper: client });

    let report = await service.advance(RUN);
    let batches = 1;
    while (!report.complete && batches < 12) {
      report = await service.advance(RUN);
      batches += 1;
    }

    expect(report.seasons.sort()).toEqual(['2024', '2025', '2026']);
    expect(batches).toBeGreaterThan(1);

    // Everything that can be finished is finished; what remains is the live
    // season's current week and its unfinished draft, which is correct.
    const ledger = new ManagerLedgerRepo(db);
    const drafts = await ledger.drafts('tony');
    expect(drafts.filter((d) => d.complete && d.picksIngested > 0)).toHaveLength(2);

    calls.length = 0;
    await service.advance(RUN);
    /*
     * A steady-state batch: the live week, the live draft index, and nothing
     * historical at all. Two requests is the whole daily cost of a league whose
     * history is stored — against a free-plan ceiling of fifty.
     */
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.some((u) => u.includes('L2025') || u.includes('L2024'))).toBe(false);
  });
});

describe('the backfill is idempotent and resumable', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedLeague(db);
  });

  async function runToCompletion(service: ManagerIntelService): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const report = await service.advance(RUN);
      if (report.complete) break;
    }
  }

  it('stores one event set for a draft ingested twice', async () => {
    const { client } = stubSleeper();
    const service = new ManagerIntelService(db, { sleeper: client });
    await runToCompletion(service);

    const ledger = new ManagerLedgerRepo(db);
    const first = await ledger.picks('tony');
    expect(first.length).toBe(24);

    // Force a re-ingest of a draft whose picks are already stored.
    await db.prepare('UPDATE manager_history_drafts SET picks_ingested = 0 WHERE draft_id = ?').bind('D2025').run();
    await db.prepare('UPDATE manager_history_checkpoints SET completed = 0 WHERE dataset = ?').bind('drafts').run();
    await service.advance(RUN);

    const second = await ledger.picks('tony');
    expect(second.length).toBe(first.length);
  });

  it('stores one row for a week fetched twice', async () => {
    const transaction = {
      transaction_id: 't1',
      type: 'waiver',
      status: 'complete',
      leg: 2,
      roster_ids: [4],
      adds: { '1001': 4 },
      settings: { waiver_bid: 12 },
      created: Date.UTC(2025, 9, 8),
    };
    const { client } = stubSleeper({ transactions: { 'L2025:2': [transaction] } });
    const service = new ManagerIntelService(db, { sleeper: client });
    await runToCompletion(service);

    const stored = await new TransactionRepo(db).listBySeason('tony');
    expect(stored.filter((s) => s.transaction.transaction_id === 't1')).toHaveLength(1);
  });

  it('leaves the checkpoint where it was when a unit fails', async () => {
    // Every attempt at 2025's picks fails; nothing else does.
    const { client } = stubSleeper({ failures: new Map([['/draft/D2025/picks', 10_000]]) });
    const service = new ManagerIntelService(db, { sleeper: client });

    const report = await service.advance({ ...RUN, budget: new RequestBudget(MAX_SLEEPER_SUBREQUESTS_PER_BATCH) });
    expect(report.errors.length).toBeGreaterThan(0);

    const ledger = new ManagerLedgerRepo(db);
    const picks = await ledger.picks('tony');
    expect(picks.some((p) => p.draftId === 'D2025')).toBe(false);

    const drafts = await ledger.drafts('tony');
    expect(drafts.find((d) => d.draftId === 'D2025')?.picksIngested).toBe(0);

    const checkpoint = (await ledger.checkpoints('tony')).find(
      (c) => c.dataset === 'drafts' && c.sleeperLeagueId === 'L2025',
    );
    expect(checkpoint?.completed).toBe(false);
    expect(checkpoint?.lastError).toBeTruthy();
  });

  it('does not let one failed week block the weeks around it', async () => {
    const { client } = stubSleeper({
      failures: new Map([['L2024/transactions/9', 10_000]]),
      transactions: { 'L2024:8': [], 'L2024:10': [] },
    });
    const service = new ManagerIntelService(db, { sleeper: client });
    for (let i = 0; i < 12; i++) await service.advance(RUN);

    const weeks = await new TransactionRepo(db).weeksRead('tony', '2024');
    const settled = weeks.filter((w) => w.settled).map((w) => w.week);
    expect(settled).toContain(8);
    expect(settled).toContain(10);
    expect(settled).not.toContain(9);

    const checkpoint = (await new ManagerLedgerRepo(db).checkpoints('tony')).find(
      (c) => c.dataset === 'transactions' && c.sleeperLeagueId === 'L2024',
    );
    expect(checkpoint?.completed).toBe(false);
  });
});

describe('manager identity survives roster churn', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedLeague(db);
  });

  it('never lets a roster slot pass its history to its next occupant', async () => {
    const { client } = stubSleeper();
    const service = new ManagerIntelService(db, { sleeper: client });
    for (let i = 0; i < 12; i++) {
      const report = await service.advance(RUN);
      if (report.complete) break;
    }

    const ledger = new ManagerLedgerRepo(db);
    const picks = await ledger.picks('tony');

    /*
     * Roster 4 was `u-departed` in 2024 and `u-veteran` in 2025; today it
     * belongs to `u-newcomer`. Every pick keeps the user who actually made it.
     */
    const roster4 = picks.filter((p) => p.rosterId === 4);
    expect(new Set(roster4.map((p) => p.userId))).toEqual(new Set(['u-departed', 'u-veteran']));
    expect(roster4.some((p) => p.userId === 'u-newcomer')).toBe(false);

    // And the newcomer has no draft profile at all, rather than an inherited one.
    const profiles = await ledger.profiles<{ picksObserved: number }>('tony', 'draft');
    expect(profiles.get('u-newcomer')).toBeUndefined();
    expect(profiles.get('u-veteran')?.sample).toBeGreaterThan(0);
  });
});

describe('derivation needs no Sleeper at all', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedLeague(db);
  });

  it('rebuilds every profile from the ledger without a request', async () => {
    const { client } = stubSleeper();
    const service = new ManagerIntelService(db, { sleeper: client });
    for (let i = 0; i < 12; i++) {
      const report = await service.advance(RUN);
      if (report.complete) break;
    }

    // A service with a client that throws on any use at all.
    const offline = new ManagerIntelService(db, {
      sleeper: new SleeperClient({
        fetch: async () => {
          throw new Error('the derivation must not touch the network');
        },
      }),
    });

    const first = await offline.derive('tony');
    const second = await offline.derive('tony');

    expect(first.picks).toBe(24);
    // Deterministic: the same ledger produces the same profile, every time.
    expect(second).toEqual(first);
  });
});
