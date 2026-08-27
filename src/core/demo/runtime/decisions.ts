/**
 * What each in-season decision reads, gathered once for two callers.
 *
 * Demo Mode's mirror of `server/services/decisionInputs.ts`, and it exists for
 * the same reason: the demo screen needs these values to answer the screen, and
 * the demo support snapshot needs the *same* values, because a snapshot of a
 * decision gathered separately is a snapshot of a different decision.
 *
 * The gathering itself is one line per input — a scenario is a value, not a
 * database — so this is short. What matters is that there is exactly one of it.
 */

import { collectBids } from '../../faab/bids.ts';
import { playoffContextFor } from '../../league/planning.ts';
import { detectBestBall } from '../../sleeper/bestBall.ts';
import { boundedFreeAgentIds, FREE_AGENTS_PER_POSITION } from '../../roster/freeAgents.ts';
import { buildRosterShape, buildScoringProfile, startablePositions } from '../../sleeper/scoring.ts';
import { LEDGER_WEEKS } from '../fixtures/ledger.ts';
import { demoManagerHistory } from './history.ts';
import { dstPlanSourcesFrom, startSitInputsFrom } from './sources.ts';
import type { WaiverAssemblyRequest } from '../../waivers/assemble.ts';
import type { TradeAssemblyRequest } from '../../trades/assemble.ts';
import type { StartSitMode } from '../../startsit/mode.ts';
import type { RosterRecord } from '../../sleeper/types.ts';
import type { ScenarioData } from '../fixtures/index.ts';

/** The pieces every league-shaped answer starts from. */
export function demoLeagueContext(data: ScenarioData) {
  const profile = buildScoringProfile(data.league.scoringSettings, data.league.rosterPositions);
  const shape = buildRosterShape(data.league.rosterPositions);
  const mine = data.rosters.find((roster) => roster.isMine) ?? null;
  const rosteredIds = new Set<string>();
  for (const roster of data.rosters) for (const id of roster.playerIds) rosteredIds.add(id);
  return { profile, shape, mine, rosteredIds };
}

/** The bounded wire, ordered exactly as the live scan orders it. */
export function demoCandidateIds(data: ScenarioData): string[] {
  const { shape, rosteredIds } = demoLeagueContext(data);
  return boundedFreeAgentIds(data.players, {
    rosteredIds,
    startable: startablePositions(shape),
    ranks: data.adpValues,
  });
}

export interface DemoWaiverGathering {
  request: Omit<WaiverAssemblyRequest, 'now' | 'generatedAt'>;
  candidateIds: string[];
  strategy: ScenarioData['strategy'];
  pool: { scanned: number; perPosition: number };
}

export function demoWaiverRequest(data: ScenarioData, mine: RosterRecord): DemoWaiverGathering {
  const { profile, shape, rosteredIds } = demoLeagueContext(data);
  const candidateIds = demoCandidateIds(data);
  const week = data.nflState?.week ?? 1;

  /*
   * The same three suppliers the live handler passes, from the same ledger.
   *
   * `observations` is every bid the league has published — which is what turns
   * "somebody else needs a tight end" into a named rival with a price on him —
   * and `history` is what the manager-intelligence pass concluded about the
   * people holding those rosters. Both are absent in a scenario with no ledger,
   * and the columns then report exactly what they report for a league nobody has
   * backfilled: not known.
   */
  const strategy = data.strategy;
  const history = demoManagerHistory(data);
  const bidHistory = collectBids(data.transactions, LEDGER_WEEKS);
  const playoff = playoffContextFor({
    leagueSettings: data.league.leagueSettings,
    rosters: data.rosters,
    mine,
    totalRosters: data.league.totalRosters,
    currentWeek: week,
  });

  return {
    candidateIds,
    strategy,
    pool: { scanned: candidateIds.length, perPosition: FREE_AGENTS_PER_POSITION },
    request: {
      shape,
      profile,
      rosterInputs: startSitInputsFrom(data, mine.playerIds),
      candidateInputs: startSitInputsFrom(data, candidateIds),
      rosteredIds,
      currentStarterIds: mine.starterIds,
      reserveIds: mine.reserveIds,
      rosters: data.rosters,
      players: data.players,
      week,
      season: data.league.season,
      strategy: strategy ?? null,
      budgets: strategy?.budget ?? null,
      prices: strategy?.prices ?? null,
      observations: bidHistory.observations,
      history: history.transactionBaseline
        ? {
            profiles: history.profilesByRoster,
            baseline: history.transactionBaseline,
            week,
            finalWeek: history.finalWeek,
          }
        : undefined,
      dstSources: dstPlanSourcesFrom(data),
      bestBall: detectBestBall({
        leagueSettings: data.league.leagueSettings,
        draftSettings: data.draft?.settings ?? null,
      }).bestBall,
      /* Post-draft is a fact about the draft, never about the calendar. */
      draftComplete: (data.draft?.status ?? '') === 'complete',
      playoff: { weeks: playoff.weeks, emphasis: playoff.emphasis },
    },
  };
}

/** The roster, evaluated for the Team screen's question. */
export function demoLineupInputs(data: ScenarioData, mine: RosterRecord, mode: StartSitMode) {
  const { profile, shape } = demoLeagueContext(data);
  return { profile, shape, inputs: startSitInputsFrom(data, mine.playerIds, { mode }), mode };
}

export function demoTradeRequest(data: ScenarioData): TradeAssemblyRequest {
  const { profile, shape } = demoLeagueContext(data);
  const history = demoManagerHistory(data);

  /*
   * Observed seasons, per manager, keyed by every owner in the room.
   *
   * Not by the managers who have a trade *profile*, which is a different and much
   * smaller set: the live service derives this from the ledger's roster
   * identities, so a manager who has been in the league for two read seasons and
   * never traded is measured with zero trades — not unknown. Keying it off the
   * profiles would call most of the room unknown and quietly demonstrate the
   * wrong branch of `activityClassFor`.
   */
  const seasonsByUser = new Map(
    data.rosters
      .map((roster) => roster.ownerId)
      .filter((userId): userId is string => !!userId)
      .map((userId) => [userId, { observed: history.seasons.length, complete: history.seasons.length > 0 }]),
  );

  return {
    leagueSettings: data.league.leagueSettings,
    shape,
    profile,
    rosters: data.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      ownerId: roster.ownerId,
      ownerName: roster.ownerName,
      playerIds: roster.playerIds,
      isMine: roster.isMine,
    })),
    inputs: startSitInputsFrom(data, [...new Set(data.rosters.flatMap((roster) => roster.playerIds))]),
    history: {
      measured: true,
      tendencies: history.tradeTendencies,
      seasonsByUser,
      seasonsComplete: history.seasons,
      profiles: [...history.tradeTendencies.values()].filter((tendencies) => tendencies.usable).length,
      complete: history.seasons.length > 0,
      leagueRate: history.tradeBaseline?.tradesPerManagerSeason ?? null,
    },
  };
}
