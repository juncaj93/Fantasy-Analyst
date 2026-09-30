/**
 * The league-strategy layer: budget truth, bid prices, market attention and
 * manager history, assembled once so every screen reads the same answer.
 *
 * The shape of the work is dictated by Sleeper's endpoints rather than by
 * preference. Transactions come one week at a time and never in bulk, so a
 * request path may not walk a season; the fetch is bounded, the finished weeks
 * are stored once, and everything downstream reads storage. Trending is a
 * single cheap request whose value comes entirely from having captured the
 * previous one. Manager history spans the previous-league chain, costs several
 * requests per season, and produces two sentences — so it is computed on a
 * refresh and cached for a week.
 *
 * The division of labour is deliberate: this file does I/O, bounding and
 * assembly. Every judgement — what a bid is worth, whether a tendency has
 * enough behind it, whether a trend disagrees with the model — lives in
 * `core/`, which has no database and is tested without one.
 */

import { SleeperClient } from '../../core/sleeper/client.ts';
import { buildBudgetState, type LeagueBudgetState } from '../../core/faab/budget.ts';
import { collectBids, losingBidNote, summarisePrices, type BidHistory, type PriceSummary } from '../../core/faab/bids.ts';
import { toSnapshot, velocity, trendingHeadline, type TrendingVelocity } from '../../core/market/trending.ts';
import { readFinalWeek } from '../../core/league/planning.ts';
import { isTransactionWeekSettled } from '../../core/league/transactionSettling.ts';
import { LeagueRepo } from '../repos/league.ts';
import { TransactionRepo } from '../repos/transactions.ts';
import { TrendingRepo } from '../repos/trending.ts';
import { ManagerProfileRepo } from '../repos/managerProfiles.ts';
import type { Database } from '../db.ts';

/**
 * How many weeks of transactions one refresh may fetch.
 *
 * A cap rather than a target. The first refresh of an established league would
 * otherwise make eighteen requests in one go; four at a time fills the history
 * over a few refreshes while keeping any single call bounded, and the newest
 * weeks — the ones that price today's waiver run — are fetched first.
 */
export const MAX_WEEKS_PER_REFRESH = 4;

/*
 * Manager history used to live here, in a `refreshProfiles` that walked the
 * previous-league chain on every call. It is gone, and its absence is the
 * point: the walk cost about sixty-six Sleeper requests against a free-plan
 * ceiling of fifty, and it re-read three seasons of immutable history every
 * time. `services/managerIntelService.ts` owns that work now — checkpointed,
 * bounded to twenty-four requests a batch, and derived from stored rows rather
 * than re-fetched. This file keeps what it was always good at: budget truth,
 * bid prices and market attention for the season being played.
 */

/*
 * The last week of the fantasy regular season, and how to read it.
 *
 * `readFinalWeek` answers "the last week a waiver can still pay off": Sleeper
 * publishes `playoff_week_start`, which is the first week a bid no longer buys
 * a regular-season game, so the last useful week is the one before it. Both it
 * and the default moved to `core/league/planning.ts` — the defence planner and
 * Demo Mode need the same reader, and Demo Mode cannot import a server module.
 * Re-exported here so every existing caller and test keeps the import it has.
 */
export { DEFAULT_FINAL_WEEK, readFinalWeek } from '../../core/league/planning.ts';

export interface StrategyContext {
  leagueId: string;
  season: string;
  week: number;
  finalWeek: number;
  budget: LeagueBudgetState;
  prices: PriceSummary;
  bidHistory: BidHistory;
  /** One line about what is and is not knowable about losing bids. */
  losingBids: string;
  trending: Map<string, TrendingVelocity>;
  trendingCapturedAt: string | null;
  /** When this season's transactions were last read from Sleeper. Null before the first read. */
  transactionsReadAt: string | null;
  /** Sleeper's trending drops, from the same daily capture. Empty before the first one. */
  trendingDrops: Map<string, TrendingVelocity>;
  /**
   * Players this league's own roster dropped in the last few weeks, with when.
   * Read off stored transactions; the waiver board says so on the card.
   */
  recentlyDropped: Map<string, string>;
  notes: string[];
}

