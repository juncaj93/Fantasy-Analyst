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
import { buildLiveRoster } from '../core/draft/liveRoster.ts';
import { compareStartSit } from '../core/startsit/engine.ts';
import { recommendLineup } from '../core/startsit/lineup.ts';
import { TALLY_WEIGHT, orderPlayers } from '../core/draft/playerOrder.ts';
import { aggregatePlayerSignal } from '../core/evidence/aggregate.ts';
import { normalizeName } from '../core/identity/normalize.ts';
import { ACCEPT_ANY_SENDER } from '../core/newsletter/pipeline.ts';
import { looksLikeBounceAddress, toEmailMessage } from '../core/newsletter/source.ts';
import { SleeperClient } from '../core/sleeper/client.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes } from '../core/sleeper/scoring.ts';
import { getPropsWithCache } from '../core/vegas/cache.ts';
import { buildConsensus } from '../core/vegas/normalize.ts';
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
import { AdpRepo } from './repos/adp.ts';
import { EvidenceRepo } from './repos/evidence.ts';
import { LeagueRepo } from './repos/league.ts';
import { NewsletterRepo } from './repos/newsletter.ts';
import { PlayerRepo } from './repos/players.ts';
import { PropsRepo } from './repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from './repos/settings.ts';
import { DraftBoardService } from './services/draftBoard.ts';
import { RepairService } from './services/repairService.ts';
import { SetupService } from './services/setupService.ts';
import { TradeService } from './services/tradeService.ts';
import { MAX_BODY_BYTES, NewsletterService } from './services/newsletterService.ts';
import { SleeperSyncService } from './services/sleeperSync.ts';

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
    return jsonResponse({
      players,
      leagues: leagues.length,
      selectedLeague: selected ? { id: selected.id, name: selected.name, season: selected.season } : null,
      pendingEvidence: evidence,
      pendingIdentity: identity,
      vegas: { ...props, provider: ctx.env.vegas.name, configured: ctx.env.vegas.isConfigured() },
      adpSnapshot: adp,
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
      drafted: hydrate(liveRoster.players.map((p) => p.playerId)).map((p, i) => ({
        ...p,
        pickNo: liveRoster.players[i]!.pickNo,
      })),
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

    const playerRepo = new PlayerRepo(db);
    const propsRepo = new PropsRepo(db);
    const [players, propsByPlayer, signals, freshness] = await Promise.all([
      playerRepo.listByIds(mine.playerIds),
      propsRepo.latestForPlayers(mine.playerIds),
      new EvidenceRepo(db).getSignals(mine.playerIds),
      propsRepo.freshness(),
    ]);

    const inputs = [];
    for (const id of mine.playerIds) {
      const player = players.get(id);
      // A roster entry with no canonical player is a gap in the dictionary, not
      // a reason to fail the whole screen.
      if (!player) continue;
      inputs.push({
        player,
        props: propsByPlayer.get(id) ?? [],
        signal: signals.get(id) ?? null,
        injuryStatus: player.status,
        propsStale: false,
      });
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);
    const recommendation = recommendLineup(inputs, shape, profile, {
      currentStarterIds: mine.starterIds,
    });

    const unknownPlayers = mine.playerIds.length - inputs.length;
    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      found: true,
      dataFreshness: freshness,
      ...recommendation,
      notes: unknownPlayers > 0
        ? [...recommendation.notes, `${unknownPlayers} roster spot(s) are not in the player list yet — update it in Setup.`]
        : recommendation.notes,
    });
  });

  // ------------------------------------------------------------------ drafts
  router.get('/api/drafts/:id/board', async (ctx) => {
    const service = new DraftBoardService(ctx.env.db);
    const limit = Number(ctx.url.searchParams.get('limit') ?? 40);
    const position = ctx.url.searchParams.get('position');
    return jsonResponse(await service.build(ctx.params['id']!, { limit, position }));
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
    const body = await ctx.json<{ content?: string; label?: string; capturedAt?: string; source?: string }>();
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
    const repo = new AdpRepo(ctx.env.db);
    const { snapshot, created } = await repo.save(result);
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
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 60) || 60, 200);
    const position = ctx.url.searchParams.get('position');
    const repo = new PlayerRepo(ctx.env.db);

    // Draft order comes from an imported ranking. Sleeper's search_rank is NOT
    // one — it ranks by who gets looked up — so when no ranking is imported the
    // list says so and falls back to the tally rather than inventing an order.
    const snapshot = await new AdpRepo(ctx.env.db).latest();
    const ranks = snapshot ? await new AdpRepo(ctx.env.db).valuesByPlayer(snapshot.id) : new Map();

    const pool = q ? await repo.search(q, 200) : (await repo.listAll()).filter((p) => p.active);
    const filtered = position ? pool.filter((p) => p.position === position.toUpperCase()) : pool;

    const shortlist = [...filtered]
      .sort(
        (a, b) =>
          (ranks.get(a.id)?.adp ?? Infinity) - (ranks.get(b.id)?.adp ?? Infinity) ||
          (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity),
      )
      .slice(0, Math.max(limit * 3, 120));

    const signals = await new EvidenceRepo(ctx.env.db).getSignals(shortlist.map((p) => p.id));
    const ordered = orderPlayers(
      shortlist.map((p) => ({
        id: p.id,
        name: p.fullName,
        draftRank: ranks.get(p.id)?.adp ?? null,
        net: signals.get(p.id)?.raw.net ?? 0,
        player: p,
      })),
    ).slice(0, limit);

    return jsonResponse({
      tallyWeight: TALLY_WEIGHT,
      rankingSource: snapshot ? snapshot.label : null,
      players: ordered.map(({ player: row, draftRank, adjustedRank: adjusted, movement }) => ({
        id: row.player.id,
        name: row.player.fullName,
        position: row.player.position,
        team: row.player.team,
        status: row.player.status,
        draftRank,
        adjustedRank: adjusted,
        movement,
        signal: signals.get(row.player.id) ?? null,
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

  router.post('/api/vegas/refresh', async (ctx) => {
    const limit = refreshLimiter.check('vegas');
    if (!limit.allowed) return errorResponse(`refresh on cooldown; retry in ${limit.retryAfterSeconds}s`, 429);
    const result = await refreshVegas(ctx.env, { manual: true });
    return jsonResponse(result);
  });

  // ---------------------------------------------------------------- start/sit
  router.post('/api/startsit/compare', async (ctx) => {
    const body = await ctx.json<{ leagueId?: string; playerIds?: string[] }>();
    if (!body?.playerIds || body.playerIds.length < 2) return errorResponse('at least two playerIds required', 400);
    const db = ctx.env.db;
    const leagueRepo = new LeagueRepo(db);
    const league = body.leagueId ? await leagueRepo.getLeague(body.leagueId) : await leagueRepo.getSelectedLeague();
    if (!league) return errorResponse('no league selected', 400);

    const playerRepo = new PlayerRepo(db);
    const propsRepo = new PropsRepo(db);
    const evidenceRepo = new EvidenceRepo(db);
    const [propsByPlayer, signals, freshness] = await Promise.all([
      propsRepo.latestForPlayers(body.playerIds),
      evidenceRepo.getSignals(body.playerIds),
      propsRepo.freshness(),
    ]);

    const inputs = [];
    for (const id of body.playerIds) {
      const player = await playerRepo.getById(id);
      if (!player) return errorResponse(`player ${id} not found`, 404);
      inputs.push({
        player,
        props: propsByPlayer.get(id) ?? [],
        signal: signals.get(id) ?? null,
        injuryStatus: player.status,
        propsStale: false,
      });
    }

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const comparison = compareStartSit(inputs, profile);
    return jsonResponse({
      league: { id: league.id, name: league.name, scoringLabel: profile.label },
      dataFreshness: freshness,
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

export async function refreshVegas(
  env: AppEnv,
  opts: { manual?: boolean } = {},
): Promise<{ provider: string; events: number; fresh: number; cached: number; stale: number; errors: string[] }> {
  const propsRepo = new PropsRepo(env.db);
  const index = await new PlayerRepo(env.db).buildIndex();
  const errors: string[] = [];
  let fresh = 0;
  let cached = 0;
  let stale = 0;

  let games: { eventId: string }[] = [];
  try {
    games = await env.vegas.getUpcomingNFLGames();
  } catch (err) {
    errors.push(`could not list games: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const game of games) {
    const result = await getPropsWithCache(game.eventId, env.vegas, propsRepo, { manual: opts.manual ?? false });
    if (result.origin === 'fresh') fresh++;
    else if (result.origin === 'cache') cached++;
    else stale++;
    if (result.error) errors.push(`${game.eventId}: ${result.error}`);

    if (result.origin === 'fresh' && result.snapshot) {
      const snapshotId = await propsRepo.snapshotId(
        result.snapshot.provider,
        result.snapshot.eventId,
        result.snapshot.fetchedAt,
      );
      if (snapshotId != null) {
        await propsRepo.saveConsensus(snapshotId, buildConsensus(result.snapshot.raw.quotes ?? [], index));
      }
    }
  }

  await new SettingsRepo(env.db).set(SETTING_KEYS.lastVegasRefresh, new Date().toISOString());
  return { provider: env.vegas.name, events: games.length, fresh, cached, stale, errors };
}
