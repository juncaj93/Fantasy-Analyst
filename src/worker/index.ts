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

import { SleeperClient, type FetchLike } from '../core/sleeper/client.ts';
import {
  budgetedFetch,
  MAX_CRON_SUBREQUESTS,
  MAX_SLEEPER_SUBREQUESTS_PER_BATCH,
  REDIRECTING_FETCH_COST,
  RequestBudget,
} from '../core/sleeper/budget.ts';
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
import { ScheduleService } from '../server/services/scheduleService.ts';
import { usageSeason } from '../server/services/usageService.ts';
import { InjuryHistoryService } from '../server/services/injuryHistoryService.ts';
import { UsageService } from '../server/services/usageService.ts';
import { NflverseService } from '../server/services/nflverseService.ts';
import { SeasonMarketService } from '../server/services/seasonMarketService.ts';
import { LeagueRepo } from '../server/repos/league.ts';
import { CronRunRecorder } from '../server/repos/cronRuns.ts';
import { stepOutcomeFrom, type StepOutcome } from '../core/health/model.ts';
import { CRON_LABELS } from '../core/health/policy.ts';
import { SETTING_KEYS, SettingsRepo } from '../server/repos/settings.ts';
import { ManagerIntelService } from '../server/services/managerIntelService.ts';
import { LeagueStrategyService } from '../server/services/leagueStrategyService.ts';
import { SleeperProjectionService } from '../server/services/sleeperProjectionService.ts';
import { MatchupService } from '../server/services/matchupService.ts';
import { resolveWeek } from '../core/matchup/build.ts';
import type { NflState } from '../core/sleeper/phase.ts';

/**
 * What one step of a scheduled run reports about itself.
 *
 * The shape `CronRunRecorder.step` accepts, named here because the two shared
 * refresh helpers below return it. Each feed decides its own outcome, because
 * only the feed knows whether "nothing was written" means it succeeded, is
 * waiting on a source that has not published, or deferred — the three states
 * §3 refuses to collapse into one.
 */
type StepResult = { outcome: StepOutcome; items?: number | null; note?: string | null };

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
  /**
   * The git revision this deployment was built from, written into
   * `wrangler.toml` by the release workflow immediately before it builds. A
   * plain var rather than a secret: it is a public commit id, and it has to
   * survive into the deployed Worker so `/api/health` can report it.
   *
   * `"unknown"` in the file that is committed, so a hand-run `wrangler deploy`
   * says so instead of claiming a revision it did not check out.
   */
  RELEASE_SHA?: string;
}

const app = createApp();

function buildVegasProvider(env: WorkerEnv, fetchImpl?: FetchLike): VegasProvider {
  if (env.VEGAS_PROVIDER === 'sportsgameodds') {
    return new SportsGameOddsProvider({ apiKey: env.SPORTSGAMEODDS_API_KEY, fetch: fetchImpl });
  }
  if (env.VEGAS_PROVIDER === 'the-odds-api') {
    return new OddsApiProvider({ apiKey: env.ODDS_API_KEY, fetch: fetchImpl });
  }
  // Default: deterministic mock. Never calls out, never costs quota.
  return new MockVegasProvider([]);
}

/**
 * This deployment's services, optionally on a transport somebody is counting.
 *
 * `fetchImpl` is how the daily cron's shared subrequest budget reaches the two
 * providers built here. A request path passes nothing and gets the ordinary
 * global `fetch`, because a budget belongs to an invocation and an invocation
 * serving one API call has no ceiling worth defending.
 */
