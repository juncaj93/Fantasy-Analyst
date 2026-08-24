/**
 * The manager-history subsystem: one bounded batch at a time, for ever.
 *
 * Two jobs, and keeping them apart is the whole architecture.
 *
 * **{@link ManagerIntelService.advance} fetches.** It reads the checkpoints,
 * asks `core/managers/backfillPlan.ts` what to do next, and does as much of it
 * as the request budget allows — never more than twenty-four Sleeper requests
 * against Cloudflare's free-plan ceiling of fifty, and never a request for a
 * fact that is already stored and can no longer change. A league with four
 * seasons of history takes several days to ingest and then costs almost nothing
 * for ever.
 *
 * **{@link ManagerIntelService.derive} computes.** It reads the ledger and
 * writes profiles, and it makes **no network calls at all**. That is what lets
 * a tendency model be rewritten, re-tuned or version-bumped without re-reading
 * a single season, and it is why the raw ledger and the derived profiles are
 * separate tables rather than one.
 *
 * The old path this replaces — `LeagueStrategyService.refreshProfiles` — did
 * both at once, walked the whole previous-league chain on every call, and cost
 * about sixty-six requests to produce a handful of sentences. It failed in
 * production against the free ceiling, and it would have re-read three seasons
 * of immutable history every week even if it had not.
 */

import { SleeperClient } from '../../core/sleeper/client.ts';
import {
  BudgetExhaustedError,
  MAX_SLEEPER_SUBREQUESTS_PER_BATCH,
  RequestBudget,
  budgetedFetch,
} from '../../core/sleeper/budget.ts';
import {
  MAX_TRANSACTION_WEEK,
  planBackfill,
  enumerateWork,
  type BackfillState,
  type SeasonState,
  type WorkUnit,
} from '../../core/managers/backfillPlan.ts';
import {
  LEDGER_VERSION,
  draftSourceHash,
  toLedgerDraft,
  toLedgerPicks,
  toLedgerTransaction,
  toRosterIdentities,
  type LedgerTransaction,
  type RosterIdentity,
} from '../../core/managers/ledger.ts';
import {
  buildLeagueTransactionBaseline,
  buildTransactionProfiles,
  TRANSACTION_PROFILE_VERSION,
  type ManagerTransactionProfile,
} from '../../core/managers/transactionProfile.ts';
import {
  TRADE_TENDENCY_VERSION,
  buildLeagueTradeBaseline,
  buildTradeTendencies,
  type ManagerTradeTendencies,
} from '../../core/managers/tradeTendencies.ts';
import {
  neutralTendencies,
  readManagerTendencies,
  toStoredTendencies,
  type ManagerTendencies,
} from '../../core/managers/managerTendencies.ts';
import { buildManagerDraftProfile, buildRoomProfile, type HistoricalPick } from '../../core/managers/draftProfile.ts';
import { buildTradeProfile, type TradeEvent } from '../../core/managers/tradeProfile.ts';
import { buildBudgetState } from '../../core/faab/budget.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { TransactionRepo } from '../repos/transactions.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
import { ManagerProfileRepo } from '../repos/managerProfiles.ts';
import { readFinalWeek } from './leagueStrategyService.ts';
import type { Database } from '../db.ts';

/** The derivation contract. Bumping it re-derives without re-fetching. */
export const INTEL_PROFILE_VERSION = 1;

/**
 * Re-plan rounds inside one batch.
 *
 * A plan is computed from stored state, so work that only becomes knowable
 * *after* a unit runs — the drafts a season has, the league a chain link points
 * at — needs another round to be scheduled. Four is enough to walk a discovery,
 * index its drafts, ingest them and start on transactions in a single batch
 * when there is budget for it, and it bounds the loop whatever the data does.
 */
const MAX_PLAN_ROUNDS = 4;

export interface AdvanceReport {
  leagueId: string;
  /** Seasons the chain is known to contain, newest first. */
  seasons: string[];
  /** Units actually completed this batch, by kind. */
  completed: { kind: WorkUnit['kind']; season: string | null; detail: string }[];
  /** Sleeper requests spent. Never above the budget's limit, by construction. */
  requestsUsed: number;
  requestBudget: number;
  /** True when the budget, rather than the work, ended the batch. */
  budgetBound: boolean;
  /** Units still outstanding across the whole backfill. */
  outstanding: number;
  /** True when nothing at all is left to fetch. */
  complete: boolean;
  /** What the derivation produced, when one ran. */
  derived: DeriveReport | null;
  errors: string[];
}

export interface DeriveReport {
  /** Historical picks in the ledger. */
  picks: number;
  /** Finalised transactions in the ledger. */
  transactions: number;
  trades: number;
  /** Managers with a usable draft tendency — the ones `Next%` will read. */
  draftProfiles: number;
  tradeProfiles: number;
  transactionProfiles: number;
  seasons: string[];
  rosters: number;
}

