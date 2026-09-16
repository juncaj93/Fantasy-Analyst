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
import { startSitInputsFor, buildStartSitContext, type StartSitContext } from './startSitInputs.ts';
import { opponentExposure, type OpponentExposure } from '../../core/startsit/correlation.ts';
import { MatchupRepo } from '../repos/matchup.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import type { SeasonMarketKey } from '../../core/vegas/types.ts';
import { evaluatePlayer } from '../../core/startsit/engine.ts';
import {
  BALANCED_BY_DEFAULT,
  suggestMode,
  type ModeSuggestion,
  type SidePlayer,
} from '../../core/startsit/modeSuggest.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';
import { LeagueStrategyService } from './leagueStrategyService.ts';
import { ManagerIntelService } from './managerIntelService.ts';
import { dstPlanSourcesFrom, playoffContextFor } from './dstPlanService.ts';
import { boundedFreeAgentIds, FREE_AGENTS_PER_POSITION } from '../../core/roster/freeAgents.ts';
import { AdpRepo } from '../repos/adp.ts';
import { PreseasonProjectionsRepo } from '../repos/preseasonProjections.ts';
import { projectionScoringFrom, scoringKey } from '../../core/startWho/scoring.ts';
import {
  buildRosterShape,
  buildScoringProfile,
  startablePositions,
  type ScoringProfile,
} from '../../core/sleeper/scoring.ts';
import { publishedRefusal } from '../../core/sleeper/weeklyProjections.ts';
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
  /** The posture the week calls for — {@link modeSuggestion}'s own answer. */
  mode: StartSitMode;
  /** Why that posture, in the suggestion's own words, for the screen to print. */
  modeSuggestion: ModeSuggestion;
  published: Map<string, number>;
  /** One sentence naming a position this league may not read a published total for. */
  publishedRefusal: string | null;
  unknownPlayers: number;
  /**
   * The games the opponent's starters are stacked in, for the Floor/Ceiling pass.
   *
   * Empty in Balanced weeks, on a bye, and before the Matchup screen has
   * written this week's pairing — all of which the optimiser reads as "no
   * opinion" rather than as an absence of correlation.
   */
  opponentExposure: ReadonlyMap<string, OpponentExposure>;
}

export async function gatherLineupInputs(
  db: Database,
  sleeper: SleeperClient,
  leagueId: string,
): Promise<LineupDecisionInputs> {
  const base = await leagueBase(db, leagueId);
  /*
   * Gathered without a mode, on purpose.
   *
   * The posture is no longer something the caller knows when it asks for these
   * — it is read off the week further down, from the margin against the
   * opponent. `startSitInputsFor` therefore leaves `mode` unset on each input,
   * and `assembleLineup`'s `i.mode ?? mode` picks up whatever is resolved.
   */
  /*
   * The slate, built here rather than inside the assembly, because two things
   * need it now. `startSitInputsFor` would build exactly this on its own — it
   * is passed in instead so the opponent-exposure read below shares it, which
   * makes the second consumer free rather than a second copy of the same
   * fixture and defence reads.
   */
  const context = await buildStartSitContext(db);
  const inputs = await startSitInputsFor(db, base.mine.playerIds, { context });

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

  /*
   * Who the reader is playing, from the row the Matchup screen already wrote.
   *
   * The pairing is Sleeper's and the honest way to get it is to ask Sleeper —
   * which is a request per Team load, on a screen that is opened many times a
   * week. `matchup_forecasts` already carries `opponent_roster_id` for this
   * league, season and week, on a row keyed exactly that way, so this is one
   * indexed lookup of one row and no request at all.
   *
   * It is null before the Matchup screen has been opened this week, and null
   * for a roster on a bye. Both end at Balanced with `auto: false`, which is
   * the honest answer: no opponent read, so no opinion about the matchup.
   */
  const forecast = await new MatchupRepo(db)
    .latest({ leagueId: base.league.id, season: base.league.season, week, rosterId: base.mine.rosterId })
    .catch(() => null);
  const opponent =
    forecast?.opponentRosterId == null
      ? null
      : (base.rosters.find((r) => r.rosterId === forecast.opponentRosterId) ?? null);

  /*
   * One published read covering both rosters, rather than one per side.
   *
   * `publishedFor` batches by id, so folding the opponent's players into the
   * same call is the difference between two queries and one — and the
   * opponent's half is the whole reason `suggestMode` can speak at all about a
   * roster this app does not buy lines for. See `core/startsit/modeSuggest.ts`.
   */
  const opponentIds = opponent?.playerIds ?? [];
  let published: Map<string, number>;
  try {
    published = await new SleeperProjectionService(db, sleeper).publishedFor({
      season: base.league.season,
      week,
      playerIds: [...base.mine.playerIds, ...opponentIds],
      profile: base.profile,
      positionOf: (id) => positions.get(id) ?? null,
    });
  } catch {
    published = new Map();
  }

  const modeSuggestion = suggestLineupMode({
    inputs,
    profile: base.profile,
    rosterPositions: base.league.rosterPositions,
    opponentIds,
    published,
  });

  return {
    ...base,
    inputs,
    mode: modeSuggestion.mode,
    modeSuggestion,
    published,
    publishedRefusal: publishedRefusalNote(base.profile, positions),
    unknownPlayers: base.mine.playerIds.length - inputs.length,
    opponentExposure: await gatherOpponentExposure(db, {
      mode: modeSuggestion.mode,
      starterIds: opponent?.starterIds ?? [],
      context,
    }),
  };
}

