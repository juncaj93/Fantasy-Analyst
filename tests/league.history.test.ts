/**
 * Transaction normalization, and the whole history pipeline against real SQL.
 *
 * The normalization tests come first because one of them guards the single
 * most consequential distinction in this workstream: a transaction with no bid
 * is not a $0 bid, and reading the first as the second drags every expected
 * cost in the league towards a dollar.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  losingBids,
  normalizeTransaction,
  normalizeTransactions,
  readWaiverBid,
  usesFaab,
  winningBids,
  type SleeperTransaction,
} from '../src/core/league/transactions.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { LeagueHistoryRepo } from '../src/server/repos/leagueHistory.ts';
import { DecisionFeedRepo } from '../src/server/repos/decisionFeed.ts';
import { RankDecompositionRepo } from '../src/server/repos/rankDecomposition.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { LeagueHistoryService } from '../src/server/services/leagueHistoryService.ts';
import { LeagueIntelService } from '../src/server/services/leagueIntelService.ts';
import { createTestDb } from './helpers/db.ts';

const CTX = { sleeperLeagueId: 'L2026', season: '2026', week: 3 };

/** A real payload, trimmed to the fields consumed — captured from the live API. */
const REAL_WAIVER: SleeperTransaction = {
  status: 'complete',
  type: 'waiver',
  metadata: { notes: 'Your waiver claim was processed successfully!' },
  created: 1757461766547,
  settings: { seq: 1, waiver_bid: 18 },
  leg: 1,
  draft_picks: [],
  creator: '565055766764228608',
  transaction_id: '1271290427063951361',
  adds: { '6271': 7 },
  drops: { '10219': 7 },
  consenter_ids: [7],
  roster_ids: [7],
};

const REAL_FAILURE: SleeperTransaction = {
  ...REAL_WAIVER,
  transaction_id: '1276401229290799104',
  status: 'failed',
  metadata: { notes: 'This player was claimed by another owner.' },
  settings: { seq: 1, waiver_bid: 25 },
  drops: null,
};

const REAL_TRADE: SleeperTransaction = {
  status: 'complete',
  type: 'trade',
  metadata: null,
  created: 1750779913670,
  settings: null,
  leg: 1,
  draft_picks: [{ round: 4, season: '2025', roster_id: 1, owner_id: 10, previous_owner_id: 9 }],
  creator: '411368198248615936',
  transaction_id: '1243264704810319872',
  adds: null,
  drops: null,
  consenter_ids: [9, 10],
  roster_ids: [9, 10],
  waiver_budget: [{ sender: 9, receiver: 10, amount: 12 }],
};

describe('normalizing what Sleeper sends', () => {
  it('reads a winning claim, its bid and both sides of the move', () => {
    const t = normalizeTransaction(REAL_WAIVER, CTX)!;
    expect(t.type).toBe('waiver');
    expect(t.status).toBe('complete');
    expect(t.waiverBid).toBe(18);
    expect(t.week).toBe(1);
    expect(t.adds).toEqual([{ sleeperPlayerId: '6271', rosterId: 7 }]);
    expect(t.drops).toEqual([{ sleeperPlayerId: '10219', rosterId: 7 }]);
  });

  it('keeps a losing claim, because it is the evidence about the price', () => {
    const t = normalizeTransaction(REAL_FAILURE, CTX)!;
    expect(t.status).toBe('failed');
    expect(t.waiverBid).toBe(25);
    expect(losingBids([t])).toHaveLength(1);
    expect(winningBids([t])).toHaveLength(0);
  });

  it('reads a trade, its picks and its FAAB transfer', () => {
    const t = normalizeTransaction(REAL_TRADE, CTX)!;
    expect(t.type).toBe('trade');
    expect(t.rosterIds).toEqual([9, 10]);
    expect(t.budgetMoves).toEqual([{ sender: 9, receiver: 10, amount: 12 }]);
    expect(t.draftPicks).toHaveLength(1);
    // A trade of nothing but picks still has both teams on it.
    expect(t.adds).toEqual([]);
  });

  it('never turns a missing bid into a bid of zero', () => {
    expect(readWaiverBid(null)).toBeNull();
    expect(readWaiverBid({ seq: 1 })).toBeNull();
    expect(readWaiverBid({ waiver_bid: 0 })).toBe(0);
    expect(readWaiverBid({ waiver_bid: '7' })).toBe(7);
    expect(readWaiverBid({ waiver_bid: -1 })).toBeNull();

    const freeAgent = normalizeTransaction({ ...REAL_WAIVER, type: 'free_agent', settings: null }, CTX)!;
    expect(freeAgent.waiverBid).toBeNull();
  });

  it('tells a FAAB league from a priority league that has a budget setting', () => {
    const zeroes = normalizeTransactions(
      [
        { ...REAL_WAIVER, transaction_id: 'a', settings: { waiver_bid: 0 } },
        { ...REAL_WAIVER, transaction_id: 'b', settings: { waiver_bid: 0 } },
      ],
      CTX,
    );
    expect(usesFaab(zeroes)).toBe(false);
    expect(usesFaab(normalizeTransactions([REAL_WAIVER], CTX))).toBe(true);
  });

  it('falls back to the requested week when Sleeper sends no leg', () => {
    const t = normalizeTransaction({ ...REAL_WAIVER, leg: null }, CTX)!;
    expect(t.week).toBe(3);
  });

  it('drops a payload with no transaction id rather than inventing one', () => {
    expect(normalizeTransaction({ ...REAL_WAIVER, transaction_id: '' }, CTX)).toBeNull();
  });
});

