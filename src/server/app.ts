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
import { nflTeam } from '../core/nfl/teams.ts';
import { reorderQueue } from '../core/draft/queueOrder.ts';
import { myGuy, toMyGuyLevel } from '../core/draft/decisions.ts';
import { buildLiveRoster } from '../core/draft/liveRoster.ts';
import { computeNeed } from '../core/draft/need.ts';
import { bestMove } from '../core/draft/bestMove.ts';
import { compareStartSit } from '../core/startsit/engine.ts';
import { recommendLineup } from '../core/startsit/lineup.ts';
import { assembleLineup } from '../core/startsit/assemble.ts';
import { assembleWaiverPlan } from '../core/waivers/assemble.ts';
import { SnapshotLossyError } from '../core/support/lossless.ts';
import { SnapshotUnavailable } from '../core/support/emit.ts';
import {
  IN_SEASON_KINDS,
  captureSupportSnapshot,
  isInSeasonKind,
} from './services/supportSnapshotService.ts';
import {
  NoDecision,
  boundedFreeAgents,
  gatherLineupInputs,
  gatherWaiverInputs,
} from './services/decisionInputs.ts';
import { normalizeMode } from '../core/startsit/mode.ts';
import { TALLY_WEIGHT, orderPlayers } from '../core/draft/playerOrder.ts';
import { aggregatePlayerSignal } from '../core/evidence/aggregate.ts';
import { normalizeName } from '../core/identity/normalize.ts';
import { ACCEPT_ANY_SENDER } from '../core/newsletter/pipeline.ts';
import { looksLikeBounceAddress, toEmailMessage } from '../core/newsletter/source.ts';
import { SleeperClient } from '../core/sleeper/client.ts';
import { positionMatchesFilter, resolveComparisonSlot } from '../core/sleeper/eligibility.ts';
import { resolveSeasonPhase, type NflState } from '../core/sleeper/phase.ts';
/* The same decision at the resolution draft-shaped features need. */
import { resolveLifecycle } from '../core/season/lifecycle.ts';
import { buildRolloverReport } from './services/rolloverService.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes, startablePositions } from '../core/sleeper/scoring.ts';
/*
 * The pricing, bench, ladder and free-agent assembly used to live in this file.
 * It moved into `core` unchanged when Demo Mode needed to run the same
 * arithmetic without a database behind it — one implementation, so a rehearsed
 * bid and a live one can never be two different numbers.
 */
/* Still used directly by handlers in this file. */
import { evaluatePlayer } from '../core/startsit/engine.ts';
import { buildHeldPlayers } from '../core/roster/held.ts';
import { buildLadderFor } from '../core/trades/ladderInputs.ts';
import type { ManagerTradeProfile } from '../core/managers/tradeProfile.ts';
import { evaluateBench } from '../core/roster/bench.ts';
import { buildLadder } from '../core/trades/ladder.ts';
import { LeagueStrategyService, readFinalWeek } from './services/leagueStrategyService.ts';
import { ManagerIntelService } from './services/managerIntelService.ts';
import { ManagerLedgerRepo } from './repos/managerLedger.ts';
import { VegasRefreshService, type VegasRefreshReport } from './services/vegasRefresh.ts';
import { VegasUsageRepo } from './repos/vegasUsage.ts';
import type { VegasProvider } from '../core/vegas/types.ts';
import type { Database } from './db.ts';
import {
  PUBLIC_PATHS,
  RateLimiter,
  checkPassphrase,
  clearDemoCookie,
  clearMockCookie,
  clearSessionCookie,
  createDemoCookie,
  createMockCookie,
  createSessionCookie,
  isDemoRequest,
  isMockRequest,
  isWrite,
  verifySession,
  type AuthEnv,
} from './http/auth.ts';
import { Router, errorResponse, jsonResponse } from './http/router.ts';
/* The demo's own control routes, named once and shared with the demo runtime. */
import { DEMO_CONTROL_PATHS } from '../core/demo/guard.ts';
/* The same, for a practice draft. See `core/draft/mockGuard.ts`. */
import { MOCK_CONTROL_PATHS, MOCK_READ_ONLY_POST } from '../core/draft/mockGuard.ts';
import { AdpRepo, UNDERDOG_SOURCE } from './repos/adp.ts';
import { validateRawAdp } from '../core/adp/underdog.ts';
import { EvidenceRepo } from './repos/evidence.ts';
import { LeagueRepo } from './repos/league.ts';
import { NewsletterRepo } from './repos/newsletter.ts';
import { DraftQueueRepo } from './repos/draftQueue.ts';
import { PlayerFlagsRepo } from './repos/playerFlags.ts';
import { PlayerRepo } from './repos/players.ts';
import { PropsRepo } from './repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from './repos/settings.ts';
import { DraftBoardService, draftBoardSourcesFromDatabase } from './services/draftBoard.ts';
import { captureDraftSnapshot, SnapshotRedactionError } from '../core/support/draftSnapshot.ts';
import { buildMockBoard, mockSnapshotSources, type MockAction } from '../core/draft/mockBoard.ts';
import { isUsableMockState } from '../core/draft/mockDraft.ts';
import { MockDraftVoidError } from '../core/draft/mockSources.ts';
import { InjuryService } from './services/injuryService.ts';
import { RepairService } from './services/repairService.ts';
import { SetupService } from './services/setupService.ts';
import { TradeService } from './services/tradeService.ts';
import { SmartTradeService } from './services/smartTradeService.ts';
import { MAX_BODY_BYTES, MAX_TALLY_BYTES, NewsletterService } from './services/newsletterService.ts';
import { SeasonMarketService, seasonFor } from './services/seasonMarketService.ts';
import { PreseasonProjectionService } from './services/preseasonProjectionService.ts';
import { PreseasonProjectionsRepo } from './repos/preseasonProjections.ts';
import { describeScoring, projectionScoringFrom, scoringKey } from '../core/startWho/scoring.ts';
import { DecisionFeedRepo } from './repos/decisionFeed.ts';
import { NO_XFP, assessXfp } from '../core/xfp/model.ts';
import type { NeedLevel } from '../core/league/competition.ts';
import { byeOutlook } from '../core/league/planning.ts';
import { findTradeFits, type TradeAsset, type TradeTeam } from '../core/league/tradeFit.ts';
import { SleeperSyncService } from './services/sleeperSync.ts';
/* Which season it is, from Sleeper's own state rather than from the clock. */
import { currentSeason } from './services/seasonService.ts';
import { StartSitRefreshService } from './services/startSitRefresh.ts';
/* The one assembly of everything the start/sit engine reads. Shared, not copied. */
import { startSitInputsFor } from './services/startSitInputs.ts';
/* And the one assembly of everything the defence planner reads. */
import { playoffContextFor } from './services/dstPlanService.ts';
import { NflScheduleRepo } from './repos/nflSchedule.ts';
import { MatchupService } from './services/matchupService.ts';
import { MatchupRepo, MIN_CALIBRATION_SAMPLE } from './repos/matchup.ts';
import { MATCHUP_MODEL_VERSION } from '../core/matchup/types.ts';
import { UsageService } from './services/usageService.ts';
import { NflverseService } from './services/nflverseService.ts';
import { ProjectionV2Service } from './services/projectionV2Service.ts';
import { classificationsByClass } from '../core/projection/classification.ts';
import { PlayerDetailService } from './services/playerDetailService.ts';
import { DataHealthService } from './services/dataHealthService.ts';
import { toSnapshotHealth } from '../core/health/snapshot.ts';
import type { SnapshotDataHealth } from '../core/support/schema.ts';

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
  /**
   * The exact git revision this deployment was built from, injected at deploy
   * time and reported by `/api/health` — so "what code is production running?"
   * is a question the site answers itself rather than one anybody has to infer
   * from the Actions tab. Null anywhere it was not injected (a local dev
   * server, a hand-run `wrangler deploy`), which reads as `unknown`.
   *
   * See docs/RELEASE.md.
   */
  releaseSha?: string | null;
}

/**
 * What `/api/health` says the running code is.
 *
 * Deliberately narrow: a revision or the word `unknown`, nothing else. A blank
 * or whitespace-only value is a failed injection rather than a revision, and
 * saying `unknown` is the honest answer to that — a smoke check comparing an
 * expected SHA against `unknown` fails, where one comparing against `""` could
 * be read as an empty match.
 */
export function reportedGitSha(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? 'unknown' : trimmed;
}

