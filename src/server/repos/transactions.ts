/**
 * Stored league transactions, and the record of which weeks have been read.
 *
 * The second half is the part that is easy to skip and expensive to skip. A
 * query returning no waiver claims for week 6 means one of two very different
 * things — nobody claimed anybody, or nobody has looked — and a bid history
 * built on the second is short without saying so. `league_transaction_weeks`
 * keeps them apart, and `settled` records the weeks that can never change again
 * so a finished week is fetched exactly once.
 */

import { chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';
import type { SleeperTransaction } from '../../core/sleeper/types.ts';

export interface StoredTransactionWeek {
  leagueId: string;
  season: string;
  week: number;
  fetchedAt: string;
  transactionsSeen: number;
  settled: boolean;
}

export class TransactionRepo {
  constructor(private readonly db: Database) {}

  /**
   * Store one week's transactions and mark the week read.
   *
   * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`: a pending claim becomes
   * complete or failed later in the same week, and a row frozen at `pending`
   * would be permanently invisible to the bid history.
   */
  async saveWeek(opts: {
    leagueId: string;
    season: string;
    week: number;
    transactions: SleeperTransaction[];
    settled: boolean;
    /**
     * The Sleeper league this week was actually read from.
     *
     * Optional, and absent means "the current season's league" — which is what
     * every row written before the history backfill existed means. Present, it
     * is what tells a 2024 row from a 2026 one: `leagueId` is this app's own id
     * for the league *now*, and history is fetched from a different Sleeper id
     * every season.
     */
    sleeperLeagueId?: string | null;
  }): Promise<number> {
    const fetchedAt = nowIso();

    for (const batch of chunk(opts.transactions, 20)) {
      const statements = batch.map((txn) =>
        this.db
          .prepare(
            `INSERT INTO league_transactions (
               league_id, transaction_id, season, week, txn_type, status, created_at_ms,
               waiver_bid, faab_traded, draft_picks_moved, roster_ids_json, adds_json,
               drops_json, creator, payload_json, fetched_at, sleeper_league_id
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(league_id, transaction_id) DO UPDATE SET
               status = excluded.status,
               waiver_bid = excluded.waiver_bid,
               faab_traded = excluded.faab_traded,
               draft_picks_moved = excluded.draft_picks_moved,
               adds_json = excluded.adds_json,
               drops_json = excluded.drops_json,
               payload_json = excluded.payload_json,
               fetched_at = excluded.fetched_at,
               sleeper_league_id = COALESCE(excluded.sleeper_league_id, league_transactions.sleeper_league_id)`,
          )
          .bind(
            opts.leagueId,
            txn.transaction_id,
            opts.season,
            typeof txn.leg === 'number' ? txn.leg : opts.week,
            txn.type,
            txn.status,
            typeof txn.created === 'number' ? txn.created : null,
            /*
             * A bid of zero is a real bid — the standard way to claim a player
             * nobody else wants — so only an absent field becomes NULL.
             */
            typeof txn.settings?.['waiver_bid'] === 'number' ? txn.settings['waiver_bid'] : null,
            (txn.waiver_budget ?? []).reduce((sum, m) => sum + (Number(m.amount) || 0), 0),
            (txn.draft_picks ?? []).length,
            toJson(txn.roster_ids ?? []),
            txn.adds ? toJson(txn.adds) : null,
            txn.drops ? toJson(txn.drops) : null,
            txn.creator ?? null,
            toJson(txn),
            fetchedAt,
            opts.sleeperLeagueId ?? null,
          ),
      );
      if (statements.length > 0) await this.db.batch(statements);
    }

    await this.db
      .prepare(
        `INSERT INTO league_transaction_weeks (league_id, season, week, fetched_at, transactions_seen, settled, sleeper_league_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(league_id, season, week) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           transactions_seen = excluded.transactions_seen,
           -- Settled is a one-way door: a week that is over does not reopen.
           settled = MAX(league_transaction_weeks.settled, excluded.settled),
           sleeper_league_id = COALESCE(excluded.sleeper_league_id, league_transaction_weeks.sleeper_league_id)`,
      )
      .bind(
        opts.leagueId,
        opts.season,
        opts.week,
        fetchedAt,
        opts.transactions.length,
        opts.settled ? 1 : 0,
        opts.sleeperLeagueId ?? null,
      )
      .run();

    return opts.transactions.length;
  }

  /** Every transaction stored for a league, newest week first. */
  async list(leagueId: string, opts: { season?: string; type?: string } = {}): Promise<SleeperTransaction[]> {
    const clauses = ['league_id = ?'];
    const binds: unknown[] = [leagueId];
    if (opts.season) {
      clauses.push('season = ?');
      binds.push(opts.season);
    }
    if (opts.type) {
      clauses.push('txn_type = ?');
      binds.push(opts.type);
    }
    const rows = await this.db
      .prepare(`SELECT payload_json FROM league_transactions WHERE ${clauses.join(' AND ')} ORDER BY week DESC`)
      .bind(...binds)
      .all<{ payload_json: string }>();
    return rows.results.map((r) => parseJson<SleeperTransaction>(r.payload_json, {} as SleeperTransaction));
  }

  /**
   * Every stored transaction with the season it belongs to, oldest first.
   *
   * The read the manager-history derivations make. `list` returns payloads
   * alone, which is enough for a single-season question and not enough for a
   * multi-season one: a transaction's roster ids can only be resolved to people
   * through the roster map of *its own* season, so a caller that has lost track
   * of which season a row came from cannot attribute it to anybody.
   */
  async listBySeason(leagueId: string): Promise<{ season: string; transaction: SleeperTransaction }[]> {
    const rows = await this.db
      .prepare(
        'SELECT season, payload_json FROM league_transactions WHERE league_id = ? ORDER BY season ASC, week ASC',
      )
      .bind(leagueId)
      .all<{ season: string; payload_json: string }>();
    return rows.results.map((r) => ({
      season: String(r.season),
      transaction: parseJson<SleeperTransaction>(r.payload_json, {} as SleeperTransaction),
    }));
  }

  /**
   * How many transactions are stored, without loading any of them.
   *
   * A count for a diagnostics line. Reading every payload to call `.length` on
   * the array was several megabytes of JSON parsed to produce one integer.
   */
  async countStored(leagueId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM league_transactions WHERE league_id = ?')
      .bind(leagueId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** Which weeks have been read, in every season. For coverage reporting. */
  async allWeeksRead(leagueId: string): Promise<StoredTransactionWeek[]> {
    const rows = await this.db
      .prepare('SELECT * FROM league_transaction_weeks WHERE league_id = ? ORDER BY season ASC, week ASC')
      .bind(leagueId)
      .all<Record<string, unknown>>();
    return rows.results.map(toWeek);
  }

  /** Which weeks have been read, so a caller knows what its sample covers. */
  async weeksRead(leagueId: string, season: string): Promise<StoredTransactionWeek[]> {
    const rows = await this.db
      .prepare('SELECT * FROM league_transaction_weeks WHERE league_id = ? AND season = ? ORDER BY week ASC')
      .bind(leagueId, season)
      .all<Record<string, unknown>>();
    return rows.results.map(toWeek);
  }

  /**
   * Weeks that still need fetching: never read, or read while still in play.
   *
   * The current week is always included even when it was read a minute ago,
   * because a waiver run can land between two page loads and a stale current
   * week is the one case where "we already have it" is wrong.
   */
  async weeksToFetch(opts: {
    leagueId: string;
    season: string;
    throughWeek: number;
    maxWeeks?: number;
  }): Promise<number[]> {
    const read = await this.weeksRead(opts.leagueId, opts.season);
    const settled = new Set(read.filter((w) => w.settled).map((w) => w.week));
    const wanted: number[] = [];
    for (let week = 1; week <= opts.throughWeek; week++) {
      if (!settled.has(week)) wanted.push(week);
    }
    /*
     * Newest first, then bounded. A page load that can afford three requests
     * should spend them on the weeks that price today's waiver run, not on
     * week 1.
     */
    wanted.reverse();
    return opts.maxWeeks != null ? wanted.slice(0, opts.maxWeeks) : wanted;
  }
}

/** One `league_transaction_weeks` row, read the same way everywhere. */
function toWeek(r: Record<string, unknown>): StoredTransactionWeek {
  return {
    leagueId: String(r['league_id']),
    season: String(r['season']),
    week: Number(r['week']),
    fetchedAt: String(r['fetched_at']),
    transactionsSeen: Number(r['transactions_seen'] ?? 0),
    settled: Number(r['settled'] ?? 0) === 1,
  };
}
