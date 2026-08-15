/**
 * League-specific intelligence, assembled once per request.
 *
 * Everything the waiver, trade and feed surfaces need from the league's own
 * history is gathered here in one pass — the season chain, the seats, the
 * transactions, the manager profiles and the wallets — because each of those
 * screens would otherwise recompute the same profiles from the same rows.
 *
 * The service owns no presentation and makes no recommendation. It answers
 * three questions and hands the answers to whoever asked: who are these
 * managers, what will this player cost, and who else is bidding.
 */

import { assessCompetition, teamNeedsFor, type CompetitionAssessment, type RosterPlayerMeta, type TeamNeed, type TeamRoster } from '../../core/league/competition.ts';
import { expectedFaabCost, type DemandInput, type FaabEstimate } from '../../core/league/faab.ts';
import {
  buildManagerProfiles,
  leagueMeanBidShare,
  type ManagerProfile,
  type TransactionPlayerMeta,
} from '../../core/league/managers.ts';
import { usesFaab, type LeagueTransaction } from '../../core/league/transactions.ts';
import type { RosterShape } from '../../core/sleeper/scoring.ts';
import type { Database } from '../db.ts';
import { LeagueRepo } from '../repos/league.ts';
import { LeagueHistoryRepo } from '../repos/leagueHistory.ts';
import { PlayerRepo } from '../repos/players.ts';

export interface LeagueIntelContext {
  leagueId: string;
  sleeperLeagueId: string;
  season: string;
  /** Seasons of history actually available, newest first. */
  seasons: string[];
  budget: number | null;
  budgetBySeason: Map<string, number>;
  transactions: LeagueTransaction[];
  /** True when this league genuinely spends FAAB, judged from the record. */
  faabLeague: boolean;
  leagueMeanShare: number | null;
  profiles: ManagerProfile[];
  profilesByUser: Map<string, ManagerProfile>;
  rosters: TeamRoster[];
  playerMeta: Map<string, RosterPlayerMeta & TransactionPlayerMeta>;
  /** What is missing, in plain language, so a thin answer is never a mystery. */
  limits: string[];
}

export class LeagueIntelService {
  private readonly leagues: LeagueRepo;
  private readonly history: LeagueHistoryRepo;
  private readonly players: PlayerRepo;

  constructor(db: Database) {
    this.leagues = new LeagueRepo(db);
    this.history = new LeagueHistoryRepo(db);
    this.players = new PlayerRepo(db);
  }

