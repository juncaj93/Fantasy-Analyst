/**
 * League transaction history, the season chain behind it, and who sat where.
 *
 * All three are keyed by the **Sleeper** league id rather than by this app's
 * internal league row, because history spans seasons and a previous season's
 * league is not a row in `leagues` — see the note in migration 0020.
 */

import type { LeagueTransaction, TransactionStatus, TransactionType } from '../../core/league/transactions.ts';
import type { ManagerSeat } from '../../core/league/managers.ts';
import { MAX_BOUND_PARAMS, chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';

export interface LineageEntry {
  rootSleeperLeagueId: string;
  sleeperLeagueId: string;
  season: string;
  name: string | null;
  depth: number;
  waiverBudget: number | null;
  totalRosters: number | null;
}

export interface WeekSync {
  sleeperLeagueId: string;
  week: number;
  transactions: number;
  syncedAt: string;
}

export class LeagueHistoryRepo {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------- lineage

  async replaceLineage(rootSleeperLeagueId: string, entries: LineageEntry[]): Promise<void> {
    const now = nowIso();
    await this.db.prepare('DELETE FROM league_lineage WHERE root_sleeper_league_id = ?').bind(rootSleeperLeagueId).run();
    for (const batch of chunk(entries, 20)) {
      await this.db.batch(
        batch.map((e) =>
          this.db
            .prepare(
              `INSERT INTO league_lineage
                 (root_sleeper_league_id, sleeper_league_id, season, name, depth, waiver_budget, total_rosters, discovered_at)
               VALUES (?,?,?,?,?,?,?,?)`,
            )
            .bind(
              e.rootSleeperLeagueId,
              e.sleeperLeagueId,
              e.season,
              e.name,
              e.depth,
              e.waiverBudget,
              e.totalRosters,
              now,
            ),
        ),
      );
    }
  }

  async listLineage(rootSleeperLeagueId: string): Promise<LineageEntry[]> {
    const rows = await this.db
      .prepare('SELECT * FROM league_lineage WHERE root_sleeper_league_id = ? ORDER BY depth')
      .bind(rootSleeperLeagueId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      rootSleeperLeagueId: String(r['root_sleeper_league_id']),
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      name: (r['name'] as string | null) ?? null,
      depth: Number(r['depth'] ?? 0),
      waiverBudget: r['waiver_budget'] == null ? null : Number(r['waiver_budget']),
      totalRosters: r['total_rosters'] == null ? null : Number(r['total_rosters']),
    }));
  }

  // -------------------------------------------------------------- seats

  async upsertSeats(seats: (ManagerSeat & { rootSleeperLeagueId: string })[]): Promise<void> {
    const now = nowIso();
    for (const batch of chunk(seats, 20)) {
      await this.db.batch(
        batch.map((s) =>
          this.db
            .prepare(
              `INSERT INTO league_managers
                 (root_sleeper_league_id, sleeper_league_id, season, roster_id, user_id, display_name,
                  waiver_budget_used, wins, losses, is_mine, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(sleeper_league_id, roster_id) DO UPDATE SET
                 user_id = excluded.user_id,
                 display_name = excluded.display_name,
                 waiver_budget_used = excluded.waiver_budget_used,
                 wins = excluded.wins,
                 losses = excluded.losses,
                 is_mine = excluded.is_mine,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              s.rootSleeperLeagueId,
              s.sleeperLeagueId,
              s.season,
              s.rosterId,
              s.userId,
              s.displayName,
              s.waiverBudgetUsed,
              s.wins ?? null,
              s.losses ?? null,
              s.isMine ? 1 : 0,
              now,
            ),
        ),
      );
    }
  }

  /**
   * Every seat in the chain, with that season's budget attached.
   *
   * The budget comes from the lineage row rather than from the seat, because it
   * is a property of the league-season and storing it per seat would let twelve
   * copies of one number disagree.
   */
  async listSeats(rootSleeperLeagueId: string): Promise<ManagerSeat[]> {
    const rows = await this.db
      .prepare(
        `SELECT m.*, l.waiver_budget AS waiver_budget
           FROM league_managers m
           LEFT JOIN league_lineage l
             ON l.root_sleeper_league_id = m.root_sleeper_league_id
            AND l.sleeper_league_id = m.sleeper_league_id
          WHERE m.root_sleeper_league_id = ?
          ORDER BY m.season DESC, m.roster_id`,
      )
      .bind(rootSleeperLeagueId)
      .all<Record<string, unknown>>();

    return rows.results.map((r) => ({
      sleeperLeagueId: String(r['sleeper_league_id']),
      season: String(r['season']),
      rosterId: Number(r['roster_id']),
      userId: (r['user_id'] as string | null) ?? null,
      displayName: (r['display_name'] as string | null) ?? null,
      waiverBudgetUsed: r['waiver_budget_used'] == null ? null : Number(r['waiver_budget_used']),
      budget: r['waiver_budget'] == null ? null : Number(r['waiver_budget']),
      wins: r['wins'] == null ? null : Number(r['wins']),
      losses: r['losses'] == null ? null : Number(r['losses']),
      isMine: Number(r['is_mine'] ?? 0) === 1,
    }));
  }

  // ------------------------------------------------------- transactions

  /**
   * Insert or refresh a week's transactions.
   *
   * Sleeper's transaction id is stable, so a re-sync of a week writes the same
   * primary keys and the history cannot double-count. `status` is allowed to
   * change on conflict, because a pending claim becomes complete or failed
   * after the waiver run and that transition is the entire point of storing it.
   */
  async upsertTransactions(transactions: LeagueTransaction[]): Promise<{ written: number }> {
    if (transactions.length === 0) return { written: 0 };
    const now = nowIso();
    for (const batch of chunk(transactions, 20)) {
      await this.db.batch(
        batch.map((t) =>
          this.db
            .prepare(
              `INSERT INTO league_transactions
                 (sleeper_league_id, transaction_id, season, week, type, status, created_ms, creator_user_id,
                  roster_ids_json, adds_json, drops_json, waiver_bid, budget_moves_json, draft_picks_json, note, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(sleeper_league_id, transaction_id) DO UPDATE SET
                 status = excluded.status,
                 week = excluded.week,
                 waiver_bid = excluded.waiver_bid,
                 adds_json = excluded.adds_json,
                 drops_json = excluded.drops_json,
                 budget_moves_json = excluded.budget_moves_json,
                 note = excluded.note,
                 fetched_at = excluded.fetched_at`,
            )
            .bind(
              t.sleeperLeagueId,
              t.transactionId,
              t.season,
              t.week,
              t.type,
              t.status,
              t.createdMs,
              t.creatorUserId,
              toJson(t.rosterIds),
              toJson(t.adds),
              toJson(t.drops),
              t.waiverBid,
              toJson(t.budgetMoves),
              toJson(t.draftPicks),
              t.note,
              now,
            ),
        ),
      );
    }
    return { written: transactions.length };
  }

  /** Every transaction across the whole season chain, newest week first. */
  async listTransactions(sleeperLeagueIds: string[]): Promise<LeagueTransaction[]> {
    if (sleeperLeagueIds.length === 0) return [];
    const out: LeagueTransaction[] = [];
    for (const batch of chunk(sleeperLeagueIds, MAX_BOUND_PARAMS)) {
      const rows = await this.db
        .prepare(
          `SELECT * FROM league_transactions
            WHERE sleeper_league_id IN (${batch.map(() => '?').join(',')})
            ORDER BY season DESC, week DESC`,
        )
        .bind(...batch)
        .all<Record<string, unknown>>();
      out.push(...rows.results.map(rowToTransaction));
    }
    return out;
  }

  async recordWeekSync(entry: WeekSync): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO league_transaction_sync (sleeper_league_id, week, transactions, synced_at)
         VALUES (?,?,?,?)
         ON CONFLICT(sleeper_league_id, week) DO UPDATE SET
           transactions = excluded.transactions,
           synced_at = excluded.synced_at`,
      )
      .bind(entry.sleeperLeagueId, entry.week, entry.transactions, entry.syncedAt)
      .run();
  }

  async listWeekSyncs(sleeperLeagueIds: string[]): Promise<WeekSync[]> {
    if (sleeperLeagueIds.length === 0) return [];
    const out: WeekSync[] = [];
    for (const batch of chunk(sleeperLeagueIds, MAX_BOUND_PARAMS)) {
      const rows = await this.db
        .prepare(
          `SELECT * FROM league_transaction_sync
            WHERE sleeper_league_id IN (${batch.map(() => '?').join(',')})
            ORDER BY sleeper_league_id, week`,
        )
        .bind(...batch)
        .all<Record<string, unknown>>();
      out.push(
        ...rows.results.map((r) => ({
          sleeperLeagueId: String(r['sleeper_league_id']),
          week: Number(r['week']),
          transactions: Number(r['transactions'] ?? 0),
          syncedAt: String(r['synced_at'] ?? ''),
        })),
      );
    }
    return out;
  }
}

function rowToTransaction(r: Record<string, unknown>): LeagueTransaction {
  return {
    sleeperLeagueId: String(r['sleeper_league_id']),
    transactionId: String(r['transaction_id']),
    season: String(r['season']),
    week: Number(r['week'] ?? 0),
    type: String(r['type'] ?? 'unknown') as TransactionType,
    status: String(r['status'] ?? 'unknown') as TransactionStatus,
    createdMs: r['created_ms'] == null ? null : Number(r['created_ms']),
    creatorUserId: (r['creator_user_id'] as string | null) ?? null,
    rosterIds: parseJson<number[]>(r['roster_ids_json'], []),
    adds: parseJson<LeagueTransaction['adds']>(r['adds_json'], []),
    drops: parseJson<LeagueTransaction['drops']>(r['drops_json'], []),
    waiverBid: r['waiver_bid'] == null ? null : Number(r['waiver_bid']),
    budgetMoves: parseJson<LeagueTransaction['budgetMoves']>(r['budget_moves_json'], []),
    draftPicks: parseJson<Record<string, unknown>[]>(r['draft_picks_json'], []),
    note: (r['note'] as string | null) ?? null,
  };
}
