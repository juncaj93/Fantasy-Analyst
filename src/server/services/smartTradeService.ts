/**
 * Smart Bilateral Trades, assembled from what is already stored.
 *
 * ## Zero Sleeper requests, and that is a property rather than an aspiration
 *
 * §20 of the brief sets the target at zero added Sleeper walks for a normal
 * Trades request, and this service meets it by construction: every read below
 * goes to D1, and the one client this app has for Sleeper is not imported. The
 * league, the rosters, the player pool, the trade tendencies, the ledger's
 * identities and its checkpoints are all rows somebody else already paid for —
 * the history subsystem's `advance` walks Sleeper on a cron, and this is the
 * `derive` side of that split reading its output.
 *
 * A league nobody has backfilled reads as no history, which is the correct
 * state and not an error: the bilateral half of the answer is unaffected, and
 * every offer keeps the roster reasoning it would have had. §18's last empty
 * state — "behavioural intelligence is an enhancement, not a dependency" — is
 * enforced here by simply never failing on an absent profile.
 *
 * ## Where the work actually goes
 *
 * The expensive part is not I/O. It is the lineup optimiser, run twice per
 * scored candidate, and that is bounded by `TRADE_BOUNDS` in the engine rather
 * than here. What this file owns is making sure the optimiser is given one
 * shared player pool so a player who appears on two rosters' candidate lists is
 * evaluated once, not twice.
 */

import { buildRosterShape, buildScoringProfile } from '../../core/sleeper/scoring.ts';
import {
  NO_TRADE_HISTORY,
  assembleSmartTrades,
  type TradeAssembly,
  type TradeHistoryContext,
} from '../../core/trades/assemble.ts';
import type { BilateralReport } from '../../core/trades/bilateral.ts';
import type { TradeAssemblyRequest } from '../../core/trades/assemble.ts';
import type { LeagueRecord, RosterRecord } from '../../core/sleeper/types.ts';
import { tradeCapabilityOf } from '../../core/trades/capability.ts';
import type { ManagerTradeTendencies, LeagueTradeBaseline } from '../../core/managers/tradeTendencies.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { LeagueRepo } from '../repos/league.ts';
import { startSitInputsFor } from './startSitInputs.ts';
import type { Database } from '../db.ts';
import type { StartSitInput } from '../../core/startsit/engine.ts';

/**
 * The board, plus the league it is about.
 *
 * Everything except `league` is `TradeAssembly` — the decision, made in
 * `core/trades/assemble.ts` where Demo Mode and the support replay reach the
 * same function. `rejections` is on the assembly and is dropped by `build`,
 * which is what makes the probe and the screen two views of one run rather than
 * two runs.
 *
 * `history.measured` is the field that stops that block lying. Every count under
 * it is meaningless when it is false, and it is false in exactly one case: no
 * league was resolved, so there was nothing to read history *for*. Anything else
 * has looked, and `profiles: 0` then means the league genuinely has none. It
 * exists because it was once absent and the block was wrong: five early-exit
 * paths returned a hardcoded `profiles: 0` before the ledger was opened, and the
 * production probe duly reported "trade profiles stored: 0" for a league holding
 * eight of them — an unmeasured value printed as a measurement, committed by the
 * diagnostics of the feature built to avoid exactly that.
 */
export interface SmartTradeBoard extends Omit<TradeAssembly, 'rejections'> {
  league: { id: string; name: string } | null;
}

/** The reads, before the search. Shared by the board and by the snapshot. */
export interface TradeGathering {
  league: LeagueRecord | null;
  request: TradeAssemblyRequest;
  /** The rosters as stored, for a capture that has to alias their owners. */
  rosterRecords?: RosterRecord[];
  /** Set only in the no-league case, where the board's note is not the search's. */
  noLeagueNote?: string;
}

export class SmartTradeService {
  private readonly leagues: LeagueRepo;
  private readonly ledger: ManagerLedgerRepo;

  constructor(private readonly db: Database) {
    this.leagues = new LeagueRepo(db);
    this.ledger = new ManagerLedgerRepo(db);
  }