export function createApp(): (request: Request, env: AppEnv) => Promise<Response> {
  const router = new Router<AppEnv>();
  // Per-app instance, not module state, so limits are scoped to one deployment
  // (and one test) rather than leaking across everything in the process.
  const loginLimiter = new RateLimiter(8, 5 * 60_000);
  const refreshLimiter = new RateLimiter(4, 15 * 60_000);
  /*
   * The manager backfill gets its own, looser allowance.
   *
   * Four in fifteen minutes was the right number for a refresh that walked the
   * previous-league chain and cost dozens of requests. That refresh is gone: a
   * batch is now capped at twenty-four subrequests and checkpointed, so calling
   * it repeatedly is the *supported* way to fill a new league's ledger in
   * minutes rather than days — and the thing the free plan actually bounds is
   * requests per invocation, which no number here can change.
   *
   * Twelve, so a resync can run a handful of batches in a row and still leave
   * the endpoint bounded against a loop that has gone wrong.
   */
  const backfillLimiter = new RateLimiter(12, 15 * 60_000);

  /**
   * Reads are public; writes need an unlocked session.
   *
   * A deployment with no passphrase configured is read-only rather than wide
   * open — failing closed here is what stops an unconfigured public URL from
   * being editable by anyone who finds it.
   */
  /**
   * Demo Mode is read-only, and the server says so too.
   *
   * The demo serves its own data in the browser, so ordinarily nothing reaches
   * here at all while a scenario is running. This exists for the request that
   * does anyway — one made from a console, replayed from history, or fired by a
   * screen that forgot to disable a control. §2 asks for the refusal to happen
   * twice, in the UI and again below it, and this is the second one.
   *
   * It runs **before** the passphrase check and ignores it entirely: an
   * unlocked session is not permission to mutate anything during a demo. The
   * demo's own three routes are exempt, because leaving must never be blocked
   * by the thing you are trying to leave.
   */
  router.use(async (ctx) => {
    if (!ctx.url.pathname.startsWith('/api/')) return null;
    if (DEMO_CONTROL_PATHS.has(ctx.url.pathname)) return null;
    if (!isWrite(ctx.request.method)) return null;
    if (!isDemoRequest(ctx.request)) return null;
    return errorResponse(
      'Demo Mode is read-only. Nothing in a demo can change a lineup, a pick, a claim, a bid, a trade, a provider or the database. Leave Demo Mode in Settings to make changes.',
      403,
    );
  });

  /**
   * A mock draft is a rehearsal, and the server says so too.
   *
   * The second of the two refusals §4 asks for. The first is in the browser, at
   * the one seam every request in this app goes through; this one catches
   * whatever did not come through it — a call from a console, a replayed
   * request, a screen that forgot to disable a control.
   *
   * The exemptions are the mock's own routes, and both kinds are reads. The
   * three control paths change nothing but whether a rehearsal is running, and
   * *leaving* one must never be blocked by the thing you are trying to leave.
   * `/api/drafts/:id/mock/board` and its snapshot are POSTs only because a
   * mock's state does not fit in a query string — the same reason
   * `/api/startsit/compare` is one — and they build a board through
   * `DraftBoardSources`, an interface with no write on it.
   *
   * Like the demo guard above it, this runs *before* the passphrase check and
   * ignores it entirely: an unlocked session is not permission to mutate the
   * real draft while rehearsing it.
   */
  router.use(async (ctx) => {
    if (!ctx.url.pathname.startsWith('/api/')) return null;
    if (MOCK_CONTROL_PATHS.has(ctx.url.pathname)) return null;
    if (MOCK_READ_ONLY_POST.test(ctx.url.pathname)) return null;
    if (!isWrite(ctx.request.method)) return null;
    if (!isMockRequest(ctx.request)) return null;
    return errorResponse(
      'A mock draft is running, so this browser is read-only. Nothing in a rehearsal can change a real pick, ' +
        'a real queue, Sleeper, a provider or the database. Leave the mock draft to make changes.',
      403,
    );
  });

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
  /*
   * Small on purpose: is it up, which app is it, and which revision is it
   * running. `release.gitSha` is the whole of the version surface — no build
   * host, no branch, no environment dump — because everything else a debug
   * dump could carry is either already public in the repository or is
   * something a public endpoint should not be handing out.
   */
  router.get('/api/health', (ctx) =>
    jsonResponse({
      ok: true,
      service: 'fantasy-analyst',
      release: { gitSha: reportedGitSha(ctx.env.releaseSha) },
    }));

  /**
   * Whether what the app knew was healthy and current.
   *
   * The read half of the support loop, and the companion to
   * `/api/*​/support-snapshot`: that one says exactly what Junculator knew when
   * it made a decision, this one says whether what it knew was any good. A
   * questionable Draft or Week 1+ recommendation can be checked against both
   * without anybody opening Cloudflare, GitHub or D1.
   *
   * **Its own route, deliberately not part of `/api/health`.** That endpoint
   * has one job — is it up, which app is it, which revision is it running — and
   * the release gate compares its `release.gitSha` against the SHA it deployed.
   * Anything added there is a thing that can break the one check standing
   * between a bad deploy and production.
   *
   * **A GET, and everything about it is a read.** `DataHealthService` has no
   * write method, no refresh and no fetch: it reads state the shipped pipelines
   * already record and derives from it. It cannot run a cron, refresh a
   * provider, mutate D1, start manager ingestion or change a fantasy decision,
   * and `tests/dataHealth.isolation.test.ts` asserts that by watching every
   * statement it prepares rather than by describing it here.
   *
   * Public like every other read, and it carries nothing that would not be:
   * timestamps, canonical outcome words, bounded notes written for a person,
   * and the same revision `/api/health` already reports. No secrets, no
   * provider payloads, no raw exceptions, no identifiers.
   */
  router.get('/api/data-health', async (ctx) =>
    jsonResponse(
      await new DataHealthService(ctx.env.db, {
        vegas: ctx.env.vegas,
        releaseSha: ctx.env.releaseSha ?? null,
      }).view(),
    ));

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

  // -------------------------------------------------------------- demo mode
  /*
   * Three routes, and none of them touches a database.
   *
   * Demo Mode's *data* never comes from here — it is built in the browser from
   * versioned fixtures. What these do is set and clear the marker the guard
   * above reads, so that while a scenario is running the server refuses every
   * write from that browser regardless of what the UI does or does not send.
   *
   * `POST` rather than `GET` for enter and exit because they change something
   * (a cookie); they are in `PUBLIC_PATHS` because what they change is not
   * anybody's data, and because a reader with no passphrase must still be able
   * to leave.
   */
  router.post('/api/demo/enter', (ctx) =>
    jsonResponse({ demo: true }, 200, { 'set-cookie': createDemoCookie(ctx.env) }),
  );

  router.post('/api/demo/exit', (ctx) =>
    jsonResponse({ demo: false }, 200, { 'set-cookie': clearDemoCookie(ctx.env) }),
  );

  router.get('/api/demo/status', (ctx) => jsonResponse({ demo: isDemoRequest(ctx.request) }));

  // ------------------------------------------------------------- mock draft
  /*
   * The same three, for a practice draft, and for the same one reason.
   *
   * A mock's *state* never comes from here either — it lives in the browser and
   * is posted to `/mock/board` to be read once and dropped. These set and clear
   * the marker the guard above reads, so that while a rehearsal is running the
   * server refuses every write from that browser regardless of what the UI does
   * or does not send.
   */
  router.post('/api/mock/enter', (ctx) =>
    jsonResponse({ mock: true }, 200, { 'set-cookie': createMockCookie(ctx.env) }),
  );

  router.post('/api/mock/exit', (ctx) =>
    jsonResponse({ mock: false }, 200, { 'set-cookie': clearMockCookie(ctx.env) }),
  );

  router.get('/api/mock/status', (ctx) => jsonResponse({ mock: isMockRequest(ctx.request) }));

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
    const [players, leagues, evidence, identity, newsletters, props, adp] = await Promise.all([
      new PlayerRepo(db).count(),
      new LeagueRepo(db).listLeagues(),
      new EvidenceRepo(db).pendingCount(),
      new NewsletterRepo(db).pendingIdentityCount(),
      new NewsletterRepo(db).awaitingTallyCount(),
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
    const lifecycleInput = {
      state,
      league: selected ? { season: selected.season, status: selected.status ?? null } : null,
      draft: draft ? { status: draft.status } : null,
    };
    const season = resolveSeasonPhase(lifecycleInput);
    /*
     * The same decision at higher resolution, alongside rather than instead.
     *
     * `season` keeps its exact four-state shape so a client running against a
     * deployment older than this one — or newer, during the minutes a deploy
     * takes — is never handed a phase it does not recognise. `lifecycle` is the
     * eight-state answer for anything that needs to tell a draft that is open
     * from one that is live from one that finished a month ago.
     */
    const lifecycle = resolveLifecycle(lifecycleInput);

    return jsonResponse({
      players,
      leagues: leagues.length,
      selectedLeague: selected ? { id: selected.id, name: selected.name, season: selected.season } : null,
      pendingEvidence: evidence,
      pendingIdentity: identity,
      /*
       * Newsletters received and not yet scored.
       *
       * Counted here, beside the two review queues, because it is the third
       * kind of unfinished work the Setup destination carries — and because
       * counting all three from one read is what stops the mark on the bar and
       * the rows behind it from disagreeing. It is deliberately its own number
       * rather than folded into `pendingEvidence`: a newsletter awaiting a
       * tally is not an evidence item, and adding it to that count would make
       * the Review row claim work it does not hold.
       */
      pendingNewsletters: newsletters,
      vegas: { ...props, provider: ctx.env.vegas.name, configured: ctx.env.vegas.isConfigured() },
      adpSnapshot: adp,
      season,
      lifecycle,
    });
  });

  // ------------------------------------------------------------------- setup
  const setupService = (ctx: { env: AppEnv }) =>
    new SetupService(ctx.env.db, ctx.env.vegas, ctx.env.inboundAddress ?? null);

  router.get('/api/setup/status', async (ctx) => jsonResponse(await setupService(ctx).status()));

  /**
   * Is the app ready for this season?
   *
   * The check that replaces "open it in March and see if it looks right", which
   * is not a test: a screen full of last season's ADP renders perfectly. Every
   * source is asked for the *current* season by name and nothing is allowed to
   * answer with the newest thing it has.
   *
   * Read-only, no fetches, one indexed read per source — so it costs nothing to
   * run and can be run from a phone on a free tier at any time of year.
   */
  router.get('/api/diagnostics/rollover', async (ctx) => jsonResponse(await buildRolloverReport(ctx.env.db)));

  /**
   * Projection v2, beside what this app shows today. Phase 1, and nothing else.
   *
   * The evaluation gate the handoff calls for in section 21: for every player on
   * the connected team, the current market projection, the Rotowire fallback,
   * Projection v2, the difference, the floor and ceiling, the confidence, what
   * the market covered, how much usage is behind it and the reasons.
   *
   * **Nothing consumes this.** It is a report, not a source. `Team`, `Matchup`,
   * `Draft`, `Trades` and `Players` do not import `core/projection` at all and a
   * test asserts that, so this route can be read, deleted or ignored without any
   * recommendation in the app changing by a point. That is the phase boundary,
   * and it stays until the evaluation has been reviewed and a rollout is
   * explicitly approved.
   *
   * A GET, like every other diagnostic here: it reads and computes and writes
   * nothing at all.
   */
  router.get('/api/diagnostics/projection-v2', async (ctx) => {
    const leagues = new LeagueRepo(ctx.env.db);
    const requested = ctx.url.searchParams.get('league');
    const league = requested ? await leagues.getLeague(requested) : await leagues.getSelectedLeague();
    if (!league) return errorResponse('no league selected', 404);
    const weekParam = Number(ctx.url.searchParams.get('week'));
    const state = await new SettingsRepo(ctx.env.db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const week = Number.isFinite(weekParam) && weekParam > 0 ? weekParam : (state?.week ?? null);
    const report = await new ProjectionV2Service(ctx.env.db).sideBySide({ leagueId: league.id, week });
    return jsonResponse({
      league: { id: league.id, name: league.name },
      authoritative: false,
      note:
        'Projection v2 is computed side-by-side for evaluation only. No recommendation, ranking or ' +
        'simulation in this app reads it.',
      classification: classificationsByClass(),
      ...report,
    });
  });

  /** What the three nflverse feeds have, and how fresh it is. Read-only. */
  router.get('/api/diagnostics/nflverse', async (ctx) =>
    jsonResponse(await new NflverseService(ctx.env.db).health()),
  );

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
    /*
     * The season to import leagues for, from Sleeper rather than the clock.
     *
     * This used to be `String(new Date().getFullYear())`, which is wrong for
     * two months a year and wrong in the worst possible way: connecting on 1
     * January 2027 asked Sleeper for the 2027 leagues, a season that does not
     * exist until March, and got back an empty list. An empty list is
     * indistinguishable from "you are not in any leagues", so the user's first
     * experience of the app was it telling them they had no leagues while they
     * were looking at twelve of them in Sleeper.
     *
     * `connectUser` has just run, so `/state/nfl` may not have been read yet on
     * a first connect — the resolver's calendar fallback covers that, and it at
     * least uses the *league year* rather than the calendar year, so the
     * January answer is 2026 rather than 2027.
     */
    const season = body.season ?? (await currentSeason(ctx.env.db));
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
          // Which teams this room reaches for. Read by Setup, and by the Next%
          // model on the server; nothing else on a screen touches it.
          localTeams: l.localTeams ?? [],
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
      /*
       * The one line of advice the draft card carries.
       *
       * Derived from the need breakdown the draft engine already computes from
       * this league's own starting slots — not a second recommendation system
       * living in the screen. Sent even when the draft is over, because that
       * costs one small object and saves the client a branch; the card that
       * shows it is only drawn while `live` is true.
       */
      bestMove: bestMove(computeNeed(shape, liveRoster.counts)),
      found: !!mine,
    });
  });

  /**
   * Whole-roster start/sit: the best legal lineup, and how it differs from the
   * one currently set in Sleeper. Read-only in every sense — it reports a
   * difference, it does not act on it.
   */
  router.get('/api/leagues/:id/lineup', async (ctx) => {
    /*
     * Floor, Balanced or Ceiling, from the query string.
     *
     * A query parameter rather than stored state: the mode is a question the
     * user is asking right now, the answer is cheap to recompute, and a stored
     * preference would mean a lineup screen that silently answers a different
     * question from the one the control shows.
     */
    const mode = normalizeMode(ctx.url.searchParams.get('mode'));

    /*
     * The reads, from the one place that does them.
     *
     * `services/decisionInputs.ts` is shared with the support snapshot, so the
     * file somebody sends in describes the state this screen was drawn from
     * rather than a second gathering that happens to look similar.
     */
    let gathered;
    try {
      gathered = await gatherLineupInputs(ctx.env.db, ctx.env.sleeper, ctx.params['id']!, mode);
    } catch (err) {
      if (err instanceof NoDecision) {
        return err.status === 404
          ? errorResponse(err.message, 404)
          : jsonResponse({ league: { id: ctx.params['id']! }, found: false, error: err.message });
      }
      throw err;
    }
    const { league, mine, shape, profile, inputs, published, unknownPlayers, props } = gathered;

    /*
     * The whole decision, in one call.
     *
     * The optimiser, the weekly intelligence pass, the projection fallback and
     * the three sentences that explain an empty column, layered in `core` where
     * Demo Mode and the support replay reach the same function. See
     * `core/startsit/assemble.ts` for why the layering had to stop being spelled
     * out at each call site.
     *
     * `rosterShape` travels with it because the Team screen orders its
     * recommended starters by the league's own slots rather than by score, so a
     * backup quarterback never sits above a starting flex player on a
     * cross-position ranking that answers no question anybody asked.
     */
    const decision = assembleLineup({
      inputs,
      shape,
      profile,
      currentStarterIds: mine.starterIds,
      mode,
      published,
      unknownPlayers,
    });

    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      found: true,
      dataFreshness: props,
      ...decision,
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
    /*
     * The reads, from the one place that does them.
     *
     * `services/decisionInputs.ts` is shared with the support snapshot, so a
     * file somebody sends in describes the board this screen drew rather than a
     * second gathering that happens to look similar.
     */
    let gathered;
    try {
      gathered = await gatherWaiverInputs(ctx.env.db, ctx.env.sleeper, ctx.params['id']!);
    } catch (err) {
      if (err instanceof NoDecision) {
        return err.status === 404
          ? errorResponse(err.message, 404)
          : jsonResponse({
              league: { id: ctx.params['id']! },
              found: false,
              upgrades: [],
              headline: null,
              notes: [],
              considered: 0,
            });
      }
      throw err;
    }
    const { league, profile, props, strategy, pool, request } = gathered;

    /*
     * The whole decision, in one call.
     *
     * The lineup, the wire scan, multi-week value, the competition read, the
     * pricing, the defence, the board and the claims — layered in `core` where
     * Demo Mode and the support replay reach the same function. See
     * `core/waivers/assemble.ts` for the order and why it is that order.
     */
    const decision = await assembleWaiverPlan({ ...request, now: new Date() });

    const { lineup: _lineup, bids, ...board } = decision;
    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      found: true,
      dataFreshness: props,
      ...board,
      /** How the pool was bounded, so a thin answer is never a mystery. */
      pool,
      faab: strategy
        ? {
            rule: strategy.budget.rule,
            mine: strategy.budget.rosters.find((r) => r.isMine) ?? null,
            rosters: strategy.budget.rosters,
            prices: strategy.prices,
            losingBids: strategy.losingBids,
            bids,
            notes: strategy.notes,
            trendingCapturedAt: strategy.trendingCapturedAt,
          }
        : null,
    });
  });

  /**
   * Refresh the league-strategy inputs: transactions and the trending list.
   *
   * A write, and rate limited like every other manual refresh. Bounded to a few
   * weeks per call by the service itself, so an established league fills its
   * history over several refreshes rather than making eighteen requests in one.
   */
  router.post('/api/leagues/:id/strategy/refresh', async (ctx) => {
    const limit = refreshLimiter.check('strategy');
    if (!limit.allowed) return errorResponse(`refresh on cooldown; retry in ${limit.retryAfterSeconds}s`, 429);

    const db = ctx.env.db;
    const league = await new LeagueRepo(db).getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const state = await new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const service = new LeagueStrategyService(db, { sleeper: ctx.env.sleeper });
    const transactions = await service.syncTransactions({
      leagueId: league.id,
      sleeperLeagueId: league.sleeperLeagueId,
      season: league.season,
      week: state?.week ?? 1,
    });
    const trending = await service.captureTrending();
    return jsonResponse({ transactions, trending });
  });

  /**
   * Advance the manager-history backfill by one bounded batch, then rebuild.
   *
   * This used to walk the previous-league chain in full on every call — about
   * sixty-six Sleeper requests, against a free-plan ceiling of fifty, so it
   * failed. It now does at most twenty-four, checkpoints what it reached, and
   * leaves the rest for the daily clock: an established league fills over a few
   * days rather than in one invocation that cannot finish.
   *
   * Calling it repeatedly is the supported way to hurry a backfill along, and
   * each call is bounded the same way. Once history is stored it makes almost
   * no requests at all and simply re-derives.
   */
  router.post('/api/leagues/:id/managers/refresh', async (ctx) => {
    const limit = backfillLimiter.check('managers');
    if (!limit.allowed) return errorResponse(`refresh on cooldown; retry in ${limit.retryAfterSeconds}s`, 429);

    const db = ctx.env.db;
    const league = await new LeagueRepo(db).getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const state = await new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const result = await new ManagerIntelService(db, { sleeper: ctx.env.sleeper }).advance({
      leagueId: league.id,
      sleeperLeagueId: league.sleeperLeagueId,
      season: league.season,
      week: state?.week ?? 1,
    });

    /*
     * The keys the resync workflow already prints, kept meaning what they
     * meant, plus what a partial backfill needs to be legible: how much is
     * left, whether the budget or the work ended the batch, and what it cost.
     */
    return jsonResponse({
      seasons: result.seasons,
      picks: result.derived?.picks ?? 0,
      trades: result.derived?.trades ?? 0,
      transactions: result.derived?.transactions ?? 0,
      rosters: result.derived?.rosters ?? 0,
      tendencies: result.derived?.draftProfiles ?? 0,
      tradeProfiles: result.derived?.tradeProfiles ?? 0,
      transactionProfiles: result.derived?.transactionProfiles ?? 0,
      backfill: {
        requestsUsed: result.requestsUsed,
        requestBudget: result.requestBudget,
        budgetBound: result.budgetBound,
        unitsCompleted: result.completed.length,
        outstanding: result.outstanding,
        complete: result.complete,
        steps: result.completed.map((c) => `${c.kind} ${c.detail}`),
      },
      errors: result.errors,
    });
  });

  /**
   * What the manager-history subsystem knows, and what it is still missing.
   *
   * Developer-facing and read-only. It exists because a backfill that quietly
   * stopped and a league with genuinely no history produce identical empty
   * profiles, and only this can tell them apart.
   */
  router.get('/api/diagnostics/manager-intelligence', async (ctx) => {
    const db = ctx.env.db;
    const league = await new LeagueRepo(db).getSelectedLeague();
    if (!league) return jsonResponse({ league: null, reason: 'no league is selected' });

    const state = await new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const coverage = await new ManagerIntelService(db).coverage({
      leagueId: league.id,
      season: league.season,
      week: state?.week ?? 1,
    });
    return jsonResponse({ league: { id: league.id, name: league.name, season: league.season }, ...coverage });
  });

  /** What has been learned about the people in this league. Read-only. */
  router.get('/api/leagues/:id/managers', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const rosters = await leagueRepo.listRosters(league.id);
    const intel = new ManagerIntelService(db);
    /*
     * Two families of profile, filed two ways, and both are wanted here.
     *
     * `profiles` are the roster-keyed caches the screens read. `tendencies` and
     * `history` come from the ledger and are keyed by Sleeper user id, which is
     * the identity that survives a season boundary — so they are looked up
     * *from* the current roster table rather than the other way round, and a
     * seat that changed hands finds its new occupant's history or none at all.
     */
    const [profiles, tendencies, history, baseline] = await Promise.all([
      new LeagueStrategyService(db, { sleeper: ctx.env.sleeper }).managerProfiles(league.id),
      intel.tradePartners({ leagueId: league.id, rosters }),
      intel.waiverHistory({ leagueId: league.id, rosters, week: 1, finalWeek: readFinalWeek(league.leagueSettings) }),
      new ManagerLedgerRepo(db).baseline<unknown>(league.id, 'transaction'),
    ]);

    return jsonResponse({
      league: { id: league.id, name: league.name },
      room: profiles.room,
      /** What the room does, so a manager's numbers can be read against it. */
      baseline: baseline?.value ?? null,
      managers: rosters.map((roster) => ({
        rosterId: roster.rosterId,
        ownerName: roster.ownerName,
        isMine: roster.isMine,
        trade: profiles.trade.get(roster.rosterId) ?? null,
        draft: profiles.draft.get(roster.rosterId) ?? null,
        /** Trade behaviour from the ledger. Null until the backfill reaches it. */
        tradeTendencies: (roster.ownerId ? tendencies.get(roster.ownerId) : null) ?? null,
        /** Waiver behaviour from the ledger, on the same terms. */
        transactions: history?.profiles.get(roster.rosterId) ?? null,
      })),
    });
  });

  /**
   * What each bench slot is earning, and which ones are earning least.
   *
   * Deliberately its own endpoint rather than a field on the roster: it needs
   * the free-agent pool scored, which is the same bounded scan the waiver
   * advice does, and a roster view should not pay for it.
   */
  router.get('/api/leagues/:id/bench', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    if (!mine) return jsonResponse({ found: false, dropCandidates: [], ranked: [], notes: [] });

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);
    const rosteredIds = new Set<string>();
    for (const roster of rosters) for (const id of roster.playerIds) rosteredIds.add(id);
    const candidateIds = await boundedFreeAgents(db, { rosteredIds, startable: startablePositions(shape) });

    const [rosterInputs, candidateInputs] = await Promise.all([
      startSitInputsFor(db, mine.playerIds),
      startSitInputsFor(db, candidateIds),
    ]);

    const lineup = recommendLineup(rosterInputs, shape, profile, { currentStarterIds: mine.starterIds });
    const advice = evaluateBench(
      buildHeldPlayers({ rosterInputs, candidateInputs, lineup, profile, reserveIds: mine.reserveIds }),
    );

    return jsonResponse({
      found: true,
      league: { id: league.id, name: league.name },
      ...advice,
    });
  });

  /**
   * This week's head-to-head, with Fantasy Analyst's own forecast over it.
   *
   * Sleeper is the authority for the pairing, the lineups and the score;
   * everything else on the response — the projected finals, the win
   * probability, the insight cards, the lineup counterfactuals — is this app's
   * own model, built from the same start/sit engine every other screen uses.
   *
   * A read, and nothing but a read.
   *
   * It used to record what it forecast to the calibration ledger on the way
   * out, which the final audit caught as F-01: the write guard is method-based,
   * so a `GET` was waved through as safe while it inserted and updated rows —
   * including for a browser in Demo Mode, whose whole guarantee is that it
   * cannot touch live data. Grading the model still matters, so the ledger did
   * not go away; it moved to the worker's own clock, where a write is a write.
   * See `MatchupService.captureCalibration`.
   */
  router.get('/api/leagues/:id/matchup', async (ctx) => {
    const league = await new LeagueRepo(ctx.env.db).getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);
    const requested = ctx.url.searchParams.get('week');
    const service = new MatchupService(ctx.env.db, { sleeper: ctx.env.sleeper });
    return jsonResponse(
      await service.forLeague(league.id, { week: requested == null ? null : Number(requested) }),
    );
  });

  /**
   * How well the matchup win probability has actually held up.
   *
   * Read-only, and honest about the sample: a band with fewer than the
   * module's minimum settled weeks reports its count and no rate at all, because
   * "we said 70% and it happened 50% of the time" off six samples is noise
   * presented as a finding.
   */
  router.get('/api/diagnostics/matchup-calibration', async (ctx) => {
    const version = ctx.url.searchParams.get('model');
    const repo = new MatchupRepo(ctx.env.db);
    const report = await repo.calibration(version ?? undefined);
    return jsonResponse({
      modelVersion: version ?? MATCHUP_MODEL_VERSION,
      minSample: MIN_CALIBRATION_SAMPLE,
      ...report,
    });
  });

  // ----------------------------------------------------- league intelligence
  //
  // The waiver board, manager profiles and FAAB pricing live above, in the
  // routes `main` owns. What follows is only what those surfaces do not
  // already answer: the deals worth proposing, the weeks ahead, and what
  // changed since you last looked.

  /**
   * Bilateral trade fits, and the timing calls behind them.
   *
   * Values on both sides come from the same weekly engine, so "what they gain"
   * is measured the same way as "what I gain" — a trade tool whose two sides
   * are scored differently is just an argument for whatever the author wanted.
   */
  router.get('/api/leagues/:id/trade-fit', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine);
    if (!mine) {
      return jsonResponse({
        league: { id: league.id, name: league.name },
        found: false,
        ideas: [],
        notes: ['your own roster is not identified, so there is nobody to trade on behalf of'],
      });
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    /*
     * Partner tendencies come from the canonical trade profiles.
     *
     * Cached and keyed by roster id by `ManagerProfileRepo`, built from the
     * league's own transaction history by `core/managers/tradeProfile.ts`.
     * There is deliberately no second profile here: plausibility reads the same
     * record the Trades ladder reads, so the two cannot disagree about whether
     * somebody trades.
     */
    const profiles = await new LeagueStrategyService(db, { sleeper: ctx.env.sleeper })
      .managerProfiles(league.id)
      .catch(() => null);
    const tradeProfiles = new Map<number, ManagerTradeProfile>(
      [...(profiles?.trade ?? new Map()).entries()].map(([rosterId, cached]) => [rosterId, cached.profile]),
    );

    const teams: TradeTeam[] = [];
    for (const roster of rosters) {
      const inputs = await startSitInputsFor(db, roster.playerIds);
      const evaluated = inputs.map((i) => evaluatePlayer(i, profile)).filter((e) => e.score != null);
      const weeksById = new Map(inputs.map((i) => [i.player.id, i.usageWeeks ?? []]));

      const byPosition = new Map<string, typeof evaluated>();
      for (const e of evaluated) {
        const bucket = byPosition.get(e.position) ?? [];
        bucket.push(e);
        byPosition.set(e.position, bucket);
      }
      for (const bucket of byPosition.values()) bucket.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const needs: Record<string, NeedLevel> = {};
      const assets: TradeAsset[] = [];
      for (const [position, bucket] of byPosition) {
        const required = shape.starters[position] ?? 0;
        const flexEligible = shape.flex.some((f) => f.positions.includes(position));
        needs[position] =
          bucket.length < required ? 'urgent' : flexEligible && bucket.length <= required ? 'thin' : 'covered';

        bucket.forEach((e, index) => {
          const weeks = weeksById.get(e.playerId) ?? [];
          const xfp = weeks.length > 0 ? assessXfp(position, weeks, profile) : NO_XFP;
          assets.push({
            playerId: e.playerId,
            name: e.name,
            position,
            value: round2(e.score ?? 0),
            // Surplus means the team can still field the position without him:
            // anybody beyond the dedicated starting slots.
            surplus: index >= required,
            /*
             * Expected points, from the model Channel 3 published.
             *
             * Two of the five timing calls were dormant while nothing measured
             * opportunity against production; `assessXfp` does, off the usage
             * weeks this route already loaded. Zero games yields `NO_XFP`, whose
             * per-game figures are null, and the timing rules require both sides
             * before they say anything — so an unmeasured player still produces
             * no call rather than a call built on a default.
             */
            timing: {
              tdShare: e.tdDependency.share ?? null,
              roleTrend: e.role.trend,
              xfpPerGame: xfp.xfpPerGame,
              fpPerGame: xfp.actualPerGame,
            },
          });
        });
      }
      // A position nobody on the roster plays is a hole, and it will not appear
      // in the loop above because there is nothing to iterate.
      for (const position of Object.keys(shape.starters)) {
        if (!(position in needs) && (shape.starters[position] ?? 0) > 0) needs[position] = 'urgent';
      }

      const profileForTeam = tradeProfiles.get(roster.rosterId);
      teams.push({
        rosterId: roster.rosterId,
        userId: roster.ownerId,
        displayName: roster.ownerName ?? `Roster ${roster.rosterId}`,
        assets,
        needs,
        ...(profileForTeam ? { profile: profileForTeam } : {}),
      });
    }

    const me = teams.find((t) => t.rosterId === mine.rosterId)!;
    const partners = teams.filter((t) => t.rosterId !== mine.rosterId);
    const ideas = findTradeFits(me, partners).slice(0, 12);

    return jsonResponse({
      league: { id: league.id, name: league.name },
      found: true,
      ideas,
      partners: partners.length,
      notes:
        tradeProfiles.size === 0
          ? ['no manager trade history has been synced, so plausibility is untested rather than measured']
          : [],
    });
  });

  /**
   * Bye-week and playoff planning.
   *
   * Quiet by design: it says nothing at all unless a bye inside the lookahead
   * window actually leaves a slot short, and playoff weeks carry no weight
   * until the season has said something about whether this team will be there.
   */
  router.get('/api/leagues/:id/plan', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    const shape = buildRosterShape(league.rosterPositions);
    const state = await new SleeperSyncService(db, ctx.env.sleeper).getNflState();
    const currentWeek = state?.week ?? 1;

    const players = mine ? await new PlayerRepo(db).listByIds(mine.playerIds) : new Map();
    const starters = new Set(mine?.starterIds ?? []);

    /*
     * Byes, from the fixture list this app now stores.
     *
     * They used to be `null` for everybody, with a note saying so: Sleeper's
     * player dictionary does not carry a bye — checked against the live
     * payload, which has forty-nine fields and no bye — and until migration
     * 0032 there was no schedule to derive one from. There is now, and a bye is
     * the *absence* of a fixture in it rather than a stored field, so a hole in
     * an ingest cannot masquerade as a week off: a team with no rows at all
     * reports no bye instead of thirteen.
     *
     * One read of one season, and the map is per team rather than per player —
     * a bye belongs to a team and every player on it shares one.
     */
    const scheduleRows = await new NflScheduleRepo(db).season(league.season).catch(() => []);
    const byeByTeam = new Map<string, number>();
    if (scheduleRows.length > 0) {
      const weeksSeen = new Map<string, Set<number>>();
      let lastWeek = 0;
      for (const row of scheduleRows) {
        lastWeek = Math.max(lastWeek, row.week);
        const team = row.team.toUpperCase();
        const seen = weeksSeen.get(team) ?? new Set<number>();
        if (row.opponent) seen.add(row.week);
        weeksSeen.set(team, seen);
      }
      for (const [team, seen] of weeksSeen) {
        for (let week = 1; week <= lastWeek; week++) {
          if (!seen.has(week)) {
            byeByTeam.set(team, week);
            break;
          }
        }
      }
    }

    const roster = [...players.values()].map((p) => ({
      playerId: p.id,
      name: p.fullName,
      position: p.position,
      byeWeek: byeByTeam.get((p.team ?? '').toUpperCase()) ?? null,
      starter: starters.has(p.id),
    }));

    const byes = byeOutlook({ roster, shape, currentWeek });
    /*
     * The playoff weeks and their weight, through the one reader.
     *
     * Shared with the defence planner rather than computed twice: a stash that
     * thought the playoffs began in week 15 while this screen said 14 would be
     * a roster spot spent on the wrong month, and the league publishes the
     * answer.
     */
    const playoffs = playoffContextFor({
      leagueSettings: league.leagueSettings,
      rosters,
      mine,
      totalRosters: league.totalRosters,
      currentWeek,
    });

    return jsonResponse({
      league: { id: league.id, name: league.name },
      currentWeek,
      byes: {
        ...byes,
        available: scheduleRows.length > 0,
        note:
          scheduleRows.length > 0
            ? `byes are derived from the stored ${league.season} fixture list`
            : 'no schedule has been ingested yet, so bye planning reports nothing rather than an all-clear',
      },
      playoffs: {
        startWeek: playoffs.startWeek,
        weeks: playoffs.weeks,
        /*
         * Whether that week came from the league or from the standard fallback.
         * A reader told the playoffs start in week 15 deserves to know whether
         * the league said so or the app assumed it.
         */
        startWeekPublished: playoffs.startWeekPublished,
        record: playoffs.record,
        weight: playoffs.emphasis,
        reason: playoffs.reason,
      },
    });
  });

  /** What changed since you last looked. Empty is the ordinary answer. */
  router.get('/api/leagues/:id/feed', async (ctx) => {
    const leagueRepo = new LeagueRepo(ctx.env.db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);
    const events = await new DecisionFeedRepo(ctx.env.db).listOpen(league.id);
    return jsonResponse({
      league: { id: league.id, name: league.name },
      events,
      unseen: events.filter((e) => e.seenAt == null).length,
    });
  });

  router.post('/api/leagues/:id/feed/seen', async (ctx) => {
    const leagueRepo = new LeagueRepo(ctx.env.db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);
    return jsonResponse(await new DecisionFeedRepo(ctx.env.db).markSeen(league.id));
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

  /**
   * The whole state behind this board, in one file the user can send somebody.
   *
   * The support workflow's first step. It builds the board through a recording
   * proxy over the same sources `/board` uses, redacts every identity, bounds
   * the player table to the players who can reach the answer, and returns a
   * `junculator/support-snapshot@1` document that replays deterministically
   * with no network — see `core/support/schema.ts`.
   *
   * **A GET, and everything about it is a read.** `DraftBoardSources` has no
   * write on it, so that is a property of the type rather than a promise. It
   * also syncs nothing and refreshes nothing: a diagnostic that went and
   * fetched fresher data would be changing the thing being diagnosed, and the
   * board this describes is the board the user is looking at.
   *
   * The deployed revision comes from the same `releaseSha` `/api/health`
   * reports, so a snapshot names a revision that actually shipped rather than
   * one somebody typed. Where none was injected it is `unknown`, which is the
   * honest answer for a local server and reads as one.
   *
   * A capture that would have contained something a snapshot must never carry
   * is refused with a 500 and the field named, rather than emitted with the
   * offending value quietly dropped — a partly-redacted file is worse than
   * none, because it looks safe.
   */
  router.get('/api/drafts/:id/support-snapshot', async (ctx) => {
    const sources = draftBoardSourcesFromDatabase(ctx.env.db);
    try {
      return jsonResponse(
        await captureDraftSnapshot(sources, {
          draftId: ctx.params['id']!,
          gitSha: reportedGitSha(ctx.env.releaseSha),
          dataHealth: await snapshotHealth(ctx.env),
          position: ctx.url.searchParams.get('position'),
          queuedOnly: ctx.url.searchParams.get('queued') === '1',
        }),
      );
    } catch (err) {
      if (err instanceof SnapshotRedactionError) return errorResponse(err.message, 500);
      throw err;
    }
  });

  /**
   * A practice draft: one action applied, one board built, nothing stored.
   *
   * **A POST, and everything about it is a read.** It is a POST for exactly the
   * reason `/api/startsit/compare` is one — the request carries a state that
   * does not fit in a query string — and it is on the mock guard's allow-list
   * for that reason and no other. It writes nothing: the board is built through
   * `mockSources.ts` over `DraftBoardSources`, an interface with no write on
   * it, so that is a property of the type rather than a promise.
   *
   * The rehearsal's state arrives in the body and leaves in the response. There
   * is no mock table and no mock column; a mock draft exists in the reader's
   * browser, keyed by the `draft_id` it rehearses, and this server never keeps a
   * byte of one. That is the isolation requirement discharged by not having a
   * place to violate it.
   *
   * A 409 means the real draft has started, at which point the mock for that
   * `draft_id` does not exist any more — the browser deletes its copy on seeing
   * this, and a client that has not noticed cannot get a board regardless.
   */
  router.post('/api/drafts/:id/mock/board', async (ctx) => {
    const body = (await ctx.json<{
      state?: unknown;
      action?: MockAction;
      limit?: number;
      position?: string | null;
      queuedOnly?: boolean;
    }>()) ?? {};
    const action = body.action ?? { kind: 'resume' as const };
    /*
     * The seed and the clock are stamped here, not in `core/`.
     *
     * A mock has to be a *different* draft every time it is started, which is
     * the one thing a pure module cannot arrange for itself. So the request
     * boundary — which is allowed to know what time it is — supplies both, and
     * everything downstream of them is deterministic in the state they produce.
     */
    const stamped: MockAction =
      action.kind === 'start'
        ? { kind: 'start', seed: Date.now() >>> 0, startedAt: new Date().toISOString() }
        : action;
    try {
      return jsonResponse(
        await buildMockBoard(draftBoardSourcesFromDatabase(ctx.env.db), {
          draftId: ctx.params['id']!,
          state: body.state ?? null,
          action: stamped,
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
          position: body.position ?? null,
          queuedOnly: body.queuedOnly === true,
        }),
      );
    } catch (err) {
      if (err instanceof MockDraftVoidError) return errorResponse(err.message, 409);
      throw err;
    }
  });

  /**
   * The same support file, captured from a rehearsal.
   *
   * Explicitly asked for by the brief: Mock Draft doubles as a way to
   * troubleshoot or demonstrate the Draft experience outside a live draft
   * window, and a capture is what makes that useful to somebody who is not
   * holding the phone. It goes through `captureDraftSnapshot` — the same
   * recorder, the same redaction, the same seal — over the mock's sources.
   *
   * The one difference is that the file says so. `rehearsal` marks it in the
   * envelope, above the decision, because a mock snapshot replays exactly as
   * cleanly as a real one and nothing inside the payload would ever hint that
   * the board it describes never happened.
   *
   * A POST for the same reason as the board above, and a read for the same
   * reason as the GET it mirrors.
   */
  router.post('/api/drafts/:id/mock/support-snapshot', async (ctx) => {
    const body = (await ctx.json<{ state?: unknown }>()) ?? {};
    const draftId = ctx.params['id']!;
    if (!isUsableMockState(body.state, draftId)) {
      return errorResponse('there is no mock draft for this draft to capture', 400);
    }
    const state = body.state;
    const sources = draftBoardSourcesFromDatabase(ctx.env.db);
    try {
      return jsonResponse(
        await captureDraftSnapshot(await mockSnapshotSources(sources, draftId, state), {
          draftId,
          gitSha: reportedGitSha(ctx.env.releaseSha),
          dataHealth: await snapshotHealth(ctx.env),
          position: null,
          queuedOnly: false,
          rehearsal: { kind: 'mock', picksMade: state.picks.length, seed: state.seed },
        }),
      );
    } catch (err) {
      if (err instanceof MockDraftVoidError) return errorResponse(err.message, 409);
      if (err instanceof SnapshotRedactionError) return errorResponse(err.message, 500);
      throw err;
    }
  });

  /**
   * The same file, for whichever in-season decision the reader was looking at.
   *
   * One route rather than five, because the user has one button: Setup infers
   * the decision from the screen they came from and names it here. The five
   * kinds are the five in-season surfaces — `lineup`, `matchup`, `waiver-plan`,
   * `dst-plan`, `trade-offer` — and Draft keeps the route above, unchanged,
   * because it is keyed by a draft rather than by a league.
   *
   * **A GET, and everything about it is a read.** Every input comes through
   * `services/decisionInputs.ts`, which is the same module the corresponding
   * screen reads, so a capture cannot see a state the screen could not. It
   * syncs nothing, refreshes nothing and writes nothing — a diagnostic that
   * fetched fresher data would be changing the thing being diagnosed.
   *
   * A capture that would have contained something a snapshot must never carry —
   * an identity, or a value the wire would silently alter — is refused with a
   * 500 and the field named, rather than emitted with the offending value
   * quietly dropped.
   */
  router.get('/api/leagues/:id/support-snapshot', async (ctx) => {
    const context = ctx.url.searchParams.get('context');
    if (!isInSeasonKind(context)) {
      return errorResponse(
        `context must be one of ${IN_SEASON_KINDS.join(', ')}; got ${JSON.stringify(context)}`,
        400,
      );
    }
    const week = ctx.url.searchParams.get('week');
    try {
      return jsonResponse(
        await captureSupportSnapshot({
          db: ctx.env.db,
          sleeper: ctx.env.sleeper,
          leagueId: ctx.params['id']!,
          context,
          gitSha: reportedGitSha(ctx.env.releaseSha),
          dataHealth: await snapshotHealth(ctx.env),
          mode: ctx.url.searchParams.get('mode'),
          week: week == null ? null : Number(week),
        }),
      );
    } catch (err) {
      if (err instanceof NoDecision) return errorResponse(err.message, err.status);
      /*
       * "There is nothing to capture" is an answer, not a failure — a league
       * with no matchup this week, or one that starts no defence, has no
       * decision for the file to be about. The sentence the screen would have
       * shown is a better response than an empty snapshot.
       */
      if (err instanceof SnapshotUnavailable) return errorResponse(err.message, err.status);
      if (err instanceof SnapshotRedactionError || err instanceof SnapshotLossyError) {
        return errorResponse(err.message, 500);
      }
      throw err;
    }
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

  /**
   * Which NFL teams this league's room drafts earlier than the market.
   *
   * A property of twelve people, not of the players: a Detroit-area league
   * takes Lions early. It is set by hand because Sleeper does not publish it
   * and never will, and it is stored on the league rather than globally because
   * two of the user's leagues can easily have different rooms.
   *
   * It reaches exactly one model — opponent demand, which is what `Next%` is
   * computed from — and it cannot reach a Score, a tier or a `Val`. See
   * core/draft/nextpick/teamPrior.ts for why, and for the bound.
   */
  router.post('/api/leagues/:id/local-teams', async (ctx) => {
    const body = await ctx.json<{ teams?: unknown }>();
    if (!Array.isArray(body?.teams)) return errorResponse('teams must be an array of NFL team codes', 400);
    const leagues = new LeagueRepo(ctx.env.db);
    const league = await leagues.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    /*
     * Only real teams. An unknown code would sit in the settings looking
     * effective and match nobody, which is the most confusing possible
     * outcome — the board would report a prior that provably does nothing.
     */
    const requested = body.teams.map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    const unknown = requested.filter((code) => nflTeam(code) == null);
    if (unknown.length > 0) return errorResponse(`unknown NFL team code: ${unknown.join(', ')}`, 400);

    return jsonResponse({ localTeams: await leagues.setLocalTeams(league.id, requested) });
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
    //
    // The *platform* snapshot, not the newest of anything: this list shows one
    // ranking and calls it the draft order, and once an Underdog snapshot
    // exists "the newest" is the Underdog one on any day it was fetched last.
    const snapshot = await new AdpRepo(ctx.env.db).latestPlatformSnapshot();
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
      /*
       * The user's own opinion, alongside the ledger and never mixed into it.
       *
       * No `queued` here. A queue belongs to a draft and this route has none —
       * a player file is read from the players list, from search and from a
       * link, none of which is inside a draft. Answering `false` would be a
       * claim about a draft nobody named; the ★ state is served by
       * `/api/drafts/:id/queue` and rendered by the board, which knows.
       */
      myGuy: myGuy(flag.level),
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

  /**
   * The three nflverse feeds Projection v2 added, on demand.
   *
   * The daily 09:00 cron is the real schedule. This is for the person who wants
   * the crosswalk populated now rather than tomorrow -- and for the first run
   * after a deploy, when the tables are empty and every projection is
   * market-only for want of a roster file.
   *
   * Returns one run per feed rather than an ok. `not_published` is a fact about
   * the calendar -- `snap_counts_2026.csv` is a 404 until the season starts --
   * and must not read as a failure.
   *
   * A change, so it needs the passphrase.
   */
  router.post('/api/nflverse/refresh', async (ctx) =>
    jsonResponse({ runs: await new NflverseService(ctx.env.db).refreshAll() }),
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
   * from the draft queue, which is a bookmark inside one draft and moves
   * nothing — this is an opinion about a player and outlives every draft he is
   * in. Level 0 clears it.
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
    });
  });

  // ------------------------------------------------------------ draft queue
  /*
   * THE QUEUE BELONGS TO A DRAFT, AND THESE ROUTES SAY SO IN THEIR PATHS.
   *
   * These used to be `/api/players/:id/queue` and `/api/queue`, with no draft
   * anywhere in them, because the stored queue had no draft in it either — one
   * global list keyed by player id, shown by whichever draft happened to be
   * open. A user queued players in a finished best-ball draft, switched
   * leagues, and found that shortlist waiting in the new one.
   *
   * Putting the draft in the path is the fix at the level the bug was at. There
   * is now no route, and no repository method, that can read or write a queue
   * without naming the draft it is for: a caller that does not know which draft
   * it is in cannot ask. Every one of them 404s on a draft that does not exist,
   * so a typo cannot open an orphan queue that no board will ever show.
   *
   * `draft_queue` rows are keyed on the Sleeper draft id rather than the
   * league's, because a league keeps its id across seasons and would leak last
   * August's shortlist into this August's draft.
   */

  /**
   * Put a player in this draft's queue, or take him out.
   *
   * A bookmark, nothing more: it is how the ★ filter finds the player you meant
   * to take, and it deliberately has no effect on the ranking. Rating a player
   * is what the heart on the players list is for, and that is a different mark
   * in a different table that is not scoped to a draft at all.
   */
  router.post('/api/drafts/:id/queue', async (ctx) => {
    const draft = await new LeagueRepo(ctx.env.db).getDraft(ctx.params['id']!);
    if (!draft) return errorResponse('draft not found', 404);
    const body = await ctx.json<{ playerId?: string; queued?: boolean }>();
    if (!body?.playerId) return errorResponse('playerId required', 400);
    if (typeof body.queued !== 'boolean') return errorResponse('queued must be true or false', 400);
    const player = await new PlayerRepo(ctx.env.db).getById(body.playerId);
    if (!player) return errorResponse('player not found', 404);

    const queued = await new DraftQueueRepo(ctx.env.db).setQueued(draft.id, player.id, body.queued);
    return jsonResponse({ draftId: draft.id, playerId: player.id, name: player.fullName, queued });
  });

  /**
   * Move a queued player to a new position in the user's own order.
   *
   * The reorder itself is `reorderQueue` in core — pure, tested, and the only
   * thing that decides what a drag means. This route's whole job is to read
   * this draft's stored ladder, hand it to that function, and persist the one
   * or two rows it says moved. It deliberately does not accept a whole ordering
   * from the client: a client that could post a sequence could post a stale
   * one, and a queue silently reverting to what it looked like two picks ago is
   * exactly the corruption this feature must not have.
   *
   * There is no reconciliation step any more, and its absence is the schema
   * being right rather than a check being dropped. Membership and rank were two
   * nullable columns that could disagree — a player starred by a path that set
   * no rank had one and not the other — so the read had to repair them on the
   * way past. A row in `draft_queue` carries a NOT NULL rank and *is* the
   * membership, so the disagreement is no longer a state that can exist.
   *
   * The queue is a bookmark. Nothing here touches a Draft Score, and nothing
   * here can: the module it delegates to operates on ids and ranks and has no
   * access to a player's ranking at all.
   */
  router.post('/api/drafts/:id/queue/reorder', async (ctx) => {
    const draft = await new LeagueRepo(ctx.env.db).getDraft(ctx.params['id']!);
    if (!draft) return errorResponse('draft not found', 404);
    const body = await ctx.json<{ playerId?: string; toIndex?: number }>();
    if (!body?.playerId) return errorResponse('playerId required', 400);
    if (typeof body.toIndex !== 'number' || !Number.isFinite(body.toIndex)) {
      return errorResponse('toIndex must be a number', 400);
    }

    const queue = new DraftQueueRepo(ctx.env.db);
    const result = reorderQueue(await queue.entries(draft.id), body.playerId, body.toIndex);
    await queue.setOrder(draft.id, result.writes);

    return jsonResponse({ order: result.sequence, compacted: result.compacted });
  });

  /** This draft's queue, in the user's own order. */
  router.get('/api/drafts/:id/queue', async (ctx) => {
    const draft = await new LeagueRepo(ctx.env.db).getDraft(ctx.params['id']!);
    if (!draft) return errorResponse('draft not found', 404);
    return jsonResponse({ order: await new DraftQueueRepo(ctx.env.db).order(draft.id) });
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
   * The newsletter as one block of text, ready to paste into a chat.
   *
   * A read, but not a public one. Everything else about a stored newsletter is
   * masked or summarised for readers because the issue is somebody else's work;
   * handing out the whole cleaned article would undo that in one request. The
   * user is unlocked whenever they are about to import anyway.
   */
  router.get('/api/newsletter/messages/:id/chat-source', async (ctx) => {
    const unlocked = ctx.env.disableAuth ? true : await verifySession(ctx.request, ctx.env);
    if (!unlocked) return errorResponse('Unlock to copy the newsletter.', 401);
    const service = new NewsletterService(ctx.env.db);
    const message = await service.storedMessage(ctx.params['id']!);
    if (!message) {
      return errorResponse('That email was not kept, so it cannot be copied.', 404);
    }
    return jsonResponse({ messageId: message.messageId, source: await service.chatSource(message) });
  });

  /**
   * What pasting this tally would do. A read: it computes and writes nothing.
   *
   * A POST because the block goes in the body — it is far too big for a query
   * string — which also means the passphrase is required, and that is right for
   * something whose next step is a write.
   */
  router.post('/api/newsletter/messages/:id/ai-tally/preview', async (ctx) => {
    const body = await ctx.json<{ text?: string }>();
    if (typeof body?.text !== 'string') return errorResponse('text required (the pasted tally)', 400);
    if (body.text.length > MAX_TALLY_BYTES) {
      return errorResponse('That paste is too large to be a tally.', 400);
    }
    const service = new NewsletterService(ctx.env.db);
    const message = await service.storedMessage(ctx.params['id']!);
    if (!message) return errorResponse('That email was not kept, so a tally cannot be filed against it.', 404);
    return jsonResponse(await service.previewAiTally(message, body.text));
  });

  /** Apply what the preview described. Existing corrections are untouched. */
  router.post('/api/newsletter/messages/:id/ai-tally/apply', async (ctx) => {
    const body = await ctx.json<{ text?: string }>();
    if (typeof body?.text !== 'string') return errorResponse('text required (the pasted tally)', 400);
    if (body.text.length > MAX_TALLY_BYTES) {
      return errorResponse('That paste is too large to be a tally.', 400);
    }
    const service = new NewsletterService(ctx.env.db);
    const message = await service.storedMessage(ctx.params['id']!);
    if (!message) return errorResponse('That email was not kept, so a tally cannot be filed against it.', 404);
    return jsonResponse(await service.applyAiTally(message, body.text));
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

  /**
   * Smart Bilateral Trades: the few offers worth actually sending.
   *
   * A separate request from the board above, and deliberately so. That one is
   * discovery — whose news is moving — and answers for sixty players at once.
   * This one prices both rosters through the lineup optimiser and only makes
   * sense for a handful of ideas, so a reader who never looks at it never pays
   * for it and the board keeps the latency it had.
   *
   * **Zero Sleeper requests.** Every input is a stored row: the rosters, the
   * player pool, and the trade tendencies the history subsystem's cron derived.
   * `SmartTradeService` does not import a Sleeper client, which is what makes
   * that a property rather than a promise.
   */
  router.get('/api/trades/smart', async (ctx) => {
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 5) || 5, 20);
    const leagueId = ctx.url.searchParams.get('leagueId');
    return jsonResponse(
      await new SmartTradeService(ctx.env.db).build({ limit, ...(leagueId ? { leagueId } : {}) }),
    );
  });

  /**
   * The same run, with every rejected candidate and the reason it died.
   *
   * For the read-only probe of §23 and for a person asking "why is that not on
   * the list". Read-only and mutation-free like the board itself — it is the
   * identical assembly, viewed with the rejections kept rather than dropped.
   */
  router.get('/api/diagnostics/smart-trades', async (ctx) => {
    const leagueId = ctx.url.searchParams.get('leagueId');
    return jsonResponse(await new SmartTradeService(ctx.env.db).explain(leagueId ? { leagueId } : {}));
  });

  /**
   * What to offer for one specific player, and where to stop.
   *
   * A separate request from the trade board on purpose. The board is discovery
   * — whose news is moving — and this is negotiation, which needs a named
   * target, both rosters scored, and the partner's own history. Nobody wants
   * that computed for sixty players they are not pursuing.
   *
   * The values are weekly fantasy points from the same optimiser the Team
   * screen draws, so the ladder is denominated in the one currency this app
   * already calibrates. There is no separate "trade value" scale to keep in
   * step with anything.
   */
  router.get('/api/leagues/:id/trades/ladder', async (ctx) => {
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = await leagueRepo.getLeague(ctx.params['id']!);
    if (!league) return errorResponse('league not found', 404);

    const targetId = ctx.url.searchParams.get('playerId');
    if (!targetId) return errorResponse('playerId is required', 400);

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    const theirs = rosters.find((r) => !r.isMine && r.playerIds.includes(targetId)) ?? null;
    if (!mine) return errorResponse('no roster in this league is marked as yours', 409);
    if (!theirs) {
      /*
       * Not an error. A player nobody else holds is a waiver add, and saying so
       * is more useful than a 404 that leaves the caller guessing which of the
       * two things went wrong.
       */
      return jsonResponse({ found: false, reason: 'Nobody in this league rosters him — this is an add, not a trade.' });
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);
    const [mineInputs, theirsInputs] = await Promise.all([
      startSitInputsFor(db, mine.playerIds),
      startSitInputsFor(db, theirs.playerIds),
    ]);

    const ladder = buildLadderFor({ targetId, mineInputs, theirsInputs, shape, profile });
    if (!ladder) return errorResponse('player not found on that roster', 404);

    const profiles = await new LeagueStrategyService(db, { sleeper: ctx.env.sleeper }).managerProfiles(league.id);
    const partner = profiles.trade.get(theirs.rosterId) ?? null;

    /*
     * The partner's tendencies are applied only when the cache has them, and
     * the ladder itself says how thin the sample is. A profile that has never
     * been built is null, and a null partner simply means the standard opening
     * discount rather than a guess about a stranger.
     */
    const withPartner = buildLadder({ ...ladder.inputs, partner: partner?.profile ?? null });

    return jsonResponse({
      found: true,
      league: { id: league.id, name: league.name },
      partner: { rosterId: theirs.rosterId, ownerName: theirs.ownerName, profile: partner },
      target: ladder.target,
      ladder: withPartner,
      /*
       * And whether turning depth into one better player is right for this
       * roster at all — which is a different question from what he costs, and
       * one a ladder cannot answer.
       */
      consolidation: ladder.consolidation,
    });
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

  /**
   * Rebuild the derived signal cache from the ledger.
   *
   * `player_signal_cache` is derived and is written whenever a player's
   * evidence changes, which covers everything the app itself does. It does not
   * cover a change made *underneath* the app — a migration that retires rows by
   * provenance, which is exactly what `0034_newsletter_awaits_a_tally.sql`
   * does. Those rows stop counting in the ledger immediately and the cached
   * lifetime totals keep including them until each player is next touched,
   * which for a quiet player could be never.
   *
   * So this exists to be run once after that migration, and it is written to be
   * safe to run at any other time: it reads the ledger and rewrites what is
   * derived from it, so running it twice produces the same numbers as running
   * it once, and running it on a healthy database changes nothing at all. One
   * pass over the players who actually have evidence — not the whole roster,
   * because a player nobody has written about has nothing to recompute.
   *
   * A POST, so it needs the passphrase: it writes, even though everything it
   * writes is a restatement of something already true.
   */
  router.post('/api/maintenance/refresh-signals', async (ctx) => {
    const seasonStart = await new SettingsRepo(ctx.env.db).get<string | null>(SETTING_KEYS.seasonStart, null);
    const players = await new EvidenceRepo(ctx.env.db).refreshAllSignals({ seasonStart });
    return jsonResponse({
      players,
      detail: `Rebuilt the derived tallies for ${players} player(s) from the evidence ledger.`,
    });
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

  /*
   * The preseason projection, in and out.
   *
   * Deliberately not under `/api/vegas`, and named for what it is. A StartWho
   * number is a projection somebody derived *from* betting markets under a
   * stated set of scoring rules — not a line a book is taking bets on. Filing
   * it beside the Vegas routes would make the two look interchangeable in the
   * one place a future reader goes to find out whether they are, which is the
   * confusion this whole path exists to avoid.
   */

  /**
   * What is imported, under whose rules, and what else is on file.
   *
   * Read-only and cheap. `current` is the capture the board is actually
   * reading — scoped to the selected league's own scoring, because a snapshot
   * captured under other rules is not a worse answer, it is not an answer.
   * `others` is everything else stored for the season, so a snapshot imported
   * under the wrong profile is visible rather than merely inert.
   */
  router.get('/api/preseason-projection', async (ctx) => {
    const leagues = new LeagueRepo(ctx.env.db);
    const league = (await leagues.listLeagues()).find((l) => l.isSelected) ?? null;
    const season = seasonFor();
    const all = await new PreseasonProjectionsRepo(ctx.env.db).list(season);

    if (!league) {
      return jsonResponse({
        season,
        league: null,
        scoringKey: null,
        scoringLabel: null,
        current: null,
        others: all,
      });
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const scoring = projectionScoringFrom(profile);
    const key = scoringKey(scoring);
    const current = all.find((s) => s.scoringKey === key) ?? null;
    return jsonResponse({
      season,
      league: { id: league.id, name: league.name },
      scoringKey: key,
      scoringLabel: describeScoring(scoring),
      current,
      others: all.filter((s) => s.id !== current?.id),
    });
  });

  /**
   * Read the paste and say what it would do. Writes nothing.
   *
   * A POST because the snapshot is a body rather than a query, not because it
   * changes anything: `preview` and `apply` are the same method behind a
   * boolean, so what is reported here is what would be stored — the preview
   * cannot drift from the import it previews.
   */
  router.post('/api/preseason-projection/preview', async (ctx) => {
    const body = await ctx.json<{ content?: string; capturedAt?: string }>();
    return preseasonProjectionImport(ctx, body, false);
  });

  /** Store it. An ordinary authenticated write, gated like every other POST. */
  router.post('/api/preseason-projection/apply', async (ctx) => {
    const body = await ctx.json<{ content?: string; capturedAt?: string }>();
    return preseasonProjectionImport(ctx, body, true);
  });

  /**
   * Forget one capture.
   *
   * Re-importing the same capture already replaces it in place, so this is not
   * how a correction is made — it is how a snapshot imported under the wrong
   * scoring profile stops sitting in the list looking like it might be used.
   */
  router.post('/api/preseason-projection/remove', async (ctx) => {
    const body = await ctx.json<{ id?: number }>();
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return errorResponse('a snapshot id is required', 400);
    const repo = new PreseasonProjectionsRepo(ctx.env.db);
    const found = (await repo.list(seasonFor())).some((s) => s.id === id);
    if (!found) return errorResponse('no such snapshot for this season', 404);
    await repo.remove(id);
    return jsonResponse({ removed: id });
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
/**
 * Preview and Apply, which differ by one boolean and nothing else.
 *
 * Written once so they cannot drift: a preview that parsed differently from
 * the import it previews would be worse than no preview, because it would be
 * believed. The league's own scoring is read here rather than accepted from
 * the client — the profile decides what the numbers mean, so it is not
 * something a paste is allowed to declare about itself.
 */
async function preseasonProjectionImport(
  ctx: { env: { db: Database }; },
  body: { content?: string; capturedAt?: string } | null,
  commit: boolean,
): Promise<Response> {
  const content = (body?.content ?? '').trim();
  if (!content) return errorResponse('paste the projection table first', 400);

  const league = (await new LeagueRepo(ctx.env.db).listLeagues()).find((l) => l.isSelected) ?? null;
  if (!league) {
    return errorResponse(
      'choose your league first — a projection is only meaningful under the scoring it was captured for',
      409,
    );
  }

  const service = new PreseasonProjectionService(ctx.env.db);
  const request = {
    content,
    season: seasonFor(),
    profile: buildScoringProfile(league.scoringSettings, league.rosterPositions),
    capturedAt: body?.capturedAt ?? null,
  };

  try {
    return jsonResponse(commit ? await service.apply(request) : await service.preview(request));
  } catch (err) {
    /*
     * A refusal, not a crash. The parser throws when the paste is not a
     * StartWho table at all — including when the plausibility guard recognises
     * a projection dressed as betting lines — and that is a 400 the reader can
     * act on rather than a 500 that says the app is broken.
     */
    return errorResponse(err instanceof Error ? err.message : String(err), 400);
  }
}

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
/**
 * The health block a support snapshot carries, or nothing.
 *
 * Read here rather than inside the capture, for the reason `gitSha` is: it is a
 * fact about the deployment, one service measures it, and a capture that
 * measured it a second time could disagree with the screen the user was
 * standing on when they tapped the button.
 *
 * Failure is silent and the section is simply absent. A snapshot with no health
 * section says nothing about health, which is honest; a snapshot carrying an
 * empty one would say everything was fine. And the point of the button is the
 * decision — a diagnostic that refused to produce one because a health read
 * threw would be the tail wagging the dog.
 */
async function snapshotHealth(env: AppEnv): Promise<SnapshotDataHealth | null> {
  try {
    const view = await new DataHealthService(env.db, {
      vegas: env.vegas,
      releaseSha: env.releaseSha ?? null,
    }).view();
    return toSnapshotHealth(view);
  } catch {
    return null;
  }
}

export async function refreshVegas(env: AppEnv, opts: { manual?: boolean } = {}): Promise<VegasRefreshReport> {
  return new VegasRefreshService(env.db, env.vegas).refresh(opts);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
