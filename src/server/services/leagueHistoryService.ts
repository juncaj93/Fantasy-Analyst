/**
 * Reading this league's own history out of Sleeper.
 *
 * One request per league-week, walked back through `previous_league_id` for as
 * many seasons as the chain offers. Nothing here is clever; the care is all in
 * bounding the work and in never writing a guess:
 *
 * - **Seasons are walked, not assumed.** A league in its first year produces a
 *   chain of one, and every downstream estimate then says "one season" rather
 *   than quietly behaving as though it had more.
 * - **The budget is stored per season.** A league that moved from $100 to $200
 *   makes every previous bid mean something different, and a bid is only
 *   comparable across seasons as a share of its own budget.
 * - **A week that returns nothing is recorded as read.** Otherwise a quiet week
 *   and an unread week look identical, and the app cannot tell "nobody moved"
 *   from "we never looked".
 *
 * This service issues GETs only. There is no code path in this application that
 * submits a waiver claim, a bid, a drop or a trade.
 */

import { normalizeTransactions } from '../../core/league/transactions.ts';
import type { ManagerSeat } from '../../core/league/managers.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { SleeperLeague } from '../../core/sleeper/types.ts';
import { nowIso, type Database } from '../db.ts';
import { LeagueHistoryRepo, type LineageEntry } from '../repos/leagueHistory.ts';
import { LeagueRepo } from '../repos/league.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';

/** How far back the chain is walked. Four seasons is more than any tendency needs. */
export const MAX_SEASONS = 4;

/** The last week a fantasy regular season plus playoffs can occupy. */
export const MAX_WEEK = 18;

export interface HistorySyncReport {
  rootSleeperLeagueId: string;
  seasons: { season: string; sleeperLeagueId: string; weeks: number; transactions: number }[];
  transactionsWritten: number;
  seatsWritten: number;
  requests: number;
  notes: string[];
}

export class LeagueHistoryService {
  private readonly history: LeagueHistoryRepo;
  private readonly leagues: LeagueRepo;
  private readonly settings: SettingsRepo;

  constructor(
    db: Database,
    private readonly client: SleeperClient,
  ) {
    this.history = new LeagueHistoryRepo(db);
    this.leagues = new LeagueRepo(db);
    this.settings = new SettingsRepo(db);
  }

  /**
   * Sync the selected league's transaction history.
   *
   * `throughWeek` bounds the request count: in week 3 there is no point asking
   * Sleeper about week 14, and asking anyway would triple the traffic for
   * fifteen guaranteed-empty answers. Prior seasons are always read in full,
   * because they are finished and will never change again.
   */
  async sync(leagueId: string, opts: { throughWeek?: number; maxSeasons?: number } = {}): Promise<HistorySyncReport> {
    const startedAt = nowIso();
    const league = await this.leagues.getLeague(leagueId);
    if (!league) throw new Error('league not found');

    const root = league.sleeperLeagueId;
    const notes: string[] = [];
    let requests = 0;

    const chain = await this.walkChain(root, opts.maxSeasons ?? MAX_SEASONS);
    requests += chain.length;
    if (chain.length === 1) notes.push('this league has no previous season on Sleeper, so history is this season only');

    const lineage: LineageEntry[] = chain.map((entry, depth) => ({
      rootSleeperLeagueId: root,
      sleeperLeagueId: entry.league_id,
      season: entry.season,
      name: entry.name ?? null,
      depth,
      waiverBudget: readBudget(entry),
      totalRosters: entry.total_rosters ?? null,
    }));
    await this.history.replaceLineage(root, lineage);

    const me = await this.settings.get<{ userId: string } | null>(SETTING_KEYS.sleeperUser, null);

    const currentWeek = clampWeek(opts.throughWeek ?? MAX_WEEK);
    const seasons: HistorySyncReport['seasons'] = [];
    let transactionsWritten = 0;
    let seatsWritten = 0;

    for (const [depth, entry] of chain.entries()) {
      const sleeperLeagueId = entry.league_id;
      const through = depth === 0 ? currentWeek : MAX_WEEK;

      const seats = await this.seatsFor(entry, root, me?.userId ?? null);
      requests += 2;
      if (seats.length > 0) {
        await this.history.upsertSeats(seats);
        seatsWritten += seats.length;
      } else {
        notes.push(`${entry.season}: no rosters returned, so its transactions cannot be attributed to managers`);
      }

      let seasonTransactions = 0;
      let weeksRead = 0;
      for (let week = 1; week <= through; week++) {
        const raw = await this.client.getTransactions(sleeperLeagueId, week);
        requests++;
        weeksRead++;
        const normalized = normalizeTransactions(raw, {
          sleeperLeagueId,
          season: entry.season,
          week,
        });
        if (normalized.length > 0) {
          const { written } = await this.history.upsertTransactions(normalized);
          transactionsWritten += written;
          seasonTransactions += written;
        }
        await this.history.recordWeekSync({
          sleeperLeagueId,
          week,
          transactions: normalized.length,
          syncedAt: nowIso(),
        });
      }

      seasons.push({ season: entry.season, sleeperLeagueId, weeks: weeksRead, transactions: seasonTransactions });
    }

    await this.settings.logSync(
      'league_history',
      'ok',
      `${transactionsWritten} transactions across ${chain.length} season(s)`,
      startedAt,
    );

    return { rootSleeperLeagueId: root, seasons, transactionsWritten, seatsWritten, requests, notes };
  }

