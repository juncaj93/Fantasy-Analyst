/**
 * API surface.
 *
 * `createApp` returns a runtime-agnostic `fetch`-style handler so the exact same
 * routes serve Cloudflare Workers, the local dev server and Playwright e2e runs.
 *
 * Safety invariants enforced at this layer:
 *   - no endpoint writes to Sleeper (there is no draft/lineup mutation path)
 *   - manual Vegas refresh is rate limited
 *   - every mutation of evidence records a `user_reviews` history row
 */

import { importAdpSnapshot } from '../core/adp/import.ts';
import { draftPickLabel, draftProvenanceLine } from '../core/draft/provenance.ts';
import { myGuy, toMyGuyLevel } from '../core/draft/decisions.ts';
import { buildLiveRoster } from '../core/draft/liveRoster.ts';
import { compareStartSit, type StartSitInput } from '../core/startsit/engine.ts';
import { recommendLineup } from '../core/startsit/lineup.ts';
import { normalizeMode, type StartSitMode } from '../core/startsit/mode.ts';
import type { DefenseTendencyIndex } from '../core/startsit/defense.ts';
import { TALLY_WEIGHT, orderPlayers } from '../core/draft/playerOrder.ts';
import { aggregatePlayerSignal } from '../core/evidence/aggregate.ts';
import { normalizeName } from '../core/identity/normalize.ts';
import { ACCEPT_ANY_SENDER } from '../core/newsletter/pipeline.ts';
import { looksLikeBounceAddress, toEmailMessage } from '../core/newsletter/source.ts';
import { SleeperClient } from '../core/sleeper/client.ts';
import { positionMatchesFilter, resolveComparisonSlot } from '../core/sleeper/eligibility.ts';
import { resolveSeasonPhase, type NflState } from '../core/sleeper/phase.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes, startablePositions } from '../core/sleeper/scoring.ts';
import { recommendWaiverUpgrades } from '../core/startsit/waivers.ts';
import { VegasRefreshService, type VegasRefreshReport } from './services/vegasRefresh.ts';
import { VegasUsageRepo } from './repos/vegasUsage.ts';
import type { VegasProvider } from '../core/vegas/types.ts';
import type { Database } from './db.ts';
import {
  PUBLIC_PATHS,
  RateLimiter,
  checkPassphrase,
  clearSessionCookie,
  createSessionCookie,
  isWrite,
  verifySession,
  type AuthEnv,
} from './http/auth.ts';
import { Router, errorResponse, jsonResponse } from './http/router.ts';
import { AdpRepo, UNDERDOG_SOURCE } from './repos/adp.ts';
import { validateRawAdp } from '../core/adp/underdog.ts';
import { EvidenceRepo } from './repos/evidence.ts';
import { LeagueRepo } from './repos/league.ts';
import { NewsletterRepo } from './repos/newsletter.ts';
import { PlayerFlagsRepo } from './repos/playerFlags.ts';
import { PlayerRepo } from './repos/players.ts';
import { PropsRepo } from './repos/props.ts';
import { VegasEventsRepo } from './repos/vegasEvents.ts';
import { SETTING_KEYS, SettingsRepo } from './repos/settings.ts';
import { DraftBoardService } from './services/draftBoard.ts';
import { InjuryService } from './services/injuryService.ts';
import { RepairService } from './services/repairService.ts';
import { SetupService } from './services/setupService.ts';
import { TradeService } from './services/tradeService.ts';
import { MAX_BODY_BYTES, NewsletterService } from './services/newsletterService.ts';
import { SeasonMarketService } from './services/seasonMarketService.ts';
import { SleeperSyncService } from './services/sleeperSync.ts';
import { StartSitRefreshService } from './services/startSitRefresh.ts';
import { UsageService } from './services/usageService.ts';
import { PlayerDetailService } from './services/playerDetailService.ts';

export interface AppEnv extends AuthEnv {
  db: Database;
  sleeper: SleeperClient;
  vegas: VegasProvider;
  /**
   * Dedicated newsletter address from the deployment config, e.g.
   * "fantasy-news@example.com". Null until the one-time email setup is done.
   */
  inboundAddress?: string | null;
  /** Set true to skip auth entirely (local dev / e2e only). */
  disableAuth?: boolean;
}