function toAppEnv(env: WorkerEnv, fetchImpl?: FetchLike, ctx?: { waitUntil(task: Promise<unknown>): void }): AppEnv {
  return {
    db: env.DB,
    /*
     * The platform's own answer to "finish this, but not while they are
     * waiting". Passed only on the request path: a scheduled run is already
     * allowed to take its time, and handing a cron a way to defer work past its
     * own invocation would hide it from the budget that bounds it.
     */
    ...(ctx ? { waitUntil: (task: Promise<unknown>) => ctx.waitUntil(task) } : {}),
    sleeper: fetchImpl ? new SleeperClient({ fetch: fetchImpl }) : new SleeperClient(),
    vegas: buildVegasProvider(env, fetchImpl),
    APP_PASSPHRASE: env.APP_PASSPHRASE,
    SESSION_SECRET: env.SESSION_SECRET,
    inboundAddress: env.NEWSLETTER_ADDRESS ?? null,
    releaseSha: env.RELEASE_SHA ?? null,
  };
}

export default {
  /**
   * `ctx` is here for `waitUntil`, and for nothing else.
   *
   * Cloudflare has always passed it; this Worker simply never took it. It is
   * what keeps an invocation alive after the response has been sent, which is
   * what lets a cold player-card outlook be fetched *around* the reader rather
   * than in front of them. Without it the fetch would be a promise nobody is
   * holding, cancelled the moment the response goes out.
   */
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx?: { waitUntil(task: Promise<unknown>): void },
  ): Promise<Response> {
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
        return await app(request, toAppEnv(env, undefined, ctx));
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
   *                       market lines the draft board prices against, the
   *                       matchup calibration ledger — the forecast written
   *                       down and finished weeks closed out — and, last of
   *                       everything and on whatever budget the rest of the
   *                       tick leaves it, one bounded batch of manager
   *                       history, which is why a league's four seasons of
   *                       drafts and transactions arrive over a few days
   *                       instead of failing in one invocation
   *
   * The daily tick is the one with a ceiling to defend. Every external call it
   * makes — Sleeper, nflverse, the Vegas provider — is charged to a single
   * `RequestBudget` created at the top of that branch, so the invariant is not
   * "each subsystem is careful" but "the fifty-first subrequest is never
   * initiated". See `core/sleeper/budget.ts`, and `cron.subrequestBudget.test.ts`
   * for the worst case it is asserted against.
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
      /*
       * One budget, and everything below it spends the same one.
       *
       * Cloudflare counts subrequests per invocation, so this is the only place
       * a ceiling can honestly be defended: the manager backfill was budgeted
       * for a year while the tick around it was not, which meant a bad
       * afternoon at Sleeper — where every read retries twice — could put the
       * invocation into the sixties with the backfill's own counter reading a
       * comfortable 24/24. See `core/sleeper/budget.ts`.
       *
       * Two transports, because a subrequest is not always a request. Sleeper
       * answers directly and costs one; every nflverse file is a GitHub release
       * asset that answers 302 to a signed `release-assets.githubusercontent.com`
       * URL, and `fetch` follows that hop itself — so one call is two
       * subrequests, and a wrapper that counted calls would undercount the
       * seven nflverse-family reads on this tick by seven.
       */
      const budget = new RequestBudget(MAX_CRON_SUBREQUESTS);
      const meteredFetch = budgetedFetch(budget);
      const meteredRedirectingFetch = budgetedFetch(budget, undefined, { cost: REDIRECTING_FETCH_COST });
      const cronEnv = toAppEnv(env, meteredFetch);
      let intelNote = 'not reached';

      /*
       * What this tick did, written down rather than logged and lost.
       *
       * A recorder, not a rearrangement. Every feed below was already wrapped in
       * its own `try`/`catch` — the invariant being that one dead provider must
       * never take down the ten under it — and `run.step` *is* that try/catch
       * with the outcome kept instead of discarded. The order, the priorities
       * and the separate-catch rule are exactly as they were: §8 asks this lane
       * to observe the schedule, not to redesign it.
       *
       * Nothing is written to D1 until `finish()` at the bottom, so a run that
       * dies half way through costs one missing update rather than a row
       * claiming eleven steps ran.
       */
      const run = new CronRunRecorder(env.DB, {
        cron: event.cron,
        label: CRON_LABELS[event.cron] ?? event.cron,
        releaseSha: env.RELEASE_SHA ?? null,
      });

      const sleeperSync = new SleeperSyncService(env.DB, cronEnv.sleeper);
      /*
       * The player dictionary, and separately caught like everything else here.
       *
       * It was the one call on this tick that was not, which meant a Sleeper
       * outage at 09:00 — the exact morning the retry paths matter — threw out
       * of `syncPlayers` and abandoned the entire invocation: no injury check,
       * no usage, no market lines, no schedule, no calibration, nothing. A feed
       * failing is a reason to skip that feed and not a reason to skip the ten
       * below it, which is the argument every other block here already makes.
       *
       * Nothing downstream is broken by a dictionary that did not refresh. Every
       * feed that matches rows against known players matches them against
       * yesterday's dictionary, which is what it would have used anyway; the
       * cost of a skipped sync is that a player who signed overnight is unknown
       * for one more day.
       */
      await run.step('players', 'Player list', async () => {
        const { written } = await sleeperSync.syncPlayers();
        return { outcome: 'succeeded', items: written };
      });
      /*
       * Where the season is, once a day.
       *
       * It changes on a Tuesday morning and decides one thing: whether Draft is
       * still a destination. A league refresh already updates it, but a user who
       * has not opened Setup since August would otherwise keep a stale answer
       * through week one — so it rides the nightly clock as well. It swallows
       * its own failures, and not knowing keeps the tab.
       */
      await run.step('nfl-state', 'NFL week', async () => {
        /*
         * It swallows its own failures and returns null, which is the honest
         * thing for the caller to record: not a crash, and not a refresh
         * either. `not_published` is the vocabulary's word for "asked, nothing
         * came back", and Sleeper being unreachable for one morning is exactly
         * that from this tick's point of view.
         */
        const state = await sleeperSync.syncNflState();
        return state == null
          ? { outcome: 'not_published' as const, note: 'Sleeper did not return a week' }
          : { outcome: 'succeeded' as const };
      });
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
      await run.step('season-stats', "Last season's statistics", async () => {
        await new PlayerDetailService(env.DB, { sleeper: cronEnv.sleeper }).refreshSeasonStats();
        return { outcome: 'succeeded' };
      });
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
      await run.step('injuries', 'Injuries', async () => {
        const injury = await new InjuryService(env.DB, { fetch: meteredRedirectingFetch }).refresh();
        return {
          outcome: stepOutcomeFrom(injury.outcome),
          items: injury.rowsReturned,
          note: injury.note,
        };
      });
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
      await run.step('usage', 'Usage', async () => {
        const usage = new UsageService(env.DB, { fetch: meteredRedirectingFetch });
        const report = await usage.refresh();
        // And one week of any gap an outage left behind, but never on the same
        // tick as a real ingest — a catch-up week is history and can wait a day.
        if (report.rowsWritten === 0) await usage.catchUpOneWeek();
        return {
          outcome: stepOutcomeFrom(report.outcome),
          items: report.rowsWritten,
          note: report.note,
        };
      });

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
      await run.step('season-markets', 'Season market lines', async () => {
        const result = await new SeasonMarketService(env.DB, cronEnv.vegas).refresh();
        if (result.error) console.error('season market refresh failed', result.error);
        /*
         * The service's own three answers, kept apart.
         *
         * It gates itself: a provider with no season support or no key returns
         * a reason without fetching, and a snapshot younger than the TTL is
         * served rather than re-bought. Neither of those is a failure and
         * neither is a refresh, so the run says `succeeded` and carries the
         * service's own sentence — which is the same sentence Setup prints.
         */
        if (result.error) return { outcome: 'failed' as const, note: result.reason };
        return { outcome: 'succeeded' as const, items: result.quotes, note: result.reason };
      });

      /*
       * The fixture list, on the clock it costs nothing to be on.
       *
       * A conditional GET against a file published in May and revised only when
       * the league flexes a Sunday-night game, so the answer is 304 on nearly
       * every tick of the season and the bytes are zero. **No cron trigger of
       * its own**: the account has five, this needs none of them, and one
       * conditional request is not worth a schedule entry.
       *
       * Nothing on a recommendation read path reads what it stores. The DST
       * model is anchored on the Vegas line for the week in play, which is the
       * right source for a game that has been priced; this is the source for
       * the two questions no book answers in October — which week is a bye, and
       * who a defence plays in December. Having it land a lane early is what
       * lets the streaming and playoff work be about the model rather than
       * about ingest.
       *
       * Separately caught, and last of the file feeds, for the ordinary reason:
       * a planning input that fails to refresh costs a screen nobody is looking
       * at today, and it must never take down a feed a lineup depends on. A
       * failure leaves the stored schedule exactly where it is.
       */
      await run.step('schedule', 'NFL schedule', async () => {
        const schedule = await new ScheduleService(env.DB, { fetch: meteredRedirectingFetch }).refresh(usageSeason());
        if (schedule.outcome === 'failed') console.error('schedule refresh failed', schedule.note);
        return {
          outcome: stepOutcomeFrom(schedule.outcome),
          items: schedule.rowsWritten ?? null,
          note: schedule.note,
        };
      });

      /*
       * The trending capture, which nothing else can reconstruct.
       *
       * Sleeper's trending list is a rolling twenty-four-hour window it keeps no
       * history of, so `add rate accelerated 6x` exists only for somebody who
       * wrote yesterday's list down. A daily capture is what makes a
       * day-over-day comparison possible at all — and it is once a day rather
       * than on the five-minute tick because the window itself is a day, so 288
       * captures would measure the same window 288 times.
       *
       * This block used to sync the current league's transactions too. It no
       * longer does, and that is a removal rather than a loss: the
       * manager-intelligence batch below reads exactly the same weeks from the
       * same repository, prioritises the live season ahead of every other, and
       * knows which weeks are settled. Running both meant paying twice for the
       * one week that is still in play.
       *
       * Separately caught — this is the layer above lineups, and it must never
       * take a lineup feed down.
       */
      await run.step('trending', 'Trending adds', async () => {
        const captured = await new LeagueStrategyService(env.DB, { sleeper: cronEnv.sleeper }).captureTrending();
        return { outcome: 'succeeded', items: captured.captured };
      });

      await run.step('matchup-calibration', 'Matchup calibration', () => refreshMatchupCalibration(env, cronEnv));
      await run.step('published-projections', 'Published projections', () =>
        refreshPublishedProjections(env, cronEnv),
      );

      /*
       * The three nflverse feeds Projection v2 reads — **last of the live
       * feeds on this tick, and that position is the point.**
       *
       * Everything above it feeds a live surface: the player dictionary, last
       * season's statistics, the injury report, per-game usage, the season-long
       * market lines the draft board prices against, the matchup calibration
       * ledger, and the published weekly fallback. The one thing below it feeds
       * no surface at all — the manager backfill is history, measured in
       * seasons, and it takes what this leaves.
       *
       * It was written directly after the usage refresh, which read well and was
       * wrong. A slow or hanging fetch there delays the season markets and the
       * calibration ledger, and an invocation killed part-way through never
       * reaches them at all — so a feed no recommendation reads could cost two
       * that several do. Phase 1 promises Projection v2 is inert to live
       * decisions; a queue position is part of keeping that promise, not just a
       * dependency graph.
       *
       * Costs three conditional GETs on an ordinary day, two of which answer
       * 304 with no body — but six subrequests, because each is a GitHub
       * release asset and the 302 to `release-assets.githubusercontent.com` is
       * a subrequest of its own that `fetch` follows before the validator is
       * ever considered. That is why this transport is charged double; see
       * `REDIRECTING_FETCH_COST`. The depth chart is a ranged read of the first
       * 768KiB of a 42MiB file rather than the file; see
       * `core/nflverse/depthChart.ts`.
       *
       * After the player dictionary, like everything else here, because snap
       * rows are matched against the players this app knows. Separately caught,
       * and this one matters least of any catch in this function: a total
       * failure of all three feeds costs an evaluation report and no
       * recommendation anywhere in the app.
       */
      await run.step('nflverse', 'Snaps and depth charts', async () => {
        const runs = await new NflverseService(env.DB, { fetch: meteredRedirectingFetch }).refreshAll();
        /*
         * Three feeds under one step, because they are one dependency chain and
         * `refreshAll` already catches each of them separately. Reported as a
         * whole: all three failing is a failure, some of them failing is a
         * failure of this step, and none of them failing is a success. The
         * per-feed detail stays where it already lives, in
         * `nflverse_source_runs`, rather than being copied into the run record.
         */
        const failed = runs.filter((r) => r.outcome === 'failed');
        if (runs.length === 0) return { outcome: 'failed' as const, note: 'no nflverse feed completed' };
        if (failed.length > 0) {
          return { outcome: 'failed' as const, items: runs.length - failed.length, note: `${failed.length} of ${runs.length} feeds did not complete` };
        }
        return { outcome: 'succeeded' as const, items: runs.length };
      });

      /*
       * One bounded batch of manager history — **last on this tick, and last is
       * now the truth rather than a claim.**
       *
       * The subsystem this feeds is the reason the batch exists. Sleeper keeps
       * a league's drafts and transactions for every season it has ever played,
       * and reading them is how `Next%` learns that the man three seats over
       * takes his quarterback in round fourteen — but reading them all at once
       * cost about sixty-six subrequests against a free-plan ceiling of fifty,
       * and it failed in production for exactly that reason.
       *
       * So it is a batch, checkpointed at every unit and resumed here tomorrow.
       * An established league fills its ledger over a few days and then costs
       * two requests a day for ever — the live draft's index and the week still
       * in play — because a finished draft and a finished week can never change
       * and are never re-read.
       *
       * **Its allowance is whatever is left.** This used to be a flat
       * twenty-four whatever the rest of the tick had spent, which is the
       * defect: twenty-four is safe on a healthy morning and is exactly what
       * takes an invocation over the ceiling on a morning where the feeds above
       * retried. Now it is `budget.remaining`, capped at the batch maximum so a
       * quiet morning does not turn into an unusually large one — and because
       * nothing external runs after this, no reserve is held back. Every unit
       * it does not get is a unit the feeds above already spent on something
       * somebody is looking at today.
       *
       * A tight morning is not a failure. Zero remaining means the batch is
       * skipped, the checkpoints stay exactly where they are, and tomorrow's
       * tick picks up the same unit — the same thing that happens every day
       * during the first week of a backfill.
       *
       * The position is the other half of it. Everything above feeds a surface
       * somebody is looking at today: the player dictionary, the injury report,
       * per-game usage, the market lines, the schedule, the trending list, the
       * calibration ledger, the published projections and the three nflverse
       * files. An earlier version of this comment claimed to be "last of the
       * Sleeper work" while five Sleeper reads and three nflverse reads still
       * ran after it, so a backfill could and did crowd out the calibration
       * ledger. It is last now.
       *
       * Separately caught, like every other feed here: a history that fails to
       * advance costs a small `Next%` adjustment and nothing else.
       */
      await run.step('manager-intel', 'Manager tendencies', async () => {
        const selected = await new LeagueRepo(env.DB).getSelectedLeague();
        if (!selected) {
          intelNote = 'no league selected';
          return { outcome: 'skipped' as const, note: 'no league selected' };
        }
        {
          const allowance = Math.min(MAX_SLEEPER_SUBREQUESTS_PER_BATCH, budget.remaining);
          if (allowance <= 0) {
            intelNote = 'skipped: no budget left after the feeds above';
            console.log(`manager intelligence skipped: ${budget.used}/${budget.limit} subrequests already spent`);
            /*
             * `deferred`, not `failed`, and this is the §7 sentence the whole
             * lane exists to be able to say. The batch yielded because the
             * feeds a lineup depends on had already spent the invocation's
             * budget, which is the strategy working exactly as designed. A run
             * record calling it a failure would send somebody diagnosing a
             * healthy system, and a run record staying silent about it would
             * leave a thin `Next%` unexplained.
             */
            return {
              outcome: 'deferred' as const,
              note: `refresh budget reserved for higher-priority data (${budget.used}/${budget.limit} already spent)`,
            };
          }
          {
            const state = await new SettingsRepo(env.DB).get<{ week?: number } | null>(SETTING_KEYS.nflState, null);
            const report = await new ManagerIntelService(env.DB, { sleeper: cronEnv.sleeper }).advance({
              leagueId: selected.id,
              sleeperLeagueId: selected.sleeperLeagueId,
              season: selected.season,
              week: state?.week ?? 1,
              /*
               * A cap on the shared pool, not a second charge against it.
               *
               * The batch runs on `cronEnv.sleeper` like everything else here,
               * so the invocation counts its requests at the transport; this
               * says only how many of them it may have. Handing it a budget
               * that also charged the invocation would count every request
               * twice and stop a batch that still had room — see
               * `RequestBudget.allowance`.
               */
              budget: budget.allowance(allowance),
            });
            const allowanceBound = report.requestsUsed >= allowance;
            intelNote =
              `allowance ${allowance}, used ${report.requestsUsed}` +
              (allowanceBound ? ' (allowance bound)' : ' (finished what it had to do)');
            if (report.errors.length > 0) {
              console.error('manager intelligence batch had failures', report.errors);
            }
            /*
             * An allowance-bound batch is deferred too, and for the same reason.
             *
             * It advanced as far as its slice of the pool allowed and stopped
             * with checkpoints intact — the steady state of a backfill's first
             * few days. Calling that a success would hide from somebody reading
             * a thin `Next%` that there is more history still to come.
             */
            return {
              outcome: allowanceBound ? ('deferred' as const) : ('succeeded' as const),
              items: report.requestsUsed,
              note: allowanceBound
                ? `advanced as far as this run's allowance of ${allowance} reached; more history arrives tomorrow`
                : null,
            };
          }
        }
      });

      /*
       * What the invocation actually cost, once per tick.
       *
       * One line, at the end, and deliberately not one per request: the number
       * that matters is the total against the ceiling, and a per-request log
       * would be fifty lines a day to learn it. It is here so that "we are
       * close to the ceiling" is visible in the tail before it is visible as an
       * outage — a healthy morning reads about 40/48, and a morning that reads
       * 48/48 with the batch skipped is the tick telling you the feeds above it
       * are retrying.
       */
      const spent = budget.snapshot();
      console.log(
        `cron 09:00 subrequests ${spent.used}/${spent.limit} (ceiling 50, ${spent.remaining} unspent); ` +
          `manager intelligence: ${intelNote}`,
      );

      /*
       * And the same three numbers where a phone can read them.
       *
       * Separately caught, and it has to be: a health record that failed to
       * save is worth a log line and is never worth taking down the tick it was
       * describing. The budget view is the transport's own counter, which
       * counts retries and redirect hops — so `used/limit` is what actually
       * went out on the wire rather than what was expected to. See §7: this is
       * the only budget number in this app that can be reported honestly, and
       * nothing here invents one.
       */
      try {
        await run.finish({ limit: spent.limit, used: spent.used, remaining: spent.remaining });
      } catch (err) {
        console.error('cron run record failed', err);
      }
      return;
    }

    /*
     * The two weekend clocks, recorded on the same terms as the daily one.
     *
     * No budget: they make four external calls between them and pass the
     * unmetered transport, so there is no ceiling to defend and none to report.
     * A zeroed budget here would read as "spent nothing" rather than as "this
     * clock does not have one", which is the distinction §7 asks for.
     */
    const weekend = new CronRunRecorder(env.DB, {
      cron: event.cron,
      label: CRON_LABELS[event.cron] ?? event.cron,
      releaseSha: env.RELEASE_SHA ?? null,
    });

    await weekend.step('vegas', 'Vegas lines', async () => {
      const report = await refreshVegas(appEnv);
      if (report.fetched === 0 && report.blocked.length > 0) {
        return { outcome: 'skipped' as const, items: 0, note: report.blocked[0] ?? report.note };
      }
      if (report.fetched === 0 && report.errors.length > 0) {
        /*
         * The category, never the provider's own words.
         *
         * `report.errors` carries whatever the odds provider said about a
         * request this app made, which can include the URL it was made to — and
         * this row is read by a support screen and copied into a snapshot. The
         * text stays in the log, where an operator can see it and a user
         * cannot.
         */
        console.error('vegas refresh failed', report.errors);
        return { outcome: 'failed' as const, items: 0, note: 'the odds provider did not answer' };
      }
      return { outcome: 'succeeded' as const, items: report.fetched, note: report.note };
    });
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
    await weekend.step('published-projections', 'Published projections', () =>
      refreshPublishedProjections(env, appEnv),
    );
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
    await weekend.step('matchup-calibration', 'Matchup calibration', () =>
      refreshMatchupCalibration(env, appEnv),
    );

    try {
      await weekend.finish(null);
    } catch (err) {
      console.error('cron run record failed', err);
    }
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
 * What it costs: up to five Sleeper requests — `SETTLE_WEEKS_PER_RUN` of them
 * closing out finished weeks, plus one for the capture — and at most six D1
 * writes per run, three runs a day. The GET path it replaces could cost four
 * writes per score change on a Sunday afternoon, once per polling client.
 *
 * On the daily tick those requests are charged to the invocation's shared
 * subrequest budget, because they are made through the client `scheduled()`
 * hands it; the two weekend clocks pass the unmetered one, which is right —
 * they run four external calls between them and have no ceiling to defend.
 */
