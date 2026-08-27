/**
 * What each in-season decision reads, gathered once for two callers.
 *
 * The screen route needs it to answer the screen. The support snapshot needs the
 * *same* values, because a snapshot of a decision assembled from different reads
 * is a snapshot of a different decision — and the whole point of the file is
 * that an agent replaying it is holding the case the user was looking at.
 *
 * So the reads live here and the routes call them. `startSitInputs.ts` made the
 * same move for the same reason when a sixth endpoint needed the identical
 * player assembly: two copies of a gathering drift, and a player who is
 * Questionable on the Team screen and healthy in the file somebody sent in is
 * not a display bug, it is two different answers to one lineup question.
 *
 * Everything here is a read. No method fetches to refresh, none writes, and the
 * only provider call on any of these paths is the published-projection fallback,
 * which reads stored rows and never triggers ingestion.
 */

import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
import { PropsRepo } from '../repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { startSitInputsFor, buildStartSitContext } from './startSitInputs.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';
import { LeagueStrategyService } from './leagueStrategyService.ts';
import { ManagerIntelService } from './managerIntelService.ts';
import { dstPlanSourcesFrom, playoffContextFor } from './dstPlanService.ts';
import { boundedFreeAgentIds, FREE_AGENTS_PER_POSITION } from '../../core/roster/freeAgents.ts';
import { AdpRepo } from '../repos/adp.ts';
import { buildRosterShape, buildScoringProfile, startablePositions } from '../../core/sleeper/scoring.ts';
import { detectBestBall } from '../../core/sleeper/bestBall.ts';
import { isDraftComplete } from '../../core/season/lifecycle.ts';
import { resolveWeek } from '../../core/matchup/build.ts';
import { DEFENCE_POSITION } from '../../core/startsit/engine.ts';
import { DEFAULT_FINAL_WEEK } from '../../core/league/planning.ts';
import type { WaiverAssemblyRequest } from '../../core/waivers/assemble.ts';
import type { StartSitInput } from '../../core/startsit/engine.ts';
import type { StartSitMode } from '../../core/startsit/mode.ts';
import type { LeagueRecord, RosterRecord } from '../../core/sleeper/types.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import type { Database } from '../db.ts';

/** How old the betting market is, in the shape every screen already prints. */
export type PropsFreshness = { fetchedAt: string | null; provider: string | null; events: number };

export interface LeagueDecisionBase {
  league: LeagueRecord;
  rosters: RosterRecord[];
  mine: RosterRecord;
  shape: ReturnType<typeof buildRosterShape>;
  profile: ReturnType<typeof buildScoringProfile>;
  nflState: NflState | null;
  props: PropsFreshness;
}

/** Raised when there is no decision to make, with the sentence a screen prints. */
export class NoDecision extends Error {
  readonly status: number;

  constructor(message: string, status = 404) {
    super(message);
    this.name = 'NoDecision';
    this.status = status;
  }
}

async function leagueBase(db: Database, leagueId: string): Promise<LeagueDecisionBase> {
  const leagueRepo = new LeagueRepo(db);
  const league = await leagueRepo.getLeague(leagueId);
  if (!league) throw new NoDecision('league not found', 404);

  const rosters = await leagueRepo.listRosters(league.id);
  const mine = rosters.find((roster) => roster.isMine) ?? null;
  if (!mine) throw new NoDecision('Your team was not found in this league.', 409);

  const [props, nflState] = await Promise.all([
    new PropsRepo(db).freshness(),
    new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null),
  ]);

  return {
    league,
    rosters,
    mine,
    shape: buildRosterShape(league.rosterPositions),
    profile: buildScoringProfile(league.scoringSettings, league.rosterPositions),
    nflState,
    props,
  };
}

// ------------------------------------------------------------------- lineup

export interface LineupDecisionInputs extends LeagueDecisionBase {
  inputs: StartSitInput[];
  mode: StartSitMode;
  published: Map<string, number>;
  unknownPlayers: number;
}

export async function gatherLineupInputs(
  db: Database,
  sleeper: SleeperClient,
  leagueId: string,
  mode: StartSitMode,
): Promise<LineupDecisionInputs> {
  const base = await leagueBase(db, leagueId);
  const inputs = await startSitInputsFor(db, base.mine.playerIds, { mode });

  /*
   * Rotowire's published week, for the players this app could not price.
   *
   * The week comes through the same function the Matchup screen uses, and that
   * is the point: two screens that disagreed about which week it is would quote
   * two different published figures for the same player on the same afternoon.
   * Read from the database only — the fetch runs on the crons, so a lineup
   * request never waits on Sleeper for a fallback.
   *
   * Failure is swallowed to an empty map. This fills a column that was blank
   * before it existed, and a blank column is a state the screen already knows
   * how to say out loud; taking the lineup down for it would be absurd.
   */
  const positions = new Map(inputs.map((input) => [input.player.id, input.player.position ?? null]));
  const week = resolveWeek(null, base.nflState?.week ?? null, base.nflState?.seasonType ?? null);
  let published: Map<string, number>;
  try {
    published = await new SleeperProjectionService(db, sleeper).publishedFor({
      season: base.league.season,
      week,
      playerIds: base.mine.playerIds,
      profile: base.profile,
      positionOf: (id) => positions.get(id) ?? null,
    });
  } catch {
    published = new Map();
  }

  return {
    ...base,
    inputs,
    mode,
    published,
    unknownPlayers: base.mine.playerIds.length - inputs.length,
  };
}

// ------------------------------------------------------------------ waivers

