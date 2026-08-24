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
import type { SleeperTransaction } from '../../core/sleeper/types.ts';
import { buildBudgetState, type LeagueBudgetState } from '../../core/faab/budget.ts';
import { collectBids, losingBidNote, summarisePrices, type BidHistory, type PriceSummary } from '../../core/faab/bids.ts';
import { toSnapshot, velocity, trendingHeadline, type TrendingVelocity } from '../../core/market/trending.ts';
import { buildTradeProfile, collectTrades, type TradeEvent } from '../../core/managers/tradeProfile.ts';
import { buildManagerDraftProfile, buildRoomProfile, type HistoricalPick } from '../../core/managers/draftProfile.ts';
import { neutralTendencies, readManagerTendencies } from '../../core/managers/managerTendencies.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
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

/**
 * How far back the previous-league chain is followed.
 *
 * Three seasons is enough for a manager profile to mean something and short
 * enough that the person described is still recognisably the same manager. It
 * also bounds the request count: each season is one league lookup plus one
 * transaction fetch per week that had any.
 */
export const MAX_HISTORY_SEASONS = 3;

/** The last week of the fantasy regular season, when the league does not say. */
export const DEFAULT_FINAL_WEEK = 14;

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
  notes: string[];
}

export class LeagueStrategyService {
  private readonly transactions: TransactionRepo;
  private readonly trending: TrendingRepo;
  private readonly profiles: ManagerProfileRepo;
  private readonly leagues: LeagueRepo;