/**
 * Which games the opponent has stacked, for the one pass that can use it.
 *
 * `core/startsit/correlation.ts` has been built, bounded and tested since the
 * shape work and had no caller: the lineup's Floor/Ceiling pass reasoned about
 * this lineup's own concentration and knew nothing at all about the lineup it
 * is being played against. This is the read that closes that, and it is
 * deliberately the smallest one that can.
 *
 * ## What it costs, measured rather than assumed
 *
 * One `players` lookup by primary key over the opponent's starting slots —
 * nine ids in this league, one `IN (...)` against the table's own key. Nothing
 * else: the fixture list, the totals and the spreads all come off the
 * {@link StartSitContext} the caller has already built for its own roster, so
 * the schedule half is free.
 *
 * It is emphatically **not** `startSitInputsFor` over a second roster. That
 * would buy props, injuries, usage weeks and evidence for twelve more players,
 * which is the spend the owner declined on 9 September 2026 and the reason the
 * opponent's side of the Matchup screen is unpriced. Which *game* somebody is
 * in is a fact about the fixture list, and the fixture list is already open.
 *
 * ## And it is skipped whenever it could not be read
 *
 * Balanced takes no view on correlation — `assessCorrelation` says so itself —
 * so a Balanced week pays nothing at all rather than paying for a map that
 * would be multiplied by zero. Same for a roster on a bye, a week the Matchup
 * screen has not written a pairing for, and a failed read: all three end at an
 * empty map, which the optimiser reads as no opinion.
 */
export async function gatherOpponentExposure(
  db: Database,
  opts: { mode: StartSitMode; starterIds: readonly string[]; context: StartSitContext },
): Promise<ReadonlyMap<string, OpponentExposure>> {
  if (opts.mode === 'balanced' || opts.starterIds.length === 0) return new Map();

  const ids = opts.starterIds.filter((id) => id && id !== '0');
  if (ids.length === 0) return new Map();

  const players = await new PlayerRepo(db).listByIds([...ids]).catch(() => new Map<string, CanonicalPlayer>());
  if (players.size === 0) return new Map();

  /*
   * The same game key the lineup's own concentration count uses.
   *
   * Both teams, sorted, joined — see `lineup.ts`'s `gameKey`. Two spellings of
   * one game would make the exposure map and the lineup silently disagree
   * about which fixture anybody is in, which is the kind of defect that looks
   * like a weighting problem for a week.
   */
  const totals = new Map<string, number>();
  const participants = [];
  for (const id of ids) {
    const player = players.get(id);
    if (!player) continue;
    const team = (player.team ?? '').toUpperCase();
    const game = team ? opts.context.schedule.get(team) : undefined;
    const gameId = team && game?.opponent ? [team, game.opponent.toUpperCase()].sort().join('@') : null;
    if (gameId && game?.total != null) totals.set(gameId, game.total);
    participants.push({ playerId: id, name: player.fullName, gameId });
  }

  return opponentExposure(participants, totals);
}