  /**
   * Build the board for one league.
   *
   * `leagueId` absent means the selected league, which is what the Trades screen
   * asks for. Every failure mode below returns a board rather than throwing: a
   * trade suggestion is an enhancement to a screen that has other things on it,
   * and a 500 from this endpoint should never be able to blank the page.
   */
  async build(opts: { leagueId?: string; limit?: number } = {}): Promise<SmartTradeBoard> {
    const { rejections: _dropped, ...board } = await this.assemble(opts);
    return board;
  }

  /**
   * The same board, with every rejection kept. For the read-only probe.
   *
   * One assembly, two views of it. The rejection list is long, developer-facing
   * and exactly the payload §17 says must not reach a phone — but it is produced
   * by the same run, so a probe and a screen can never disagree about what the
   * engine did.
   */
  async explain(opts: { leagueId?: string } = {}): Promise<SmartTradeBoard & { rejections: BilateralReport['rejections'] }> {
    return this.assemble(opts);
  }

  /**
   * Everything the search needs, read but not yet run.
   *
   * Split out of `assemble` so the support snapshot can capture the *same*
   * reads and then run the same search over them — a snapshot gathered
   * separately would describe a board this service never produced. Null league
   * is the one genuinely unmeasured case; see the note below.
   */
  async gather(opts: { leagueId?: string; limit?: number } = {}): Promise<TradeGathering> {
    const warnings: string[] = [];
    const league = opts.leagueId
      ? await this.leagues.getLeague(opts.leagueId)
      : await this.leagues.getSelectedLeague();

    if (!league) {
      /*
       * The one genuinely unmeasured case, and the only one that may say so.
       *
       * With no league there is nothing to read history *for*, so the counts are
       * absent rather than zero. Every exit below has a league and therefore
       * reads the ledger before answering.
       */
      return {
        league: null,
        request: {
          leagueSettings: {},
          shape: buildRosterShape([]),
          profile: buildScoringProfile({}, []),
          rosters: [],
          inputs: [],
          history: NO_TRADE_HISTORY,
          warnings,
        },
        noLeagueNote: 'No league is selected, so there is nobody to trade with.',
      };
    }

    /*
     * What the ledger actually holds, read once, before any exit that could
     * report on it.
     *
     * Deliberately ahead of the roster checks even though a pre-draft league
     * will not use the profiles: the board's history block is a *diagnostic*,
     * and a diagnostic that is only populated on the happy path is one that
     * says nothing in exactly the situations somebody is investigating. Four
     * indexed reads.
     */
    const history = await this.history(league.id).catch((err) => {
      warnings.push(`manager history could not be read: ${String(err)}`);
      return { ...NO_TRADE_HISTORY, measured: true };
    });

    const rosters = await this.leagues.listRosters(league.id);
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    /*
     * One pool for the whole league, built in one pass.
     *
     * `startSitInputsFor` batches its repository reads across the ids it is
     * given, so asking once for every rostered player is a handful of indexed
     * queries — and asking twelve times would be twelve times as many for the
     * same rows.
     *
     * Skipped entirely when nothing downstream could use it: a format that
     * cannot trade, a league with no roster of mine, and a league nobody has
     * drafted all answer before the pool is read, and reading it anyway would
     * be a handful of queries spent on an answer already known.
     */
    const wanted =
      tradeCapabilityOf({ leagueSettings: league.leagueSettings }).tradeable &&
      rosters.some((r) => r.isMine) &&
      rosters.some((r) => !r.isMine && r.playerIds.length > 0);
    const everyPlayerId = wanted ? [...new Set(rosters.flatMap((r) => r.playerIds))] : [];
    const inputs = await startSitInputsFor(this.db, everyPlayerId).catch((err): StartSitInput[] => {
      warnings.push(`player inputs could not be read: ${String(err)}`);
      return [];
    });

    return {
      league,
      request: {
        leagueSettings: league.leagueSettings,
        shape,
        profile,
        rosters: rosters.map((r) => ({
          rosterId: r.rosterId,
          ownerId: r.ownerId,
          ownerName: r.ownerName,
          playerIds: r.playerIds,
          isMine: r.isMine,
        })),
        inputs,
        history,
        limit: opts.limit,
        warnings,
      },
      rosterRecords: rosters,
    };
  }

