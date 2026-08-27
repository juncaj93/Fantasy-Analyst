/**
 * The demo's answer to every request the app makes.
 *
 * Read this as a routing table, not as a screen builder. Each entry does three
 * things and only three: pick the fixture data the endpoint needs, hand it to
 * the production engine that owns the question, and wrap the result in the same
 * envelope the server wraps it in.
 *
 * The engines are imported, never re-implemented:
 *
 *   - the draft board is `buildDraftBoard`, the same function the worker calls;
 *   - the lineup is `assembleLineup`, which is `recommendLineup` with the
 *     weekly intelligence pass and the projection fallback layered on it;
 *   - the wire, its prices, the defence beside it and the claim plan are
 *     `assembleWaiverPlan`, which is the same eight steps in the same order the
 *     deployed route runs;
 *   - the comparison is `compareStartSit`;
 *   - the trade board is `rankTrades` and `groupByVerdict`, and the bilateral
 *     offers are `assembleSmartTrades`;
 *   - the player list is ordered by `orderPlayers`;
 *   - the matchup is `buildMatchupResponse`, distributions and all;
 *   - the lifecycle is `resolveLifecycle` and `resolveSeasonPhase`.
 *
 * So a number on a demo screen is the same number the same code would print
 * against a live league in the same state. Nothing below writes a score, a
 * verdict, a bid or an explanation.
 */

import { buildDraftBoard } from '../../draft/boardBuilder.ts';
import { captureDraftSnapshot } from '../../support/draftSnapshot.ts';
/* The one player matcher, so Demo Mode searches exactly as the product does. */
import { rankByNormalized } from '../../search/players.ts';
import { buildMatchupResponse } from '../../matchup/build.ts';
import { myGuy } from '../../draft/decisions.ts';
import { TALLY_WEIGHT, orderPlayers } from '../../draft/playerOrder.ts';
import { buildLiveRoster } from '../../draft/liveRoster.ts';
/* The draft card's one sentence, and the need breakdown it reads. Same two
   functions the live roster route calls — see the note where it is used. */
import { bestMove } from '../../draft/bestMove.ts';
import { computeNeed } from '../../draft/need.ts';
import { compareStartSit } from '../../startsit/engine.ts';
import { recommendLineup } from '../../startsit/lineup.ts';
import { assembleLineup } from '../../startsit/assemble.ts';
import { assembleWaiverPlan } from '../../waivers/assemble.ts';
import { normalizeMode } from '../../startsit/mode.ts';
import { collectBids } from '../../faab/bids.ts';
import { demoManagerHistory } from './history.ts';
import { buildManagerDraftProfile, buildRoomProfile, type HistoricalPick } from '../../managers/draftProfile.ts';
import { LEDGER_WEEKS } from '../fixtures/ledger.ts';
import { playoffContextFor } from '../../league/planning.ts';
import { detectBestBall } from '../../sleeper/bestBall.ts';
import { evaluateBench } from '../../roster/bench.ts';
import { buildHeldPlayers } from '../../roster/held.ts';
import { FREE_AGENTS_PER_POSITION, boundedFreeAgentIds } from '../../roster/freeAgents.ts';
import { groupByVerdict, rankTrades } from '../../trades/engine.ts';
import { assembleSmartTrades } from '../../trades/assemble.ts';
import { positionMatchesFilter, resolveComparisonSlot } from '../../sleeper/eligibility.ts';
import {
  buildRosterShape,
  buildScoringProfile,
  leagueFitNotes,
  startablePositions,
} from '../../sleeper/scoring.ts';
import { resolveSeasonPhase } from '../../sleeper/phase.ts';
import { resolveLifecycle } from '../../season/lifecycle.ts';
import type { ScenarioData } from '../fixtures/index.ts';
import {
  draftBoardSourcesFrom,
  dstPlanSourcesFrom,
  matchupSourcesFrom,
  startSitInputsFrom,
  tradeCandidatesFrom,
} from './sources.ts';
import { buildDemoPlayerDetail, buildDemoRollover, buildDemoSetupStatus } from './setup.ts';