  /**
   * Follow `previous_league_id` back through the seasons.
   *
   * Bounded twice — by `maxSeasons` and by a visited set — because a
   * misconfigured league that points at itself would otherwise be an infinite
   * loop against somebody else's API.
   */
  private async walkChain(rootSleeperLeagueId: string, maxSeasons: number): Promise<SleeperLeague[]> {
    const chain: SleeperLeague[] = [];
    const seen = new Set<string>();
    let id: string | null = rootSleeperLeagueId;

    while (id && chain.length < maxSeasons && !seen.has(id)) {
      seen.add(id);
      const league: SleeperLeague | null = await this.client.getLeague(id);
      if (!league) break;
      chain.push(league);
      const previous = league.previous_league_id;
      id = previous && previous !== '0' ? String(previous) : null;
    }

    return chain;
  }

  /**
   * Who sat in which seat that season, and what they had spent.
   *
   * `waiver_budget_used` is on the roster, not on the user, and Sleeper reports
   * spent rather than remaining — the subtraction happens against the season's
   * own budget in the profile layer, and stays unknown when either half is
   * missing rather than defaulting to a full wallet.
   */
  private async seatsFor(
    league: SleeperLeague,
    rootSleeperLeagueId: string,
    myUserId: string | null,
  ): Promise<(ManagerSeat & { rootSleeperLeagueId: string })[]> {
    const [rosters, users] = await Promise.all([
      this.client.getRosters(league.league_id).catch(() => []),
      this.client.getLeagueUsers(league.league_id).catch(() => []),
    ]);
    const nameByUser = new Map(users.map((u) => [u.user_id, u.display_name ?? u.username ?? null]));

    return rosters.map((roster) => ({
      rootSleeperLeagueId,
      sleeperLeagueId: league.league_id,
      season: league.season,
      rosterId: roster.roster_id,
      userId: roster.owner_id ?? null,
      displayName: roster.owner_id ? (nameByUser.get(roster.owner_id) ?? null) : null,
      waiverBudgetUsed: readNumber(roster.settings?.['waiver_budget_used']),
      budget: readBudget(league),
      wins: readNumber(roster.settings?.['wins']),
      losses: readNumber(roster.settings?.['losses']),
      isMine: myUserId != null && roster.owner_id === myUserId,
    }));
  }
}

/**
 * The league's FAAB budget, if it has one.
 *
 * `waiver_budget` is present on most leagues regardless of waiver type, so a
 * value here means "this league is configured with a budget", not "this league
 * spends it". Whether it actually does is decided from the transactions —
 * `usesFaab` in `core/league/transactions.ts`.
 */
export function readBudget(league: SleeperLeague): number | null {
  return readNumber(league.settings?.['waiver_budget']);
}

function readNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}

function clampWeek(week: number): number {
  if (!Number.isFinite(week)) return MAX_WEEK;
  return Math.min(MAX_WEEK, Math.max(1, Math.trunc(week)));
}