  /**
   * Gather everything league-specific for one league.
   *
   * `unavailablePlayerIds` is supplied by the caller rather than looked up here
   * because availability is the injury layer's answer, not this one's, and two
   * screens disagreeing about who is hurt is worse than either being wrong.
   */
  async context(
    leagueId: string,
    opts: { unavailablePlayerIds?: Iterable<string> } = {},
  ): Promise<LeagueIntelContext | null> {
    const league = await this.leagues.getLeague(leagueId);
    if (!league) return null;

    const root = league.sleeperLeagueId;
    const [lineage, seats, rosterRecords, allPlayers] = await Promise.all([
      this.history.listLineage(root),
      this.history.listSeats(root),
      this.leagues.listRosters(league.id),
      this.players.listAll(),
    ]);

    const limits: string[] = [];
    const budgetBySeason = new Map<string, number>();
    for (const entry of lineage) {
      if (entry.waiverBudget != null && entry.waiverBudget > 0) budgetBySeason.set(entry.season, entry.waiverBudget);
    }
    /*
     * The current season's budget comes from the league record when the lineage
     * has not been synced yet, so a league whose history has never been read
     * still prices this season rather than reporting no budget at all.
     */
    const settingsBudget = readNumber(league.leagueSettings?.['waiver_budget']);
    if (settingsBudget != null && settingsBudget > 0 && !budgetBySeason.has(league.season)) {
      budgetBySeason.set(league.season, settingsBudget);
    }

    const sleeperLeagueIds = lineage.length > 0 ? lineage.map((l) => l.sleeperLeagueId) : [root];
    const transactions = await this.history.listTransactions(sleeperLeagueIds);

    if (lineage.length === 0) limits.push('league history has never been synced');
    else if (lineage.length === 1) limits.push('only this season is on record — Sleeper has no previous league linked');

    const unavailable = new Set(opts.unavailablePlayerIds ?? []);
    const playerMeta = new Map<string, RosterPlayerMeta & TransactionPlayerMeta>();
    for (const p of allPlayers) {
      playerMeta.set(p.id, {
        position: p.position || null,
        unavailable: unavailable.has(p.id),
        yearsExp: p.yearsExp ?? null,
      });
    }

    const rosters: TeamRoster[] = rosterRecords.map((r) => ({
      rosterId: r.rosterId,
      userId: r.ownerId,
      displayName: r.ownerName ?? `Roster ${r.rosterId}`,
      isMine: r.isMine,
      playerIds: r.playerIds,
    }));

    const profiles = buildManagerProfiles({
      seats,
      transactions,
      playerMeta,
      currentSeason: league.season,
      rosters: rosters.map((r) => ({ rosterId: r.rosterId, playerIds: r.playerIds })),
    });

    if (seats.length === 0) {
      limits.push('no manager seats on record, so bids cannot be attributed to anybody');
    }

    const faabLeague = usesFaab(transactions);
    if (!faabLeague && transactions.length > 0) {
      limits.push('no winning bid in this league has ever cost more than $0 — FAAB advice would be fiction here');
    }

    return {
      leagueId: league.id,
      sleeperLeagueId: root,
      season: league.season,
      seasons: [...new Set(lineage.map((l) => l.season))],
      budget: budgetBySeason.get(league.season) ?? null,
      budgetBySeason,
      transactions,
      faabLeague,
      leagueMeanShare: leagueMeanBidShare(transactions, budgetBySeason),
      profiles,
      profilesByUser: new Map(profiles.filter((p) => p.userId).map((p) => [p.userId, p])),
      rosters,
      playerMeta,
      limits,
    };
  }

  /**
   * Price one player and read the room, in that order.
   *
   * Order matters: competition needs the bottom of the price range to decide
   * who can afford to bid, and pricing needs the count of needy teams. The
   * circle is broken by pricing first against the *need count* — which is a
   * property of the rosters and needs no price — and then filtering the bidder
   * list by affordability.
   */
  priceAndCompete(
    ctx: LeagueIntelContext,
    input: {
      position: string;
      shape: RosterShape;
      demand: Omit<DemandInput, 'needyTeams' | 'totalTeams'>;
    },
  ): { cost: FaabEstimate; competition: CompetitionAssessment; needs: TeamNeed[] } {
    const needs = teamNeedsFor(input.position, ctx.rosters, ctx.playerMeta, input.shape);
    const needy = needs.filter((n) => n.level !== 'covered');

    const likelyBidders = needy
      .map((n) => (n.userId ? ctx.profilesByUser.get(n.userId) : undefined))
      .filter((p): p is ManagerProfile => p != null);

    const cost = expectedFaabCost({
      demand: { ...input.demand, needyTeams: needy.length, totalTeams: ctx.rosters.length },
      transactions: ctx.transactions,
      budgetBySeason: ctx.budgetBySeason,
      currentSeason: ctx.season,
      budget: ctx.budget,
      likelyBidders,
      leagueMeanShare: ctx.leagueMeanShare,
      rivalRemaining: ctx.profiles
        .filter((p) => !p.isMine && p.remainingFaab != null)
        .map((p) => p.remainingFaab as number),
    });

    const competition = assessCompetition({
      needs,
      profiles: ctx.profilesByUser,
      expectedLow: cost.low,
      faabLeague: ctx.faabLeague,
    });

    return { cost, competition, needs };
  }

  /** What each manager has left, for the Team and Waivers headers. */
  static wallets(ctx: LeagueIntelContext): { displayName: string; remaining: number | null; isMine: boolean }[] {
    return ctx.profiles
      .filter((p) => p.rosterId != null)
      .map((p) => ({ displayName: p.displayName, remaining: p.remainingFaab, isMine: p.isMine }))
      .sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
  }
}

function readNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}