export interface DemoRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  params: URLSearchParams;
  body: unknown;
}

export interface DemoResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): DemoResponse => ({ status: 200, body });
const fail = (message: string, status = 400): DemoResponse => ({ status, body: { error: message } });

/** The pieces every league-shaped answer starts from. */
function leagueContext(data: ScenarioData) {
  const profile = buildScoringProfile(data.league.scoringSettings, data.league.rosterPositions);
  const shape = buildRosterShape(data.league.rosterPositions);
  const mine = data.rosters.find((r) => r.isMine) ?? null;
  const rosteredIds = new Set<string>();
  for (const roster of data.rosters) for (const id of roster.playerIds) rosteredIds.add(id);
  return { profile, shape, mine, rosteredIds };
}

/** How fresh the market is, in the shape every screen already prints. */
function freshness(data: ScenarioData) {
  return {
    fetchedAt: data.vegas.fetchedAt,
    provider: data.vegas.fetchedAt ? 'demo fixtures' : null,
    events: data.vegas.events,
  };
}

export async function handleDemoRequest(data: ScenarioData, request: DemoRequest): Promise<DemoResponse> {
  const { path, params } = request;

  // ------------------------------------------------------------- the shell
  if (path === '/api/health') return ok({ ok: true, service: 'fantasy-analyst', demo: data.scenario.id });

  if (path === '/api/auth/status') {
    /*
     * View only, and not because the passphrase is wrong.
     *
     * `canUnlock: false` is the honest answer in a demo: there is nothing to
     * unlock, because there is nothing a passphrase would let you change. It
     * also stops the draft screen starting its sync loop, which is the one
     * background writer in the app.
     */
    return ok({ unlocked: false, canUnlock: false });
  }

  if (path === '/api/overview') return ok(overview(data));
  if (path === '/api/leagues') return ok({ leagues: [leagueSummary(data)] });
  if (path === '/api/setup/status') return ok(buildDemoSetupStatus(data));
  if (path === '/api/diagnostics/rollover') return ok(buildDemoRollover(data));
  if (path === '/api/setup/newsletter') return ok(buildDemoSetupStatus(data).newsletter);
  if (path === '/api/newsletter/messages') return ok({ messages: [] });
  if (path === '/api/adp/snapshots') {
    return ok({ snapshots: data.adpSnapshot ? [{ ...data.adpSnapshot, source: 'demo fixtures' }] : [] });
  }
  if (path === '/api/repair') return ok(repairStatus(data));
  if (path === '/api/review/queue') return ok({ evidence: [], identity: [] });
  if (path === '/api/review/applied') return ok({ evidence: [] });

  // -------------------------------------------------------------- the draft
  const board = /^\/api\/drafts\/([^/]+)\/board$/.exec(path);
  if (board) {
    if (!data.draft) return fail('no draft in this scenario', 404);
    /*
     * Offline is modelled as the request failing, because that is what offline
     * is. The screen then does what it does in a tunnel: reads the board it
     * cached before the signal went and says, in the loudest tone it has, how
     * old it is. Demo Mode seeds that cache on entry — see `runtime/index.ts`.
     */
    if (data.freshness.sleeper === 'unavailable') {
      return fail('network request failed', 503);
    }
    return ok(
      await buildDraftBoard(draftBoardSourcesFrom(data), decodeURIComponent(board[1]!), {
        limit: Number(params.get('limit') ?? 40) || 40,
        position: params.get('position'),
        queuedOnly: params.get('queued') === '1',
      }),
    );
  }

  /*
   * A support snapshot of the rehearsed board.
   *
   * Served here for the same reason every other route is: there is one capture,
   * and it reads a `DraftBoardSources`. A demo satisfies that interface from
   * fixtures, so the file a scenario produces is the file the live app produces
   * — same schema, same redaction, same replay — and somebody learning the
   * support workflow can run it end to end without a live draft.
   *
   * `gitSha` is `demo` rather than the deployment's revision, and deliberately
   * so: a snapshot of a rehearsal must never be mistakable for a snapshot of
   * production, and a fixture built from one must not claim a revision it does
   * not describe.
   */
  const snapshot = /^\/api\/drafts\/([^/]+)\/support-snapshot$/.exec(path);
  if (snapshot) {
    if (!data.draft) return fail('no draft in this scenario', 404);
    if (data.freshness.sleeper === 'unavailable') return fail('network request failed', 503);
    return ok(
      await captureDraftSnapshot(draftBoardSourcesFrom(data), {
        draftId: decodeURIComponent(snapshot[1]!),
        gitSha: 'demo',
        position: params.get('position'),
        queuedOnly: params.get('queued') === '1',
      }),
    );
  }

  // --------------------------------------------------------------- a league
  /*
   * The matchup, through `buildMatchupResponse` — the same assembly the server
   * calls, over sources this scenario fills. Separate from the block below only
   * because it is the one league read that is asynchronous.
   */
  const matchup = /^\/api\/leagues\/([^/]+)\/matchup$/.exec(path);
  if (matchup) {
    const leagueId = decodeURIComponent(matchup[1]!);
    if (leagueId !== data.league.id) return fail('league not found', 404);
    const week = params.get('week');
    return ok(
      await buildMatchupResponse(matchupSourcesFrom(data), leagueId, {
        week: week == null ? null : Number(week),
      }),
    );
  }

  const league = /^\/api\/leagues\/([^/]+)\/(roster|lineup|waivers|bench|managers)$/.exec(path);
  if (league) {
    const leagueId = decodeURIComponent(league[1]!);
    if (leagueId !== data.league.id) return fail('league not found', 404);
    switch (league[2]) {
      case 'roster':
        return ok(roster(data));
      case 'lineup':
        return ok(lineup(data, normalizeMode(params.get('mode'))));
      case 'waivers':
        return ok(await waivers(data));
      case 'bench':
        return ok(bench(data));
      case 'managers':
        return ok(managers(data));
    }
  }

  // --------------------------------------------------------------- players
  if (path === '/api/players') return ok(playerList(data, params));

  const detail = /^\/api\/players\/([^/]+)\/detail$/.exec(path);
  if (detail) {
    const built = buildDemoPlayerDetail(data, decodeURIComponent(detail[1]!));
    return built ? ok(built) : fail('player not found', 404);
  }

  const file = /^\/api\/players\/([^/]+)$/.exec(path);
  if (file) return playerFile(data, decodeURIComponent(file[1]!));

  // -------------------------------------------------------------- decisions
  if (path === '/api/trades') return ok(trades(data, Number(params.get('limit') ?? 60) || 60));
  if (path === '/api/trades/smart') return ok(smartTrades(data, Number(params.get('limit') ?? 5) || 5));
  if (path === '/api/startsit/compare') return compare(data, request.body);

  return fail(`Demo Mode has no fixture for ${path}`, 404);
}

