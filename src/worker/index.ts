/**
 * Cloudflare Worker entry point.
 *
 * Three entry surfaces:
 *   fetch()    — the API + static SPA assets
 *   scheduled() — Vegas refresh cadence + nightly Sleeper player sync, and the
 *                 daily captures nothing can reconstruct later (trending, and
 *                 the current week's league transactions)
 *   email()    — inbound FF Newsletter delivery (Email Workers)
 *
 * Secrets (APP_PASSPHRASE, SESSION_SECRET, ODDS_API_KEY) live in the worker
 * environment and are never sent to the browser.
 */

import { SleeperClient } from '../core/sleeper/client.ts';
import { decodeEncodedWords, parseMimeMessage } from '../core/newsletter/mime.ts';
import { toEmailMessage } from '../core/newsletter/source.ts';
import { MockVegasProvider } from '../core/vegas/mockProvider.ts';
import { OddsApiProvider } from '../core/vegas/oddsApiProvider.ts';
import { SportsGameOddsProvider } from '../core/vegas/sportsGameOddsProvider.ts';
import type { VegasProvider } from '../core/vegas/types.ts';
import { createApp, refreshVegas, type AppEnv } from '../server/app.ts';
import type { Database } from '../server/db.ts';
import { NewsletterService } from '../server/services/newsletterService.ts';
import { SleeperSyncService } from '../server/services/sleeperSync.ts';
import { PlayerDetailService } from '../server/services/playerDetailService.ts';
import { InjuryService, previousSeason } from '../server/services/injuryService.ts';
import { InjuryHistoryService } from '../server/services/injuryHistoryService.ts';
import { UsageService } from '../server/services/usageService.ts';
import { SeasonMarketService } from '../server/services/seasonMarketService.ts';
import { LeagueRepo } from '../server/repos/league.ts';
import { SETTING_KEYS, SettingsRepo } from '../server/repos/settings.ts';
import { LeagueStrategyService } from '../server/services/leagueStrategyService.ts';
import { SleeperProjectionService } from '../server/services/sleeperProjectionService.ts';
import { MatchupService } from '../server/services/matchupService.ts';
import { resolveWeek } from '../core/matchup/build.ts';
import type { NflState } from '../core/sleeper/phase.ts';

export interface WorkerEnv {
  DB: Database;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  APP_PASSPHRASE?: string;
  SESSION_SECRET?: string;
  ODDS_API_KEY?: string;
  SPORTSGAMEODDS_API_KEY?: string;
  /** 'mock' (default), 'sportsgameodds' or 'the-odds-api'. */
  VEGAS_PROVIDER?: string;
  /**
   * The dedicated address the FF Newsletter is subscribed to, e.g.
   * "fantasy-news@example.com". Shown in Settings so the user knows where to
   * subscribe. Can also be set in-app, which overrides this value.
   */
  NEWSLETTER_ADDRESS?: string;
}

const app = createApp();

function buildVegasProvider(env: WorkerEnv): VegasProvider {
  if (env.VEGAS_PROVIDER === 'sportsgameodds') {
    return new SportsGameOddsProvider({ apiKey: env.SPORTSGAMEODDS_API_KEY });
  }
  if (env.VEGAS_PROVIDER === 'the-odds-api') {
    return new OddsApiProvider({ apiKey: env.ODDS_API_KEY });
  }
  // Default: deterministic mock. Never calls out, never costs quota.
  return new MockVegasProvider([]);
}

