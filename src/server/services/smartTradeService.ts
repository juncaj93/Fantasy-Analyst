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
import { buildRosterViews, type RosterView } from '../../core/trades/rosterUtility.ts';
import {
  TRADE_BOUNDS,
  findBilateralTrades,
  type BilateralReport,
  type TradeBounds,
  type TradePartnerView,
} from '../../core/trades/bilateral.ts';
import type { ManagerFitInput } from '../../core/trades/managerFit.ts';
import { TRADEABLE, tradeCapabilityOf, type TradeCapability } from '../../core/trades/capability.ts';
import type { ManagerTradeTendencies, LeagueTradeBaseline } from '../../core/managers/tradeTendencies.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { LeagueRepo } from '../repos/league.ts';
import { startSitInputsFor } from './startSitInputs.ts';
import type { Database } from '../db.ts';
import type { StartSitInput } from '../../core/startsit/engine.ts';

export interface SmartTradeBoard {
  league: { id: string; name: string } | null;
  found: boolean;
  offers: BilateralReport['offers'];
  /** What the search did, for the probe and for the perf report. */
  search: {
    partners: number;
    generated: number;
    scored: number;
    viable: number;
    surfaced: number;
    bounds: TradeBounds;
  };
  /** Whether this league can trade at all, and why not when it cannot. */
  capability: TradeCapability;
  /** How much manager history was available, and how complete it is. */
  history: {
    /**
     * Whether the ledger was actually read.
     *
     * The field that stops this block lying. Every count below is meaningless
     * when this is false, and it is false in exactly one case: no league was
     * resolved, so there was nothing to read history *for*. Anything else has
     * looked, and `profiles: 0` then means the league genuinely has none.
     *
     * This exists because it was once absent and the block was wrong. Five
     * early-exit paths returned a hardcoded `profiles: 0` before the ledger was
     * opened, and the production probe duly reported "trade profiles stored: 0"
     * for a league holding eight of them — an unmeasured value printed as a
     * measurement, which is the exact failure this whole feature is built to
     * avoid, committed by its own diagnostics.
     */
    measured: boolean;
    /** Managers in this league with a stored trade profile. */
    profiles: number;
    /** Seasons whose transaction history is finished. */
    seasonsComplete: string[];
    /** True when nothing about this league's history is still outstanding. */
    complete: boolean;
    /** The room's own trades per manager per season, when derived. */
    leagueRate: number | null;
  };
  notes: string[];
  warnings: string[];
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

  private async assemble(
    opts: { leagueId?: string; limit?: number } = {},
  ): Promise<SmartTradeBoard & { rejections: BilateralReport['rejections'] }> {
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
      return empty(null, ['No league is selected, so there is nobody to trade with.'], { capability: TRADEABLE });
    }