// ------------------------------------------------------------------ pieces

function overview(data: ScenarioData) {
  const lifecycleInput = {
    state: data.nflState,
    league: { season: data.league.season, status: data.league.status ?? null },
    draft: data.draft ? { status: data.draft.status } : null,
  };
  return {
    players: data.players.length,
    leagues: 1,
    selectedLeague: { id: data.league.id, name: data.league.name, season: data.league.season },
    /*
     * Nothing is waiting in Review, in every scenario, and it is meant to be
     * nothing.
     *
     * Demo Mode ships no review fixtures — the queue below answers both of its
     * reads with an empty list — so these two counts are the only honest
     * numbers to publish. `pendingIdentity` used to be the count of unresolved
     * *aliases*, which is a different ledger belonging to Help my scores, and
     * borrowing it here made a scenario say "2 items need attention" above a
     * queue with nothing in it. That mattered less when the number was a badge
     * on a destination and matters a great deal now that it is a sentence on a
     * settings row leading to the queue itself.
     *
     * The unresolved names are still demonstrated, in the place they are
     * actually about: `/api/repair`, and the Help my scores row it feeds.
     */
    pendingEvidence: 0,
    pendingIdentity: 0,
    vegas: {
      ...freshness(data),
      provider: 'demo fixtures',
      configured: data.freshness.vegas !== 'unavailable',
    },
    adpSnapshot: data.adpSnapshot
      ? {
          id: data.adpSnapshot.id,
          label: data.adpSnapshot.label,
          capturedAt: data.adpSnapshot.capturedAt,
          matchedCount: data.adpSnapshot.matchedCount,
        }
      : null,
    season: resolveSeasonPhase(lifecycleInput),
    lifecycle: resolveLifecycle(lifecycleInput),
  };
}