export interface WaiverDecisionInputs extends LeagueDecisionBase {
  /** Everything `assembleWaiverPlan` takes, minus the clock. */
  request: Omit<WaiverAssemblyRequest, 'now' | 'generatedAt'>;
  pool: { scanned: number; perPosition: number };
  /** The FAAB summary the response envelope prints. Null in a priority league. */
  strategy: Awaited<ReturnType<LeagueStrategyService['context']>>;
  weeksRead: number | null;
  /** The whole player table, before any distillation. */
  players: Awaited<ReturnType<PlayerRepo['listAll']>>;
}

export async function gatherWaiverInputs(
  db: Database,
  sleeper: SleeperClient,
  leagueId: string,
): Promise<WaiverDecisionInputs> {
  const base = await leagueBase(db, leagueId);
  const { league, rosters, mine, shape, profile } = base;

  /*
   * Sleeper decides who is available, and it decides it for the whole league.
   *
   * Every player on every roster — mine, and the eleven managers I am playing
   * against — is off the table. This set is also handed to the engine, which
   * checks it again: it is the one mistake this feature must never make.
   */
  const rosteredIds = new Set<string>();
  for (const roster of rosters) for (const id of roster.playerIds) rosteredIds.add(id);

  const players = await new PlayerRepo(db).listAll();
  const candidateIds = await boundedFreeAgents(db, {
    rosteredIds,
    startable: startablePositions(shape),
    players,
  });

  /*
   * The slate, the defences and the fixture list, built once for both scans.
   *
   * Passing it guarantees the roster and the wire are read against the *same*
   * week — which includes which teams are at home, the input the defence
   * model's smallest residual has been waiting for.
   */
  const context = await buildStartSitContext(db);
  const week = base.nflState?.week ?? 1;

  const [rosterInputs, candidateInputs] = await Promise.all([
    startSitInputsFor(db, mine.playerIds, { context }),
    startSitInputsFor(db, candidateIds, { context }),
  ]);

  /*
   * What the ledger and the league's own transactions know.
   *
   * Both are reads of stored rows and never a fetch: the manager-history
   * backfill fills them on the daily clock, and a waiver board that triggered
   * ingestion would turn a page load into a walk of the previous-league chain.
   */
  const strategy = await new LeagueStrategyService(db, { sleeper })
    .context(league.id, { week, season: league.season })
    .catch(() => null);
  const history = await new ManagerIntelService(db)
    .waiverHistory({
      leagueId: league.id,
      rosters,
      week,
      finalWeek: strategy?.finalWeek ?? DEFAULT_FINAL_WEEK,
    })
    .catch(() => undefined);

  const draft = league.draftId ? await new LeagueRepo(db).getDraft(league.draftId).catch(() => null) : null;
  const format = detectBestBall({ leagueSettings: league.leagueSettings, draftSettings: draft?.settings ?? null });
  const playoffs = playoffContextFor({
    leagueSettings: league.leagueSettings,
    rosters,
    mine,
    totalRosters: league.totalRosters,
    currentWeek: week,
  });

  return {
    ...base,
    players,
    strategy,
    weeksRead: strategy?.bidHistory.weeksRead.length ?? null,
    pool: { scanned: candidateIds.length, perPosition: FREE_AGENTS_PER_POSITION },
    request: {
      shape,
      profile,
      rosterInputs,
      candidateInputs,
      rosteredIds,
      currentStarterIds: mine.starterIds,
      reserveIds: mine.reserveIds,
      rosters,
      players,
      week,
      season: league.season,
      strategy,
      budgets: strategy?.budget ?? null,
      prices: strategy?.prices ?? null,
      /*
       * The league's published bids, for the named-rival pass.
       *
       * Already gathered by the strategy context — the same `collectBids` output
       * the price summary was built from, not a second read, so the names and
       * the price cannot be looking at different weeks.
       */
      observations: strategy?.bidHistory.observations ?? [],
      history,
      /*
       * A league that starts no defence does not have its schedule read to be
       * told so — see `WaiverAssemblyRequest.dstSources`.
       */
      dstSources: (shape.starters[DEFENCE_POSITION] ?? 0) > 0 ? dstPlanSourcesFrom(db) : null,
      bestBall: format.confident && format.bestBall,
      /*
       * Post-draft is a fact about the draft, never about the calendar.
       *
       * A league whose draft has not finished has no weekly acquisition
       * pressure, whatever the date says — and a league that drafts in week 2 is
       * not behind, it is a league that drafts in week 2.
       */
      draftComplete: isDraftComplete(draft?.status ?? league.status ?? null),
      playoff: { weeks: playoffs.weeks, emphasis: playoffs.emphasis },
    },
  };
}

/**
 * The best few unrostered players at each position, from the database.
 *
 * The ordering itself is shared — see `core/roster/freeAgents.ts` — so the
 * waiver scan is bounded identically wherever it runs. What is left here is the
 * two reads it needs, and the caller's option to hand in a player list it has
 * already fetched.
 */
export async function boundedFreeAgents(
  db: Database,
  opts: { rosteredIds: Set<string>; startable: Set<string>; players?: CanonicalPlayer[] },
): Promise<string[]> {
  const adpRepo = new AdpRepo(db);
  const snapshot = await adpRepo.latestPlatformSnapshot();
  const ranks = snapshot ? await adpRepo.valuesByPlayer(snapshot.id) : new Map();
  const players = opts.players ?? (await new PlayerRepo(db).listAll());
  return boundedFreeAgentIds(players, { ...opts, ranks });
}