export interface ManagerIntelCoverage {
  leagueId: string;
  currentSeason: string;
  /** Every season the chain has revealed. */
  seasonsDiscovered: string[];
  /** Seasons whose drafts and transactions are both finished. */
  seasonsComplete: string[];
  /** The link the walk is waiting on, or null when the chain is fully read. */
  chainUnresolved: string | null;
  drafts: { total: number; complete: number; picksStored: number };
  transactions: { weeksRead: number; weeksSettled: number; weeksMissing: number; stored: number };
  checkpoints: {
    dataset: string;
    season: string;
    cursor: number | null;
    completed: boolean;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    requestsUsed: number;
    version: number;
  }[];
  profiles: {
    kind: string;
    count: number;
    usable: number;
    medianSample: number;
    derivedAt: string | null;
    version: number | null;
  }[];
  /** Units still to fetch, and whether anything is left at all. */
  outstandingUnits: number;
  complete: boolean;
  /** The batch budget in force, so a reader can see the ceiling is respected. */
  requestBudget: number;
}

export class ManagerIntelService {
  private readonly ledger: ManagerLedgerRepo;
  private readonly transactions: TransactionRepo;
  private readonly leagues: LeagueRepo;
  private readonly players: PlayerRepo;
  private readonly profiles: ManagerProfileRepo;

  constructor(
    db: Database,
    private readonly deps: { sleeper?: SleeperClient } = {},
  ) {
    this.ledger = new ManagerLedgerRepo(db);
    this.transactions = new TransactionRepo(db);
    this.leagues = new LeagueRepo(db);
    this.players = new PlayerRepo(db);
    this.profiles = new ManagerProfileRepo(db);
  }

  private get sleeper(): SleeperClient {
    return this.deps.sleeper ?? new SleeperClient();
  }

  // ------------------------------------------------------------- ingestion --

  /**
   * Advance the backfill by one bounded batch, then rebuild what changed.
   *
   * Safe to call on any schedule and safe to call twice in a row: the second
   * call finds the same checkpoints, plans the next units, and — once history
   * is complete — plans nothing at all and makes zero historical requests.
   */
  async advance(opts: {
    leagueId: string;
    sleeperLeagueId: string;
    season: string;
    /** The current NFL week, for bounding the live season's transaction walk. */
    week: number;
    budget?: RequestBudget;
    /** Skip the derivation, for tests that want to inspect the raw ledger. */
    skipDerive?: boolean;
  }): Promise<AdvanceReport> {
    const budget = opts.budget ?? new RequestBudget(MAX_SLEEPER_SUBREQUESTS_PER_BATCH);
    const client = this.sleeper.withFetch((inner) => budgetedFetch(budget, inner));

    await this.seed(opts);

    const completed: AdvanceReport['completed'] = [];
    const errors: string[] = [];
    let budgetBound = false;
    /*
     * Units already attempted in this batch, so a re-plan cannot repeat one.
     *
     * The re-plan loop exists to pick up work that only becomes *knowable* once
     * an earlier unit has run — the drafts a season turns out to have, the
     * league a chain link turns out to point at. It is not there to retry, and
     * without this it silently did: a live draft's index and the current week's
     * transactions are both permanently "wanted" by design, so every round
     * planned them again and a steady-state batch cost four times what it
     * should.
     */
    const attempted = new Set<string>();

    for (let round = 0; round < MAX_PLAN_ROUNDS; round++) {
      const state = await this.readState(opts);
      const plan = planBackfill(state, budget.remaining);
      if (plan.budgetBound) budgetBound = true;
      const units = plan.units.filter((unit) => !attempted.has(unitKey(unit)));
      if (units.length === 0) break;

      let progressed = false;
      for (const unit of units) {
        attempted.add(unitKey(unit));
        if (!budget.canAfford(1)) {
          budgetBound = true;
          break;
        }
        try {
          const detail = await this.execute(unit, { ...opts, client, state });
          completed.push({ kind: unit.kind, season: unit.season, detail });
          progressed = true;
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            budgetBound = true;
            break;
          }
          /*
           * One failed unit, recorded against its own checkpoint and nothing
           * else. The units around it keep whatever they had — which is the
           * property that makes "one failed week does not corrupt completed
           * weeks" true by construction rather than by care.
           */
          errors.push(`${unit.kind}${unit.season ? ` ${unit.season}` : ''}: ${String(err)}`);
          await this.ledger
            .recordFailure({
              leagueId: opts.leagueId,
              dataset: unit.kind === 'transactions' ? 'transactions' : 'drafts',
              sleeperLeagueId: unit.sleeperLeagueId,
              season: unit.season ?? opts.season,
              error: String(err),
              requestsUsed: 1,
            })
            .catch(() => undefined);
        }
      }
      if (!progressed || budget.exhausted) break;
    }

    const finalState = await this.readState(opts);
    const outstanding = enumerateWork(finalState).length;

    const derived =
      opts.skipDerive || completed.length === 0 ? null : await this.derive(opts.leagueId).catch((err) => {
        errors.push(`derive: ${String(err)}`);
        return null;
      });