async function refreshMatchupCalibration(env: WorkerEnv, appEnv: AppEnv): Promise<StepResult> {
  const league = await new LeagueRepo(env.DB).getSelectedLeague();
  if (!league) return { outcome: 'skipped', note: 'no league selected' };
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
  /*
   * A week with nothing to record is not a failure and not a refresh.
   *
   * `settleFinishedWeeks` capped at `SETTLE_WEEKS_PER_RUN` leaves the rest for
   * the next run, which is a deferral in the same sense the manager backfill's
   * is — deliberate, bounded and resumed — so it is reported as one rather than
   * as a clean success that hides unsettled weeks.
   */
  if (closed.pending > 0) {
    return {
      outcome: 'deferred',
      items: closed.settled.length,
      note: `${closed.pending} finished week(s) still to settle on the next run`,
    };
  }
  return {
    outcome: captured.recorded ? 'succeeded' : 'not_published',
    items: closed.settled.length,
    note: captured.recorded ? null : `nothing to record for week ${captured.week ?? '?'}`,
  };
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
async function refreshPublishedProjections(env: WorkerEnv, appEnv: AppEnv): Promise<StepResult> {
  const league = await new LeagueRepo(env.DB).getSelectedLeague();
  if (!league) return { outcome: 'skipped', note: 'no league selected' };
  const state = await new SettingsRepo(env.DB).get<NflState | null>(SETTING_KEYS.nflState, null);
  const week = resolveWeek(null, state?.week ?? null, state?.seasonType ?? null);
  const report = await new SleeperProjectionService(env.DB, appEnv.sleeper).refresh(league.season, week);
  if (report.outcome === 'unavailable') {
    console.log(`published projections ${report.season} week ${report.week}: ${report.detail ?? 'unavailable'}`);
  }
  /*
   * Three outcomes, and `unavailable` is the one that must not read as a fault.
   *
   * The feed publishes a week when it publishes it, and out of the regular
   * season it publishes nothing at all — `resolveWeek` hands back week one for
   * a preseason state and the service correctly finds nothing. That is a source
   * with nothing to say, which is `not_published` and never `failed`.
   */
  if (report.outcome === 'unavailable') {
    return { outcome: 'not_published', items: 0, note: report.detail ?? 'nothing published for this week yet' };
  }
  return {
    outcome: report.outcome === 'current' ? 'skipped' : 'succeeded',
    items: report.rows,
    note: report.detail,
  };
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