    const named = { id: league.id, name: league.name };

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
      return NO_HISTORY;
    });

    /*
     * Can this league trade at all? Asked first, because the answer is free and
     * because it is permanent.
     *
     * A best-ball league has full rosters and no trading. Without this it would
     * fall through to the roster checks below, find populated squads, and start
     * pricing offers nobody in that format can send — or, before its draft,
     * report "no other roster has any players", which is a reason that stops
     * being true on a date and would tell a reader to come back for a feature
     * their league will never have.
     */
    const capability = tradeCapabilityOf({ leagueSettings: league.leagueSettings });
    if (!capability.tradeable) {
      return empty(named, [capability.reason!], { capability, history });
    }

    const rosters = await this.leagues.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    if (!mine) {
      return empty(
        named,
        ['Your own roster is not identified in this league, so there is nobody to trade on behalf of.'],
        { capability, history },
      );
    }

    /*
     * Pre-draft, stated as the temporary thing it is.
     *
     * Sleeper reports empty squads until a draft ends and becomes authoritative
     * the moment it does, so this is the ordinary state of a league in August
     * and it resolves itself: `SleeperSyncService.adoptCompletedDraftRosters`
     * re-reads the rosters as soon as a draft is seen complete, and the next
     * read of this endpoint finds them. Nothing here has to be switched on.
     */
    const others = rosters.filter((r) => !r.isMine && r.playerIds.length > 0);
    if (others.length === 0) {
      return empty(
        named,
        [
          mine.playerIds.length === 0
            ? 'No rosters have been drafted in this league yet — trade ideas appear once the draft is done.'
            : 'No other roster in this league has any players yet.',
        ],
        { capability, history },
      );
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    /*
     * One pool for the whole league, built in one pass.
     *
     * `startSitInputsFor` batches its repository reads across the ids it is
     * given, so asking once for every rostered player is a handful of indexed
     * queries — and asking twelve times would be twelve times as many for the
     * same rows. It also means a player is evaluated against exactly one set of
     * inputs, which is what lets objective value mean the same thing on both
     * sides of a trade.
     */
    const everyPlayerId = [...new Set(rosters.flatMap((r) => r.playerIds))];
    const inputs = await startSitInputsFor(this.db, everyPlayerId).catch((err): StartSitInput[] => {
      warnings.push(`player inputs could not be read: ${String(err)}`);
      return [];
    });
    if (inputs.length === 0) {
      return empty(named, ['No player data is available for these rosters yet, so no trade can be priced.'], {
        capability,
        history,
      });
    }
    const pool = new Map(inputs.map((i) => [i.player.id, i]));

    const views = buildRosterViews({
      rosters: rosters.map((r) => ({ key: String(r.rosterId), playerIds: r.playerIds })),
      pool,
      shape,
      profile,
    });

    const me = views.get(String(mine.rosterId));
    if (!me) return empty(named, ['Your roster could not be evaluated.'], { capability, history });

    const partners: { view: RosterView; partner: TradePartnerView; fit: Omit<ManagerFitInput, 'offer'> }[] = [];
    for (const roster of others) {
      const view = views.get(String(roster.rosterId));
      if (!view) continue;
      const userId = roster.ownerId;
      const observed = userId ? (history.seasonsByUser.get(userId) ?? { observed: 0, complete: false }) : null;
      partners.push({
        view,
        partner: {
          key: String(roster.rosterId),
          rosterId: roster.rosterId,
          displayName: roster.ownerName ?? `Roster ${roster.rosterId}`,
          userId,
        },
        fit: {
          tendencies: userId ? (history.tendencies.get(userId) ?? null) : null,
          userId,
          displayName: roster.ownerName,
          /*
           * A manager the ledger has no identity for is unknown, not inactive.
           *
           * That is §10's standing principle and this is the line that enforces
           * it: a null owner, an unbackfilled league and a manager who joined
           * this season all arrive with zero observed seasons, which
           * `activityClassFor` reads as `unknown` and gives a contribution of
           * exactly zero.
           */
          seasonsObserved: observed?.observed ?? 0,
          historyComplete: observed?.complete ?? false,
          askingUserId: mine.ownerId,
          leagueRate: history.leagueRate,
        },
      });
    }

    const report = findBilateralTrades({
      me,
      partners,
      ...(opts.limit ? { bounds: { offersTotal: Math.max(1, Math.min(opts.limit, 20)) } } : {}),
    });

    if (history.profiles === 0) {
      warnings.push(
        'No manager trade history has been derived for this league yet, so every offer is ranked on roster fit alone.',
      );
    }

    return {
      league: { id: league.id, name: league.name },
      found: report.offers.length > 0,
      offers: report.offers,
      search: {
        partners: report.partners,
        generated: report.generated,
        scored: report.scored,
        viable: report.viable,
        surfaced: report.offers.length,
        bounds: TRADE_BOUNDS,
      },
      capability,
      history: {
        measured: true,
        profiles: history.profiles,
        seasonsComplete: history.seasonsComplete,
        complete: history.complete,
        leagueRate: history.leagueRate,
      },
      notes: report.notes,
      warnings,
      rejections: report.rejections,
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
  private async history(leagueId: string): Promise<HistoryContext> {
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
      tendencies,
      seasonsByUser,
      seasonsComplete,
      profiles: tendencies.size,
      complete: seasonsComplete.length > 0 && incomplete.size === 0,
      leagueRate: baseline?.value?.tradesPerManagerSeason ?? null,
    };
  }
}

interface HistoryContext {
  tendencies: Map<string, ManagerTradeTendencies>;
  /** Per manager: fully read seasons, and whether any of his have been read. */
  seasonsByUser: Map<string, { observed: number; complete: boolean }>;
  seasonsComplete: string[];
  profiles: number;
  complete: boolean;
  leagueRate: number | null;
}

const NO_HISTORY: HistoryContext = {
  tendencies: new Map(),
  seasonsByUser: new Map(),
  seasonsComplete: [],
  profiles: 0,
  complete: false,
  leagueRate: null,
};

/**
 * A board that says why there is nothing on it. Never an error.
 *
 * `found` is what it always was. What changed is that the history block is now
 * *passed in* rather than invented: a caller that has read the ledger reports
 * what it found, and only the one caller that could not — no league resolved —
 * leaves `measured: false`. The counts are zeroed there for shape, and
 * `measured` is the field that says not to read them.
 */
function empty(
  league: { id: string; name: string } | null,
  notes: string[],
  context: { capability: TradeCapability; history?: HistoryContext },
): SmartTradeBoard & { rejections: BilateralReport['rejections'] } {
  const history = context.history;
  return {
    rejections: [],
    league,
    found: false,
    offers: [],
    search: { partners: 0, generated: 0, scored: 0, viable: 0, surfaced: 0, bounds: TRADE_BOUNDS },
    capability: context.capability,
    history: {
      measured: history != null,
      profiles: history?.profiles ?? 0,
      seasonsComplete: history?.seasonsComplete ?? [],
      complete: history?.complete ?? false,
      leagueRate: history?.leagueRate ?? null,
    },
    notes,
    warnings: [],
  };
}
