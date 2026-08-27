/**
 * The whole Smart Trades decision, in one call.
 *
 * `findBilateralTrades` is the search and `buildRosterViews` is what it
 * searches over, but between a league and an offer there are six decisions that
 * are not in either — can this format trade at all, is there a roster to trade
 * on behalf of, has anybody drafted, which partners are eligible, what the
 * ledger knows about each of them, and which empty answer to give when there is
 * nothing to say. Those six lived in `server/services/smartTradeService.ts` and
 * again in `core/demo/runtime/handlers.ts`, and the demo's copy had already
 * drifted: it derived a partner's observed seasons from the league's season
 * list rather than from the manager's own.
 *
 * There are now three callers and the third is a support replay, which is what
 * makes the duplication untenable rather than merely untidy: an offer
 * reproduced from a snapshot has to be the offer that was surfaced, and a third
 * spelling of these six decisions would be a third chance to disagree.
 *
 * ## The behavioural half is passed in, never read here
 *
 * Whether a manager trades, with whom, and how often is a question about a
 * ledger, and a ledger is a database. So {@link TradeHistoryContext} arrives as
 * a value: the deployed service crosses roster identities with transaction
 * checkpoints to build it, Demo Mode builds it from a fixture, and a replay
 * reads it out of the snapshot. All three then reach the same search.
 *
 * `measured` is the field that stops the history block lying, and it is
 * preserved exactly as the service established it: every count under it is
 * meaningless when it is false, and it is false in exactly one case — no league
 * was resolved, so there was nothing to read history *for*.
 */

import { buildRosterViews, type RosterView } from './rosterUtility.ts';
import {
  TRADE_BOUNDS,
  findBilateralTrades,
  type BilateralReport,
  type TradeBounds,
  type TradePartnerView,
} from './bilateral.ts';
import { TRADEABLE, tradeCapabilityOf, type TradeCapability } from './capability.ts';
import type { ManagerFitInput } from './managerFit.ts';
import type { ManagerTradeTendencies } from '../managers/tradeTendencies.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';

/** One roster, in the only terms the trade search needs it in. */
export interface TradeAssemblyRoster {
  rosterId: number;
  ownerId: string | null;
  ownerName: string | null;
  playerIds: string[];
  isMine: boolean;
}

/**
 * What the ledger holds about this league's managers, already resolved.
 *
 * Keyed by Sleeper user id, because that is what follows a person between
 * seasons — a roster id follows a *slot*, and a profile keyed that way would
 * attach one manager's history to whoever holds his old seat this year.
 */
export interface TradeHistoryContext {
  /** False only when there was no league to read history for. See the note. */
  measured: boolean;
  tendencies: ReadonlyMap<string, ManagerTradeTendencies>;
  /** Per manager: fully read seasons, and whether any of his have been read. */
  seasonsByUser: ReadonlyMap<string, { observed: number; complete: boolean }>;
  seasonsComplete: string[];
  profiles: number;
  complete: boolean;
  leagueRate: number | null;
}

export const NO_TRADE_HISTORY: TradeHistoryContext = {
  measured: false,
  tendencies: new Map(),
  seasonsByUser: new Map(),
  seasonsComplete: [],
  profiles: 0,
  complete: false,
  leagueRate: null,
};

export interface TradeAssemblyRequest {
  leagueSettings: Record<string, unknown>;
  shape: RosterShape;
  profile: ScoringProfile;
  rosters: TradeAssemblyRoster[];
  /**
   * Every rostered player, evaluated once for the whole league.
   *
   * One shared pool rather than one per roster, so a player who appears on two
   * candidate lists is evaluated once — which is also what lets objective value
   * mean the same thing on both sides of an offer.
   */
  inputs: StartSitInput[];
  history: TradeHistoryContext;
  /** Surfaced offers, bounded by the engine at twenty whatever is asked for. */
  limit?: number | undefined;
  /** Carried through rather than discarded; see `warnings` on the result. */
  warnings?: string[];
}

/** The board, minus the league identity each caller names for itself. */
export interface TradeAssembly {
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
  history: {
    measured: boolean;
    profiles: number;
    seasonsComplete: string[];
    complete: boolean;
    leagueRate: number | null;
  };
  notes: string[];
  warnings: string[];
  /** Every rejected candidate and the reason it died. For the probe only. */
  rejections: BilateralReport['rejections'];
}