export class LeagueStrategyService {
  private readonly transactions: TransactionRepo;
  private readonly trending: TrendingRepo;
  private readonly profiles: ManagerProfileRepo;
  private readonly leagues: LeagueRepo;

  constructor(
    db: Database,
    private readonly deps: { sleeper?: SleeperClient } = {},
  ) {
    this.transactions = new TransactionRepo(db);
    this.trending = new TrendingRepo(db);
    this.profiles = new ManagerProfileRepo(db);
    this.leagues = new LeagueRepo(db);
  }

  private get sleeper(): SleeperClient {
    return this.deps.sleeper ?? new SleeperClient();
  }

  /**
   * Fetch the weeks that are missing or still in play, and store them.
   *
   * The current week is always refetched, because a waiver run can land
   * between two page loads, and so is the week before it until Thursday:
   * Sleeper files that week's Wednesday-morning waiver claims under it after
   * the week number has already moved on. See
   * `core/league/transactionSettling.ts`.
   */
  async syncTransactions(opts: {
    leagueId: string;
    sleeperLeagueId: string;
    season: string;
    week: number;
    maxWeeks?: number;
    now?: Date;
  }): Promise<{ weeksFetched: number[]; transactions: number }> {
    const throughWeek = Math.max(1, Math.min(opts.week, 18));
    const wanted = await this.transactions.weeksToFetch({
      leagueId: opts.leagueId,
      season: opts.season,
      throughWeek,
      maxWeeks: opts.maxWeeks ?? MAX_WEEKS_PER_REFRESH,
    });

    const fetched: number[] = [];
    let stored = 0;
    for (const week of wanted) {
      const rows = await this.sleeper.getTransactions(opts.sleeperLeagueId, week);
      stored += await this.transactions.saveWeek({
        leagueId: opts.leagueId,
        season: opts.season,
        week,
        transactions: rows,
        settled: isTransactionWeekSettled({
          week,
          currentWeek: throughWeek,
          finishedSeason: false,
          now: opts.now ?? new Date(),
        }),
      });
      fetched.push(week);
    }
    return { weeksFetched: fetched, transactions: stored };
  }

  /**
   * Capture the trending list.
   *
   * Stamped with the capture time rather than with anything Sleeper sends,
   * because Sleeper sends no timestamp at all — the list is simply "now", and
   * the whole velocity story rests on knowing when now was.
   */
  async captureTrending(opts: { lookbackHours?: number; limit?: number; now?: Date } = {}): Promise<{
    captured: number;
    capturedAt: string;
    /** Rows of the drops list stored, or null when that read failed. */
    drops: number | null;
  }> {
    const lookbackHours = opts.lookbackHours ?? 24;
    const capturedAt = (opts.now ?? new Date()).toISOString();
    const rows = await this.sleeper.getTrendingPlayers('add', { lookbackHours, limit: opts.limit ?? 50 });
    const snapshot = toSnapshot(rows, { capturedAt, type: 'add', lookbackHours });
    const captured = await this.trending.save(snapshot);

    /*
     * The drops list, one more request on the same clock.
     *
     * Same shape, same table (`trend_type` is part of the key), same window. It
     * answers the one question the adds list cannot: is the rest of Sleeper
     * cutting this free agent today, which usually means news the projections
     * have not caught up with. Caught on its own, because a failed drop read is
     * no reason to lose the adds that already landed.
     */
    let drops: number | null = null;
    try {
      const dropRows = await this.sleeper.getTrendingPlayers('drop', { lookbackHours, limit: opts.limit ?? 50 });
      drops = await this.trending.save(toSnapshot(dropRows, { capturedAt, type: 'drop', lookbackHours }));
    } catch {
      drops = null;
    }

    await this.trending.prune(undefined, opts.now ?? new Date());
    return { captured, capturedAt, drops };
  }