// ------------------------------------------------------------- persistence

/** A Sleeper stub that answers the documented endpoints from fixtures. */
function stubClient(opts: {
  leagues: Record<string, Record<string, unknown>>;
  transactions: Record<string, SleeperTransaction[]>;
  rosters?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
}) {
  const calls: string[] = [];
  const client = new SleeperClient({
    fetch: async (url: string) => {
      calls.push(url);
      const path = new URL(url).pathname;
      const league = /\/league\/([^/]+)/.exec(path)?.[1];

      if (/\/transactions\/(\d+)$/.test(path)) {
        const week = /\/transactions\/(\d+)$/.exec(path)![1]!;
        return json(opts.transactions[`${league}:${week}`] ?? []);
      }
      if (path.endsWith('/rosters')) return json(opts.rosters ?? []);
      if (path.endsWith('/users')) return json(opts.users ?? []);
      if (league) return json(opts.leagues[league] ?? null);
      return json(null);
    },
  });
  return { client, calls };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const LEAGUE_2026 = {
  league_id: 'L2026',
  name: 'The League',
  season: '2026',
  total_rosters: 2,
  settings: { waiver_budget: 100, playoff_week_start: 15, playoff_teams: 4 },
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN'],
  scoring_settings: { rec: 1, pass_yd: 0.04 },
  previous_league_id: 'L2025',
};

const LEAGUE_2025 = { ...LEAGUE_2026, league_id: 'L2025', season: '2025', previous_league_id: null };

const ROSTERS = [
  { roster_id: 1, owner_id: 'u1', league_id: 'L2026', players: ['1'], starters: ['1'], settings: { waiver_budget_used: 93, wins: 8, losses: 2 } },
  { roster_id: 2, owner_id: 'u2', league_id: 'L2026', players: ['2'], starters: ['2'], settings: { waiver_budget_used: 10, wins: 2, losses: 8 } },
];

const USERS = [
  { user_id: 'u1', username: 'alice', display_name: 'Alice', avatar: null },
  { user_id: 'u2', username: 'bob', display_name: 'Bob', avatar: null },
];

describe('LeagueHistoryService', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await new LeagueRepo(db).upsertLeague({
      id: 'L2026',
      sleeperLeagueId: 'L2026',
      name: 'The League',
      season: '2026',
      totalRosters: 2,
      scoringSettings: { rec: 1 },
      rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN'],
      leagueSettings: { waiver_budget: 100 },
      draftId: null,
      lastSyncedAt: '2026-09-01T00:00:00.000Z',
    });
    await new LeagueRepo(db).selectLeague('L2026');
    await new SettingsRepo(db).set(SETTING_KEYS.sleeperUser, { userId: 'u1', username: 'alice', displayName: 'Alice' });
  });

  it('walks the season chain and stores both seasons', async () => {
    const { client } = stubClient({
      leagues: { L2026: LEAGUE_2026, L2025: LEAGUE_2025 },
      transactions: { 'L2026:1': [REAL_WAIVER, REAL_FAILURE], 'L2025:1': [REAL_TRADE] },
      rosters: ROSTERS,
      users: USERS,
    });

    const report = await new LeagueHistoryService(db, client).sync('L2026', { throughWeek: 2 });

    expect(report.seasons.map((s) => s.season)).toEqual(['2026', '2025']);
    expect(report.transactionsWritten).toBe(3);
    expect(report.seatsWritten).toBe(4);

    const repo = new LeagueHistoryRepo(db);
    const lineage = await repo.listLineage('L2026');
    expect(lineage.map((l) => l.season)).toEqual(['2026', '2025']);
    expect(lineage[0]!.waiverBudget).toBe(100);
  });

  it('says so when a league has no previous season', async () => {
    const { client } = stubClient({ leagues: { L2026: { ...LEAGUE_2026, previous_league_id: null } }, transactions: {}, rosters: ROSTERS, users: USERS });
    const report = await new LeagueHistoryService(db, client).sync('L2026', { throughWeek: 1 });
    expect(report.notes.join(' ')).toContain('no previous season');
    expect(report.seasons).toHaveLength(1);
  });

  it('is idempotent: a second sync does not double-count', async () => {
    const { client } = stubClient({
      leagues: { L2026: { ...LEAGUE_2026, previous_league_id: null } },
      transactions: { 'L2026:1': [REAL_WAIVER, REAL_FAILURE] },
      rosters: ROSTERS,
      users: USERS,
    });
    const service = new LeagueHistoryService(db, client);
    await service.sync('L2026', { throughWeek: 1 });
    await service.sync('L2026', { throughWeek: 1 });

    const stored = await new LeagueHistoryRepo(db).listTransactions(['L2026']);
    expect(stored).toHaveLength(2);
  });

  it('records a quiet week as read, so silence is explicable', async () => {
    const { client } = stubClient({
      leagues: { L2026: { ...LEAGUE_2026, previous_league_id: null } },
      transactions: {},
      rosters: ROSTERS,
      users: USERS,
    });
    await new LeagueHistoryService(db, client).sync('L2026', { throughWeek: 3 });
    const syncs = await new LeagueHistoryRepo(db).listWeekSyncs(['L2026']);
    expect(syncs.map((s) => s.week)).toEqual([1, 2, 3]);
    expect(syncs.every((s) => s.transactions === 0)).toBe(true);
  });

  it('does not loop forever on a league that points at itself', async () => {
    const { client } = stubClient({
      leagues: { L2026: { ...LEAGUE_2026, previous_league_id: 'L2026' } },
      transactions: {},
      rosters: ROSTERS,
      users: USERS,
    });
    const report = await new LeagueHistoryService(db, client).sync('L2026', { throughWeek: 1 });
    expect(report.seasons).toHaveLength(1);
  });

  it('stores each manager’s spend and record against their own seat', async () => {
    const { client } = stubClient({
      leagues: { L2026: { ...LEAGUE_2026, previous_league_id: null } },
      transactions: {},
      rosters: ROSTERS,
      users: USERS,
    });
    await new LeagueHistoryService(db, client).sync('L2026', { throughWeek: 1 });

    const seats = await new LeagueHistoryRepo(db).listSeats('L2026');
    const alice = seats.find((s) => s.userId === 'u1')!;
    expect(alice.waiverBudgetUsed).toBe(93);
    expect(alice.budget).toBe(100);
    expect(alice.wins).toBe(8);
    expect(alice.isMine).toBe(true);
    expect(seats.find((s) => s.userId === 'u2')!.isMine).toBe(false);
  });
});