  private async assemble(
    opts: { leagueId?: string; limit?: number } = {},
  ): Promise<SmartTradeBoard & { rejections: BilateralReport['rejections'] }> {
    const gathered = await this.gather(opts);
    const board = assembleSmartTrades(gathered.request);
    return {
      league: gathered.league == null ? null : { id: gathered.league.id, name: gathered.league.name },
      ...board,
      ...(gathered.noLeagueNote ? { notes: [gathered.noLeagueNote] } : {}),
    };
  }

  /**
   * Everything the behavioural half needs, in three reads of stored rows.
   *
   * The interesting one is `seasonsByUser`, which answers a question no single
   * table does: *has this manager been measured?* A stored trade profile records
   * the seasons a manager traded in, so a manager who never traded has an empty
   * list — identical to a manager nobody has ingested. Telling them apart needs
   * the ledger's roster identities (which seasons was he in the league) crossed
   * with its transaction checkpoints (which of those seasons were read to the
   * end), and that cross is §10's whole distinction.
   */
  private async history(leagueId: string): Promise<TradeHistoryContext> {
    const [stored, identities, checkpoints, baseline] = await Promise.all([
      this.ledger.profiles<ManagerTradeTendencies>(leagueId, 'trade'),
      this.ledger.rosterIdentities(leagueId),
      this.ledger.checkpoints(leagueId),
      this.ledger.baseline<LeagueTradeBaseline>(leagueId, 'trade'),
    ]);

    const tendencies = new Map<string, ManagerTradeTendencies>();
    for (const [userId, entry] of stored) tendencies.set(userId, entry.profile);

    /*
     * A season is finished when its transaction walk says so.
     *
     * The `completed` flag is written by the ingestion subsystem only when every
     * week of a finished season has been read and settled — never for a live
     * one, which is exactly right for §19's "treat current season as partial
     * exposure, never falsely complete". So a live season contributes to a
     * manager's trade counts and never to his observed-season count, and a
     * manager cannot be called inactive on the strength of a season still in
     * progress.
     */
    const completeLeagues = new Set(
      checkpoints.filter((c) => c.dataset === 'transactions' && c.completed).map((c) => c.sleeperLeagueId),
    );
    const seasonsComplete = [
      ...new Set(
        checkpoints
          .filter((c) => c.dataset === 'transactions' && c.completed)
          .map((c) => c.season)
          .filter(Boolean),
      ),
    ].sort();

    const seasonsByUser = new Map<string, { observed: number; complete: boolean }>();
    const seenSeasons = new Map<string, Set<string>>();
    const incomplete = new Map<string, boolean>();
    for (const identity of identities) {
      if (!identity.userId) continue;
      const done = completeLeagues.has(identity.sleeperLeagueId);
      if (done) {
        const set = seenSeasons.get(identity.userId) ?? new Set<string>();
        set.add(identity.season);
        seenSeasons.set(identity.userId, set);
      } else {
        incomplete.set(identity.userId, true);
      }
    }
    for (const userId of new Set(identities.map((i) => i.userId).filter((id): id is string => !!id))) {
      seasonsByUser.set(userId, {
        observed: seenSeasons.get(userId)?.size ?? 0,
        /*
         * "Complete" means *the finished seasons* are read, not that nothing is
         * outstanding — the live season is always outstanding and always will be
         * until it ends. A manager is called measured when at least one season
         * of his has been read to the end.
         */
        complete: (seenSeasons.get(userId)?.size ?? 0) > 0,
      });
    }

    return {
      /*
       * Read, therefore measured. `profiles: 0` under this means the league
       * genuinely has none — see the field's note on `SmartTradeBoard`.
       */
      measured: true,
      tendencies,
      seasonsByUser,
      seasonsComplete,
      profiles: tendencies.size,
      complete: seasonsComplete.length > 0 && incomplete.size === 0,
      leagueRate: baseline?.value?.tradesPerManagerSeason ?? null,
    };
  }
}
