/**
 * What the league's own history says about the people in it.
 *
 * The demo half of `services/managerIntelService.ts`, and deliberately the same
 * shape: the service reads stored transactions and stored picks out of D1,
 * projects them with `toLedgerTransaction`, and hands them to
 * `buildTransactionProfiles`, `buildTradeTendencies` and `readManagerTendencies`.
 * This does exactly that over the scenario's own ledger and the scenario's own
 * draft, through the same four functions.
 *
 * Nothing here decides that anybody is aggressive, patient, or good at drafting.
 * The fixture states transactions and picks; these engines state tendencies; and
 * the waiver board, the trade board and the managers endpoint read what the
 * engines concluded.
 *
 * Built once per scenario and cached with it, because three screens ask for it
 * and the arithmetic over four hundred rows is not free.
 */

import { toLedgerTransaction, type LedgerTransaction } from '../../managers/ledger.ts';
import {
  buildLeagueTransactionBaseline,
  buildTransactionProfiles,
  type LeagueTransactionBaseline,
  type ManagerTransactionProfile,
} from '../../managers/transactionProfile.ts';
import {
  buildLeagueTradeBaseline,
  buildTradeTendencies,
  type LeagueTradeBaseline,
  type ManagerTradeTendencies,
} from '../../managers/tradeTendencies.ts';
import { readManagerTendencies, type ManagerTendencies } from '../../managers/managerTendencies.ts';
import type { HistoricalPick } from '../../managers/draftProfile.ts';
import { readFinalWeek } from '../../league/planning.ts';
import type { ScenarioData } from '../fixtures/index.ts';
import {
  LEDGER_WEEKS,
  PRIOR_SEASON,
  PRIOR_SEASON_WEEKS,
  demoTransactions,
  displayNames,
  userByRoster,
} from '../fixtures/ledger.ts';

export interface DemoManagerHistory {
  /** Transaction profiles, keyed by *current* roster id, as the waiver board wants them. */
  profilesByRoster: Map<number, ManagerTransactionProfile>;
  /** The same, keyed by user id, as the managers endpoint wants them. */
  profilesByUser: Map<string, ManagerTransactionProfile>;
  transactionBaseline: LeagueTransactionBaseline | null;
  tradeTendencies: Map<string, ManagerTradeTendencies>;
  tradeBaseline: LeagueTradeBaseline | null;
  draftTendencies: Map<string, ManagerTendencies>;
  /** Which seasons the ledger actually covers, for the "how much is known" line. */
  seasons: string[];
  finalWeek: number;
  ledger: LedgerTransaction[];
}

const EMPTY: DemoManagerHistory = {
  profilesByRoster: new Map(),
  profilesByUser: new Map(),
  transactionBaseline: null,
  tradeTendencies: new Map(),
  tradeBaseline: null,
  draftTendencies: new Map(),
  seasons: [],
  finalWeek: 14,
  ledger: [],
};

const cache = new WeakMap<ScenarioData, DemoManagerHistory>();

export function demoManagerHistory(data: ScenarioData): DemoManagerHistory {
  const cached = cache.get(data);
  if (cached) return cached;
  const built = build(data);
  cache.set(data, built);
  return built;
}

function build(data: ScenarioData): DemoManagerHistory {
  if (data.transactions.length === 0) return EMPTY;

  const season = data.league.season;
  const byRoster = userByRoster();
  const names = displayNames();
  const finalWeek = readFinalWeek(data.league.leagueSettings);

  /*
   * Two seasons, because one is a thin sample.
   *
   * The live feature walks the previous-league chain for exactly this reason —
   * a manager who traded once in a season is indistinguishable from a manager
   * nobody has ingested — so a demo built on one season would only ever
   * demonstrate the uncertain branch of every reading. The season being played
   * is the scenario's own ledger; the season before it is generated on the same
   * habits over a full fourteen weeks.
   *
   * Only the current season's rows are on the response anywhere: the price
   * summary the Waivers screen prints is `collectBids` over `data.transactions`
   * alone, because what a claim goes for is a fact about this season's market.
   */
  const priorSeason = demoTransactions(PRIOR_SEASON);
  const ledger = [
    ...priorSeason.map((txn) => toLedgerTransaction({ txn, season: PRIOR_SEASON, userByRoster: byRoster })),
    ...data.transactions.map((txn) => toLedgerTransaction({ txn, season, userByRoster: byRoster })),
  ];

  /*
   * How many weeks of history the profiles are rates over.
   *
   * The ledger's own weeks rather than the scenario's, because a rate's
   * denominator is what was *read*, not what has happened: a manager observed
   * across six weeks who claimed twice claims a third as often as one observed
   * across two who did the same.
   */
  const weeksBySeason = new Map([
    [PRIOR_SEASON, PRIOR_SEASON_WEEKS],
    [season, LEDGER_WEEKS.length],
  ]);
  const seasons = [PRIOR_SEASON, season];
  const seasonsByUser = new Map<string, string[]>([...byRoster.values()].map((userId) => [userId, [...seasons]]));
  const positionOf = positionLookup(data);

  const transactionInput = {
    transactions: ledger,
    weeksBySeason,
    seasonsByUser,
    budgetTotal: data.strategy?.budget.rule.total ?? null,
    positionOf,
    displayNames: names,
    finalWeek,
  };
  const transactionBaseline = buildLeagueTransactionBaseline(transactionInput);
  const profilesByUser = buildTransactionProfiles(transactionInput, transactionBaseline);

  const tradeInput = {
    transactions: ledger,
    seasonsByUser,
    positionOf,
    displayNames: names,
    latestSeason: season,
  };

  /*
   * The draft, which this league does have a season of.
   *
   * `readManagerTendencies` wants historical picks with a position on each, and
   * the scenario's own completed draft is exactly that — so the demo's draft
   * tendencies are a reading of the draft the demo itself ran, not a second
   * fixture that could disagree with it. No market rank: Sleeper publishes none
   * with a pick, so reach-vs-market stays unavailable here exactly as it does
   * in production.
   */
  const picks: HistoricalPick[] = data.picks
    .filter((pick) => pick.playerId != null)
    .map((pick) => ({
      season,
      draftId: pick.draftId,
      pickNo: pick.pickNo,
      round: pick.round,
      userId: pick.rosterId == null ? null : (byRoster.get(pick.rosterId) ?? null),
      rosterId: pick.rosterId ?? null,
      position: positionOf(pick.playerId!),
      marketRank: null,
      yearsExp: null,
    }));

  const draftTendencies = readManagerTendencies({
    picks,
    positions: [...new Set(picks.map((p) => p.position).filter((p): p is string => !!p))].sort(),
    latestSeason: season,
    displayNames: names,
  });

  const profilesByRoster = new Map<number, ManagerTransactionProfile>();
  for (const [rosterId, userId] of byRoster) {
    const profile = profilesByUser.get(userId);
    if (profile) profilesByRoster.set(rosterId, profile);
  }

  return {
    profilesByRoster,
    profilesByUser,
    transactionBaseline,
    tradeTendencies: buildTradeTendencies(tradeInput),
    tradeBaseline: buildLeagueTradeBaseline(tradeInput),
    draftTendencies,
    seasons,
    finalWeek,
    ledger,
  };
}

function positionLookup(data: ScenarioData): (playerId: string) => string | null {
  const byId = new Map(data.players.map((p) => [p.id, p.position ?? null]));
  return (playerId) => byId.get(playerId) ?? null;
}