describe('LeagueIntelService', () => {
  let db: NodeSqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
    await new LeagueRepo(db).upsertLeague({
      id: 'L2026',
      sleeperLeagueId: 'L2026',
      name: 'The League',
      season: '2026',
      totalRosters: 2,
      scoringSettings: { rec: 1 },
      rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN'],
      leagueSettings: { waiver_budget: 100 },
      draftId: null,
      lastSyncedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('reports the limits rather than pretending it has history', async () => {
    const context = (await new LeagueIntelService(db).context('L2026'))!;
    expect(context.limits).toContain('league history has never been synced');
    expect(context.transactions).toEqual([]);
    expect(context.faabLeague).toBe(false);
    // The current season's budget still comes through from the league record.
    expect(context.budget).toBe(100);
  });

  it('is null for a league that does not exist', async () => {
    expect(await new LeagueIntelService(db).context('nope')).toBeNull();
  });
});

describe('decision feed storage', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('supersedes rather than deletes, and can be marked seen', async () => {
    const repo = new DecisionFeedRepo(db);
    const event = {
      kind: 'injury' as const,
      dedupeKey: 'injury:1',
      playerId: '1',
      headline: 'Ruled out',
      magnitude: 0.9,
      occurredAt: '2026-09-12T10:00:00.000Z',
      changesDecision: true,
      corroboration: ['Sleeper', 'injury report'],
      detail: null,
    };
    await repo.insert('L2026', event);

    const open = await repo.listOpen('L2026');
    expect(open).toHaveLength(1);
    expect(open[0]!.detail).toContain('also reported by');

    await repo.supersede(open[0]!.id);
    expect(await repo.listOpen('L2026')).toHaveLength(0);

    await repo.insert('L2026', { ...event, dedupeKey: 'injury:2' });
    expect((await repo.markSeen('L2026')).marked).toBe(1);
    expect((await repo.listOpen('L2026'))[0]!.seenAt).not.toBeNull();
  });
});

describe('rank decomposition storage', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  const snapshot = (over: Record<string, unknown> = {}) => ({
    context: 'draft',
    scope: 'd1',
    playerId: 'p1',
    rank: 8,
    total: 10,
    components: [{ key: 'role', label: 'Role', value: 10 }],
    inputHash: 'aaaa',
    ...over,
  });

  it('stores a changed snapshot and skips an unchanged one', async () => {
    const repo = new RankDecompositionRepo(db);
    expect(await repo.capture([snapshot()], '2026-09-10T00:00:00.000Z')).toEqual({ captured: 1, unchanged: 0 });
    expect(await repo.capture([snapshot()], '2026-09-11T00:00:00.000Z')).toEqual({ captured: 0, unchanged: 1 });
    expect(
      await repo.capture([snapshot({ inputHash: 'bbbb', total: 14, rank: 4 })], '2026-09-12T00:00:00.000Z'),
    ).toEqual({ captured: 1, unchanged: 0 });

    const latest = (await repo.latest('draft', 'd1', 'p1'))!;
    expect(latest.total).toBe(14);
    expect(latest.capturedAt).toBe('2026-09-12T00:00:00.000Z');
  });
});
