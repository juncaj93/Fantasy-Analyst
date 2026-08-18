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
 *   - the wire is `recommendWaiverUpgrades` priced by `priceWaiverUpgrades`;
 *   - the comparison is `compareStartSit`;
 *   - the trade board is `rankTrades` and `groupByVerdict`;
 *   - the player list is ordered by `orderPlayers`;
 *   - the lifecycle is `resolveLifecycle` and `resolveSeasonPhase`.
 *
 * So a number on a demo screen is the same number the same code would print
 * against a live league in the same state. Nothing below writes a score, a
 * verdict, a bid or an explanation.
 */

import { buildDraftBoard } from '../../draft/boardBuilder.ts';
import { myGuy } from '../../draft/decisions.ts';
import { TALLY_WEIGHT, orderPlayers } from '../../draft/playerOrder.ts';
import { buildLiveRoster } from '../../draft/liveRoster.ts';
import { compareStartSit } from '../../startsit/engine.ts';
import { recommendLineup } from '../../startsit/lineup.ts';
import { normalizeMode } from '../../startsit/mode.ts';
import { recommendWaiverUpgrades } from '../../startsit/waivers.ts';
import { priceWaiverUpgrades } from '../../waivers/pricing.ts';
import { evaluateBench } from '../../roster/bench.ts';
import { buildHeldPlayers } from '../../roster/held.ts';
import { FREE_AGENTS_PER_POSITION, boundedFreeAgentIds } from '../../roster/freeAgents.ts';
import { groupByVerdict, rankTrades } from '../../trades/engine.ts';
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
import { draftBoardSourcesFrom, startSitInputsFrom, tradeCandidatesFrom } from './sources.ts';
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
  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    found: true,
    dataFreshness: freshness(data),
    rosterShape: shape,
    ...recommendation,
    notes: [...recommendation.notes, ...data.notes],
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

  const strategy = data.strategy;
  const bids = strategy ? priceWaiverUpgrades({ advice, strategy, rosteredIds }) : [];

  return {
    league: { id: data.league.id, name: data.league.name, scoringLabel: profile.label },
    found: true,
    dataFreshness: freshness(data),
    ...advice,
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
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const limit = Math.min(Number(params.get('limit') ?? 60) || 60, 200);
  const position = params.get('position');
  const availabilityLeagueId = params.get('leagueId');

  const pool = data.players.filter(
    (p) => p.active && (q === '' || p.fullName.toLowerCase().includes(q) || p.normalizedName.includes(q)),
  );
  const filtered = position ? pool.filter((p) => positionMatchesFilter(p.position, position)) : pool;

  const availability = new Map<string, 'mine' | 'rostered' | 'available'>();
  if (availabilityLeagueId) {
    for (const roster of data.rosters) {
      for (const id of roster.playerIds) availability.set(id, roster.isMine ? 'mine' : 'rostered');
    }
  }

  const shortlist = [...filtered]
    .sort(
      (a, b) =>
        (data.adpValues.get(a.id)?.adp ?? Infinity) - (data.adpValues.get(b.id)?.adp ?? Infinity) ||
        (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity),
    )
    .slice(0, Math.max(limit * 3, 120));

  const ordered = orderPlayers(
    shortlist.map((p) => ({
      id: p.id,
      name: p.fullName,
      draftRank: data.adpValues.get(p.id)?.adp ?? null,
      net: data.signals.get(p.id)?.raw.net ?? 0,
      player: p,
    })),
  ).slice(0, limit);

  return {
    tallyWeight: TALLY_WEIGHT,
    rankingSource: data.adpSnapshot?.label ?? null,
    players: ordered.map(({ player: row, draftRank, adjustedRank, movement }) => ({
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
      queued: data.flags.get(row.player.id)?.queued ?? false,
      ...(availabilityLeagueId
        ? { availability: availability.get(row.player.id) ?? ('available' as const) }
        : {}),
    })),
  };
}

function playerFile(data: ScenarioData, playerId: string): DemoResponse {
  const player = data.players.find((p) => p.id === playerId);
  if (!player) return fail('player not found', 404);
  const flag = data.flags.get(playerId) ?? { level: 0 as const, queued: false };
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
    myGuy: myGuy(flag.level),
    queued: flag.queued,
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