function leagueSummary(data: ScenarioData) {
  const { profile, shape } = leagueContext(data);
  return {
    id: data.league.id,
    name: data.league.name,
    season: data.league.season,
    teams: data.league.totalRosters,
    isSelected: true,
    scoringLabel: profile.label,
    notes: leagueFitNotes(profile, shape),
    rosterPositions: data.league.rosterPositions,
    draftId: data.draft?.id ?? null,
  };
}

function roster(data: ScenarioData) {
  const { profile, shape, mine } = leagueContext(data);
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const signals = data.signals;

  const hydrate = (ids: string[]) =>
    ids.map((id) => {
      const p = byId.get(id);
      const signal = signals.get(id) ?? null;
      return {
        playerId: id,
        name: p?.fullName ?? id,
        position: p?.position ?? '',
        team: p?.team ?? '',
        status: p?.status ?? null,
        newsNet: signal?.raw.net ?? 0,
        recentNet: signal?.last30.net ?? 0,
        pending: signal?.pendingCount ?? 0,
      };
    });

  const live = buildLiveRoster({
    picks: data.picks,
    rosterId: mine?.rosterId ?? null,
    ownerId: mine?.ownerId ?? null,
    sleeperPlayerIds: mine?.playerIds ?? [],
    byId,
    shape,
    draftStatus: data.draft?.status ?? 'complete',
  });

  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label, notes: leagueFitNotes(profile, shape) },
    rosterShape: shape,
    starters: hydrate(mine?.starterIds ?? []),
    bench: hydrate((mine?.playerIds ?? []).filter((id) => !(mine?.starterIds ?? []).includes(id))),
    live: live.live,
    drafted: hydrate(live.players.map((p) => p.playerId)).map((p, i) => ({
      ...p,
      pickNo: live.players[i]!.pickNo,
    })),
    counts: live.counts,
    filled: live.filled,
    remaining: live.remaining,
    openStarters: live.openStarters,
    picksMade: live.picksMade,
    /*
     * The one line of advice the draft card carries — the same call the live
     * route makes, on this scenario's own roster shape.
     *
     * It was missing here, and the omission was invisible for as long as the
     * card had other things on it: Demo Mode drew a `Live draft` dot, the pick
     * counts and the coverage sentence, and simply never reached the sentence
     * underneath. Trimming the card to the advice alone is what surfaced it —
     * a demo draft had no card at all.
     *
     * That is a demo defect rather than a product one. Demo Mode's whole
     * contract is that it drives the production screens with fixture data, so a
     * response missing a field the real one sends is a scenario the reader
     * cannot see the product through. Same import, same derivation from
     * `computeNeed` and the league's own starting slots — see
     * core/draft/bestMove.ts — so a Best Ball scenario, a redraft scenario and
     * a league with two flexes each get the sentence their own shape produces.
     */
    bestMove: bestMove(computeNeed(shape, live.counts)),
    found: !!mine,
  };
}

