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
 *   - the lineup is `recommendLineup`;
 *   - the wire is `recommendWaiverUpgrades`, priced by `priceWaiverUpgrades` and
 *     layered with `waiverMultiWeekFor` and `waiverLeagueIntel`;
 *   - the lineup's advanced pass is `weeklyIntelligence`;
 *   - the comparison is `compareStartSit`;
 *   - the trade board is `rankTrades` and `groupByVerdict`;
 *   - the player list is ordered by `orderPlayers`;
 *   - the matchup is `buildMatchupResponse`, distributions and all;
 *   - the lifecycle is `resolveLifecycle` and `resolveSeasonPhase`.
 *
 * So a number on a demo screen is the same number the same code would print
 * against a live league in the same state. Nothing below writes a score, a
 * verdict, a bid or an explanation.
 */

import { buildDraftBoard } from '../../draft/boardBuilder.ts';
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
import { waiverMultiWeekFor, weeklyIntelligence } from '../../contracts/integration.ts';
import { normalizeMode } from '../../startsit/mode.ts';
import { recommendWaiverUpgrades } from '../../startsit/waivers.ts';
import { priceWaiverUpgrades } from '../../waivers/pricing.ts';
import { waiverLeagueIntel, withCompetition } from '../../waivers/intel.ts';
import { evaluateBench } from '../../roster/bench.ts';
import { buildHeldPlayers } from '../../roster/held.ts';
import { FREE_AGENTS_PER_POSITION, boundedFreeAgentIds } from '../../roster/freeAgents.ts';
import { groupByVerdict, rankTrades } from '../../trades/engine.ts';
import { TRADE_BOUNDS, findBilateralTrades } from '../../trades/bilateral.ts';
import { buildRosterViews } from '../../trades/rosterUtility.ts';
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
        return ok(waivers(data));
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
    pendingEvidence: 0,
    pendingIdentity: data.repair.summary.names,
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
  const recommendation = recommendLineup(inputs, shape, profile, {
    currentStarterIds: mine.starterIds,
    mode,
  });

  /*
   * The advanced pass, layered exactly as the live handler layers it.
   *
   * `weeklyIntelligence` is one call producing the expected-points read, the
   * contingency plans, the fragility and the rest, and it is applied to the
   * same three evaluation lists. Calling it here rather than reproducing any
   * of it is the whole point: the weekly card a demo shows is the weekly card
   * the app shows.
   */
  const intelligence = weeklyIntelligence({ lineup: recommendation, inputs, profile, mode });
  const withIntelligence = <T extends { playerId: string }>(evaluations: T[]): T[] =>
    evaluations.map((evaluation) => {
      const extra = intelligence.get(evaluation.playerId);
      return extra ? { ...evaluation, ...extra } : evaluation;
    });

  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    found: true,
    dataFreshness: freshness(data),
    rosterShape: shape,
    ...recommendation,
    starters: withIntelligence(recommendation.starters),
    bench: withIntelligence(recommendation.bench),
    undecidable: withIntelligence(recommendation.undecidable),
    notes: [...recommendation.notes, ...data.notes],
  };
}

/**
 * Smart Bilateral Trades, run through the real engine on fixture rosters.
 *
 * Not a canned payload. The scenario's own rosters go through the same
 * `buildRosterViews` and `findBilateralTrades` the deployed service uses, so a
 * demo shows what the app would actually say about these teams — and a change
 * that breaks the engine breaks the demo, which is the point of building it this
 * way rather than storing an answer.
 *
 * Manager history is deliberately absent. A fixture league has no ingested
 * ledger, so every partner reads as `unknown` and contributes exactly zero —
 * which is also the correct demonstration of §18's last empty state: the
 * bilateral reasoning stands on its own.
 */