    return {
      leagueId: opts.leagueId,
      seasons: finalState.seasons.map((s) => s.season),
      completed,
      requestsUsed: budget.used,
      requestBudget: budget.limit,
      budgetBound,
      outstanding,
      complete: outstanding === 0,
      derived,
      errors,
    };
  }

  /**
   * Make sure the chain has a starting point.
   *
   * The current league's id and season are already known from the app's own
   * league row, so seeding costs no request. `resolved` stays false, which is
   * what puts the first `discover` on the plan and starts the walk.
   */
  private async seed(opts: { leagueId: string; sleeperLeagueId: string; season: string }): Promise<void> {
    const links = await this.ledger.seasonLinks(opts.leagueId);
    if (links.some((l) => l.sleeperLeagueId === opts.sleeperLeagueId)) return;
    await this.ledger.saveSeasonLink({
      leagueId: opts.leagueId,
      sleeperLeagueId: opts.sleeperLeagueId,
      season: opts.season,
      previousLeagueId: null,
      status: null,
      resolved: false,
    });
  }

  /** Assemble the planner's view of the world from what is stored. */
  private async readState(opts: {
    leagueId: string;
    season: string;
    week: number;
  }): Promise<BackfillState> {
    const [links, drafts, checkpoints, identities, weeks] = await Promise.all([
      this.ledger.seasonLinks(opts.leagueId),
      this.ledger.drafts(opts.leagueId),
      this.ledger.checkpoints(opts.leagueId),
      this.ledger.rosterIdentities(opts.leagueId),
      this.transactions.allWeeksRead(opts.leagueId),
    ]);

    const identifiedLeagues = new Set(identities.map((i) => i.sleeperLeagueId));
    const checkpointOf = (dataset: string, sleeperLeagueId: string) =>
      checkpoints.find((c) => c.dataset === dataset && c.sleeperLeagueId === sleeperLeagueId) ?? null;

    const seasons: SeasonState[] = links.map((link) => {
      const seasonDrafts = drafts.filter((d) => d.sleeperLeagueId === link.sleeperLeagueId);
      const pendingDraftIds = seasonDrafts.filter((d) => d.complete && d.picksIngested === 0).map((d) => d.draftId);
      const settledWeeks = weeks.filter((w) => w.season === link.season && w.settled).map((w) => w.week);

      /*
       * A season that is over can never produce another transaction, so every
       * week of it is worth reading once. A live one is walked only as far as
       * the week the NFL is actually in — asking for week 15 in October returns
       * an empty list that would then be *settled*, and a settled empty week is
       * a permanent hole in the history.
       */
      const finished = isFinishedSeason(link.season, opts.season, link.status);
      const throughWeek = finished ? MAX_TRANSACTION_WEEK : Math.max(1, Math.min(opts.week, MAX_TRANSACTION_WEEK));

      return {
        sleeperLeagueId: link.sleeperLeagueId,
        season: link.season,
        status: link.status,
        previousLeagueId: link.previousLeagueId,
        resolved: link.resolved,
        identityKnown: identifiedLeagues.has(link.sleeperLeagueId),
        drafts: {
          indexFresh: pendingDraftIds.length > 0,
          pendingDraftIds,
          completed: checkpointOf('drafts', link.sleeperLeagueId)?.completed ?? false,
        },
        transactions: {
          settledWeeks,
          throughWeek,
          completed: checkpointOf('transactions', link.sleeperLeagueId)?.completed ?? false,
        },
      };
    });

    return { currentSeason: opts.season, seasons };
  }

  /**
   * Do one unit of work and checkpoint it.
   *
   * Every branch writes its facts *before* it advances its checkpoint, so a
   * crash in between costs a repeat of one idempotent write and never a lost
   * or duplicated one.
   */
  private async execute(
    unit: WorkUnit,
    ctx: { leagueId: string; season: string; week: number; client: SleeperClient; state: BackfillState },
  ): Promise<string> {
    switch (unit.kind) {
      case 'discover':
        return this.discover(unit, ctx);
      case 'identity':
        return this.ingestIdentity(unit, ctx);
      case 'draft-index':
        return this.indexDrafts(unit, ctx);
      case 'draft-picks':
        return this.ingestDraftPicks(unit, ctx);
      case 'transactions':
        return this.ingestWeek(unit, ctx);
    }
  }

  private async discover(
    unit: Extract<WorkUnit, { kind: 'discover' }>,
    ctx: { leagueId: string; client: SleeperClient },
  ): Promise<string> {
    const league = await ctx.client.getLeague(unit.sleeperLeagueId);

    if (!league) {
      /*
       * A league that cannot be read is the end of the road, and it is recorded
       * as one rather than retried for ever. Sleeper answers 404 for a deleted
       * league and for one made private, and neither will start answering
       * later. `resolved` with a null previous link stops the walk; the status
       * says why, so a diagnostic reports a short history rather than a stuck
       * one.
       */
      await this.ledger.saveSeasonLink({
        leagueId: ctx.leagueId,
        sleeperLeagueId: unit.sleeperLeagueId,
        season: unit.season ?? '',
        previousLeagueId: null,
        status: 'unavailable',
        resolved: true,
      });
      return `${unit.sleeperLeagueId}: unavailable, chain ends here`;
    }

    await this.ledger.saveSeasonLink({
      leagueId: ctx.leagueId,
      sleeperLeagueId: league.league_id,
      season: league.season,
      previousLeagueId: league.previous_league_id ?? null,
      status: league.status ?? null,
      resolved: true,
    });
    return `${league.season}: ${league.previous_league_id ? 'links to an earlier season' : 'oldest season in the chain'}`;
  }

  private async ingestIdentity(
    unit: Extract<WorkUnit, { kind: 'identity' }>,
    ctx: { leagueId: string; client: SleeperClient },
  ): Promise<string> {
    const rosters = await ctx.client.getRosters(unit.sleeperLeagueId);
    /*
     * Rosters only, never the users endpoint.
     *
     * The map from roster id to *user id* is the load-bearing fact and rosters
     * carry it. Display names would cost a second request per season to produce
     * metadata the brief explicitly calls metadata — and the current league's
     * own roster table already has the names of everybody still in the league,
     * which is everybody a screen ever mentions.
     */
    const identities = toRosterIdentities({
      sleeperLeagueId: unit.sleeperLeagueId,
      season: unit.season,
      rosters,
    });
    await this.ledger.saveRosterIdentities(ctx.leagueId, identities);
    const named = identities.filter((i) => i.userId).length;
    return `${unit.season}: ${named}/${identities.length} rosters mapped to a Sleeper user`;
  }

  private async indexDrafts(
    unit: Extract<WorkUnit, { kind: 'draft-index' }>,
    ctx: { leagueId: string; season: string; client: SleeperClient },
  ): Promise<string> {
    const drafts = await ctx.client.getLeagueDrafts(unit.sleeperLeagueId);
    for (const draft of drafts) {
      await this.ledger.saveDraftIndex(
        toLedgerDraft({ leagueId: ctx.leagueId, sleeperLeagueId: unit.sleeperLeagueId, draft }),
      );
    }

    const stored = await this.ledger.drafts(ctx.leagueId);
    const forSeason = stored.filter((d) => d.sleeperLeagueId === unit.sleeperLeagueId);
    /*
     * Drafts are finished for a season when every draft in it is complete and
     * its picks are stored. A season with a `pre_draft` draft is never marked
     * complete, which is what brings this index back on the next batch — one
     * request a day, until the draft ends and its picks land.
     */
    const done = forSeason.length > 0 && forSeason.every((d) => d.complete && d.picksIngested > 0);

    await this.ledger.recordSuccess({
      leagueId: ctx.leagueId,
      dataset: 'drafts',
      sleeperLeagueId: unit.sleeperLeagueId,
      season: unit.season,
      cursor: forSeason.length,
      completed: done,
      requestsUsed: 1,
    });

    const pending = forSeason.filter((d) => d.complete && d.picksIngested === 0).length;
    return `${unit.season}: ${drafts.length} draft(s) indexed, ${pending} awaiting picks`;
  }

  private async ingestDraftPicks(
    unit: Extract<WorkUnit, { kind: 'draft-picks' }>,
    ctx: { leagueId: string; client: SleeperClient },
  ): Promise<string> {
    const stored = (await this.ledger.drafts(ctx.leagueId)).find((d) => d.draftId === unit.draftId);
    if (!stored) throw new Error(`draft ${unit.draftId} is not indexed`);

    const rawPicks = await ctx.client.getDraftPicks(unit.draftId);
    const identities = await this.ledger.rosterIdentities(ctx.leagueId);
    const userByRoster = identityMapForLeague(identities, unit.sleeperLeagueId);
    const positions = await this.positionIndex();

    const picks = toLedgerPicks({
      draft: {
        draftId: stored.draftId,
        leagueId: stored.leagueId,
        sleeperLeagueId: stored.sleeperLeagueId,
        season: stored.season,
        status: stored.status,
        draftType: null,
        rounds: stored.rounds,
        teams: stored.teams,
        complete: stored.complete,
        startedAtMs: null,
      },
      picks: rawPicks,
      userByRoster,
      positionOf: (id) => positions.get(id) ?? null,
    });

    await this.ledger.savePicks(picks);
    await this.ledger.recordDraftPicks(unit.draftId, picks.length, draftSourceHash(picks));

    // The season is finished only when nothing in it is still awaiting picks.
    const after = (await this.ledger.drafts(ctx.leagueId)).filter(
      (d) => d.sleeperLeagueId === unit.sleeperLeagueId,
    );
    const done = after.length > 0 && after.every((d) => d.complete && d.picksIngested > 0);

    await this.ledger.recordSuccess({
      leagueId: ctx.leagueId,
      dataset: 'drafts',
      sleeperLeagueId: unit.sleeperLeagueId,
      season: unit.season,
      cursor: after.length,
      completed: done,
      requestsUsed: 1,
    });

    const attributed = picks.filter((p) => p.userId).length;
    return `${unit.season}: ${picks.length} pick(s) stored, ${attributed} attributed to a manager`;
  }

  private async ingestWeek(
    unit: Extract<WorkUnit, { kind: 'transactions' }>,
    ctx: { leagueId: string; season: string; week: number; client: SleeperClient; state: BackfillState },
  ): Promise<string> {
    const seasonState = ctx.state.seasons.find((s) => s.sleeperLeagueId === unit.sleeperLeagueId);
    const throughWeek = seasonState?.transactions.throughWeek ?? MAX_TRANSACTION_WEEK;
    const finished = isFinishedSeason(unit.season, ctx.season, seasonState?.status ?? null);

    const rows = await ctx.client.getTransactions(unit.sleeperLeagueId, unit.week);
    /*
     * Settled means "this can never change again".
     *
     * Every week of a finished season qualifies. In a live season only the
     * weeks strictly before the current one do — the week in play is re-read
     * every batch, because a waiver run lands between two of them, and it is
     * the one case where "we already have it" is wrong.
     */
    const settled = finished || unit.week < throughWeek;
    const stored = await this.transactions.saveWeek({
      leagueId: ctx.leagueId,
      season: unit.season,
      week: unit.week,
      transactions: rows,
      settled,
      sleeperLeagueId: unit.sleeperLeagueId,
    });

    const settledWeeks = new Set(
      (await this.transactions.weeksRead(ctx.leagueId, unit.season)).filter((w) => w.settled).map((w) => w.week),
    );
    const done = finished && countFrom1To(throughWeek).every((w) => settledWeeks.has(w));
    const remaining = countFrom1To(throughWeek).filter((w) => !settledWeeks.has(w));

    await this.ledger.recordSuccess({
      leagueId: ctx.leagueId,
      dataset: 'transactions',
      sleeperLeagueId: unit.sleeperLeagueId,
      season: unit.season,
      // The next week to read, counting down. Null when there is none left.
      cursor: remaining.length > 0 ? Math.max(...remaining) : null,
      completed: done,
      requestsUsed: 1,
    });

    return `${unit.season} week ${unit.week}: ${stored} transaction(s)${settled ? ', settled' : ', still in play'}`;
  }

  // ------------------------------------------------------------ derivation --

  /**
   * Rebuild every profile from the ledger. **No Sleeper requests.**
   *
   * The property this method exists to have. Everything downstream — draft
   * tendencies, trade tendencies, waiver pressure, the league baselines — is a
   * function of stored rows, so re-deriving is a few queries and some
   * arithmetic. A constant can change, a version can bump, a bug can be fixed,
   * and none of it costs a request.
   */
  async derive(leagueId: string): Promise<DeriveReport> {
    const league = await this.leagues.getLeague(leagueId);
    if (!league) throw new Error(`league ${leagueId} not found`);

    const [picks, identities, rosters, storedTransactions, weeks, positions] = await Promise.all([
      this.ledger.picks(leagueId),
      this.ledger.rosterIdentities(leagueId),
      this.leagues.listRosters(leagueId),
      this.transactions.listBySeason(leagueId),
      this.transactions.allWeeksRead(leagueId),
      this.positionIndex(),
    ]);

    const positionOf = (id: string): string | null => positions.get(id) ?? null;
    const seasons = [...new Set([...picks.map((p) => p.season), ...storedTransactions.map((t) => t.season)])].sort();
    const latestSeason = seasons.at(-1) ?? league.season;

    /*
     * Names come from the current league's own roster table, never from the
     * historical identity rows — those are deliberately fetched without the
     * users endpoint. A manager who has left keeps his user id and loses his
     * name, which costs nothing: no screen mentions a manager who is not in the
     * league.
     */
    const displayNames = new Map<string, string | null>();
    for (const roster of rosters) if (roster.ownerId) displayNames.set(roster.ownerId, roster.ownerName);
    for (const identity of identities) {
      if (identity.userId && !displayNames.has(identity.userId)) {
        displayNames.set(identity.userId, identity.displayName);
      }
    }

    /*
     * Transactions, resolved to people through each season's own roster map.
     *
     * The per-season lookup is the identity rule in code: a row from 2024 is
     * resolved against 2024's rosters and never against today's.
     */
    const identityBySeason = new Map<string, Map<number, string>>();
    for (const season of new Set(identities.map((i) => i.season))) {
      identityBySeason.set(season, ManagerLedgerRepo.identityMapFor(identities, season));
    }
    const ledgerTransactions: LedgerTransaction[] = storedTransactions.map((row) =>
      toLedgerTransaction({
        txn: row.transaction,
        season: row.season,
        userByRoster: identityBySeason.get(row.season) ?? new Map(),
      }),
    );

    const weeksBySeason = new Map<string, number>();
    for (const week of weeks) weeksBySeason.set(week.season, (weeksBySeason.get(week.season) ?? 0) + 1);

    const seasonsByUser = new Map<string, string[]>();
    for (const identity of identities) {
      if (!identity.userId) continue;
      const list = seasonsByUser.get(identity.userId) ?? [];
      if (!list.includes(identity.season)) list.push(identity.season);
      seasonsByUser.set(identity.userId, list);
    }

    const budgetState = buildBudgetState({
      leagueSettings: league.leagueSettings,
      rosters: rosters.map((r) => ({
        rosterId: r.rosterId,
        ownerName: r.ownerName,
        isMine: r.isMine,
        settings: r.settings ?? null,
      })),
      transactions: storedTransactions.map((t) => t.transaction),
    });
    const finalWeek = readFinalWeek(league.leagueSettings);

    // ------------------------------------------------------ draft tendencies
    const historical: HistoricalPick[] = picks.map((p) => ({
      season: p.season,
      draftId: p.draftId,
      pickNo: p.pickNo,
      round: p.round,
      userId: p.userId,
      rosterId: p.rosterId,
      position: p.position,
      /*
       * No historical market price exists and none is invented. Sleeper
       * publishes no ADP, rank or `search_rank` with a pick, so reach-vs-market
       * stays unavailable rather than being measured against today's ranking.
       */
      marketRank: null,
      yearsExp: p.yearsExp,
    }));

    const tendencies = readManagerTendencies({
      picks: historical,
      positions: [...new Set(historical.map((p) => p.position).filter((p): p is string => !!p))].sort(),
      latestSeason,
      displayNames,
    });

    // ------------------------------------- transaction and trade tendencies
    const transactionInput = {
      transactions: ledgerTransactions,
      weeksBySeason,
      seasonsByUser,
      budgetTotal: budgetState.rule.total,
      positionOf,
      displayNames,
      finalWeek,
    };
    const transactionBaseline = buildLeagueTransactionBaseline(transactionInput);
    const transactionProfiles = buildTransactionProfiles(transactionInput, transactionBaseline);

    const tradeInput = {
      transactions: ledgerTransactions,
      seasonsByUser,
      positionOf,
      displayNames,
      latestSeason,
    };
    const tradeBaseline = buildLeagueTradeBaseline(tradeInput);
    const tradeTendencies = buildTradeTendencies(tradeInput);

    const coverage = coverageSummary({ seasons, weeksBySeason, picks: picks.length });

    // ------------------------------------------------------------- persist --
    await this.writeProfiles({
      leagueId,
      tendencies,
      transactionProfiles,
      tradeTendencies,
      displayNames,
      coverage,
    });

    await this.ledger.saveBaseline(leagueId, 'transaction', {
      sample: transactionBaseline.sample,
      seasons: transactionBaseline.seasons,
      value: transactionBaseline,
      version: TRANSACTION_PROFILE_VERSION,
    });
    await this.ledger.saveBaseline(leagueId, 'trade', {
      sample: tradeBaseline.trades,
      seasons: tradeBaseline.seasons,
      value: tradeBaseline,
      version: TRADE_TENDENCY_VERSION,
    });

    /*
     * And the roster-keyed profiles the existing managers screen reads.
     *
     * Filed against the *current* roster of the *matching user*, which is the
     * repair this rebuild makes: the previous implementation filtered historical
     * trades by current roster id, so a manager who inherited roster 4 inherited
     * roster 4's trades from two seasons of strangers.
     */
    await this.writeRosterProfiles({ leagueId, rosters, tendencies, ledgerTransactions, historical, positionOf, latestSeason });

    return {
      picks: picks.length,
      transactions: ledgerTransactions.filter((t) => t.status === 'complete').length,
      trades: ledgerTransactions.filter((t) => t.type === 'trade' && t.status === 'complete').length,
      draftProfiles: [...tendencies.values()].filter((t) => t.usable).length,
      tradeProfiles: [...tradeTendencies.values()].filter((t) => t.usable).length,
      transactionProfiles: [...transactionProfiles.values()].filter((t) => t.usable).length,
      seasons,
      rosters: rosters.length,
    };
  }

  private async writeProfiles(args: {
    leagueId: string;
    tendencies: Map<string, ManagerTendencies>;
    transactionProfiles: Map<string, ManagerTransactionProfile>;
    tradeTendencies: Map<string, ManagerTradeTendencies>;
    displayNames: Map<string, string | null>;
    coverage: Record<string, unknown>;
  }): Promise<void> {
    const { leagueId, coverage } = args;

    for (const [userId, tendency] of args.tendencies) {
      await this.ledger.saveProfile(leagueId, 'draft', {
        userId,
        displayName: tendency.displayName ?? args.displayNames.get(userId) ?? null,
        sample: tendency.picksObserved,
        usable: tendency.usable,
        seasons: tendency.seasons,
        coverage,
        profile: toStoredTendencies(tendency),
        version: INTEL_PROFILE_VERSION,
        derivedAt: '',
      });
    }
    await this.ledger.pruneProfiles(leagueId, 'draft', [...args.tendencies.keys()]);

    for (const [userId, profile] of args.transactionProfiles) {
      await this.ledger.saveProfile(leagueId, 'transaction', {
        userId,
        displayName: profile.displayName ?? args.displayNames.get(userId) ?? null,
        sample: profile.sample,
        usable: profile.usable,
        seasons: profile.seasons,
        coverage,
        profile,
        version: TRANSACTION_PROFILE_VERSION,
        derivedAt: '',
      });
    }
    await this.ledger.pruneProfiles(leagueId, 'transaction', [...args.transactionProfiles.keys()]);

    for (const [userId, tendency] of args.tradeTendencies) {
      await this.ledger.saveProfile(leagueId, 'trade', {
        userId,
        displayName: tendency.displayName ?? args.displayNames.get(userId) ?? null,
        sample: tendency.sample,
        usable: tendency.usable,
        seasons: tendency.seasons,
        coverage,
        profile: tendency,
        version: TRADE_TENDENCY_VERSION,
        derivedAt: '',
      });
    }
    await this.ledger.pruneProfiles(leagueId, 'trade', [...args.tradeTendencies.keys()]);
  }

  /**
   * The roster-keyed caches the existing screens read, rebuilt from the ledger.
   *
   * Kept because two live surfaces already read them — the managers endpoint
   * and the draft board's tendency source — and cheap because they are a
   * projection of rows that are already in memory. Nothing here fetches.
   */
  private async writeRosterProfiles(args: {
    leagueId: string;
    rosters: { rosterId: number; ownerId: string | null; ownerName: string | null }[];
    tendencies: Map<string, ManagerTendencies>;
    ledgerTransactions: LedgerTransaction[];
    historical: HistoricalPick[];
    positionOf: (playerId: string) => string | null;
    latestSeason: string;
  }): Promise<void> {
    const rosterByUser = new Map<string, number>();
    for (const roster of args.rosters) if (roster.ownerId) rosterByUser.set(roster.ownerId, roster.rosterId);

    const events = ledgerTradeEvents(args.ledgerTransactions, rosterByUser);

    for (const roster of args.rosters) {
      const tendency =
        (roster.ownerId ? args.tendencies.get(roster.ownerId) : undefined) ??
        neutralTendencies(roster.ownerId ?? '', roster.ownerName);
      await this.profiles.saveTendencies(args.leagueId, roster.rosterId, tendency);

      await this.profiles.saveTradeProfile(
        args.leagueId,
        buildTradeProfile({
          rosterId: roster.rosterId,
          ownerName: roster.ownerName,
          trades: events,
          positionOf: args.positionOf,
          latestSeason: args.latestSeason,
        }),
      );

      await this.profiles.saveDraftProfile(
        args.leagueId,
        buildManagerDraftProfile({
          rosterId: roster.rosterId,
          userId: roster.ownerId,
          ownerName: roster.ownerName,
          picks: args.historical,
        }),
      );
    }

    await this.profiles.saveRoomProfile(args.leagueId, buildRoomProfile(args.historical));
  }

  // ----------------------------------------------------------- diagnostics --

  /**
   * What the subsystem knows, what it is missing, and where it will go next.
   *
   * Silent staleness is the failure mode this exists to prevent: a backfill
   * that quietly stopped two months ago and a league with genuinely no history
   * produce identical empty profiles, and only this can tell them apart.
   */
  async coverage(opts: { leagueId: string; season: string; week: number }): Promise<ManagerIntelCoverage> {
    const [links, drafts, checkpoints, weeks, picks] = await Promise.all([
      this.ledger.seasonLinks(opts.leagueId),
      this.ledger.drafts(opts.leagueId),
      this.ledger.checkpoints(opts.leagueId),
      this.transactions.allWeeksRead(opts.leagueId),
      this.ledger.picks(opts.leagueId),
    ]);

    const state = await this.readState(opts);
    const outstanding = enumerateWork(state);

    const profiles: ManagerIntelCoverage['profiles'] = [];
    for (const kind of ['draft', 'trade', 'transaction'] as const) {
      const stored = await this.ledger.profiles<unknown>(opts.leagueId, kind);
      const samples = [...stored.values()].map((p) => p.sample).sort((a, b) => a - b);
      profiles.push({
        kind,
        count: stored.size,
        usable: [...stored.values()].filter((p) => p.usable).length,
        medianSample: samples.length > 0 ? (samples[Math.floor(samples.length / 2)] ?? 0) : 0,
        derivedAt: [...stored.values()].map((p) => p.derivedAt).sort().at(-1) ?? null,
        version: [...stored.values()][0]?.version ?? null,
      });
    }

    const unresolved = links.find((l) => !l.resolved);
    const missingLink = links.find(
      (l) => l.previousLeagueId && !links.some((other) => other.sleeperLeagueId === l.previousLeagueId),
    );

    const seasonsComplete = state.seasons
      .filter((s) => s.drafts.completed && s.transactions.completed)
      .map((s) => s.season);

    /*
     * Weeks missing is counted against what is *wanted*, not against eighteen.
     *
     * A live season in week 6 is not missing twelve weeks; it is missing the
     * ones before week 6 that have not been read. Counting to eighteen would
     * report every league in October as two-thirds incomplete for ever.
     */
    let weeksMissing = 0;
    for (const season of state.seasons) {
      const settled = new Set(season.transactions.settledWeeks);
      for (let week = 1; week <= season.transactions.throughWeek; week++) {
        if (!settled.has(week)) weeksMissing += 1;
      }
    }

    return {
      leagueId: opts.leagueId,
      currentSeason: opts.season,
      seasonsDiscovered: links.map((l) => l.season).filter(Boolean),
      seasonsComplete,
      chainUnresolved: unresolved?.sleeperLeagueId ?? missingLink?.previousLeagueId ?? null,
      drafts: {
        total: drafts.length,
        complete: drafts.filter((d) => d.complete && d.picksIngested > 0).length,
        picksStored: picks.length,
      },
      transactions: {
        weeksRead: weeks.length,
        weeksSettled: weeks.filter((w) => w.settled).length,
        weeksMissing,
        stored: (await this.transactions.listBySeason(opts.leagueId)).length,
      },
      checkpoints: checkpoints.map((c) => ({
        dataset: c.dataset,
        season: c.season,
        cursor: c.cursor,
        completed: c.completed,
        lastSuccessAt: c.lastSuccessAt,
        lastAttemptAt: c.lastAttemptAt,
        lastError: c.lastError,
        requestsUsed: c.requestsUsed,
        version: c.version,
      })),
      profiles,
      outstandingUnits: outstanding.length,
      complete: outstanding.length === 0,
      requestBudget: MAX_SLEEPER_SUBREQUESTS_PER_BATCH,
    };
  }

  /** Player id to position, once per call rather than per lookup. */
  private async positionIndex(): Promise<Map<string, string | null>> {
    return new Map((await this.players.listAll()).map((p) => [p.id, p.position]));
  }
}