/**
 * Which posture this week actually calls for, read rather than asked for.
 *
 * The Team screen used to carry a Balanced / Floor / Ceiling control and send
 * whichever the reader tapped. It is gone: the app is in a better position to
 * answer that than the person holding the phone, because the answer is a fact
 * about the margin — a substantial favourite wants his floor protected and a
 * substantial underdog needs upside, and neither of those is a preference.
 *
 * `suggestMode` owns the judgement and its circularity guard owns the inputs:
 * market expectation first, Rotowire's published week where there is no market,
 * and nothing that a Start/Sit score could travel through. Both sides are
 * evaluated mode-free here, which they are anyway — `expectation.points` is the
 * sportsbook's number under the league's scoring, computed before any weight in
 * `mode.ts` is applied.
 *
 * The opponent's side is projections only. This path has no live scores in it,
 * and that is a deliberate limit rather than an oversight: the reader's own
 * banked points would need a Sleeper request per Team load. The Matchup screen
 * makes that request for its own reasons and passes the live figures to the
 * same function — see `core/matchup/build.ts` — so the live reading exists,
 * on the screen that had already paid for it.
 */
function suggestLineupMode(opts: {
  inputs: StartSitInput[];
  profile: ScoringProfile;
  rosterPositions: readonly string[];
  opponentIds: readonly string[];
  published: ReadonlyMap<string, number>;
}): ModeSuggestion {
  if (opts.opponentIds.length === 0) {
    return {
      ...BALANCED_BY_DEFAULT,
      detail: 'Balanced — no opponent lineup is known for this week yet.',
    };
  }

  const mine: SidePlayer[] = opts.inputs.map((input) => {
    const evaluation = evaluatePlayer(input, opts.profile);
    return {
      playerId: input.player.id,
      position: evaluation.position ?? '',
      marketPoints: evaluation.expectation.points ?? null,
      publishedPoints: opts.published.get(input.player.id) ?? null,
      ruledOut: evaluation.ruledOut ?? false,
    };
  });

  /*
   * The opponent from the published week alone.
   *
   * There is no start/sit evaluation for his players — this request never
   * gathered them, and gathering a second roster's usage, injuries and props is
   * the spend the owner declined on 9 September 2026. What is here is free:
   * Rotowire's totals are already stored for every player in the NFL.
   */
  const opponent: SidePlayer[] = opts.opponentIds.map((playerId) => ({
    playerId,
    position: '',
    marketPoints: null,
    publishedPoints: opts.published.get(playerId) ?? null,
  }));

  return suggestMode({ mine, opponent, shape: buildRosterShape([...opts.rosterPositions]) });
}

/**
 * The positions this league may not read a published total for, said once.
 *
 * A league fact, not a player fact, which is why it becomes one note beside the
 * lineup rather than a mark on sixteen rows. In a league scoring six-point
 * passing touchdowns, every running back, receiver and tight end gets
 * Rotowire's number and the quarterback gets a dash — correctly, because that
 * total was computed under four-point passing touchdowns and would understate
 * him — and from the outside those two facts are one screen that looks
 * half-broken. Reported as exactly that on 2 September 2026: "projections show
 * for most players but not for QB Joe Burrow specifically."
 *
 * Composed here because this file is one of the few sanctioned to import the
 * published feed at all, and it hands `assembleLineup` a finished sentence. The
 * optimiser never sees the assumptions it was built from, which is the boundary
 * `tests/sleeperProjectionFallback.test.ts` exists to hold.
 *
 * Only positions actually on the roster are named. A rule about tight ends is
 * not worth a sentence to somebody who does not have one.
 */