function toAppEnv(env: WorkerEnv): AppEnv {
  return {
    db: env.DB,
    sleeper: new SleeperClient(),
    vegas: buildVegasProvider(env),
    APP_PASSPHRASE: env.APP_PASSPHRASE,
    SESSION_SECRET: env.SESSION_SECRET,
    inboundAddress: env.NEWSLETTER_ADDRESS ?? null,
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      /*
       * The last thing standing between an `/api/` request and a page.
       *
       * Anything that escapes a Worker's `fetch` is answered by Cloudflare
       * with an HTML error page — `Error 1101`, `text/html`, status 500 — and
       * a client that asked this path for JSON is then holding markup. That is
       * the shape of the defect this guard closes, and it is worth having even
       * though the router below now catches its own handlers and middleware:
       * this catches what the router cannot, which is anything thrown while
       * building the environment, resolving a binding, or inside the router
       * itself.
       *
       * The message is the error's own, because every caller of this API is
       * this app and there is nothing here a stranger could not already get by
       * reading the source. What is *not* included is anything from `env`.
       */
      try {
        return await app(request, toAppEnv(env));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('static assets are not configured', { status: 404 });
  },

  /**
   * Cron cadence (see wrangler.toml):
   *   Every 5 minutes  -> injury check (conditional; usually a 304 and no work)
   *                       plus, until it finishes, one step of last season's
   *                       history backfill
   *   Sat 23:00 UTC    -> Vegas refresh, and a late pregame calibration capture
   *   Sun 15:00 UTC    -> Vegas refresh, and a late pregame calibration capture
   *   Daily 09:00 UTC  -> Sleeper player dictionary, last season's statistics,
   *                       one injury check, per-game usage (weekly stats
   *                       settle when a game ends, so a daily check learns
   *                       everything 288 of them would), the season-long
   *                       market lines the draft board prices against, and the
   *                       matchup calibration ledger — the forecast written
   *                       down and finished weeks closed out
   *
   * The calibration ledger is on a clock at all because of the final audit's
   * F-01: it used to be written from inside `GET /api/leagues/:id/matchup`, so
   * a read mutated the database and the method-based write guard could not see
   * it. See `refreshMatchupCalibration` below.
   *
   * The injury check is deliberately the odd one out. Everything else here is a
   * job that costs real work every time it runs, so it runs on a schedule
   * chosen to be as infrequent as the data allows. The injury check costs a
   * conditional request that is almost always answered 304 with no body, so it
   * can run constantly — and it has to, because a player is ruled out ninety
   * minutes before kickoff and kickoff is 9:30am for a London game, Thursday
   * night, Friday on a holiday, or Saturday in December. No fixed window covers
   * that set; a flat cadence does.
   */
  async scheduled(event: { cron: string }, env: WorkerEnv): Promise<void> {
    const appEnv = toAppEnv(env);

    /*
     * The five-minute tick. Checked first and returned from immediately,
     * because it is by far the most frequent path and it must stay cheap.
     */
    if (event.cron.startsWith('*/5')) {
      try {
        const injuries = new InjuryService(env.DB);
        const run = await injuries.refresh();
        await recomputeForChangedPlayers(env, run.changedPlayerIds ?? []);
        /*
         * And one week of any gap an outage left behind.
         *
         * Only when the check itself found nothing to do, so a tick never pays
         * for both a real ingest and a catch-up week. The gap is filled oldest
         * first, one week per tick, and writes rows without touching current
         * state -- a week from a fortnight ago cannot change who plays today.
         */
        if ((run.changedPlayerIds ?? []).length === 0) await injuries.catchUpOneWeek();
      } catch (err) {
        console.error('injury check failed', err);
      }

      /*
       * And, while there is anything left of it, one step of last season's
       * backfill.
       *
       * It rides this tick rather than getting a cron of its own for two
       * reasons. The account has five cron triggers and this needs none of
       * them; and the work is finite — 2025 is a finished season, so the walk
       * converges in a couple of hours and then `isComplete` is one indexed
       * read that answers "nothing to do" forever after.
       *
       * Separately caught. The backfill is history, and history failing must
       * never take down the check that decides whether somebody plays today.
       */
      try {
        const history = new InjuryHistoryService(env.DB);
        const season = previousSeason();
        if (!(await history.isComplete(season))) await history.step(season);
      } catch (err) {
        console.error('injury history backfill failed', err);
      }
      return;
    }

    if (event.cron.startsWith('0 9')) {
      const sleeperSync = new SleeperSyncService(env.DB, appEnv.sleeper);
      await sleeperSync.syncPlayers();
      /*
       * Where the season is, once a day.
       *
       * It changes on a Tuesday morning and decides one thing: whether Draft is
       * still a destination. A league refresh already updates it, but a user who
       * has not opened Setup since August would otherwise keep a stale answer
       * through week one — so it rides the nightly clock as well. It swallows
       * its own failures, and not knowing keeps the tab.
       */
      await sleeperSync.syncNflState();
      /*
       * Last season's line, on the same clock and deliberately after the
       * dictionary: the statistics are matched against the players this app
       * knows, so syncing them in the other order would report every new player
       * as unmatched for a day.
       *
       * A finished season does not change, so a failure here is not worth
       * taking the player sync down with it — the cards fall back to saying
       * nothing, which is what they said before this existed.
       */
      try {
        await new PlayerDetailService(env.DB, { sleeper: appEnv.sleeper }).refreshSeasonStats();
      } catch (err) {
        console.error('season stats refresh failed', err);
      }
      /*
       * One injury check on this clock too, after the dictionary.
       *
       * Not for freshness — the five-minute tick has that covered — and not, as
       * an earlier version of this comment claimed, to re-resolve players who
       * were unmatched yesterday: this is the same conditional path, so if the
       * file has not changed it answers 304 and returns without re-reading
       * anything. Re-mapping only happens when the source itself moves.
       *
       * It stays because it costs one conditional request and it is the one
       * injury check that does not depend on the five-minute cron still being
       * scheduled — a floor under the freshest thing this app has.
       */
      try {
        await new InjuryService(env.DB).refresh();
      } catch (err) {
        console.error('injury report refresh failed', err);
      }
      /*
       * Per-game usage, and this is the honest home for it.
       *
       * It was tempting to hang it off the five-minute tick beside the injury
       * check, since a conditional GET that 304s is nearly free. But cheap is
       * not the same as warranted: a game's target count is settled the moment
       * the game ends and never changes again, so 288 checks a day would learn
       * exactly what one check learns and cost 288 bookkeeping writes to do it.
       * The two feeds are different kinds of fact — one is news that arrives
       * ninety minutes before kickoff, the other is a box score — and putting
       * them on the same clock would be treating them as the same thing.
       *
       * 09:00 UTC is about 5am Eastern: after Sunday's late window and Monday
       * night have finished and after nflverse's own pipeline has run. A game
       * that lands too late for one morning's tick is picked up by the next,
       * six days before it could matter to a lineup.
       *
       * After the dictionary, like everything else here, because rows are
       * matched against the players this app knows. Separately caught: usage is
       * a nudge in a close call, and it must never take down the player sync.
       */
      try {
        const usage = new UsageService(env.DB);
        const run = await usage.refresh();
        // And one week of any gap an outage left behind, but never on the same
        // tick as a real ingest — a catch-up week is history and can wait a day.
        if (run.rowsWritten === 0) await usage.catchUpOneWeek();
      } catch (err) {
        console.error('usage refresh failed', err);
      }

      /*
       * The season-long market lines the draft board prices players against.
       *
       * `SeasonMarketService` was built for a daily clock -- its TTL is
       * twenty-four hours and one probe costs two entities -- but until now
       * nothing ever called it on one. The only trigger was the button in
       * Setup, so a deployment nobody had pressed it on carried no snapshot at
       * all, and every `MKT` line on every card was blank. A production board
       * of 250 players had exactly zero priced; that is what put this here.
       *
       * The service does its own gating, so this is cheap to call daily and
       * costs nothing when it should not run: a provider with no season
       * support or no key returns the reason without fetching, and a snapshot
       * younger than the TTL is served rather than re-bought.
       *
       * After the dictionary, like everything else on this clock, because
       * quotes are resolved against the players this app knows -- refreshing
       * first would report a day's worth of new names as unresolved.
       * Separately caught: a draft-time nicety must never take down the feeds
       * a lineup depends on.
       */
      try {
        const result = await new SeasonMarketService(env.DB, appEnv.vegas).refresh();
        if (result.error) console.error('season market refresh failed', result.error);
      } catch (err) {
        console.error('season market refresh failed', err);
      }

      /*
       * The league-strategy inputs, on the same daily clock.
       *
       * Two feeds with one thing in common: neither can be reconstructed after
       * the fact. Sleeper's transaction endpoint has no all-weeks form, so a
       * week nobody read while it was current is read later or not at all; and
       * the trending list is a rolling window Sleeper keeps no history of, so
       * `add rate accelerated 6x` exists only for somebody who wrote yesterday's
       * list down. A daily capture is what makes a day-over-day comparison
       * possible at all.
       *
       * Once a day rather than on the five-minute tick, and for the same reason
       * usage is: a finished week's transactions never change, and Sleeper's own
       * trending window is twenty-four hours, so 288 captures a day would
       * measure the same window 288 times.
       *
       * Only the selected league, because that is the only one anything reads,
       * and separately caught — this is the layer above lineups, and it must
       * never take a lineup feed down.
       */
      try {
        const strategy = new LeagueStrategyService(env.DB, { sleeper: appEnv.sleeper });
        await strategy.captureTrending();
        const selected = await new LeagueRepo(env.DB).getSelectedLeague();
        if (selected) {
          const state = await new SettingsRepo(env.DB).get<{ week?: number } | null>(SETTING_KEYS.nflState, null);
          await strategy.syncTransactions({
            leagueId: selected.id,
            sleeperLeagueId: selected.sleeperLeagueId,
            season: selected.season,
            week: state?.week ?? 1,
          });
        }
      } catch (err) {
        console.error('league strategy refresh failed', err);
      }

      await refreshMatchupCalibration(env, appEnv);
      await refreshPublishedProjections(env, appEnv);
      return;
    }

    await refreshVegas(appEnv);
    /*
     * And, on the two weekend ticks, the published fallback beside the market.
     *
     * These are the clocks that exist because a weekend is when a weekly number
     * matters, and the fallback answers the same question the market does when
     * the market has no answer — so it belongs on the same schedule rather than
     * on one of its own. Rotowire revises through the week, which is why this
     * runs on all three clocks (both of these and the nightly one above) and
     * declines cheaply when what it holds is young; see `MAX_AGE_HOURS`.
     */
    await refreshPublishedProjections(env, appEnv);
    /*
     * And the calibration ledger, on the two clocks that bracket a Sunday.
     *
     * Saturday 23:00 UTC is the evening before the slate and Sunday 15:00 UTC is
     * about 11am Eastern, an hour and a bit before the early kickoffs — the last
     * moment a forecast for the main slate is still a pregame forecast. The
     * nightly clock already captures every day including Sunday morning, so what
     * these two add is a *late* pregame reading, made after Friday's injury
     * report rather than before it.
     */
    await refreshMatchupCalibration(env, appEnv);
  },

  /**
   * Inbound email — the production newsletter path.
   *
   * Cloudflare Email Routing delivers to the dedicated Fantasy Analyst address,
   * which routes here. Every message is logged so Settings can show "last
   * received"; only mail from the configured sender is parsed into evidence.
   *
   * Mail is never rejected at the SMTP level: rejecting bounces the message back
   * to the sender, which would look like a broken subscription. Unexpected mail
   * is quarantined instead — recorded, visible, and never turned into evidence.
   */
  async email(
    message: {
      from: string;
      to: string;
      headers: Headers;
      raw: ReadableStream;
      setReject: (reason: string) => void;
    },
    env: WorkerEnv,
  ): Promise<void> {
    try {
      // Read the message as octets and view them one-byte-per-character rather
      // than letting the runtime decode the whole thing as UTF-8. Every part
      // then reaches the MIME decoder with its bytes intact, so the part's own
      // charset — not a guess made over the entire message — decides what its
      // text says.
      const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
      let raw = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const parsed = parseRawEmail(raw);
      // `message.from` is the SMTP envelope sender. Bulk senders put a
      // per-message bounce address there (Substack sends
      // `bounce+<token>-you=your.domain@mg-dN.substack.com`), so a subscription
      // matched against it would work once and then silently stop. The visible
      // `From:` header is the stable identity; the envelope is kept alongside
      // it for the record.
      //
      // Header values arrive RFC 2047 encoded whenever they are not pure ASCII,
      // so a subject like `Week 1 =?UTF-8?Q?=E2=80=94?= Risers` is decoded
      // before it is stored or matched against a subject pattern.
      const email = toEmailMessage({
        messageId: message.headers.get('message-id') ?? parsed.messageId,
        from: decodeEncodedWords(message.headers.get('from') ?? '') || parsed.from || message.from,
        envelopeFrom: message.from,
        subject: decodeEncodedWords(message.headers.get('subject') ?? '') || parsed.subject,
        date: message.headers.get('date'),
        html: parsed.html,
        text: parsed.text,
      });
      await new NewsletterService(env.DB).ingest(email);
    } catch (err) {
      // Never throw out of email(): an exception would retry or bounce the
      // message. The failure is recorded by the service where it can be.
      console.error('inbound email failed', err);
    }
  },
};

/**
 * Pull the HTML and plain-text bodies out of a raw newsletter.
 *
 * The decoding itself lives in `core/newsletter/mime.ts`, done to the standard:
 * headers are unfolded before they are read, nested multiparts are walked, and
 * transfer decoding produces octets that the part's own charset then
 * interprets. This wrapper exists to give the worker the flat shape
 * `toEmailMessage` wants.
 *
 * The version this replaced read headers a physical line at a time. A
 * `Content-Type` folded before its `boundary=` parameter — which is exactly how
 * Substack sends one — therefore looked like a message with no boundary at all,
 * and the entire raw MIME body was handed downstream as the newsletter's plain
 * text: part headers, boundary markers, undecoded quoted-printable and all.
 */
export function parseRawEmail(raw: string): {
  messageId: string | null;
  subject: string | null;
  from: string | null;
  html: string | null;
  text: string | null;
} {
  const parsed = parseMimeMessage(raw);
  const header = (name: string): string | null => {
    const value = parsed.headers.get(name);
    return value == null || value === '' ? null : decodeEncodedWords(value);
  };

  return {
    messageId: header('message-id'),
    subject: header('subject'),
    from: header('from'),
    html: parsed.html,
    text: parsed.text,
  };
}


/**
 * The calibration ledger, which is now the only thing that writes to it.
 *
 * This is the second half of the final audit's F-01. Both of these used to
 * happen inside `GET /api/leagues/:id/matchup`: opening the Matchup screen
 * inserted the week's forecasts and, if the games happened to be over at that
 * moment, settled them. A read that writes is a read the method-based auth
 * guard cannot protect — a demo browser's GET wrote live rows — so the write
 * moved here, where `scheduled()` is server-owned and unreachable over HTTP.
 *
 * Settlement first, so a week that has just finished is closed before this
 * week's row is written; they touch different weeks, so the order is for
 * reading rather than for correctness.
 *
 * Only the selected league, like every other league job on these clocks,
 * because it is the only one anything reads. Separately caught, like every
 * optional feed here: grading the model is a thing this app owes itself over a
 * season, and it must never be the reason an injury check does not run.
 *
 * What it costs: two Sleeper requests and at most six D1 writes per run, three
 * runs a day. The GET path it replaces could cost four writes per score change
 * on a Sunday afternoon, once per polling client.
 */
async function refreshMatchupCalibration(env: WorkerEnv, appEnv: AppEnv): Promise<void> {
  try {
    const league = await new LeagueRepo(env.DB).getSelectedLeague();
    if (!league) return;
    const service = new MatchupService(env.DB, { sleeper: appEnv.sleeper });

    const closed = await service.settleFinishedWeeks(league.id);
    for (const week of closed.settled) {
      console.log(`matchup calibration settled ${week.season} week ${week.week}: ${week.rosters} rosters`);
    }
    // Never silent about a cap: "nothing logged" has to mean "nothing left".
    if (closed.pending > 0) {
      console.log(`matchup calibration: ${closed.pending} finished weeks still unsettled, for the next run`);
    }

    const captured = await service.captureCalibration(league.id);
    if (!captured.recorded) {
      console.log(`matchup calibration: nothing to record for week ${captured.week ?? '?'}`);
    }
  } catch (err) {
    console.error('matchup calibration refresh failed', err);
  }
}

/**
 * Recompute only what a changed player actually touches.
 *
 * The point of the diff is wasted if a three-player update triggers a rebuild of
 * everything, so this asks the narrow question: is any changed player on the
 * user's roster? Nobody else's injury changes what this app would tell *this*
 * user to do — a receiver on a team they have no interest in is news the board
 * will pick up whenever it is next drawn, not a reason to do work now.
 *
 * Start/Sit and Trades both read the normalized injury state at request time
 * rather than from a cache, so "recompute" here means invalidating nothing and
 * warming nothing: the work is in deciding whether anything downstream *could*
 * have changed, and saying so in the log. This is the hook the brief asks for,
 * and it is honest about the fact that the read path is already live.
 */
/**
 * One week of Rotowire's published projections, for the selected league's season.
 *
 * Its own function because three clocks call it, and separately caught for the
 * reason every optional feed here is: this fills a column that was blank before
 * it existed, and it must never be the reason an injury check or a market
 * refresh does not run.
 *
 * The week is resolved by the same two functions the Matchup screen and the
 * lineup route use, so all three ask the feed about the same week. Nothing to
 * do outside the regular season, which `resolveWeek` reports by handing back
 * week one for a preseason state — and the service then finds nothing published
 * and says so, at the cost of one request a day.
 */
async function refreshPublishedProjections(env: WorkerEnv, appEnv: AppEnv): Promise<void> {
  try {
    const league = await new LeagueRepo(env.DB).getSelectedLeague();
    if (!league) return;
    const state = await new SettingsRepo(env.DB).get<NflState | null>(SETTING_KEYS.nflState, null);
    const week = resolveWeek(null, state?.week ?? null, state?.seasonType ?? null);
    const report = await new SleeperProjectionService(env.DB, appEnv.sleeper).refresh(league.season, week);
    if (report.outcome === 'unavailable') {
      console.log(`published projections ${report.season} week ${report.week}: ${report.detail ?? 'unavailable'}`);
    }
  } catch (err) {
    console.error('published projection refresh failed', err);
  }
}

async function recomputeForChangedPlayers(env: WorkerEnv, changedPlayerIds: string[]): Promise<void> {
  if (changedPlayerIds.length === 0) return;

  const leagues = new LeagueRepo(env.DB);
  const league = await leagues.getSelectedLeague().catch(() => null);
  if (!league) return;

  const rosters = await leagues.listRosters(league.id).catch(() => []);
  const mine = new Set(rosters.find((r) => r.isMine)?.playerIds ?? []);
  const owned = new Set(rosters.flatMap((r) => r.playerIds));

  const onMyRoster = changedPlayerIds.filter((id) => mine.has(id));
  const rosteredElsewhere = changedPlayerIds.filter((id) => !mine.has(id) && owned.has(id));

  if (onMyRoster.length === 0 && rosteredElsewhere.length === 0) return;

  /*
   * Logged rather than acted on, deliberately.
   *
   * Start/Sit and Trades compute from the stored injury state on every request,
   * so the next time either screen is opened it already reflects this change —
   * there is no stale cache to bust. Writing one here to "invalidate" would be
   * inventing a cache in order to clear it. What is worth recording is that the
   * change reached players the user actually cares about, which is what makes a
   * missed propagation visible later.
   */
  console.log(
    `injury-propagate roster=${onMyRoster.length} league=${rosteredElsewhere.length} ` +
      `startSit=${onMyRoster.length} trades=${onMyRoster.length + rosteredElsewhere.length}`,
  );
}