/**
 * A season's roster map, for one Sleeper league.
 *
 * Keyed on the Sleeper league id rather than the season string, because that is
 * what the pick rows carry and because two chains cannot collide on it.
 */
function identityMapForLeague(identities: readonly RosterIdentity[], sleeperLeagueId: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const identity of identities) {
    if (identity.sleeperLeagueId === sleeperLeagueId && identity.userId) {
      out.set(identity.rosterId, identity.userId);
    }
  }
  return out;
}

/**
 * Historical trades, re-keyed to the roster each manager holds *today*.
 *
 * The bridge between a user-keyed ledger and the roster-keyed profile cache the
 * existing screens read, and the place the old identity bug is fixed. A trade
 * made from roster 4 in 2024 belongs to the manager who made it, wherever he
 * sits now; a manager who has left the league contributes nothing, rather than
 * contributing to whoever inherited his seat.
 */
export function ledgerTradeEvents(
  transactions: readonly LedgerTransaction[],
  currentRosterByUser: ReadonlyMap<string, number>,
): TradeEvent[] {
  const out: TradeEvent[] = [];

  for (const txn of transactions) {
    if (txn.type !== 'trade' || txn.status !== 'complete') continue;

    const received = new Map<number, string[]>();
    const sent = new Map<number, string[]>();
    const rosterIds: number[] = [];

    for (const userId of txn.userIds) {
      const rosterId = currentRosterByUser.get(userId);
      if (rosterId == null) continue;
      rosterIds.push(rosterId);
      const got = txn.addsByUser.get(userId);
      const gave = txn.dropsByUser.get(userId);
      if (got) received.set(rosterId, [...got]);
      if (gave) sent.set(rosterId, [...gave]);
    }

    if (rosterIds.length === 0) continue;

    out.push({
      transactionId: txn.transactionId,
      season: txn.season,
      week: txn.week,
      rosterIds,
      initiatorRosterId:
        txn.creatorUserId != null ? (currentRosterByUser.get(txn.creatorUserId) ?? null) : null,
      received,
      sent,
      picksMoved: txn.draftPicksMoved,
      faabMoved: txn.faabTraded,
    });
  }

  return out;
}