function publishedRefusalNote(
  profile: ScoringProfile,
  positions: ReadonlyMap<string, string | null>,
): string | null {
  const distinct = [...new Set([...positions.values()].map((p) => (p ?? '').toUpperCase()).filter(Boolean))];
  const refused = distinct
    .map((position) => ({ position, reason: publishedRefusal(profile, position) }))
    .filter((r): r is { position: string; reason: string } => r.reason != null);
  if (refused.length === 0) return null;

  /*
   * One reason, when every refused position shares it — the ordinary case,
   * because a single non-default setting disqualifies a single position.
   * Otherwise the positions are named and the detail is left to Setup: three
   * explanations joined together is not a sentence anybody finishes.
   */
  const reasons = new Set(refused.map((r) => r.reason));
  const only = [...reasons][0];
  if (reasons.size === 1 && only) return `Published projections — ${only}`;
  return `Published projections are not quoted for ${refused
    .map((r) => r.position)
    .join(', ')} in this league: its scoring for those positions differs from what the published feed assumes.`;
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

  const [rosterInputs, candidateInputs, seasonMarkets, preseasonPoints] = await Promise.all([
    startSitInputsFor(db, mine.playerIds, { context }),
    startSitInputsFor(db, candidateIds, { context }),
    /*
     * The season market for the candidates, and only the candidates.
     *
     * The board is the one surface that draws a rest-of-season column, so this
     * is scoped to the ids it will actually draw. Swallowed to an empty map:
     * a deployment that has taken no season snapshot loses the column and
     * keeps the board, which is the same trade every other optional column on
     * this page already makes.
     */
    new SeasonMarketsRepo(db)
      .latestForPlayers(base.league.season, candidateIds)
      .catch(() => new Map<string, { market: SeasonMarketKey; line: number | null }[]>()),
    /*
     * This league's own preseason capture, for the roster and nobody else.
     *
     * It answers one question — what a bench player is worth to *hold* — and
     * only a player already on the roster can be dropped, so the wire is not
     * asked about. That scoping is the whole of the cost control: sixteen ids
     * through the covering index migration 0041 added, behind one indexed
     * lookup for the snapshot id.
     *
     * `latestId` rather than `latest`, for the reason its own doc comment
     * gives: `latest` is built on `list`, which counts every projection row in
     * the season to fill in an Admin screen's totals.
     *
     * Scoped by scoring key first, so a capture taken under other rules is
     * absent rather than converted — the same rule the matchup screen's third
     * projection tier keeps. Swallowed to an empty map, which restores the
     * previous valuation exactly rather than degrading it.
     */
    preseasonPointsFor(db, base.league.season, profile, mine.playerIds),
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
      preseasonPoints,
      currentStarterIds: mine.starterIds,
      reserveIds: mine.reserveIds,
      rosters,
      players,
      week,
      season: league.season,
      strategy,
      /* The same capture the pricing pass reads, handed over for surfacing too. */
      trending: strategy?.trending,
      /*
       * The season market for the candidates on the board, for the
       * rest-of-season column.
       *
       * One read over the ids already in hand, and only the candidates — the
       * board is the only thing that shows this, and widening it to the roster
       * would pay for rows nobody draws. Swallowed to an empty map on failure:
       * the column is additive, and a board without it is the board that
       * shipped yesterday. See `core/waivers/seasonOutlook.ts`.
       */
      seasonMarkets,
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

/**
 * This league's own preseason capture, for a named set of players.
 *
 * Two indexed statements and no table scan. `latestId` reads one row from the
 * covering index `idx_preseason_projection_lookup` and never opens the snapshot
 * table; `pointsForSnapshot` seeks `(snapshot_id, player_id, points)`, which
 * migration 0041 made covering for exactly this shape of question.
 *
 * Scoped by scoring key before anything else. A capture taken under other rules
 * is not a worse number for this reader, it is the wrong one at a plausible
 * size, and a league with no matching capture correctly gets nothing.
 *
 * Every failure is an empty map rather than an exception, because the caller's
 * fallback — the behaviour this app had before a durable value existed — is a
 * working answer and not a broken one.
 *
 * Exported for `waivers.preseasonReadCost.test.ts`, which asserts the statement
 * count and the scoping rather than the answer — an assertion about the map
 * would pass just as happily against a read of the whole capture.
 */
export async function preseasonPointsFor(
  db: Database,
  season: string,
  profile: ScoringProfile,
  playerIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (playerIds.length === 0) return new Map<string, number>();
  try {
    const repo = new PreseasonProjectionsRepo(db);
    const snapshotId = await repo.latestId(season, scoringKey(projectionScoringFrom(profile)));
    if (snapshotId == null) return new Map<string, number>();
    return await repo.pointsForSnapshot(snapshotId, [...playerIds]);
  } catch {
    return new Map<string, number>();
  }
}