function lineup(data: ScenarioData, mode: ReturnType<typeof normalizeMode>) {
  const { profile, shape, mine } = leagueContext(data);
  if (!mine || mine.playerIds.length === 0) {
    return {
      league: { id: data.league.id, name: data.league.name },
      found: false,
      error: 'Your team was not found in this league.',
    };
  }
  const inputs = startSitInputsFrom(data, mine.playerIds, { mode });

  /*
   * The whole decision, through the one function the live handler calls.
   *
   * `assembleLineup` is the optimiser, the weekly intelligence pass and the
   * projection fallback layered in `core` — so the card a demo shows is the
   * card the app shows, and neither can grow a step the other lacks. It used
   * to be spelled out here and again in `app.ts`, which is exactly the pair of
   * copies `core/startsit/assemble.ts` exists to collapse.
   *
   * No published map: a scenario has no Rotowire fallback, and the projection
   * pass then reports the market's own number or nothing, which is what a
   * fixture league genuinely has.
   */
  const decision = assembleLineup({
    inputs,
    shape,
    profile,
    currentStarterIds: mine.starterIds,
    mode,
    now: data.clock.now(),
  });

  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    found: true,
    dataFreshness: freshness(data),
    ...decision,
    notes: [...decision.notes, ...data.notes],
  };
}

/**
 * Smart Bilateral Trades, run through the real engine on fixture rosters.
 *
 * Not a canned payload. The scenario's own rosters go through the same
 * `assembleSmartTrades` the deployed service calls — the capability gate, the
 * roster views, the partner list, the search and the empty answers — so a demo
 * shows what the app would actually say about these teams, and a change that
 * breaks the engine breaks the demo.
 *
 * The behavioural half comes from the scenario's own ledger, which is what the
 * live service reads from D1. Two of the room's managers have a usable profile
 * and the rest do not, which is the honest and common case: `managerFit`
 * contributes nothing for a manager it cannot describe, and the bilateral
 * reasoning stands on its own.
 */
function smartTrades(data: ScenarioData, limit: number) {
  const { profile, shape } = leagueContext(data);
  const history = demoManagerHistory(data);

  /*
   * Observed seasons, per manager, keyed by every owner in the room.
   *
   * Not by the managers who have a trade *profile*, which is a different and
   * much smaller set: the live service derives this from the ledger's roster
   * identities, so a manager who has been in the league for two read seasons
   * and never traded is measured with zero trades — not unknown. Keying it off
   * the profiles would call most of the room unknown and quietly demonstrate
   * the wrong branch of `activityClassFor`.
   *
   * The scenario's ledger covers every roster over the same seasons, so the
   * per-manager answer is the league-wide one here.
   */
  const seasonsByUser = new Map(
    data.rosters
      .map((roster) => roster.ownerId)
      .filter((userId): userId is string => !!userId)
      .map((userId) => [userId, { observed: history.seasons.length, complete: history.seasons.length > 0 }]),
  );

  const decision = assembleSmartTrades({
    leagueSettings: data.league.leagueSettings,
    shape,
    profile,
    rosters: data.rosters.map((r) => ({
      rosterId: r.rosterId,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      playerIds: r.playerIds,
      isMine: r.isMine,
    })),
    inputs: startSitInputsFrom(data, [...new Set(data.rosters.flatMap((r) => r.playerIds))]),
    history: {
      measured: true,
      tendencies: history.tradeTendencies,
      seasonsByUser,
      seasonsComplete: history.seasons,
      profiles: [...history.tradeTendencies.values()].filter((t) => t.usable).length,
      complete: history.seasons.length > 0,
      leagueRate: history.tradeBaseline?.tradesPerManagerSeason ?? null,
    },
    limit,
  });

  const { rejections: _rejections, ...board } = decision;
  return {
    league: { id: data.league.id, name: data.league.name },
    ...board,
    notes: [...board.notes, ...data.notes],
  };
}

/** The bounded wire, ordered exactly as the live scan orders it. */
function candidateIdsFor(data: ScenarioData): string[] {
  const { shape, rosteredIds } = leagueContext(data);
  return boundedFreeAgentIds(data.players, {
    rosteredIds,
    startable: startablePositions(shape),
    ranks: data.adpValues,
  });
}