/**
 * A season is finished when the calendar says so, or when Sleeper does.
 *
 * The calendar leads because it is the reliable half: a season earlier than the
 * one being played is over whatever a stale `status` field says. Sleeper's own
 * `complete` is the second witness, and it is what settles the current season's
 * final weeks once the league itself wraps up.
 */
export function isFinishedSeason(season: string, currentSeason: string, status: string | null): boolean {
  if (season && currentSeason && season < currentSeason) return true;
  return status === 'complete';
}

/** A unit's identity within one batch. Two plans naming the same work agree. */
function unitKey(unit: WorkUnit): string {
  switch (unit.kind) {
    case 'draft-picks':
      return `draft-picks:${unit.draftId}`;
    case 'transactions':
      return `transactions:${unit.sleeperLeagueId}:${unit.week}`;
    default:
      return `${unit.kind}:${unit.sleeperLeagueId}`;
  }
}

function countFrom1To(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);
}

/** The completeness block every profile carries. See §11 of the brief. */
function coverageSummary(args: {
  seasons: string[];
  weeksBySeason: Map<string, number>;
  picks: number;
}): Record<string, unknown> {
  return {
    seasons: args.seasons,
    seasonsCovered: args.seasons.length,
    weeksBySeason: Object.fromEntries(args.weeksBySeason),
    weeksRead: [...args.weeksBySeason.values()].reduce((a, w) => a + w, 0),
    picksStored: args.picks,
    ledgerVersion: LEDGER_VERSION,
  };
}