function smartTrades(data: ScenarioData, limit: number) {
  const { profile, shape, mine } = leagueContext(data);
  const league = { id: data.league.id, name: data.league.name };
  const emptyBoard = (notes: string[]) => ({
    league,
    found: false,
    offers: [],
    search: { partners: 0, generated: 0, scored: 0, viable: 0, surfaced: 0, bounds: TRADE_BOUNDS },
    history: { profiles: 0, seasonsComplete: [], complete: false, leagueRate: null },
    notes,
    warnings: [],
  });

  if (!mine || mine.playerIds.length === 0) {
    return emptyBoard(['Your team was not found in this league.']);
  }
  const others = data.rosters.filter((r) => !r.isMine && r.playerIds.length > 0);
  if (others.length === 0) return emptyBoard(['No other roster in this league has any players.']);

  const everyId = [...new Set(data.rosters.flatMap((r) => r.playerIds))];
  const pool = new Map(startSitInputsFrom(data, everyId).map((i) => [i.player.id, i]));
  const views = buildRosterViews({
    rosters: data.rosters.map((r) => ({ key: String(r.rosterId), playerIds: r.playerIds })),
    pool,
    shape,
    profile,
  });

  const me = views.get(String(mine.rosterId));
  if (!me) return emptyBoard(['Your roster could not be evaluated.']);

  const report = findBilateralTrades({
    me,
    partners: others.flatMap((roster) => {
      const view = views.get(String(roster.rosterId));
      return view
        ? [
            {
              view,
              partner: {
                key: String(roster.rosterId),
                rosterId: roster.rosterId,
                displayName: roster.ownerName ?? `Roster ${roster.rosterId}`,
                userId: roster.ownerId,
              },
              fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
            },
          ]
        : [];
    }),
    bounds: { offersTotal: Math.max(1, Math.min(limit, 20)) },
  });

  return {
    league,
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
    history: { profiles: 0, seasonsComplete: [], complete: false, leagueRate: null },
    notes: [...report.notes, ...data.notes],
    warnings: [],
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

function waivers(data: ScenarioData) {
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

  const currentLineup = recommendLineup(rosterInputs, shape, profile, { currentStarterIds: mine.starterIds });
  const advice = recommendWaiverUpgrades({
    roster: rosterInputs,
    candidates: candidateInputs,
    shape,
    profile,
    rosteredPlayerIds: rosteredIds,
    currentStarterIds: mine.starterIds,
    lineup: currentLineup,
  });

  /*
   * The two league-intelligence passes the live handler layers on top, in the
   * same order and from the same suppliers.
   *
   * `multiWeek` says what the add is worth past this Sunday; `competition` says
   * who else needs him and can pay. Both are scoped to the players who actually
   * made the board, both fold onto rows the waiver engine already built, and
   * neither reorders anything — exactly as in `app.ts`. The competition count
   * also feeds the price model, which is why it is computed before the bids.
   */
  const boardIds = advice.upgrades.flatMap((upgrade) => upgrade.candidates.map((c) => c.playerId));
  const multiWeek = waiverMultiWeekFor({
    playerIds: boardIds,
    inputs: candidateInputs,
    scores: new Map(advice.upgrades.flatMap((u) => u.candidates.map((c) => [c.playerId, c.score] as const))),
    profile,
    currentWeek: data.nflState?.week ?? 1,
  });
  const upgradesWithValue = advice.upgrades.map((upgrade) => ({
    ...upgrade,
    candidates: upgrade.candidates.map((candidate) => {
      const value = multiWeek.get(candidate.playerId);
      return value ? { ...candidate, multiWeek: value } : candidate;
    }),
  }));

  const strategy = data.strategy;
  const intel = waiverLeagueIntel({
    advice,
    rosters: data.rosters,
    players: data.players,
    shape,
    budgets: strategy?.budget ?? null,
    prices: strategy?.prices ?? null,
  });

  const bids = strategy
    ? priceWaiverUpgrades({ advice, strategy, rosteredIds, competition: intel.competition })
    : [];

  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    found: true,
    dataFreshness: freshness(data),
    ...advice,
    upgrades: withCompetition(upgradesWithValue, intel.competition),
    notes: [...advice.notes, ...data.notes],
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
  return {
    league: { id: data.league.id, name: data.league.name },
    /*
     * Every profile is null, and that is the honest answer rather than a gap.
     *
     * A tendency needs a sample, and the live feature builds one by walking a
     * league's history — dozens of requests producing a handful of sentences
     * that change once a season. Demo Mode has no history to walk, so it says
     * what the live app says about a league nobody has run the pass for:
     * nothing. Inventing tendencies would be the one thing §9's "interesting
     * fixtures" must not become — a demonstration of a claim the product cannot
     * make about a real league.
     */
    room: null,
    managers: data.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      ownerName: roster.ownerName,
      isMine: roster.isMine,
      trade: null,
      draft: null,
    })),
  };
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