async function waivers(data: ScenarioData) {
  const { profile, shape, mine, rosteredIds } = leagueContext(data);
  if (!mine || mine.playerIds.length === 0) {
    return {
      league: { id: data.league.id, name: data.league.name },
      found: false,
      upgrades: [],
      headline: null,
      notes: data.notes,
      considered: 0,
    };
  }

  const candidateIds = candidateIdsFor(data);
  const rosterInputs = startSitInputsFrom(data, mine.playerIds);
  const candidateInputs = startSitInputsFrom(data, candidateIds);

  /*
   * The same three suppliers the live handler passes, from the same ledger.
   *
   * `observations` is every bid the league has published — which is what turns
   * "somebody else needs a tight end" into a named rival with a price on him —
   * and `history` is what the manager-intelligence pass concluded about the
   * people holding those rosters. Both are absent in a scenario with no ledger,
   * and the columns then report exactly what they report for a league nobody
   * has backfilled: not known.
   */
  const strategy = data.strategy;
  const history = demoManagerHistory(data);
  const bidHistory = collectBids(data.transactions, LEDGER_WEEKS);
  const playoff = playoffContextFor({
    leagueSettings: data.league.leagueSettings,
    rosters: data.rosters,
    mine,
    totalRosters: data.league.totalRosters,
    currentWeek: data.nflState?.week ?? 1,
  });

  /*
   * The whole decision, through the one function the live handler calls.
   *
   * This used to be the live route's pipeline written out a second time, with a
   * comment saying it mirrored `app.ts` line for line. It did — and a pipeline
   * that is correct because two files agree is one careless edit from two
   * different waiver boards in one app. See `core/waivers/assemble.ts`.
   *
   * The clock is the scenario's rather than the device's, which is the whole
   * reason Demo Mode can be on a Tuesday, and it is what makes a demo plan
   * reproducible.
   */
  const decision = await assembleWaiverPlan({
    shape,
    profile,
    rosterInputs,
    candidateInputs,
    rosteredIds,
    currentStarterIds: mine.starterIds,
    reserveIds: mine.reserveIds,
    rosters: data.rosters,
    players: data.players,
    week: data.nflState?.week ?? 1,
    season: data.league.season,
    strategy: strategy ?? null,
    budgets: strategy?.budget ?? null,
    prices: strategy?.prices ?? null,
    observations: bidHistory.observations,
    history: history.transactionBaseline
      ? {
          profiles: history.profilesByRoster,
          baseline: history.transactionBaseline,
          week: data.nflState?.week ?? 1,
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
    now: data.clock.now(),
    generatedAt: data.clock.iso(),
  });

  const { lineup: _lineup, bids, ...board } = decision;
  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    found: true,
    dataFreshness: freshness(data),
    ...board,
    notes: [...board.notes, ...data.notes],
    pool: { scanned: candidateIds.length, perPosition: FREE_AGENTS_PER_POSITION },
    faab: strategy
      ? {
          rule: strategy.budget.rule,
          mine: strategy.budget.rosters.find((r) => r.isMine) ?? null,
          rosters: strategy.budget.rosters,
          prices: strategy.prices,
          losingBids: strategy.losingBids,
          bids,
          notes: [...strategy.budget.notes, ...strategy.notes],
          trendingCapturedAt: strategy.trendingCapturedAt,
        }
      : null,
  };
}

function bench(data: ScenarioData) {
  const { profile, shape, mine } = leagueContext(data);
  if (!mine || mine.playerIds.length === 0) return { found: false, dropCandidates: [], ranked: [], notes: [] };

  const rosterInputs = startSitInputsFrom(data, mine.playerIds);
  const candidateInputs = startSitInputsFrom(data, candidateIdsFor(data));
  const currentLineup = recommendLineup(rosterInputs, shape, profile, { currentStarterIds: mine.starterIds });

  return {
    found: true,
    league: { id: data.league.id, name: data.league.name },
    ...evaluateBench(
      buildHeldPlayers({
        rosterInputs,
        candidateInputs,
        lineup: currentLineup,
        profile,
        reserveIds: mine.reserveIds,
      }),
    ),
  };
}