export function createApp(): (request: Request, env: AppEnv) => Promise<Response> {
  const router = new Router<AppEnv>();
  // Per-app instance, not module state, so limits are scoped to one deployment
  // (and one test) rather than leaking across everything in the process.
  const loginLimiter = new RateLimiter(8, 5 * 60_000);
  const refreshLimiter = new RateLimiter(4, 15 * 60_000);

  /**
   * Reads are public; writes need an unlocked session.
   *
   * A deployment with no passphrase configured is read-only rather than wide
   * open — failing closed here is what stops an unconfigured public URL from
   * being editable by anyone who finds it.
   */
  router.use(async (ctx) => {
    if (ctx.env.disableAuth) return null;
    if (!ctx.url.pathname.startsWith('/api/')) return null;
    if (PUBLIC_PATHS.has(ctx.url.pathname)) return null;
    if (!isWrite(ctx.request.method)) return null;

    if (!ctx.env.APP_PASSPHRASE && !ctx.env.SESSION_SECRET) {
      return errorResponse(
        'This site is read-only: no passphrase has been set up for making changes.',
        503,
      );
    }
    const ok = await verifySession(ctx.request, ctx.env);
    return ok ? null : errorResponse('Unlock in Setup to make changes.', 401);
  });

  // ------------------------------------------------------------- health/auth
  router.get('/api/health', () => jsonResponse({ ok: true, service: 'fantasy-analyst' }));

  router.get('/api/auth/status', async (ctx) => {
    const unlocked = ctx.env.disableAuth ? true : await verifySession(ctx.request, ctx.env);
    const canUnlock = !!ctx.env.APP_PASSPHRASE || !!ctx.env.SESSION_SECRET;
    return jsonResponse({
      // Reads never need a session; this only says whether changes are allowed.
      unlocked,
      canUnlock,
      readOnly: !unlocked,
      authDisabled: !!ctx.env.disableAuth,
    });
  });

  router.post('/api/auth/login', async (ctx) => {
    const ip = ctx.request.headers.get('cf-connecting-ip') ?? 'local';
    const limit = loginLimiter.check(ip);
    if (!limit.allowed) return errorResponse(`too many attempts; retry in ${limit.retryAfterSeconds}s`, 429);

    const body = await ctx.json<{ passphrase?: string }>();
    if (!body?.passphrase) return errorResponse('Enter your passphrase.', 400);
    if (!ctx.env.APP_PASSPHRASE) {
      return errorResponse('No passphrase has been set up for this site.', 503);
    }
    if (!checkPassphrase(ctx.env, body.passphrase)) return errorResponse('That passphrase is not right.', 401);
    const cookie = await createSessionCookie(ctx.env);
    return jsonResponse({ ok: true }, 200, { 'set-cookie': cookie });
  });

  router.post('/api/auth/logout', () => jsonResponse({ ok: true }, 200, { 'set-cookie': clearSessionCookie() }));

  // ---------------------------------------------------------------- overview
  router.get('/api/overview', async (ctx) => {
    const db = ctx.env.db;
    const [players, leagues, evidence, identity, props, adp] = await Promise.all([
      new PlayerRepo(db).count(),
      new LeagueRepo(db).listLeagues(),
      new EvidenceRepo(db).pendingCount(),
      new NewsletterRepo(db).pendingIdentityCount(),
      new PropsRepo(db).freshness(),
      new AdpRepo(db).latest(),
    ]);
    const selected = leagues.find((l) => l.isSelected) ?? null;

    /*
     * Where the season is, and therefore whether Draft is still a destination.
     *
     * Answered from what is already stored — Sleeper's last-read `/state/nfl`,
     * the league's own status, the draft's status — so the toolbar costs no
     * network call of its own. Nothing known means preseason, which keeps the
     * tab; see `resolveSeasonPhase` for why that is the safe direction.
     */
    const state = await new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const draft = selected?.draftId ? await new LeagueRepo(db).getDraft(selected.draftId) : null;
    const season = resolveSeasonPhase({
      state,
      league: selected ? { season: selected.season, status: selected.status ?? null } : null,
      draft: draft ? { status: draft.status } : null,
    });

    return jsonResponse({
      players,
      leagues: leagues.length,
      selectedLeague: selected ? { id: selected.id, name: selected.name, season: selected.season } : null,
      pendingEvidence: evidence,
      pendingIdentity: identity,
      vegas: { ...props, provider: ctx.env.vegas.name, configured: ctx.env.vegas.isConfigured() },
      adpSnapshot: adp,
      season,
    });
  });

  // ------------------------------------------------------------------- setup
  const setupService = (ctx: { env: AppEnv }) =>
    new SetupService(ctx.env.db, ctx.env.vegas, ctx.env.inboundAddress ?? null);

  router.get('/api/setup/status', async (ctx) => jsonResponse(await setupService(ctx).status()));

  router.get('/api/setup/newsletter', async (ctx) => {
    const status = await setupService(ctx).newsletterStatus();
    const unlocked = ctx.env.disableAuth ? true : await verifySession(ctx.request, ctx.env);
    // The sender of the last email is a personal address. Masked in public,
    // shown in full once unlocked — which is also the only state in which the
    // "accept this sender" action is available.
    return jsonResponse(
      unlocked
        ? status
        : {
            ...status,
            lastReceivedFrom: maskAddress(status.lastReceivedFrom),
            lastProcessedDetail: maskAddressesIn(status.lastProcessedDetail),
            lastError: maskAddressesIn(status.lastError),
          },
    );
  });

  /**
   * Plain-language newsletter configuration, so the user never has to hand-write
   * a source object: they type the sender their newsletter comes from.
   */
  router.post('/api/setup/newsletter', async (ctx) => {
    const body = await ctx.json<{
      senderEmail?: string;
      subjectContains?: string;
      label?: string;
      enabled?: boolean;
      inboundAddress?: string;
    }>();
    if (!body) return errorResponse('nothing to save', 400);

    const settings = new SettingsRepo(ctx.env.db);
    if (body.inboundAddress !== undefined) {
      const address = body.inboundAddress.trim();
      if (address && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(address)) {
        return errorResponse('That does not look like an email address.', 400);
      }
      await settings.set(SETTING_KEYS.inboundAddress, address || null);
    }

    if (body.senderEmail !== undefined) {
      const sender = body.senderEmail.trim().toLowerCase();
      if (!sender) return errorResponse('Enter the address your newsletter comes from.', 400);
      // The wildcard skips every check below: there is no address to validate,
      // and a bounce-shaped sender is exactly what it is there to accept.
      const wildcard = sender === ACCEPT_ANY_SENDER;
      // Accept either a full address or a bare domain.
      if (!wildcard && !/^@?[^@\s]+(\.[^@\s]+)+$/.test(sender) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) {
        return errorResponse('That does not look like an email address or domain.', 400);
      }
      // A bounce address carries a token unique to one send. Saving it would
      // match a single issue and then silently stop, which is indistinguishable
      // from the newsletter having stopped arriving.
      if (!wildcard && looksLikeBounceAddress(sender)) {
        return errorResponse(
          'That is a bounce address — it changes with every issue, so it would only ever match one. ' +
            'Use the domain instead (for example @substack.com), or wait for the next issue: it will be ' +
            'listed as ignored and you can accept the real sender in one tap.',
          400,
        );
      }
      const subject = (body.subjectContains ?? '').trim();
      await new NewsletterService(ctx.env.db).setSources([
        {
          id: 'ff-newsletter',
          label: body.label?.trim() || 'FF Newsletter',
          fromPatterns: [sender],
          subjectPatterns: subject ? [escapeRegex(subject)] : [],
          enabled: body.enabled ?? true,
        },
      ]);
    }
    return jsonResponse(await setupService(ctx).newsletterStatus());
  });

  // ----------------------------------------------------------------- sleeper
  router.post('/api/sleeper/connect', async (ctx) => {
    const body = await ctx.json<{ username?: string; season?: string }>();
    if (!body?.username) return errorResponse('username required', 400);
    const service = new SleeperSyncService(ctx.env.db, ctx.env.sleeper);
    const user = await service.connectUser(body.username);
    const season = body.season ?? String(new Date().getFullYear());
    const { imported } = await service.syncLeagues(season);
    return jsonResponse({ user, season, leaguesImported: imported });
  });

  router.post('/api/sleeper/sync-players', async (ctx) => {
    const service = new SleeperSyncService(ctx.env.db, ctx.env.sleeper);
    return jsonResponse(await service.syncPlayers());
  });

  router.get('/api/leagues', async (ctx) => {
    const leagues = await new LeagueRepo(ctx.env.db).listLeagues();
    return jsonResponse({
      leagues: leagues.map((l) => {
        const profile = buildScoringProfile(l.scoringSettings, l.rosterPositions);
        const shape = buildRosterShape(l.rosterPositions);
        return {
          id: l.id,
          name: l.name,
          season: l.season,
          teams: l.totalRosters,
          isSelected: l.isSelected,
          scoringLabel: profile.label,
          notes: leagueFitNotes(profile, shape),
          rosterPositions: l.rosterPositions,
          draftId: l.draftId,
        };
      }),
    });
  });

  router.post('/api/leagues/:id/select', async (ctx) => {
    const repo = new LeagueRepo(ctx.env.db);
    const league = await repo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);
    await repo.selectLeague(league.id);
    await new SleeperSyncService(ctx.env.db, ctx.env.sleeper).syncLeague(league.id);
    return jsonResponse({ ok: true, leagueId: league.id });
  });

  router.post('/api/leagues/:id/sync', async (ctx) => {
    const service = new SleeperSyncService(ctx.env.db, ctx.env.sleeper);
    return jsonResponse(await service.syncLeague(ctx.params['id']!));
  });

  router.get('/api/leagues/:id/roster', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);
    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    const playerRepo = new PlayerRepo(db);
    const all = await playerRepo.listAll();
    const byId = new Map(all.map((p) => [p.id, p]));
    const signals = await new EvidenceRepo(db).getSignals(mine?.playerIds ?? []);

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
          // The number on his shirt, which is what identifies a player on a
          // team sheet once the draft has stopped being the thing happening.
          jerseyNumber: p?.jerseyNumber ?? null,
          newsNet: signal?.raw.net ?? 0,
          recentNet: signal?.last30.net ?? 0,
          pending: signal?.pendingCount ?? 0,
        };
      });

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    // During a draft Sleeper's roster is still empty, so the pick stream is the
    // only current answer. Reconstruct from it and merge; after the draft the
    // two agree and the merge is a no-op.
    const draft = league.draftId ? await leagueRepo.getDraft(league.draftId) : null;
    const picks = draft ? await leagueRepo.listPicks(draft.id) : [];
    const liveRoster = buildLiveRoster({
      picks,
      rosterId: mine?.rosterId ?? null,
      ownerId: mine?.ownerId ?? null,
      sleeperPlayerIds: mine?.playerIds ?? [],
      byId,
      shape,
      draftStatus: draft?.status ?? 'complete',
    });

    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label, notes: leagueFitNotes(profile, shape) },
      rosterShape: shape,
      starters: hydrate(mine?.starterIds ?? []),
      bench: hydrate((mine?.playerIds ?? []).filter((id) => !(mine?.starterIds ?? []).includes(id))),
      // Mid-draft there is no lineup to show, only players held and slots still
      // open. Presenting a starters/bench split would invent decisions the user
      // has not made.
      live: liveRoster.live,
      /*
       * Which pick he was, and what that is called.
       *
       * `pickNo` is kept because it is the raw fact and other things read it;
       * `draftPick` is the same fact in the unit the room used — `1.04` — and
       * it is what a row prints. Formatted here rather than on the screen so
       * the Team page, the player detail and Trades cannot disagree about which
       * round pick 40 was in.
       */
      drafted: hydrate(liveRoster.players.map((p) => p.playerId)).map((p, i) => ({
        ...p,
        pickNo: liveRoster.players[i]!.pickNo,
        draftPick: draftPickLabel(liveRoster.players[i]!.pickNo, draft?.teams ?? league.totalRosters ?? 12),
      })),
      /*
       * How many seats the draft had, so a client can format a pick number it
       * was not handed a label for. Without it `1.04` is unrecoverable from
       * `40` — the round length is the whole of the conversion.
       */
      teams: draft?.teams ?? league.totalRosters ?? 12,
      counts: liveRoster.counts,
      filled: liveRoster.filled,
      remaining: liveRoster.remaining,
      openStarters: liveRoster.openStarters,
      picksMade: liveRoster.picksMade,
      found: !!mine,
    });
  });

  /**
   * Whole-roster start/sit: the best legal lineup, and how it differs from the
   * one currently set in Sleeper. Read-only in every sense — it reports a
   * difference, it does not act on it.
   */
  router.get('/api/leagues/:id/lineup', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    if (!mine) {
      return jsonResponse({
        league: { id: league.id, name: league.name },
        found: false,
        error: 'Your team was not found in this league.',
      });
    }

    /*
     * Floor, Balanced or Ceiling, from the query string.
     *
     * A query parameter rather than stored state: the mode is a question the
     * user is asking right now, the answer is cheap to recompute, and a stored
     * preference would mean a lineup screen that silently answers a different
     * question from the one the control shows.
     */
    const mode = normalizeMode(ctx.url.searchParams.get('mode'));

    const [inputs, freshness] = await Promise.all([
      startSitInputsFor(db, mine.playerIds, { mode }),
      new PropsRepo(db).freshness(),
    ]);

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);
    const recommendation = recommendLineup(inputs, shape, profile, {
      currentStarterIds: mine.starterIds,
      mode,
    });

    const unknownPlayers = mine.playerIds.length - inputs.length;
    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      found: true,
      dataFreshness: freshness,
      /*
       * The slots the league actually starts, sent alongside the assignment.
       *
       * The Team screen orders its recommended starters by this rather than by
       * score, so a backup quarterback never sits above a starting flex player
       * on a cross-position ranking that answers no question anybody asked.
       */
      rosterShape: shape,
      ...recommendation,
      notes: unknownPlayers > 0
        ? [...recommendation.notes, `${unknownPlayers} roster spot(s) are not in the player list yet — update it in Setup.`]
        : recommendation.notes,
    });
  });

  /**
   * Whether anybody unrostered would actually improve the lineup.
   *
   * Its own request rather than part of the lineup, and deliberately: the Team
   * screen draws the roster from data it already has and this arrives beside it,
   * so the free-agent scan can never be the reason the screen is slow to appear.
   *
   * Advisory only. There is no add, no drop, no claim and no bid anywhere in
   * this app, and this endpoint is a GET that writes nothing.
   */
  router.get('/api/leagues/:id/waivers', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    if (!mine) {
      return jsonResponse({
        league: { id: league.id, name: league.name },
        found: false,
        upgrades: [],
        headline: null,
        notes: [],
        considered: 0,
      });
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    /*
     * Sleeper decides who is available, and it decides it for the whole league.
     *
     * Every player on every roster — mine, and the eleven managers I am playing
     * against — is off the table. This set is also handed to the engine, which
     * checks it again: it is the one mistake this feature must never make.
     */
    const rosteredIds = new Set<string>();
    for (const roster of rosters) for (const id of roster.playerIds) rosteredIds.add(id);

    const startable = startablePositions(shape);
    const candidateIds = await boundedFreeAgents(db, { rosteredIds, startable });

    const [rosterInputs, candidateInputs, freshness] = await Promise.all([
      startSitInputsFor(db, mine.playerIds),
      startSitInputsFor(db, candidateIds),
      new PropsRepo(db).freshness(),
    ]);

    const lineup = recommendLineup(rosterInputs, shape, profile, { currentStarterIds: mine.starterIds });
    const advice = recommendWaiverUpgrades({
      roster: rosterInputs,
      candidates: candidateInputs,
      shape,
      profile,
      rosteredPlayerIds: rosteredIds,
      currentStarterIds: mine.starterIds,
      lineup,
    });

    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      found: true,
      dataFreshness: freshness,
      ...advice,
      /** How the pool was bounded, so a thin answer is never a mystery. */
      pool: { scanned: candidateIds.length, perPosition: FREE_AGENTS_PER_POSITION },
    });
  });

  // ------------------------------------------------------------------ drafts
  router.get('/api/drafts/:id/board', async (ctx) => {
    const service = new DraftBoardService(ctx.env.db);
    const limit = Number(ctx.url.searchParams.get('limit') ?? 40);
    const position = ctx.url.searchParams.get('position');
    // `queued=1` narrows the board to the user's own queue.
    const queuedOnly = ctx.url.searchParams.get('queued') === '1';
    return jsonResponse(await service.build(ctx.params['id']!, { limit, position, queuedOnly }));
  });

  router.post('/api/drafts/:id/sync', async (ctx) => {
    const service = new SleeperSyncService(ctx.env.db, ctx.env.sleeper);
    const result = await service.syncDraft(ctx.params['id']!);
    return jsonResponse({ ...result, pollIntervalSeconds: SleeperSyncService.pollIntervalSeconds(result.status) });
  });

  router.post('/api/drafts/:id/adp-snapshot', async (ctx) => {
    const body = await ctx.json<{ snapshotId?: number | null }>();
    await new LeagueRepo(ctx.env.db).setDraftSnapshot(ctx.params['id']!, body?.snapshotId ?? null);
    return jsonResponse({ ok: true });
  });

  // --------------------------------------------------------------------- ADP
  router.get('/api/adp/snapshots', async (ctx) => jsonResponse({ snapshots: await new AdpRepo(ctx.env.db).list() }));

  router.post('/api/adp/import', async (ctx) => {
    const body = await ctx.json<{
      content?: string;
      label?: string;
      capturedAt?: string;
      source?: string;
      /** Underdog provenance, sent by the DOG workflow and by nothing else. */
      provider?: string;
      snapshotAt?: string;
      fetchedAt?: string;
    }>();
    if (!body?.content) return errorResponse('content required (CSV or JSON text)', 400);
    const index = await new PlayerRepo(ctx.env.db).buildIndex();
    let result;
    try {
      result = importAdpSnapshot(body.content, index, {
        label: body.label,
        capturedAt: body.capturedAt,
        source: body.source,
      });
    } catch (err) {
      return errorResponse(`could not parse file: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    if (result.rows.length === 0) {
      return errorResponse('no usable rows found — expected columns for player name and ADP or rank', 400);
    }

    /*
     * The gate that keeps `DOG` meaning one thing.
     *
     * An import into the Underdog source has to prove it is raw ADP before it
     * is written, because once it is written the board has no way of telling a
     * ranking from an average — both are a column of numbers that sort
     * plausibly. `validateRawAdp` reads the shape of the values (a dense run of
     * whole numbers is a ranking, whatever the column was called) and the
     * import is refused outright rather than stored with a caveat: a rejected
     * file leaves the previous good snapshot in place, which is the safe
     * outcome, while a stored bad one silently becomes the market baseline.
     *
     * Every other source is unaffected and imports exactly as it always has.
     */
    const isUnderdog = (body.source ?? '') === UNDERDOG_SOURCE;
    if (isUnderdog) {
      const verdict = validateRawAdp(
        result.rows.flatMap((row) =>
          row.adp == null ? [] : [{ name: row.sourceName, team: row.sourceTeam, position: row.sourcePosition, adp: row.adp }],
        ),
      );
      if (!verdict.valid) {
        return errorResponse(
          `refusing to store this as Underdog ADP: ${verdict.reason}. Raw Underdog ADP only — rankings, expert ranks and projections cannot be labelled DOG.`,
          422,
        );
      }
    }

    const repo = new AdpRepo(ctx.env.db);
    const { snapshot, created } = await repo.save(result, {
      provider: body.provider ?? null,
      sourceType: 'raw_adp',
      snapshotAt: body.snapshotAt ?? null,
      fetchedAt: body.fetchedAt ?? null,
    });
    // The same file imported twice is normally a no-op, but the matcher may
    // have learned a name since — so give the rows that found nothing another
    // go rather than make the user wait for the source file to change.
    const reconciled = created ? 0 : await repo.reconcile(snapshot.id, result);
    return jsonResponse({
      snapshot,
      created,
      reconciled,
      matched: result.matchedCount,
      ambiguous: result.ambiguousCount,
      unmatched: result.unmatchedCount,
      skipped: result.skipped,
    });
  });

  router.get('/api/adp/snapshots/:id/unresolved', async (ctx) => {
    const rows = await new AdpRepo(ctx.env.db).unresolvedRows(Number(ctx.params['id']));
    return jsonResponse({ rows });
  });

  router.post('/api/adp/rows/:id/resolve', async (ctx) => {
    const body = await ctx.json<{ playerId?: string }>();
    if (!body?.playerId) return errorResponse('playerId required', 400);
    await new AdpRepo(ctx.env.db).resolveRow(Number(ctx.params['id']), body.playerId);
    return jsonResponse({ ok: true });
  });

  // ----------------------------------------------------------------- players
  router.get('/api/players', async (ctx) => {
    const q = ctx.url.searchParams.get('q') ?? '';
    /*
     * How deep the list goes, and where this page starts.
     *
     * The default was 60 and the ceiling was 200, which is why Players ended
     * somewhere around the sixtieth name and looked exactly like the end of the
     * player universe rather than the end of a page — the same failure the
     * draft board had. Both numbers move: a page is 100 by default and may be
     * up to 200, and `offset` means the client can keep asking.
     *
     * The cap on one *request* stays, and deliberately. It is not a cap on
     * coverage now that there is an offset; it is the thing that keeps a single
     * response small enough to parse on a phone, and it is what makes the
     * client render a page at a time instead of putting thousands of rows into
     * the DOM at once.
     */
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 100) || 100, 1), 200);
    const offset = Math.max(Number(ctx.url.searchParams.get('offset') ?? 0) || 0, 0);
    const position = ctx.url.searchParams.get('position');
    const repo = new PlayerRepo(ctx.env.db);

    // Draft order comes from an imported ranking. Sleeper's search_rank is NOT
    // one — it ranks by who gets looked up — so when no ranking is imported the
    // list says so and falls back to the tally rather than inventing an order.
    const snapshot = await new AdpRepo(ctx.env.db).latest();
    const ranks = snapshot ? await new AdpRepo(ctx.env.db).valuesByPlayer(snapshot.id) : new Map();

    /*
     * A filter narrows what comes back, so the pool it narrows has to be wider.
     *
     * The search returns the best N matches for the text; filtering those to one
     * position afterwards can leave a handful, which looks exactly like "there
     * are no more players called that". Asking for more when a filter is on
     * costs nothing when it is off.
     */
    /*
     * The pool a page is cut from has to be deeper than the page.
     *
     * A search returns the best N matches for the text and the position filter
     * then narrows those, so a shallow search pool looks exactly like "there
     * are no more players called that". It also has to cover the offset: page
     * three of a filtered search is only reachable if the search returned
     * enough rows to have a page three.
     */
    const searchDepth = Math.max((position ? 400 : 200), offset + limit * 3);
    const pool = q ? await repo.search(q, searchDepth) : (await repo.listAll()).filter((p) => p.active);
    // `FLX` is a view over RB/WR/TE and is never a position on a player — see
    // core/sleeper/eligibility.ts, which every screen's filter goes through.
    const filtered = position ? pool.filter((p) => positionMatchesFilter(p.position, position)) : pool;

    /*
     * Who owns whom, when the caller says which league they mean.
     *
     * The comparison picker needs it: comparing a bench player against a free
     * agent is a real question, and comparing one against a player another
     * manager owns is not a question at all. Sleeper's rosters are the whole
     * answer, and the field is simply absent when no league was named.
     */
    const availabilityLeagueId = ctx.url.searchParams.get('leagueId');
    const availability = new Map<string, 'mine' | 'rostered' | 'available'>();
    if (availabilityLeagueId) {
      const rosters = await new LeagueRepo(ctx.env.db).listRosters(availabilityLeagueId);
      for (const roster of rosters) {
        for (const id of roster.playerIds) availability.set(id, roster.isMine ? 'mine' : 'rostered');
      }
    }

    /*
     * Scored deep enough to serve this page, then some.
     *
     * The shortlist exists because the tally nudge is applied after the market
     * sort, so a player can move a few places and the window has to be wider
     * than the page for that movement to be real rather than clipped. It now
     * grows with the offset, which is what makes page five as honest as page
     * one — before, every page was cut from the same first 120 names.
     */
    const shortlist = [...filtered]
      .sort(
        (a, b) =>
          (ranks.get(a.id)?.adp ?? Infinity) - (ranks.get(b.id)?.adp ?? Infinity) ||
          (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity),
      )
      .slice(0, offset + Math.max(limit * 3, 120));

    const signals = await new EvidenceRepo(ctx.env.db).getSignals(shortlist.map((p) => p.id));
    const flags = await new PlayerFlagsRepo(ctx.env.db).forPlayers(shortlist.map((p) => p.id));
    const ordered = orderPlayers(
      shortlist.map((p) => ({
        id: p.id,
        name: p.fullName,
        draftRank: ranks.get(p.id)?.adp ?? null,
        net: signals.get(p.id)?.raw.net ?? 0,
        player: p,
      })),
    );
    const page = ordered.slice(offset, offset + limit);

    return jsonResponse({
      tallyWeight: TALLY_WEIGHT,
      rankingSource: snapshot ? snapshot.label : null,
      /*
       * Whether asking again would return anything.
       *
       * Sent rather than inferred from `players.length === limit`, which is
       * wrong exactly once — on the page that happens to end on the boundary,
       * where the client would show a spinner for a page that does not exist.
       */
      offset,
      hasMore: filtered.length > offset + page.length,
      total: filtered.length,
      players: page.map(({ player: row, draftRank, adjustedRank: adjusted, movement }) => ({
        id: row.player.id,
        name: row.player.fullName,
        position: row.player.position,
        team: row.player.team,
        status: row.player.status,
        draftRank,
        adjustedRank: adjusted,
        movement,
        signal: signals.get(row.player.id) ?? null,
        myGuy: myGuy(flags.get(row.player.id)?.level ?? 0),
        queued: flags.get(row.player.id)?.queued ?? false,
        ...(availabilityLeagueId
          ? { availability: availability.get(row.player.id) ?? ('available' as const) }
          : {}),
      })),
    });
  });

  router.get('/api/players/:id', async (ctx) => {
    const db = ctx.env.db;
    const player = await new PlayerRepo(db).getById(ctx.params['id']!);
    if (!player) return errorResponse('player not found', 404);
    const evidenceRepo = new EvidenceRepo(db);
    const items = await evidenceRepo.listForPlayer(player.id, 200);
    const seasonStart = await new SettingsRepo(db).get<string | null>(SETTING_KEYS.seasonStart, null);
    const signal = aggregatePlayerSignal(player.id, items, { seasonStart });
    const props = await new PropsRepo(db).latestForPlayers([player.id]);
    const flag = await new PlayerFlagsRepo(db).get(player.id);
    return jsonResponse({
      player: {
        id: player.id,
        name: player.fullName,
        position: player.position,
        team: player.team,
        status: player.status,
        aliases: player.aliases,
      },
      signal,
      evidence: items,
      props: props.get(player.id) ?? [],
      // The user's own opinion, alongside the ledger and never mixed into it.
      myGuy: myGuy(flag.level),
      queued: flag.queued,
    });
  });

  /**
   * The context an expanded card adds: last season, and this season's outlook.
   *
   * Separate from the board on purpose. The board is what a live draft waits
   * on, and it must never wait on a third party — so nothing here is fetched
   * until a card is actually open, and then at most once per player per week.
   *
   * A read, not a change, so it needs no passphrase.
   */
  /**
   * Pull last season's statistics now, rather than waiting for the nightly run.
   *
   * The cron is the normal path and this changes nothing about it. What this is
   * for is the two moments the cron cannot cover: a fresh deployment, whose
   * cards would say nothing about last season until the next 09:00, and a run
   * that failed and left partial coverage. Idempotent — the same season fetched
   * twice replaces its own rows — and it returns the counts rather than a bare
   * ok, because "it worked" and "it matched eleven players" look identical from
   * a card.
   *
   * A change, so it needs the passphrase.
   */
  router.post('/api/players/season-stats/refresh', async (ctx) => {
    const service = new PlayerDetailService(ctx.env.db, { sleeper: ctx.env.sleeper });
    return jsonResponse(await service.refreshSeasonStats());
  });

  /**
   * Pull the published injury report now.
   *
   * The crons cover the week — daily at 09:00 for the practice reports, and
   * again at Sunday 11am Eastern beside the Vegas refresh. This is for the
   * moment neither covers: a designation that changed since, on a morning when
   * a lineup is being set.
   *
   * Returns the counts rather than an ok, because "it ran" and "it mapped 40 of
   * 1,400 rows" are indistinguishable from a card. A season with nothing
   * published yet comes back `not_published`, which is a fact about the
   * calendar and not a failure.
   *
   * A change, so it needs the passphrase.
   */
  router.post('/api/injuries/refresh', async (ctx) =>
    jsonResponse(await new InjuryService(ctx.env.db).refresh()),
  );

  /**
   * Pull the published weekly usage now.
   *
   * The daily 09:00 cron is the real schedule and is right for a file whose
   * numbers are settled the moment a game ends. This is for the person who has
   * just watched a Sunday-night game and does not want to wait until Tuesday to
   * see the target count behind it.
   *
   * Returns the counts rather than an ok, for the same reason the injury one
   * does. `not_published` is a fact about the calendar, not a failure.
   *
   * A change, so it needs the passphrase.
   */
  router.post('/api/usage/refresh', async (ctx) =>
    jsonResponse(await new UsageService(ctx.env.db).refresh()),
  );

  router.get('/api/players/:id/detail', async (ctx) => {
    const player = await new PlayerRepo(ctx.env.db).getById(ctx.params['id']!);
    if (!player) return errorResponse('player not found', 404);
    const detail = await new PlayerDetailService(ctx.env.db, { sleeper: ctx.env.sleeper }).forPlayer(player.id);
    /*
     * Where he came from, kept after it stops being the headline.
     *
     * Mid-draft a Team row says `1.04` and the reader needs nothing more. Once
     * the season starts the row shows his shirt number instead — and "what did
     * I spend on him" is still a real question in week nine, so the draft
     * position moves here rather than being dropped.
     *
     * Read from Sleeper's own draft history, and only ever attached to a
     * manager Sleeper names. Attributing a pick to a person is the worst thing
     * on this card to get wrong, so an unnamed seat produces a line about the
     * pick alone rather than a guess about who made it.
     */
    return jsonResponse({ ...detail, draft: await draftProvenanceFor(ctx.env.db, player.id) });
  });

  /**
   * Mark a player as one the user personally rates — ♥, ♥♥ or ♥♥♥.
   *
   * Separate from the evidence ledger by design: this is preference, not news,
   * and the two are weighed separately by the draft engine. It is also separate
   * from the draft queue, which is a bookmark and moves nothing. Level 0 clears
   * it.
   */
  router.post('/api/players/:id/my-guy', async (ctx) => {
    const body = await ctx.json<{ level?: number }>();
    const player = await new PlayerRepo(ctx.env.db).getById(ctx.params['id']!);
    if (!player) return errorResponse('player not found', 404);
    const raw = Number(body?.level ?? 0);
    if (!Number.isInteger(raw) || raw < 0 || raw > 3) {
      return errorResponse('level must be 0, 1, 2 or 3', 400);
    }
    const stored = await new PlayerFlagsRepo(ctx.env.db).setLevel(player.id, toMyGuyLevel(raw));
    return jsonResponse({
      playerId: player.id,
      name: player.fullName,
      myGuy: myGuy(stored.level),
      queued: stored.queued,
    });
  });

  /**
   * Put a player in the draft queue, or take him out.
   *
   * A bookmark, nothing more: it is how the ★ filter finds the player you meant
   * to take, and it deliberately has no effect on the ranking. Rating a player
   * is what the heart on the players list is for.
   */
  router.post('/api/players/:id/queue', async (ctx) => {
    const body = await ctx.json<{ queued?: boolean }>();
    const player = await new PlayerRepo(ctx.env.db).getById(ctx.params['id']!);
    if (!player) return errorResponse('player not found', 404);
    if (typeof body?.queued !== 'boolean') return errorResponse('queued must be true or false', 400);
    const stored = await new PlayerFlagsRepo(ctx.env.db).setQueued(player.id, body.queued);
    return jsonResponse({
      playerId: player.id,
      name: player.fullName,
      queued: stored.queued,
      myGuy: myGuy(stored.level),
    });
  });

  // -------------------------------------------------------------- newsletter
  router.post('/api/newsletter/ingest', async (ctx) => {
    const body = await ctx.json<{
      messageId?: string;
      from?: string;
      subject?: string;
      date?: string;
      html?: string;
      text?: string;
      force?: boolean;
    }>();
    if (!body || (!body.html && !body.text)) return errorResponse('html or text required', 400);
    const message = toEmailMessage(body);
    const service = new NewsletterService(ctx.env.db);
    return jsonResponse(await service.ingest(message, { force: body.force ?? false }));
  });

  router.get('/api/newsletter/messages', async (ctx) => {
    const messages = await new NewsletterRepo(ctx.env.db).listMessages(15);
    const unlocked = ctx.env.disableAuth ? true : await verifySession(ctx.request, ctx.env);
    // Bodies are retained so rules can be re-run over them, but reads on this
    // site are public and the newsletter is someone else's work. The log says
    // what arrived and what came of it; it does not republish the issue.
    // Sender addresses are masked for the public too — they are personal
    // addresses, not fantasy data.
    return jsonResponse({
      messages: messages.map(({ bodyHtml: _html, bodyText: _text, ...rest }) => ({
        ...rest,
        fromAddress: unlocked ? rest.fromAddress : maskAddress(rest.fromAddress),
        rejectReason: unlocked ? rest.rejectReason : maskAddressesIn(rest.rejectReason),
        detail: unlocked ? rest.detail : maskAddressesIn(rest.detail),
        bodyRetained: !!(bodyOf(_html) || bodyOf(_text)),
      })),
    });
  });

  /**
   * What would re-running the current rules over a stored newsletter do?
   * A read: it computes a difference and writes nothing.
   */
  router.get('/api/newsletter/messages/:id/preview', async (ctx) => {
    const service = new NewsletterService(ctx.env.db);
    const message = await service.storedMessage(ctx.params['id']!);
    if (!message) {
      return errorResponse(
        'That email was not kept, so its rules cannot be re-run. Only newsletters processed since body retention was added can be reprocessed.',
        404,
      );
    }
    return jsonResponse(await service.previewReprocess(message));
  });

  /** Apply what the preview described. Existing corrections are untouched. */
  router.post('/api/newsletter/messages/:id/reprocess', async (ctx) => {
    const service = new NewsletterService(ctx.env.db);
    const message = await service.storedMessage(ctx.params['id']!);
    if (!message) {
      return errorResponse('That email was not kept, so its rules cannot be re-run.', 404);
    }
    return jsonResponse(await service.reprocess(message));
  });

  /**
   * Backfill a hand-maintained tally.
   *
   * A one-off for issues read before the app existed. It shares the ledger and
   * the review queue with parsed mail, so nothing here is privileged: an
   * imported row can be corrected or rejected like any other item.
   */
  router.post('/api/newsletter/tally-import', async (ctx) => {
    const body = await ctx.json<{
      content?: string;
      sourceName?: string;
      sourceDate?: string;
      sourceMessageId?: string;
    }>();
    if (!body?.content?.trim()) return errorResponse('content required (the tally document)', 400);
    if (body.content.length > MAX_BODY_BYTES) {
      return errorResponse('That document is too large to import.', 400);
    }
    const result = await new NewsletterService(ctx.env.db).importTallyDocument(body.content, {
      sourceName: body.sourceName,
      sourceDate: body.sourceDate,
      sourceMessageId: body.sourceMessageId,
    });
    if (result.rowsParsed === 0) {
      return errorResponse(
        'No tally rows were found. Expected a table with Player and Score columns.',
        400,
      );
    }
    return jsonResponse(result);
  });

  router.get('/api/newsletter/sources', async (ctx) =>
    jsonResponse({ sources: await new NewsletterService(ctx.env.db).getSources() }),
  );

  router.post('/api/newsletter/sources', async (ctx) => {
    const body = await ctx.json<{ sources?: unknown }>();
    if (!Array.isArray(body?.sources)) return errorResponse('sources array required', 400);
    await new NewsletterService(ctx.env.db).setSources(body.sources as never);
    return jsonResponse({ ok: true });
  });

  // ------------------------------------------------------------------ review
  router.get('/api/review/queue', async (ctx) => {
    const db = ctx.env.db;
    const [evidence, identity] = await Promise.all([
      new EvidenceRepo(db).listPending(50),
      new NewsletterRepo(db).listIdentityReviews(50),
    ]);
    const players = await new PlayerRepo(db).listAll();
    const byId = new Map(players.map((p) => [p.id, p]));
    return jsonResponse({
      evidence: evidence.map((e) => ({
        ...e,
        playerName: byId.get(e.playerId)?.fullName ?? e.playerId,
        playerPosition: byId.get(e.playerId)?.position ?? '',
        playerTeam: byId.get(e.playerId)?.team ?? '',
      })),
      identity,
    });
  });

  router.post('/api/review/evidence/:id', async (ctx) => {
    const body = await ctx.json<{
      action?: 'accept' | 'correct' | 'reject' | 'ignore';
      polarity?: string;
      magnitude?: number;
      category?: string;
      playerId?: string;
      note?: string;
    }>();
    if (!body?.action) return errorResponse('action required', 400);
    const repo = new EvidenceRepo(ctx.env.db);
    const updated = await repo.applyReview(Number(ctx.params['id']), body.action, {
      ...(body.polarity ? { polarity: body.polarity as never } : {}),
      ...(body.magnitude != null ? { magnitude: body.magnitude } : {}),
      ...(body.category ? { category: body.category } : {}),
      ...(body.playerId ? { playerId: body.playerId } : {}),
      ...(body.note ? { note: body.note } : {}),
    });
    if (!updated) return errorResponse('evidence item not found', 404);
    const seasonStart = await new SettingsRepo(ctx.env.db).get<string | null>(SETTING_KEYS.seasonStart, null);
    const signal = await repo.refreshSignal(updated.playerId, { seasonStart });
    return jsonResponse({ item: updated, signal });
  });

  /** Recently applied items, so auto-applied evidence stays inspectable. */
  router.get('/api/review/applied', async (ctx) => {
    const db = ctx.env.db;
    const items = await new EvidenceRepo(db).listApplied(Number(ctx.url.searchParams.get('limit') ?? 30));
    const players = await new PlayerRepo(db).listAll();
    const byId = new Map(players.map((p) => [p.id, p]));
    return jsonResponse({
      evidence: items.map((e) => ({
        ...e,
        playerName: byId.get(e.playerId)?.fullName ?? e.playerId,
        playerPosition: byId.get(e.playerId)?.position ?? '',
        playerTeam: byId.get(e.playerId)?.team ?? '',
      })),
    });
  });

  router.post('/api/review/identity/:id', async (ctx) => {
    const body = await ctx.json<{ playerId?: string; dismiss?: boolean; remember?: boolean }>();
    const repo = new NewsletterRepo(ctx.env.db);
    const id = Number(ctx.params['id']);

    if (body?.dismiss) {
      await repo.resolveIdentityReview(id, null, 'dismissed');
      return jsonResponse({ ok: true, status: 'dismissed' });
    }
    if (!body?.playerId) return errorResponse('playerId or dismiss required', 400);

    // Teaching the app the name is the point: without it, "JSN" comes back as a
    // question every single week.
    let remembered: string | null = null;
    if (body.remember !== false) {
      const item = (await repo.listIdentityReviews(200)).find((r) => r.id === id) ?? null;
      const text = item?.matchedText?.trim();
      if (text) {
        await new PlayerRepo(ctx.env.db).addAlias(body.playerId, text, normalizeName(text), 'user');
        remembered = text;
      }
    }

    await repo.resolveIdentityReview(id, body.playerId, 'resolved');
    return jsonResponse({ ok: true, status: 'resolved', remembered });
  });

  // -------------------------------------------------------------- trades ---
  router.get('/api/trades', async (ctx) => {
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 60) || 60, 200);
    return jsonResponse(await new TradeService(ctx.env.db).build({ limit }));
  });

  // ------------------------------------------------------- help my scores ---
  // Names the matcher would not guess at, and the tally they are costing.
  router.get('/api/repair', async (ctx) => jsonResponse(await new RepairService(ctx.env.db).status()));

  // Recovers evidence for names resolved before resolving created any.
  router.post('/api/repair/backfill', async (ctx) =>
    jsonResponse(await new RepairService(ctx.env.db).backfillResolved()),
  );

  router.post('/api/repair/assign', async (ctx) => {
    const body = await ctx.json<{ alias?: string; playerId?: string; remember?: boolean }>();
    if (!body?.alias || !body?.playerId) return errorResponse('alias and playerId are required', 400);
    try {
      const result = await new RepairService(ctx.env.db).assign(body.alias, body.playerId, {
        remember: body.remember,
      });
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : String(err), 400);
    }
  });

  // --------------------------------------------------------------- nicknames
  router.get('/api/players/:id/aliases', async (ctx) => {
    const repo = new PlayerRepo(ctx.env.db);
    const player = await repo.getById(ctx.params['id']!);
    if (!player) return errorResponse('player not found', 404);
    const stored = await repo.listAliases(player.id);
    return jsonResponse({
      playerId: player.id,
      name: player.fullName,
      // What was taught, separately from what the name implies.
      aliases: stored.map((a) => a.alias),
      derived: player.aliases,
    });
  });

  /**
   * Teach the app another name for a player.
   *
   * Refused when the name already belongs to someone else: an alias that points
   * two ways is worse than no alias, because it turns a clean match into an
   * ambiguous one for both players.
   */
  router.post('/api/players/:id/aliases', async (ctx) => {
    const body = await ctx.json<{ alias?: string; remove?: boolean }>();
    const alias = body?.alias?.trim();
    if (!alias) return errorResponse('Enter the nickname or short name to remember.', 400);

    const repo = new PlayerRepo(ctx.env.db);
    const player = await repo.getById(ctx.params['id']!);
    if (!player) return errorResponse('player not found', 404);

    const key = normalizeName(alias);
    if (!key) return errorResponse('That does not look like a name.', 400);

    if (body?.remove) {
      await repo.removeAlias(player.id, key);
      return jsonResponse({ ok: true, removed: alias });
    }

    const index = await repo.buildIndex();
    const clash = index
      .byNormalizedName(key)
      .concat(index.byAliasKey(key))
      .find((p) => p.id !== player.id);
    if (clash) {
      return errorResponse(
        `"${alias}" already means ${clash.fullName} (${clash.position} ${clash.team}). Pick a nickname that is not already taken.`,
        409,
      );
    }

    await repo.addAlias(player.id, alias, key, 'user');
    const stored = await repo.listAliases(player.id);
    return jsonResponse({
      ok: true,
      playerId: player.id,
      name: player.fullName,
      aliases: stored.map((a) => a.alias),
    });
  });

  // ------------------------------------------------------------------- vegas
  router.get('/api/vegas/status', async (ctx) => {
    const freshness = await new PropsRepo(ctx.env.db).freshness();
    return jsonResponse({
      // The configured provider, and separately whoever produced the cached data.
      provider: ctx.env.vegas.name,
      configured: ctx.env.vegas.isConfigured(),
      quota: ctx.env.vegas.getQuotaStatus?.() ?? null,
      cachedProvider: freshness.provider,
      fetchedAt: freshness.fetchedAt,
      events: freshness.events,
    });
  });

  /**
   * Season-long market refresh, for the draft.
   *
   * Rate limited alongside the weekly refresh and gated by its own daily TTL,
   * because season totals move over weeks and every fetch is quota the live
   * Sunday will want back. `force=1` skips the TTL, never the cooldown.
   */
  router.post('/api/vegas/season/refresh', async (ctx) => {
    const limit = refreshLimiter.check('vegas-season');
    if (!limit.allowed) return errorResponse(`refresh on cooldown; retry in ${limit.retryAfterSeconds}s`, 429);
    const service = new SeasonMarketService(ctx.env.db, ctx.env.vegas);
    return jsonResponse(await service.refresh({ force: ctx.url.searchParams.get('force') === '1' }));
  });

  router.get('/api/vegas/season', async (ctx) => {
    const service = new SeasonMarketService(ctx.env.db, ctx.env.vegas);
    return jsonResponse(await service.status());
  });

  /**
   * Manual refresh. Rate limited *and* budgeted.
   *
   * The cooldown stops a thumb on a button from becoming a loop; the budget
   * stops the loop from mattering if it ever gets through. A tap that the
   * budget declines is a 200 with the reason in it, not an error — the lines
   * on screen are still the last good ones.
   */
  router.post('/api/vegas/refresh', async (ctx) => {
    const limit = refreshLimiter.check('vegas');
    if (!limit.allowed) return errorResponse(`refresh on cooldown; retry in ${limit.retryAfterSeconds}s`, 429);
    const result = await refreshVegas(ctx.env, { manual: true });
    return jsonResponse(result);
  });

  /**
   * Where the month's Vegas allowance has gone.
   *
   * Public and read-only: it makes no provider call of its own, it reads the
   * ledger. Quota problems are only visible before they become outages if
   * somebody can see them, and this is the page that shows them.
   */
  router.get('/api/vegas/budget', async (ctx) => {
    const usage = new VegasUsageRepo(ctx.env.db);
    const [view, bySource, recent, preview] = await Promise.all([
      usage.view(),
      usage.bySource(),
      usage.recent(10),
      new VegasRefreshService(ctx.env.db, ctx.env.vegas).preview(),
    ]);
    return jsonResponse({
      provider: ctx.env.vegas.name,
      configured: ctx.env.vegas.isConfigured(),
      budget: view,
      bySource,
      recent,
      nextPlan: {
        events: preview.plan.events.map((e) => ({
          eventId: e.eventId,
          kickoff: e.kickoff,
          players: e.playerIds.length,
          priority: e.priority,
          reason: e.reason,
        })),
        estimatedEntities: preview.plan.estimatedEntities,
        skipped: preview.plan.skipped.length,
      },
    });
  });

  // ---------------------------------------------------------------- start/sit
  /**
   * Rank two to four candidates for the same lineup spot.
   *
   * The players may come from anywhere — the user's own roster, the free-agent
   * pool, or a mixture — because "should I start my tight end or the one sitting
   * on waivers" is an ordinary question and refusing to answer it would be an
   * arbitrary restriction. Who is *addable* is a separate matter, answered by
   * the waiver endpoint; this one only ranks.
   */
  /**
   * Refresh everything a lineup decision reads, then say what actually moved.
   *
   * A write, because it spends quota and stores what it learns — so it needs
   * the passphrase like every other write. It creates no schedule and starts no
   * background job: it runs while the request is open and returns the state of
   * each source, including the ones that were already current and the one
   * (weather) this app has no feed for.
   */
  router.post('/api/startsit/refresh', async (ctx) => {
    const ip = ctx.request.headers.get('cf-connecting-ip') ?? 'local';
    const limit = refreshLimiter.check(`startsit:${ip}`);
    if (!limit.allowed) return errorResponse(`too many refreshes; retry in ${limit.retryAfterSeconds}s`, 429);
    const service = new StartSitRefreshService(ctx.env.db, { sleeper: ctx.env.sleeper, vegas: ctx.env.vegas });
    return jsonResponse(await service.refresh());
  });

  const MAX_COMPARE = 4;
  router.post('/api/startsit/compare', async (ctx) => {
    const body = await ctx.json<{
      leagueId?: string;
      playerIds?: string[];
      slot?: string | null;
      mode?: string | null;
    }>();
    const requested = body?.playerIds ?? [];
    if (requested.length < 2) return errorResponse('at least two playerIds required', 400);
    // Duplicates are rejected rather than quietly collapsed: silently comparing
    // three players when four were sent would be answering a different question.
    if (new Set(requested).size !== requested.length) return errorResponse('the same player was sent twice', 400);
    if (requested.length > MAX_COMPARE) {
      return errorResponse(`at most ${MAX_COMPARE} players can be compared at once`, 400);
    }

    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = body?.leagueId ? await leagueRepo.getLeague(body.leagueId) : await leagueRepo.getSelectedLeague();
    if (!league) return errorResponse('no league selected', 400);

    const playerRepo = new PlayerRepo(db);
    for (const id of requested) {
      if (!(await playerRepo.getById(id))) return errorResponse(`player ${id} not found`, 404);
    }

    const mode = normalizeMode(body?.mode ?? null);
    const [inputs, freshness] = await Promise.all([
      startSitInputsFor(db, requested, { mode }),
      new PropsRepo(db).freshness(),
    ]);

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);
    /*
     * Which lineup spot this is actually about.
     *
     * Sent alongside the ranking rather than instead of it: a comparison with no
     * legal shared slot still produces honest per-player numbers, and the screen
     * says plainly that they are not competing for the same spot instead of
     * printing "Start X" for a decision that does not exist.
     */
    const slot = resolveComparisonSlot(
      inputs.map((i) => i.player.position),
      shape,
      body?.slot ?? null,
    );

    const comparison = compareStartSit(inputs, profile, { mode });
    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      dataFreshness: freshness,
      slot,
      ...comparison,
    });
  });

  return (request, env) => router.handle(request, env);
}

/**
 * Everything the start/sit engine knows about a set of players.
 *
 * One function, used by the lineup, the head-to-head comparison and the waiver
 * scan alike, because the alternative is three copies that drift: a player who
 * is Questionable on one screen and healthy on another is not a display bug, it
 * is two different answers to a lineup question.
 *
 * A player missing from the dictionary is skipped rather than fatal — a gap in
 * the player list is not a reason to fail the whole screen.
 */
async function startSitInputsFor(
  db: Database,
  playerIds: string[],
  opts: { mode?: StartSitMode; context?: StartSitContext } = {},
): Promise<StartSitInput[]> {
  if (playerIds.length === 0) return [];
  const propsRepo = new PropsRepo(db);
  const [players, propsByPlayer, previousProps, kickoffs, signals] = await Promise.all([
    new PlayerRepo(db).listByIds(playerIds),
    propsRepo.latestForPlayers(playerIds),
    propsRepo.previousForPlayers(playerIds),
    propsRepo.kickoffsForPlayers(playerIds),
    new EvidenceRepo(db).getSignals(playerIds),
  ]);

  /*
   * Availability, resolved once for everybody.
   *
   * Sleeper's designation and the published injury report are combined here
   * rather than in the engine, so every screen reads the same state — and a
   * failure of the secondary source costs the practice detail and nothing else,
   * because the resolver falls back to Sleeper on its own.
   */
  const injuries = await new InjuryService(db)
    .statesFor([...players.values()].map((p) => ({ playerId: p.id, status: p.status })))
    .catch(() => new Map());

  /*
   * Per-game opportunity, for the role trend.
   *
   * Absent for a player with fewer than six games stored, which is the ordinary
   * state in September and is passed through as absent rather than padded:
   * `assessRole` answers `insufficient_data` for a short series, and that is the
   * honest answer rather than a trend invented from four games.
   */
  const usageService = new UsageService(db);
  const usage = await usageService
    .roleMetricsFor([...players.values()].map((p) => ({ playerId: p.id, position: p.position })))
    .catch(() => new Map());
  /*
   * The stored weeks themselves, for everything the trend series cannot answer.
   *
   * One extra indexed read for the same players, and it is what the opportunity
   * level, the role classification and the touchdown-dependency read are all
   * built from. A failure costs those three components and nothing else: they
   * report unknown, which is what they said before this pipeline existed.
   */
  const weeks = await usageService.weeksFor(playerIds).catch(() => new Map());

  /*
   * League-wide context, built once per request rather than once per player.
   *
   * The opponent table is a model over the whole season's games and the
   * schedule is one row per event — computing either inside the per-player loop
   * would turn one query into forty. `context` is passed in by callers that
   * have already built it for a different endpoint on the same request.
   */
  const context = opts.context ?? (await buildStartSitContext(db, usageService));

  const inputs: StartSitInput[] = [];
  for (const id of playerIds) {
    const player = players.get(id);
    if (!player) continue;
    const game = context.schedule.get((player.team ?? '').toUpperCase()) ?? null;
    inputs.push({
      player,
      props: propsByPlayer.get(id) ?? [],
      previousProps: previousProps.get(id) ?? [],
      // Absent means the schedule is unknown, which is never treated as a lock:
      // refusing a change the user can still make would be the app inventing a
      // restriction.
      kickoff: kickoffs.get(id) ?? null,
      signal: signals.get(id) ?? null,
      injuryStatus: player.status,
      injury: injuries.get(id) ?? null,
      usage: usage.get(id) ?? undefined,
      usageWeeks: weeks.get(id) ?? undefined,
      game: game ? { spread: game.spread, total: game.total, opponent: game.opponent } : null,
      opponent: game?.opponent ?? null,
      defenseTendencies: context.defense,
      mode: opts.mode ?? 'balanced',
      propsStale: false,
    });
  }
  return inputs;
}

/**
 * The things every player in a request shares: the slate, and the defences.
 *
 * Assembled once and handed to `startSitInputsFor`, because both halves are
 * league-wide models rather than per-player facts. Both degrade to empty
 * without failing the screen: no schedule means the game-script component says
 * "no game line", and no tendencies mean the matchup component says so too.
 */
export interface StartSitContext {
  /** Team abbreviation -> the game they are in, from the paid-for schedule. */
  schedule: Map<string, { opponent: string | null; spread: number | null; total: number | null; kickoff: string | null }>;
  defense: DefenseTendencyIndex;
}

export async function buildStartSitContext(
  db: Database,
  usageService = new UsageService(db),
  now = new Date(),
): Promise<StartSitContext> {
  const from = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  const to = new Date(now.getTime() + 9 * 86_400_000).toISOString();

  const [events, defense] = await Promise.all([
    new VegasEventsRepo(db).between(from, to).catch(() => []),
    usageService.defenseTendencies().catch(() => new Map() as DefenseTendencyIndex),
  ]);

  const schedule: StartSitContext['schedule'] = new Map();
  for (const event of events) {
    const sides = [event.homeTeam, event.awayTeam].filter((t): t is string => !!t).map((t) => t.toUpperCase());
    if (sides.length === 0) continue;
    for (const team of sides) {
      if (schedule.has(team)) continue;
      const opponent = sides.find((t) => t !== team) ?? null;
      /*
       * The spread, resolved against the team it was stored for.
       *
       * Never against a column position: `home_team` in this table means "a
       * team we asked about", so reading the spread as "the home team's" would
       * be backwards for half the slate. A spread whose team is not one of the
       * two sides is dropped rather than guessed at.
       */
      const spreadTeam = (event.spreadTeam ?? '').toUpperCase();
      const spread =
        event.spread == null || !spreadTeam || !sides.includes(spreadTeam)
          ? null
          : spreadTeam === team
            ? event.spread
            : -event.spread;
      schedule.set(team, { opponent, spread, total: event.total ?? null, kickoff: event.kickoff });
    }
  }

  return { schedule, defense };
}

/**
 * How many unrostered players per position the waiver scan will score.
 *
 * The pool is thousands of players and the intelligence is not free, so the
 * scan takes a bounded slice off the top of the draft order instead. Twelve is
 * comfortably past where a startable free agent is ever found, and it keeps the
 * whole scan to a few dozen players — which is what keeps Team quick on a phone.
 */
const FREE_AGENTS_PER_POSITION = 12;

/**
 * The best few unrostered players at each position this league starts.
 *
 * Ordered by the imported draft ranking, falling back to Sleeper's own
 * `search_rank` where no ranking covers a position. That is an ordering, not a
 * judgement — the actual comparison is the same start/sit engine everything else
 * uses, run afterwards on this shortlist.
 */
async function boundedFreeAgents(
  db: Database,
  opts: { rosteredIds: Set<string>; startable: Set<string> },
): Promise<string[]> {
  const adpRepo = new AdpRepo(db);
  const snapshot = await adpRepo.latest();
  const ranks = snapshot ? await adpRepo.valuesByPlayer(snapshot.id) : new Map();

  const available = (await new PlayerRepo(db).listAll()).filter(
    (p) =>
      p.active &&
      !opts.rosteredIds.has(p.id) &&
      (opts.startable.size === 0 || opts.startable.has(p.position)),
  );

  const byPosition = new Map<string, typeof available>();
  for (const p of available) {
    const bucket = byPosition.get(p.position);
    if (bucket) bucket.push(p);
    else byPosition.set(p.position, [p]);
  }

  const ids: string[] = [];
  for (const bucket of byPosition.values()) {
    bucket.sort(
      (a, b) =>
        (ranks.get(a.id)?.adp ?? Infinity) - (ranks.get(b.id)?.adp ?? Infinity) ||
        (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity) ||
        a.fullName.localeCompare(b.fullName),
    );
    for (const p of bucket.slice(0, FREE_AGENTS_PER_POSITION)) ids.push(p.id);
  }
  return ids;
}

/**
 * Fetch and cache Vegas props for every upcoming game.
 * Used by both the manual refresh endpoint and the scheduled worker.
 */
/** Non-empty body text, or null. Used only to report whether one was kept. */
/**
 * Which pick a player was, and who made it — from Sleeper's draft history.
 *
 * Answered from the selected league, because "drafted 1.02 by Joe" is a fact
 * about one league rather than about the player: the same man went in the
 * second round of one draft and the fourth of another, and a card that mixed
 * them would be worse than a card with no line at all.
 *
 * Every part degrades independently. No selected league, no draft, or no pick
 * for this player returns null and the card shows nothing; a pick whose seat
 * Sleeper never named still produces the pick, which is most of the value.
 */
async function draftProvenanceFor(
  db: Database,
  playerId: string,
): Promise<{ pickNo: number; pick: string; managerName: string | null; season: string | null; line: string } | null> {
  const leagues = new LeagueRepo(db);
  const league = (await leagues.listLeagues()).find((l) => l.isSelected) ?? null;
  if (!league?.draftId) return null;

  const draft = await leagues.getDraft(league.draftId);
  if (!draft) return null;

  const pick = (await leagues.listPicks(draft.id)).find((p) => p.playerId === playerId);
  if (!pick) return null;

  // The manager who actually holds the seat, named only if Sleeper named them.
  const rosters = await leagues.listRosters(league.id);
  const managerName =
    (rosters.find((r) => r.rosterId === pick.rosterId)?.ownerName ?? '').trim() || null;

  const teams = draft.teams || league.totalRosters || 12;
  const label = draftPickLabel(pick.pickNo, teams);
  if (!label) return null;

  return {
    pickNo: pick.pickNo,
    pick: label,
    managerName,
    season: draft.season ?? null,
    line: draftProvenanceLine({ pickNo: pick.pickNo, teams, managerName, season: draft.season }) ?? '',
  };
}

function bodyOf(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null;
}

/**
 * Hide most of an email address: `alex@gmail.com` -> `a***@gmail.com`.
 *
 * The site's reads are public because fantasy data is not sensitive. The
 * address of whoever mailed the inbound address is a different matter — it is
 * ordinarily the owner's own personal address, and anything else that arrives
 * belongs to a stranger. Enough is left to recognise a sender you expect;
 * not enough to harvest one.
 */
export function maskAddress(value: string | null | undefined): string | null {
  const address = value?.trim();
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  return `${local[0]}***${address.slice(at)}`;
}

/**
 * Mask every address inside a free-text field.
 *
 * Masking the structured `fromAddress` alone is not enough: plain-language
 * messages quote the sender too ("Unexpected sender ..."), so the address
 * escapes through the explanation. Redacting by pattern rather than by the one
 * address we happen to know also covers wording added later.
 */
export function maskAddressesIn(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (match) => maskAddress(match) ?? '***');
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Refresh weekly lines, inside the budget.
 *
 * This used to list every upcoming NFL game and fetch props for all of them.
 * The provider bills one entity per event returned and the free plan is 2,500 a
 * month, so a slate fetch on a timer was an unattended standing order — and the
 * games it paid for were mostly ones nobody on the roster is playing in.
 *
 * The work now lives in `VegasRefreshService`, which starts from the roster,
 * asks the budget before it spends, and records every entity. This wrapper is
 * kept because the scheduled worker and the manual route both call it, and
 * neither should have to know any of that.
 */
export async function refreshVegas(env: AppEnv, opts: { manual?: boolean } = {}): Promise<VegasRefreshReport> {
  return new VegasRefreshService(env.db, env.vegas).refresh(opts);
}