  constructor(
    private readonly db: Database,
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
   * A week before the current one can never change again, so it is marked
   * settled and never fetched a second time. The current week is always
   * refetched, because a waiver run can land between two page loads.
   */
  async syncTransactions(opts: {
    leagueId: string;
    sleeperLeagueId: string;
    season: string;
    week: number;
    maxWeeks?: number;
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
        settled: week < throughWeek,
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
  }> {
    const lookbackHours = opts.lookbackHours ?? 24;
    const rows = await this.sleeper.getTrendingPlayers('add', { lookbackHours, limit: opts.limit ?? 50 });
    const snapshot = toSnapshot(rows, {
      capturedAt: (opts.now ?? new Date()).toISOString(),
      type: 'add',
      lookbackHours,
    });
    const captured = await this.trending.save(snapshot);
    await this.trending.prune(undefined, opts.now ?? new Date());
    return { captured, capturedAt: snapshot.capturedAt };
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
    const weeksRead = (await this.transactions.weeksRead(leagueId, opts.season)).map((w) => w.week);

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
      notes,
    };
  }

  /** One short line about a player's market attention, or nothing. */
  headlineFor(context: StrategyContext, playerId: string, opts: { availableInLeague?: boolean } = {}): string | null {
    const v = context.trending.get(playerId);
    return v ? trendingHeadline(v, opts) : null;
  }

  /**
   * Rebuild every manager profile for a league from its history.
   *
   * Walks the previous-league chain, which is the only way Sleeper exposes
   * earlier seasons. Each season contributes its trades and its completed
   * draft; both are bounded by `MAX_HISTORY_SEASONS` and by the transaction cap
   * per season, so a league with ten years of history costs the same as one
   * with three.
   */
  async refreshProfiles(opts: {
    leagueId: string;
    sleeperLeagueId: string;
    maxSeasons?: number;
  }): Promise<{ seasons: string[]; trades: number; picks: number; rosters: number; tendencies: number }> {
    const maxSeasons = opts.maxSeasons ?? MAX_HISTORY_SEASONS;
    /*
     * The whole dictionary, once. A trade profile has to look up the position
     * of every player who has ever changed hands in this league across three
     * seasons — hundreds of ids that no longer appear on any current roster —
     * and one full read beats hundreds of `IN (?, ?)` batches.
     */
    const players = new Map((await new PlayerRepo(this.db).listAll()).map((p) => [p.id, p.position]));
    const positionOf = (id: string) => players.get(id) ?? null;

    const seasons: string[] = [];
    const trades: TradeEvent[] = [];
    const picks: HistoricalPick[] = [];

    let sleeperLeagueId: string | null = opts.sleeperLeagueId;
    for (let i = 0; i < maxSeasons && sleeperLeagueId; i++) {
      const league = await this.sleeper.getLeague(sleeperLeagueId);
      if (!league) break;
      seasons.push(league.season);

      /*
       * Owner id to roster id, for that season's rosters specifically.
       *
       * Sleeper records a trade's creator as a *user* id, and a roster id is
       * only meaningful within one league. Rebuilding the map per season is
       * what keeps a manager who changed roster slots between seasons from
       * having his old trades attributed to whoever holds that slot now.
       */
      const leagueRosters = await this.sleeper.getRosters(sleeperLeagueId);
      const rosterByUser = new Map<string, number>();
      for (const roster of leagueRosters) {
        if (roster.owner_id) rosterByUser.set(roster.owner_id, roster.roster_id);
      }

      /*
       * Trades cluster in the middle of a season and are rare at either end,
       * but there is no endpoint that says which weeks had any — so every week
       * of a *finished* season is read once and never again. The current season
       * is handled by `syncTransactions`, which knows about settled weeks.
       */
      const seasonTransactions: SleeperTransaction[] = [];
      for (let week = 1; week <= 18; week++) {
        const rows = await this.sleeper.getTransactions(sleeperLeagueId, week);
        if (rows.length > 0) seasonTransactions.push(...rows);
      }
      trades.push(...collectTrades(seasonTransactions, league.season, rosterByUser));

      /*
       * That season's roster id back to the user who held it, so a pick with no
       * `picked_by` can still be identified. The direction matters: this is
       * rebuilt per season precisely because a roster id means nothing across
       * one — see the identity note below.
       */
      const userByRoster = new Map<number, string>();
      for (const roster of leagueRosters) {
        if (roster.owner_id) userByRoster.set(roster.roster_id, roster.owner_id);
      }

      for (const draft of await this.sleeper.getLeagueDrafts(sleeperLeagueId)) {
        /*
         * A draft that never finished describes nobody's habits.
         *
         * Sleeper reports `pre_draft` for a scheduled draft and `in_progress`
         * for one under way; both carry picks arrays that are empty or partial,
         * and a partial draft is worse than no draft here — it is every
         * manager's *first* few picks with none of the rest, which reads as a
         * whole room that only ever drafts running backs.
         */
        if (draft.status !== 'complete') continue;
        const draftPicks = await this.sleeper.getDraftPicks(draft.draft_id);
        for (const pick of draftPicks) {
          const meta = pick.metadata ?? {};
          const rosterId = typeof pick.roster_id === 'number' ? pick.roster_id : Number(pick.roster_id) || null;
          picks.push({
            season: league.season,
            draftId: draft.draft_id,
            pickNo: pick.pick_no,
            round: pick.round,
            /*
             * Identity is the user, and only the user.
             *
             * `picked_by` is present on every historical pick this was verified
             * against (320 of them, two completed drafts). `roster_id` is the
             * fallback *within this season only*, resolved through that
             * season's own roster table — never carried across one. Roster ids
             * are reused between seasons: in this league roster 4 belonged to
             * three different people in three years, so keying history on it
             * would build a confident profile for a manager out of two
             * strangers' picks.
             */
            userId: pick.picked_by ?? (rosterId != null ? (userByRoster.get(rosterId) ?? null) : null),
            rosterId,
            position: typeof meta['position'] === 'string' ? meta['position'] : (pick.player_id ? positionOf(pick.player_id) : null),
            /*
             * No historical market price exists, so none is invented.
             *
             * `GET /draft/<id>/picks` returns a player snapshot and no price of
             * any kind — no ADP, no rank, no `search_rank`; confirmed against
             * both completed drafts by `scripts/probe-sleeper-draft-history.mjs`.
             * This previously read `meta['search_rank']`, which is absent and so
             * always produced null in practice, but the line invited the one
             * substitution that must never be made: today's ranking is not what
             * the market thought in 2024, and measuring a two-year-old pick
             * against it would report two seasons of player movement as a
             * manager's habit. `reachAvailability` says `no-historical-market`
             * and the reach metric stays unavailable until a contemporaneous
             * snapshot exists to measure against.
             */
            marketRank: null,
            yearsExp: numberOrNull(meta['years_exp']),
          });
        }
      }

      sleeperLeagueId = league.previous_league_id ?? null;
    }

    const latestSeason = seasons[0] ?? String(new Date().getUTCFullYear());
    const rosters = await this.leagues.listRosters(opts.leagueId);

    /*
     * Tendencies are read once, over every manager at once.
     *
     * Per-manager rather than per-roster because the room baseline each manager
     * is measured against has to be the same one for all of them — computing it
     * inside a per-roster loop would measure each manager against a room that
     * included himself to a different degree.
     */
    const tendencies = readManagerTendencies({
      picks,
      positions: [...new Set(picks.map((p) => p.position).filter((p): p is string => !!p))].sort(),
      latestSeason,
      displayNames: new Map(rosters.map((r) => [r.ownerId ?? '', r.ownerName])),
    });

    for (const roster of rosters) {
      /*
       * A roster with no matched owner, or an owner with no history, is stored
       * as explicitly neutral rather than left absent — so "we looked and there
       * is nothing" and "we never looked" stay distinguishable at read time.
       */
      await this.profiles.saveTendencies(
        opts.leagueId,
        roster.rosterId,
        (roster.ownerId ? tendencies.get(roster.ownerId) : undefined) ??
          neutralTendencies(roster.ownerId ?? '', roster.ownerName),
      );
      await this.profiles.saveTradeProfile(
        opts.leagueId,
        buildTradeProfile({
          rosterId: roster.rosterId,
          ownerName: roster.ownerName,
          trades,
          positionOf,
          latestSeason,
        }),
      );
      await this.profiles.saveDraftProfile(
        opts.leagueId,
        buildManagerDraftProfile({
          rosterId: roster.rosterId,
          // The current league's owner, matched against `picked_by` in every
          // prior season. A roster whose owner is unknown gets no history
          // rather than the history of whoever last held the slot.
          userId: roster.ownerId,
          ownerName: roster.ownerName,
          picks,
        }),
      );
    }
    await this.profiles.saveRoomProfile(opts.leagueId, buildRoomProfile(picks));

    return {
      seasons,
      trades: trades.length,
      picks: picks.length,
      rosters: rosters.length,
      /** Managers with enough history for the Next% adjustment to read. */
      tendencies: [...tendencies.values()].filter((t) => t.usable).length,
    };
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

/**
 * The last week a waiver can still pay off.
 *
 * Sleeper publishes `playoff_week_start`, which is the first week the bid no
 * longer buys a regular-season game — so the last useful week is the one before
 * it. A league that does not publish it gets the standard fourteen rather than
 * an invented number, because being wrong by a week here shifts a budget curve
 * slightly and being silent shows no bid advice at all.
 */
export function readFinalWeek(settings: Record<string, unknown> | null | undefined): number {
  const raw = settings?.['playoff_week_start'];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 1 && value <= 19) return Math.round(value) - 1;
  return DEFAULT_FINAL_WEEK;
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