function managers(data: ScenarioData) {
  /*
   * What the ledger knows, and nothing beyond it.
   *
   * This used to answer `null` to everything, on the ground that a tendency
   * needs a sample and Demo Mode had no history to walk. It has one now — see
   * `fixtures/ledger.ts` — so the honest answer changed: the same engines the
   * nightly backfill runs have read the season's transactions and the demo's
   * own draft, and this reports what they concluded.
   *
   * What is still null is still null. `trade` and `draft` here are the
   * *roster-keyed cached profiles* the live app writes during a backfill, and a
   * demo runs no backfill and stores nothing; the draft reading is served from
   * `draftTendencies`, which is derived on the spot from the picks. A scenario
   * with no ledger at all — a draft, an offseason, the league that has never
   * published a bid — gets nulls throughout, which is exactly what the live app
   * returns for a league nobody has run the pass for.
   */
  const history = demoManagerHistory(data);
  const room = history.draftTendencies.size > 0 ? buildRoomProfile(historicalPicks(data)) : null;

  return {
    league: { id: data.league.id, name: data.league.name },
    room,
    baseline: history.transactionBaseline,
    managers: data.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      ownerName: roster.ownerName,
      isMine: roster.isMine,
      trade: null,
      draft:
        history.draftTendencies.size === 0
          ? null
          : buildManagerDraftProfile({
              rosterId: roster.rosterId,
              userId: roster.ownerId,
              ownerName: roster.ownerName,
              picks: historicalPicks(data),
            }),
      tradeTendencies: (roster.ownerId ? history.tradeTendencies.get(roster.ownerId) : null) ?? null,
      transactions: history.profilesByRoster.get(roster.rosterId) ?? null,
    })),
  };
}

/** The scenario's own draft, in the shape the draft-profile readers want. */
function historicalPicks(data: ScenarioData): HistoricalPick[] {
  const byId = new Map(data.players.map((p) => [p.id, p.position ?? null]));
  return data.picks
    .filter((pick) => pick.playerId != null)
    .map((pick) => ({
      season: data.league.season,
      draftId: pick.draftId,
      pickNo: pick.pickNo,
      round: pick.round,
      userId: pick.rosterId == null ? null : `owner-${pick.rosterId}`,
      rosterId: pick.rosterId ?? null,
      position: byId.get(pick.playerId!) ?? null,
      marketRank: null,
      yearsExp: null,
    }));
}