export function assembleSmartTrades(request: TradeAssemblyRequest): TradeAssembly {
  const warnings = [...(request.warnings ?? [])];
  const history = request.history;

  /*
   * Can this league trade at all? The first thing decided.
   *
   * A best-ball league has full rosters and no trading. Without this it would
   * fall through to the roster checks below, find populated squads, and start
   * pricing offers nobody in that format can send — or, before its draft,
   * report "no other roster has any players", which is a reason that stops
   * being true on a date and would tell a reader to come back for a feature
   * their league will never have.
   */
  const capability = tradeCapabilityOf({ leagueSettings: request.leagueSettings });
  if (!capability.tradeable) return empty([capability.reason!], capability, history, warnings);

  const mine = request.rosters.find((roster) => roster.isMine) ?? null;
  if (!mine) {
    return empty(
      ['Your own roster is not identified in this league, so there is nobody to trade on behalf of.'],
      capability,
      history,
      warnings,
    );
  }

  /*
   * Pre-draft, stated as the temporary thing it is.
   *
   * Sleeper reports empty squads until a draft ends and becomes authoritative
   * the moment it does, so this is the ordinary state of a league in August and
   * it resolves itself. Nothing here has to be switched on.
   */
  const others = request.rosters.filter((roster) => !roster.isMine && roster.playerIds.length > 0);
  if (others.length === 0) {
    return empty(
      [
        mine.playerIds.length === 0
          ? 'No rosters have been drafted in this league yet — trade ideas appear once the draft is done.'
          : 'No other roster in this league has any players yet.',
      ],
      capability,
      history,
      warnings,
    );
  }

  if (request.inputs.length === 0) {
    return empty(
      ['No player data is available for these rosters yet, so no trade can be priced.'],
      capability,
      history,
      warnings,
    );
  }

  const pool = new Map(request.inputs.map((input) => [input.player.id, input]));
  const views = buildRosterViews({
    rosters: request.rosters.map((roster) => ({ key: String(roster.rosterId), playerIds: roster.playerIds })),
    pool,
    shape: request.shape,
    profile: request.profile,
  });

  const me = views.get(String(mine.rosterId));
  if (!me) return empty(['Your roster could not be evaluated.'], capability, history, warnings);

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
         * A null owner, an unbackfilled league and a manager who joined this
         * season all arrive with zero observed seasons, which `activityClassFor`
         * reads as `unknown` and gives a contribution of exactly zero.
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
    ...(request.limit ? { bounds: { offersTotal: Math.max(1, Math.min(request.limit, 20)) } } : {}),
  });

  if (history.profiles === 0) {
    warnings.push(
      'No manager trade history has been derived for this league yet, so every offer is ranked on roster fit alone.',
    );
  }

  return {
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
    history: reportHistory(history),
    notes: report.notes,
    warnings,
    rejections: report.rejections,
  };
}

/**
 * A board that says why there is nothing on it. Never an error.
 *
 * The history block is reported rather than invented: a caller that read the
 * ledger says what it found, and only the caller that could not — no league —
 * leaves `measured: false`. The counts are zeroed there for shape, and
 * `measured` is the field that says not to read them.
 */
function empty(
  notes: string[],
  capability: TradeCapability,
  history: TradeHistoryContext,
  warnings: string[],
): TradeAssembly {
  return {
    found: false,
    offers: [],
    search: { partners: 0, generated: 0, scored: 0, viable: 0, surfaced: 0, bounds: TRADE_BOUNDS },
    capability,
    history: reportHistory(history),
    notes,
    /*
     * Carried, not discarded. Losing the explanation for a degraded answer is
     * the same defect as inventing a number for one.
     */
    warnings,
    rejections: [],
  };
}

function reportHistory(history: TradeHistoryContext): TradeAssembly['history'] {
  return {
    measured: history.measured,
    profiles: history.profiles,
    seasonsComplete: history.seasonsComplete,
    complete: history.complete,
    leagueRate: history.leagueRate,
  };
}

/** Re-exported so a caller with no league to check still names one capability. */
export { TRADEABLE };