  /**
   * Everything the strategy layer knows about one league, in one object.
   *
   * Read-only: it never fetches. A caller that wants fresh data calls the sync
   * methods first, which keeps a page load from silently turning into eight
   * Sleeper requests.
   */
  async context(leagueId: string, opts: { week: number; season: string }): Promise<StrategyContext | null> {
    const league = await this.leagues.getLeague(leagueId);
    if (!league) return null;

    const rosters = await this.leagues.listRosters(leagueId);
    const stored = await this.transactions.list(leagueId, { season: opts.season });
    const weekRows = await this.transactions.weeksRead(leagueId, opts.season);
    const weeksRead = weekRows.map((w) => w.week);
    const transactionsReadAt = weekRows.reduce<string | null>((latest, w) => (latest == null || w.fetchedAt > latest ? w.fetchedAt : latest), null);

    const budget = buildBudgetState({
      leagueSettings: league.leagueSettings,
      rosters: rosters.map((r) => ({
        rosterId: r.rosterId,
        ownerName: r.ownerName,
        isMine: r.isMine,
        settings: r.settings ?? null,
      })),
      transactions: stored,
    });

    const bidHistory = collectBids(stored, weeksRead);
    const prices = summarisePrices(bidHistory);

    const current = await this.trending.capture('add');
    const previous = current ? await this.trending.comparablePrevious(current) : null;
    const dropCapture = await this.trending.capture('drop').catch(() => null);

    /*
     * Your own cuts, newest first, keyed by player. Completed transactions only:
     * a failed claim dropped nobody. Four weeks back is plenty for a note that
     * reaches back two.
     */
    const mine = rosters.find((r) => r.isMine)?.rosterId ?? null;
    const recentlyDropped = new Map<string, string>();
    const since = Date.now() - 28 * 86_400_000;
    for (const txn of stored) {
      if (mine == null || txn.status !== 'complete' || !txn.drops || typeof txn.created !== 'number') continue;
      if (txn.created < since) continue;
      for (const [playerId, rosterId] of Object.entries(txn.drops)) {
        if (Number(rosterId) !== mine) continue;
        const at = new Date(txn.created).toISOString();
        const known = recentlyDropped.get(playerId);
        if (!known || known < at) recentlyDropped.set(playerId, at);
      }
    }

    const notes = [...budget.notes];
    if (weeksRead.length === 0) {
      notes.push('No transaction history has been read for this league yet, so bid prices are estimates.');
    }
    if (current == null) {
      notes.push('No trending capture has been taken yet, so market attention is unknown.');
    } else if (previous == null) {
      notes.push('Only one trending capture exists, so add rates are shown without velocity.');
    }

    return {
      leagueId,
      season: opts.season,
      week: opts.week,
      finalWeek: readFinalWeek(league.leagueSettings),
      budget,
      prices,
      bidHistory,
      losingBids: losingBidNote(prices),
      trending: current ? velocity(current, previous) : new Map(),
      trendingCapturedAt: current?.capturedAt ?? null,
      transactionsReadAt,
      trendingDrops: dropCapture ? velocity(dropCapture, null) : new Map(),
      recentlyDropped,
      notes,
    };
  }

  /** One short line about a player's market attention, or nothing. */
  headlineFor(context: StrategyContext, playerId: string, opts: { availableInLeague?: boolean } = {}): string | null {
    const v = context.trending.get(playerId);
    return v ? trendingHeadline(v, opts) : null;
  }

  async managerProfiles(leagueId: string) {
    const [trade, draft, room] = await Promise.all([
      this.profiles.tradeProfiles(leagueId),
      this.profiles.draftProfiles(leagueId),
      this.profiles.roomProfile(leagueId),
    ]);
    return { trade, draft, room };
  }
}