function playerList(data: ScenarioData, params: URLSearchParams) {
  const q = (params.get('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 100) || 100, 1), 200);
  const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);
  const position = params.get('position');
  const availabilityLeagueId = params.get('leagueId');

  /*
   * The same matcher the live handler ranks with, for the same reason.
   *
   * This was a lowercase `includes`, which meant Demo Mode answered `Amon Ra`
   * and `Ja'Marr` differently from the product it exists to demonstrate — and a
   * demo that behaves unlike the thing it is demonstrating is worse than no
   * demo. Ranking off `normalizedName` rather than the display name, exactly as
   * the server does, so the two cannot drift.
   *
   * No recall step here: the scenario's whole player list is already in memory,
   * so there is nothing to narrow before ranking.
   */
  const active = data.players.filter((p) => p.active);
  const pool = q ? rankByNormalized(active, q, (p) => p.normalizedName) : active;
  const filtered = position ? pool.filter((p) => positionMatchesFilter(p.position, position)) : pool;

  const availability = new Map<string, 'mine' | 'rostered' | 'available'>();
  if (availabilityLeagueId) {
    for (const roster of data.rosters) {
      for (const id of roster.playerIds) availability.set(id, roster.isMine ? 'mine' : 'rostered');
    }
  }

  /*
   * The shortlist grows with the offset, exactly as the live handler's does.
   *
   * The tally nudge is applied after the market sort, so a player can move a
   * few places and the window has to be wider than the page for that movement
   * to be real rather than clipped — and it has to keep being wider on page
   * five, or a demo would show a differently-ordered tail from the live app.
   */
  const shortlist = [...filtered]
    .sort(
      (a, b) =>
        (data.adpValues.get(a.id)?.adp ?? Infinity) - (data.adpValues.get(b.id)?.adp ?? Infinity) ||
        (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity),
    )
    .slice(0, offset + Math.max(limit * 3, 120));

  const ordered = orderPlayers(
    shortlist.map((p) => ({
      id: p.id,
      name: p.fullName,
      draftRank: data.adpValues.get(p.id)?.adp ?? null,
      net: data.signals.get(p.id)?.raw.net ?? 0,
      player: p,
    })),
  );
  const page = ordered.slice(offset, offset + limit);

  return {
    tallyWeight: TALLY_WEIGHT,
    rankingSource: data.adpSnapshot?.label ?? null,
    offset,
    hasMore: filtered.length > offset + page.length,
    total: filtered.length,
    players: page.map(({ player: row, draftRank, adjustedRank, movement }) => ({
      id: row.player.id,
      name: row.player.fullName,
      position: row.player.position,
      team: row.player.team,
      status: row.player.status,
      draftRank,
      adjustedRank,
      movement,
      signal: data.signals.get(row.player.id) ?? null,
      myGuy: myGuy(data.flags.get(row.player.id)?.level ?? 0),
      ...(availabilityLeagueId
        ? { availability: availability.get(row.player.id) ?? ('available' as const) }
        : {}),
    })),
  };
}

function playerFile(data: ScenarioData, playerId: string): DemoResponse {
  const player = data.players.find((p) => p.id === playerId);
  if (!player) return fail('player not found', 404);
  const flag = data.flags.get(playerId) ?? { level: 0 as const };
  return ok({
    player: {
      id: player.id,
      name: player.fullName,
      position: player.position,
      team: player.team,
      status: player.status,
      aliases: player.aliases,
    },
    signal: data.signals.get(playerId) ?? null,
    /*
     * No excerpts.
     *
     * The evidence ledger holds copyrighted newsletter text, and inventing
     * plausible-looking excerpts would be putting words in a publisher's mouth
     * on a screen whose whole premise is that every original excerpt is
     * preserved verbatim. The tally is real, computed from the same windows the
     * ledger produces; the timeline says there is nothing to show.
     */
    evidence: [],
    props: [],
    // No `queued`: a queue belongs to a draft and a player file is not in one.
    // The live route dropped the field for the same reason — see `app.ts`.
    myGuy: myGuy(flag.level),
  });
}

function trades(data: ScenarioData, limit: number) {
  const candidates = tradeCandidatesFrom(data);
  const ranked = rankTrades(candidates).slice(0, limit);
  return {
    league: { id: data.league.id, name: data.league.name },
    sections: groupByVerdict(ranked),
    suggestions: ranked,
    considered: candidates.length,
    warnings: data.notes,
  };
}

const MAX_COMPARE = 4;

function compare(data: ScenarioData, body: unknown): DemoResponse {
  const input = (body ?? {}) as { playerIds?: string[]; slot?: string | null; mode?: string | null };
  const requested = input.playerIds ?? [];
  if (requested.length < 2) return fail('at least two playerIds required');
  if (new Set(requested).size !== requested.length) return fail('the same player was sent twice');
  if (requested.length > MAX_COMPARE) return fail(`at most ${MAX_COMPARE} players can be compared at once`);

  const { profile, shape } = leagueContext(data);
  const mode = normalizeMode(input.mode ?? null);
  const inputs = startSitInputsFrom(data, requested, { mode });
  if (inputs.length !== requested.length) return fail('player not found', 404);

  const slot = resolveComparisonSlot(inputs.map((i) => i.player.position), shape, input.slot ?? null);
  return ok({
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    dataFreshness: freshness(data),
    slot,
    ...compareStartSit(inputs, profile, { mode }),
  });
}

function repairStatus(data: ScenarioData) {
  return {
    groups: [],
    suspicions: [],
    summary: {
      names: data.repair.summary.names,
      items: data.repair.summary.names * 2,
      net: data.repair.summary.net,
      headline: data.repair.summary.headline,
    },
  };
}
