/**
 * Was Junculator using healthy, current data when it made this decision?
 *
 * One read-only assembly, over state the shipped pipelines already keep. Every
 * number below is read from a table some feed writes as part of doing its job —
 * `injury_source_state`, `usage_source_state`, `nflverse_source_state`,
 * `prop_snapshots`, `settings`, `sync_log`, the season-market snapshot, the new
 * `cron_run_state` — and nothing here computes a second opinion about any of
 * them. Where a service already decides whether its own data is stale
 * (`SeasonMarketService.status()` does, against `SEASON_TTL_MINUTES`), that
 * decision is used rather than re-derived, because a health screen that
 * disagreed with the engine it describes would be worse than none.
 *
 * ## Read-only, and it is structural rather than promised
 *
 * There is no write method on this class, no provider on it, no `refresh` and
 * no `fetch`. Reading data health cannot run a cron, refresh a provider, mutate
 * D1, start manager ingestion, publish anything, alter a snapshot or change a
 * fantasy decision. `tests/dataHealth.isolation.test.ts` asserts it by watching
 * every statement prepared during an assembly and by replacing `fetch` with
 * something that throws, rather than by describing it here.
 *
 * The one thing it is *given* is the Vegas provider, and only to ask it two
 * synchronous questions — its name and whether it is configured — which is what
 * Setup already asks it. Neither call leaves the process.
 *
 * ## What it is not
 *
 * Not a monitoring platform. There is no history, no chart, no alert, no
 * retention and no counter this app cannot honestly measure. The whole surface
 * is a current view, a last attempt, a last success, and the most recent
 * scheduled run.
 */

import {
  boundedNote,
  describeRun,
  headline,
  minutesSince,
  needsAttention,
  overallState,
  type DataHealthView,
  type RunHealth,
  type SourceHealth,
  type SourceState,
} from '../../core/health/model.ts';
import {
  DAILY_ATTEMPT_STALE_MINUTES,
  FREQUENT_ATTEMPT_STALE_MINUTES,
  classifyAge,
  policyFor,
  sourceHealth,
  vegasFreshWithinMinutes,
  type SourceId,
} from '../../core/health/policy.ts';
import { FRESHNESS_HOURS } from '../../core/injury/model.ts';
import { STATE_STALE_AFTER_DAYS } from '../../core/season/context.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { resolveWeek } from '../../core/matchup/build.ts';
import type { VegasProvider } from '../../core/vegas/types.ts';
import type { Database } from '../db.ts';
import { CronRunRepo, type CronRunRecord } from '../repos/cronRuns.ts';
import { LeagueRepo } from '../repos/league.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { NewsletterRepo } from '../repos/newsletter.ts';
import { PropsRepo } from '../repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { SleeperProjectionsRepo } from '../repos/sleeperProjections.ts';
import { TrendingRepo } from '../repos/trending.ts';
import { InjuryService } from './injuryService.ts';
import { SCHEDULE_SOURCE } from './scheduleService.ts';
import { NflverseService } from './nflverseService.ts';
import { SEASON_TTL_MINUTES, SeasonMarketService } from './seasonMarketService.ts';
import { UsageService, usageSeason } from './usageService.ts';
import { VEGAS_STALE_HOURS } from './setupService.ts';
import { NflScheduleRepo, ScheduleSourceRepo } from '../repos/nflSchedule.ts';

/**
 * How long each source may go without moving before it stops being current.
 *
 * Every one of these belongs to a module that already owns it, and is imported
 * rather than restated — §6's rule, enforced by having no literal minutes in
 * this file except the two the policy module declares and justifies.
 *
 *   - `FRESHNESS_HOURS.fresh` is the injury layer's own "this reading is
 *     current" boundary, the same one `injuryLine` prints against;
 *   - `VEGAS_STALE_HOURS` is what Setup has always called a stale market, and
 *     it is the *floor* under the Vegas window rather than the window itself.
 *     The market refreshes on two weekend clocks and nothing touches it in
 *     between, so a flat day-and-a-half window called a perfectly healthy
 *     market stale for most of every week — and Vegas is `critical`, so it took
 *     the headline with it. `vegasFreshWithinMinutes` stretches the window to
 *     cover the gap the cadence itself creates and no further, which turns the
 *     row's question from "how old are these lines" into "did the last
 *     scheduled refresh land". Keeping Setup's number as a floor means this can
 *     only be more patient than Setup, never less, so the two can never
 *     contradict each other about a market Setup has called stale;
 *   - `SEASON_TTL_MINUTES` is the season-market refetch window, and is used
 *     here only through `SeasonMarketService.status()`'s own `stale` verdict;
 *   - `STATE_STALE_AFTER_DAYS` is the season resolver's own patience with a
 *     cached NFL state;
 *   - `DAILY_ATTEMPT_STALE_MINUTES` and `FREQUENT_ATTEMPT_STALE_MINUTES` are
 *     the two new ones, declared and justified in `core/health/policy.ts`.
 *
 * `MAX_AGE_HOURS` from the published-projection service is deliberately *not*
 * here: twelve hours is when that feed is willing to re-ask, which is a
 * different question from when its numbers stop describing the week. It is
 * refreshed on all three clocks, so the daily window is the honest one.
 */
/**
 * A window is a number of minutes, or — for a source whose own refresh cadence
 * decides how old is too old — a function of the moment it is asked about.
 *
 * The function form exists for exactly one source and is deliberately still in
 * this one table: §6's rule is that no screen decides how old is too old, not
 * that every window has to be a constant.
 */
type Window = number | null | ((now: Date) => number);

const WINDOW_MINUTES: Record<SourceId, Window> = {
  /*
   * The daily window, because the daily cron is now what keeps it current.
   *
   * A pull down Team or Waivers refreshes it sooner and that is a bonus, never
   * the expectation — the whole reason a claimed defence went missing for two
   * days is that this app used to depend on somebody making that gesture.
   */
  roster: DAILY_ATTEMPT_STALE_MINUTES,
  injuries: FRESHNESS_HOURS.fresh * 60,
  vegas: (now) => vegasFreshWithinMinutes(now, VEGAS_STALE_HOURS * 60),
  'nfl-state': STATE_STALE_AFTER_DAYS * 24 * 60,
  'published-projections': DAILY_ATTEMPT_STALE_MINUTES,
  usage: DAILY_ATTEMPT_STALE_MINUTES,
  'season-markets': SEASON_TTL_MINUTES,
  players: DAILY_ATTEMPT_STALE_MINUTES,
  schedule: DAILY_ATTEMPT_STALE_MINUTES,
  nflverse: DAILY_ATTEMPT_STALE_MINUTES,
  trending: DAILY_ATTEMPT_STALE_MINUTES,
  newsletter: null,
  'manager-intel': DAILY_ATTEMPT_STALE_MINUTES,
};

/**
 * How long a source's *check* may be overdue before the pipeline is the story.
 *
 * Separate from the window above, and the distinction is the one §3 is built
 * on. A feed whose data is a day old on a daily cadence is fine; a feed nobody
 * has asked in three days has stopped, and its data being fine today is only
 * because it was fetched before it stopped. Where a source is already measured
 * by attempt age the two coincide, and this adds nothing.
 */
const ATTEMPT_STALE_MINUTES: Record<SourceId, number | null> = {
  roster: DAILY_ATTEMPT_STALE_MINUTES,
  injuries: FREQUENT_ATTEMPT_STALE_MINUTES,
  vegas: null,
  'nfl-state': DAILY_ATTEMPT_STALE_MINUTES,
  'published-projections': DAILY_ATTEMPT_STALE_MINUTES,
  usage: DAILY_ATTEMPT_STALE_MINUTES,
  'season-markets': DAILY_ATTEMPT_STALE_MINUTES,
  players: DAILY_ATTEMPT_STALE_MINUTES,
  schedule: DAILY_ATTEMPT_STALE_MINUTES,
  nflverse: DAILY_ATTEMPT_STALE_MINUTES,
  trending: DAILY_ATTEMPT_STALE_MINUTES,
  newsletter: null,
  'manager-intel': null,
};

/** Everything one source contributes, before the state is derived from it. */
interface SourceReading {
  id: SourceId;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** Set where the source itself has already decided, and overrides derivation. */
  state?: SourceState;
  note?: string | null;
  technical?: Partial<SourceHealth['technical']>;
}

export class DataHealthService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      /** Asked only for its name and whether it is configured. Never fetched from. */
      vegas?: VegasProvider;
      releaseSha?: string | null;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async view(): Promise<DataHealthView> {
    const now = this.now();
    const readings = await this.readAll(now);
    const sources = readings.map((reading) => this.toHealth(reading, now));

    const lastRun = await this.lastRun();
    const state = overallState(sources, lastRun);
    const attention = sources.filter(needsAttention).length;
    /*
     * "Refreshed" is the newest *success* across every source, not the newest
     * attempt. A screen that said "refreshed 4 minutes ago" because a check
     * happened four minutes ago and learned nothing would be making the exact
     * claim this whole model refuses to make.
     */
    const refreshedAt = newest(sources.map((s) => s.lastSuccessAt));

    return {
      generatedAt: now.toISOString(),
      overall: {
        state,
        headline: headline(state, attention, refreshedAt, now),
        refreshedAt,
        needsAttention: attention,
      },
      sources,
      lastRun,
      release: { gitSha: this.deps.releaseSha?.trim() || 'unknown' },
    };
  }

  /**
   * The most recent scheduled run of any clock.
   *
   * Only the daily and the two weekend ticks are recorded — the five-minute
   * injury check is not, because `injury_source_state.checked_at` already says
   * whether it ran and a second copy could only ever disagree with the first.
   * See `migrations/0033_cron_runs.sql`.
   */
  async lastRun(): Promise<RunHealth | null> {
    const record = await new CronRunRepo(this.db).latest().catch(() => null);
    if (!record) return null;
    return {
      cron: record.cron,
      label: record.label,
      trigger: record.trigger,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      outcome: record.outcome,
      summary: describeRun({ ...record }),
      budget: record.budget,
      steps: record.steps,
      releaseSha: record.releaseSha,
    };
  }

  // ------------------------------------------------------------- the sources

  private async readAll(now: Date): Promise<SourceReading[]> {
    /*
     * Every read is independent and every one is allowed to fail on its own.
     *
     * A health screen that goes blank because one of twelve reads threw is the
     * screen failing at the moment it is most needed. A source that cannot be
     * read reports `unknown`, which is the honest answer and is a state the
     * model already has a word for.
     */
    const season = usageSeason(now);
    const runs = await new CronRunRepo(this.db).all().catch(() => [] as CronRunRecord[]);

    const settled = await Promise.all([
      this.roster(),
      this.injuries(),
      this.vegas(),
      this.nflState(),
      this.publishedProjections(),
      this.usage(),
      this.seasonMarkets(now),
      this.players(),
      this.schedule(season),
      this.nflverse(season),
      this.trending(),
      this.newsletter(),
      this.managerIntel(runs),
    ].map((p) => p.catch((): SourceReading | null => null)));

    return settled.filter((r): r is SourceReading => r != null);
  }

  /**
   * When this app last asked Sleeper who is on the roster.
   *
   * `logSync('league', …)` is written by `SleeperSyncService.syncLeague`, which
   * is the only thing that replaces roster rows — so this measures the exact
   * event that matters and cannot drift from it.
   *
   * No league selected is `unknown` rather than a fault: there is nothing to
   * sync and nothing has gone wrong. A league that has never synced at all is
   * `missing`, which is a real problem and reads as one.
   */
  private async roster(): Promise<SourceReading> {
    const league = await new LeagueRepo(this.db).getSelectedLeague().catch(() => null);
    if (!league) {
      return {
        id: 'roster',
        lastSuccessAt: null,
        lastAttemptAt: null,
        state: 'unknown',
        note: 'No league selected yet. Open Setup to choose one.',
        technical: { lastOutcome: null },
      };
    }

    const last = await new SettingsRepo(this.db).lastSync('league');
    const rosters = await new LeagueRepo(this.db).listRosters(league.id).catch(() => []);
    const mine = rosters.find((r) => r.isMine) ?? null;
    const held = mine?.playerIds.length ?? 0;
    return {
      id: 'roster',
      lastSuccessAt: last?.status === 'ok' ? last.finishedAt || null : null,
      lastAttemptAt: last?.finishedAt || null,
      ...(last == null ? { state: 'missing' as const } : {}),
      note:
        last == null
          ? `${league.name} has never been read from Sleeper.`
          : last.status === 'error'
            ? 'The last roster sync did not finish, so the squad below may be out of date.'
            : `${held} player(s) on your squad in ${league.name}.`,
      technical: { lastOutcome: last?.status ?? null },
    };
  }

  private async injuries(): Promise<SourceReading> {
    const health = await new InjuryService(this.db).health();
    /*
     * Waiting, not missing, when the season's file has not been published.
     *
     * The pipeline records `not_published` for a 404 on purpose — a preseason
     * file that does not exist yet is the source having nothing to say — and
     * turning that into a fault here would undo the distinction the ingest went
     * to the trouble of recording.
     */
    const waiting = health.ingestedAt == null && health.lastOutcome === 'not_published';
    return {
      id: 'injuries',
      lastSuccessAt: health.ingestedAt,
      lastAttemptAt: health.checkedAt,
      ...(waiting ? { state: 'waiting' as const } : {}),
      note: waiting ? `No injury report published for ${health.season} yet.` : health.lastNote,
      technical: {
        lastOutcome: health.lastOutcome,
        consecutiveFailures: health.consecutiveFailures,
        failingSince: health.failingSince,
      },
    };
  }

  private async vegas(): Promise<SourceReading> {
    const freshness = await new PropsRepo(this.db).freshness();
    const provider = this.deps.vegas;
    /*
     * The provider is asked two synchronous questions and nothing else.
     *
     * `name` and `isConfigured()` are the same two Setup asks. Neither touches
     * the network, neither costs quota, and there is no third question this
     * screen has any business asking.
     */
    if (provider && provider.name === 'mock') {
      return {
        id: 'vegas',
        lastSuccessAt: freshness.fetchedAt,
        lastAttemptAt: freshness.fetchedAt,
        state: 'degraded',
        note: 'Practice data only — real betting lines are not connected.',
        technical: { lastOutcome: 'mock provider' },
      };
    }
    if (provider && !provider.isConfigured()) {
      return {
        id: 'vegas',
        lastSuccessAt: freshness.fetchedAt,
        lastAttemptAt: null,
        state: 'missing',
        note: `${provider.name} is selected but its key is missing, so no lines are being fetched.`,
        technical: { lastOutcome: 'not configured' },
      };
    }
    if (freshness.events === 0) {
      return {
        id: 'vegas',
        lastSuccessAt: null,
        lastAttemptAt: null,
        state: 'waiting',
        note: 'Connected, but no lines have been stored yet.',
      };
    }
    return {
      id: 'vegas',
      lastSuccessAt: freshness.fetchedAt,
      lastAttemptAt: freshness.fetchedAt,
      technical: { lastOutcome: freshness.provider },
    };
  }

  private async nflState(): Promise<SourceReading> {
    const state = await new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null);
    return {
      id: 'nfl-state',
      lastSuccessAt: state?.fetchedAt ?? null,
      lastAttemptAt: state?.fetchedAt ?? null,
      note: state == null ? 'Sleeper has never been asked which week it is.' : null,
      technical: { lastOutcome: state == null ? null : `${state.seasonType ?? '?'} week ${state.week ?? '?'}` },
    };
  }

  private async publishedProjections(): Promise<SourceReading> {
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    if (!league) return { id: 'published-projections', lastSuccessAt: null, lastAttemptAt: null, state: 'unknown' };
    const state = await new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const week = resolveWeek(null, state?.week ?? null, state?.seasonType ?? null);
    const held = await new SleeperProjectionsRepo(this.db).freshness(league.season, week);
    return {
      id: 'published-projections',
      lastSuccessAt: held.fetchedAt,
      lastAttemptAt: held.fetchedAt,
      ...(held.players === 0 ? { state: 'waiting' as const } : {}),
      note: held.players === 0 ? `Nothing published for week ${week} yet.` : null,
      technical: { lastOutcome: held.publisher },
    };
  }

  private async usage(): Promise<SourceReading> {
    const health = await new UsageService(this.db).health();
    const waiting = health.ingestedAt == null && health.lastOutcome === 'not_published';
    return {
      id: 'usage',
      lastSuccessAt: health.ingestedAt,
      lastAttemptAt: health.checkedAt,
      ...(waiting ? { state: 'waiting' as const } : {}),
      note: waiting
        ? `No ${health.season} usage published yet.`
        : health.latestWeek == null
          ? health.lastNote
          : `Through week ${health.latestWeek}.`,
      technical: {
        lastOutcome: health.lastOutcome,
        consecutiveFailures: health.consecutiveFailures,
        failingSince: health.failingSince,
      },
    };
  }

  private async seasonMarkets(now: Date): Promise<SourceReading> {
    /*
     * `status()` reads the stored snapshot and asks the provider nothing.
     *
     * Its `stale` verdict is the one `SEASON_TTL_MINUTES` produces, and it is
     * used verbatim rather than recomputed: the draft board prices against
     * exactly this snapshot, so the screen and the board have to be saying the
     * same thing about it.
     */
    const status = await new SeasonMarketService(this.db, this.deps.vegas ?? nullProvider()).status(now);
    return {
      id: 'season-markets',
      lastSuccessAt: status.fetchedAt,
      lastAttemptAt: status.fetchedAt,
      ...(status.fetchedAt == null ? { state: 'waiting' as const } : status.stale ? { state: 'stale' as const } : {}),
      note: status.fetchedAt == null ? 'No season-long lines stored yet.' : status.reason,
      technical: { lastOutcome: `${status.quotes} quote(s), ${status.unresolved} unresolved` },
    };
  }

  private async players(): Promise<SourceReading> {
    const last = await new SettingsRepo(this.db).lastSync('players');
    return {
      id: 'players',
      lastSuccessAt: last?.status === 'ok' ? (last.finishedAt || null) : null,
      lastAttemptAt: last?.finishedAt || null,
      ...(last == null ? { state: 'unknown' as const } : {}),
      note: last?.status === 'error' ? 'The last player-list sync did not finish.' : last?.detail ?? null,
      technical: { lastOutcome: last?.status ?? null },
    };
  }

  private async schedule(season: string): Promise<SourceReading> {
    /*
     * The repository, not `ScheduleService`.
     *
     * The service is the only thing in this app allowed to fetch a fixture
     * list, and `tests/schedule.test.ts` keeps it off every read path for
     * exactly that reason. Reading `coverage()` straight from the repository
     * gets the same three numbers with no object in scope that could fetch —
     * the boundary held structurally rather than by remembering which of the
     * service's methods are safe.
     */
    const [coverage, state] = await Promise.all([
      new NflScheduleRepo(this.db).coverage(season),
      new ScheduleSourceRepo(this.db).get(SCHEDULE_SOURCE, season).catch(() => null),
    ]);
    return {
      id: 'schedule',
      lastSuccessAt: state?.ingestedAt ?? coverage.fetchedAt,
      lastAttemptAt: state?.checkedAt ?? coverage.fetchedAt,
      ...(coverage.rows === 0 ? { state: 'missing' as const } : {}),
      note:
        coverage.rows === 0
          ? `No ${season} fixture list stored.`
          : `${coverage.teams} teams across ${coverage.weeks} weeks of ${season}.`,
      technical: {
        lastOutcome: state?.lastOutcome ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        failingSince: state?.failingSince ?? null,
      },
    };
  }

  private async nflverse(season: string): Promise<SourceReading> {
    const health = await new NflverseService(this.db).health(season);
    const runs = Object.values(health.runs).filter((r): r is NonNullable<typeof r> => r != null);
    const attempted = newest(runs.map((r) => r.fetchedAt));
    const stored = newest(runs.filter((r) => r.rowsWritten > 0).map((r) => r.fetchedAt));
    const failing = runs.filter((r) => r.outcome === 'failed');
    return {
      id: 'nflverse',
      /*
       * Nothing written is not nothing learned: an unchanged file answers 304
       * and stores no rows, which is a healthy outcome. So a run that came back
       * `ok` or `not_modified` counts as a success even with zero rows, and
       * only the row-writing runs contribute a distinct "last stored".
       */
      lastSuccessAt: stored ?? (runs.some((r) => r.outcome !== 'failed') ? attempted : null),
      lastAttemptAt: attempted,
      ...(runs.length === 0 ? { state: 'unknown' as const } : failing.length > 0 ? { state: 'degraded' as const } : {}),
      note:
        failing.length > 0
          ? `${failing.length} of ${runs.length} feed(s) did not complete.`
          : health.dataHealth,
      technical: { lastOutcome: runs.map((r) => `${r.source}: ${r.outcome}`).join(', ') || null },
    };
  }

  private async trending(): Promise<SourceReading> {
    const capture = await new TrendingRepo(this.db).capture('add');
    return {
      id: 'trending',
      lastSuccessAt: capture?.capturedAt ?? null,
      lastAttemptAt: capture?.capturedAt ?? null,
      ...(capture == null ? { state: 'waiting' as const } : {}),
      note: capture == null ? 'No trending capture stored yet.' : null,
      technical: { lastOutcome: capture == null ? null : `${capture.rows.length} player(s)` },
    };
  }

  /**
   * Delivery, and only delivery.
   *
   * The one thing this row must not do is confuse two questions that now have
   * different answers. **Is the feed alive?** is about the last issue arriving,
   * and it is what freshness is measured on. **Has a person scored it yet?** is
   * work waiting for the reader, it is normal for days at a time, and it is not
   * a fault in anything.
   *
   * So the pending work is stated in the note and changes no state at all. An
   * issue received on Sunday and untallied on Monday is a healthy newsletter
   * feed with a job attached, and calling that "degraded" would train the reader
   * to ignore the word on the day something has actually stopped arriving. Where
   * that job is announced is the Setup attention dot, which is a different
   * mechanism on a different screen for exactly this reason.
   */
  private async newsletter(): Promise<SourceReading> {
    const repo = new NewsletterRepo(this.db);
    const [received, processed, awaiting] = await Promise.all([
      repo.lastReceived(),
      repo.lastProcessed(),
      repo.awaitingTallyCount(),
    ]);
    const pending =
      awaiting > 0
        ? `${awaiting} issue${awaiting === 1 ? '' : 's'} waiting to be scored with ChatGPT. ` +
          'That is work for you, not a problem with the feed.'
        : null;
    return {
      id: 'newsletter',
      lastSuccessAt: processed?.receivedAt ?? null,
      lastAttemptAt: received?.receivedAt ?? null,
      /*
       * Waiting, always, when nothing has arrived. A newsletter is delivered
       * rather than fetched, so there is no schedule for it to be behind and no
       * such thing as a late one — only one that has not come.
       */
      ...(processed == null ? { state: 'waiting' as const } : {}),
      note: processed == null ? 'No newsletter has been processed yet.' : pending,
      technical: { lastOutcome: received?.status ?? null },
    };
  }

  private async managerIntel(runs: CronRunRecord[]): Promise<SourceReading> {
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    if (!league) return { id: 'manager-intel', lastSuccessAt: null, lastAttemptAt: null, state: 'unknown' };
    const checkpoints = await new ManagerLedgerRepo(this.db).checkpoints(league.id).catch(() => []);
    const advanced = newest(checkpoints.map((c) => c.lastSuccessAt));
    const attempted = newest(checkpoints.map((c) => c.lastAttemptAt));

    /*
     * The one source whose current state is a fact about the *scheduler*.
     *
     * Everything else here can be answered from its own table. "Did the manager
     * backfill yield because the feeds above it spent the budget" cannot: the
     * ledger looks identical whether the batch ran and found nothing or never
     * started. The run record is the only place that distinction exists, which
     * is most of why the run record exists.
     */
    const step = runs
      .flatMap((run) => run.steps.map((s) => ({ run, step: s })))
      .filter((entry) => entry.step.id === 'manager-intel')
      .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))[0];

    if (step?.step.outcome === 'deferred') {
      return {
        id: 'manager-intel',
        lastSuccessAt: advanced,
        lastAttemptAt: step.run.startedAt,
        state: 'deferred',
        note: step.step.note ?? 'Refresh budget reserved for higher-priority data.',
        technical: { lastOutcome: 'deferred' },
      };
    }

    return {
      id: 'manager-intel',
      lastSuccessAt: advanced,
      lastAttemptAt: newest([attempted, step?.run.startedAt]),
      ...(advanced == null ? { state: 'unknown' as const } : {}),
      note: step?.step.note ?? null,
      technical: { lastOutcome: step?.step.outcome ?? null },
    };
  }

  // ---------------------------------------------------------- the derivation

  /**
   * A reading, plus the policy, becomes a state.
   *
   * The order is the whole rule and it is stated once, here, for every source
   * alike — which is what stops one feed's panel deciding staleness differently
   * from another's:
   *
   *   1. a state the source itself declared wins, because a pipeline knows
   *      things this function cannot infer (a 404 is `waiting`, a missing key
   *      is `missing`) — except a declared `waiting` while the check itself is
   *      overdue, for the reason below;
   *   2. consecutive ingest failures are `degraded`, whatever the timestamps
   *      say — this is the case a fresh `checked_at` would otherwise vouch for;
   *   3. an overdue *check* is `degraded`, because data that is fine today only
   *      because it was fetched before the pipeline stopped is not fine;
   *   4. nothing ever stored, with no reason recorded, is `missing`;
   *   5. otherwise, age against this source's own window.
   *
   * ## Two questions, not one
   *
   * *Has the source published?* and *is the check still running?* are
   * independent, and rule 1 used to answer both with the first. It cost the
   * alarm rule 3 exists to raise: the injury file for a season that has not
   * started 404s every five minutes on purpose, the reading is a declared
   * `waiting`, and a declared state returned early meant the thirty-minute
   * cron-death window underneath it never got to run. A trigger somebody
   * deleted in July read exactly like a trigger firing on time — *Waiting on
   * source*, all preseason, right up to the first Sunday it mattered.
   *
   * So the overdue check is decided before the state is, and a declared
   * `waiting` yields to it: a quiet cron that is alive still reads `waiting`
   * with its last attempt minutes old, and a cron that has stopped reads
   * `degraded` whether or not the source had anything to say. Only `waiting`
   * yields — every other declared state (`missing` for an unconfigured key,
   * `degraded` for the mock provider) is already the more specific fault, and
   * saying "the scheduled check has not run" over it would be a worse sentence
   * about the same trouble.
   */
  private toHealth(reading: SourceReading, now: Date): SourceHealth {
    const policy = policyFor(reading.id);
    const declared = WINDOW_MINUTES[reading.id];
    const window = typeof declared === 'function' ? declared(now) : declared;
    const attemptWindow = ATTEMPT_STALE_MINUTES[reading.id];
    const technical: SourceHealth['technical'] = {
      lastOutcome: reading.technical?.lastOutcome ?? null,
      consecutiveFailures: reading.technical?.consecutiveFailures ?? 0,
      failingSince: reading.technical?.failingSince ?? null,
      note: boundedNote(reading.note),
    };

    const measured = policy.measure === 'attempt' ? reading.lastAttemptAt : reading.lastSuccessAt;
    const ageMinutes = minutesSince(measured, now);
    const attemptAge = minutesSince(reading.lastAttemptAt, now);

    /*
     * Whether the *check* is overdue, asked once and independently of what the
     * source itself had to say. A dead cron is a dead cron whether or not there
     * was anything to fetch, which is why this is computed above the branch
     * rather than inside it.
     */
    const checkOverdue = attemptWindow != null && attemptAge != null && attemptAge > attemptWindow;

    let state: SourceState;
    let note = reading.note ?? null;

    if (reading.state != null && !(checkOverdue && reading.state === 'waiting')) {
      state = reading.state;
    } else if (technical.consecutiveFailures > 0) {
      state = 'degraded';
      note = `${technical.consecutiveFailures} refresh${technical.consecutiveFailures === 1 ? '' : 'es'} in a row did not finish.`;
    } else if (checkOverdue) {
      state = 'degraded';
      note = 'The scheduled check for this has not run recently.';
    } else if (measured == null) {
      state = 'missing';
      note = note ?? 'Nothing has ever been stored for this.';
    } else {
      state = classifyAge(ageMinutes, window);
    }

    /*
     * The row itself is built by the shared assembler, which Demo Mode uses
     * too. The only difference between the two is above this line: a deployment
     * measures the state from what the pipelines recorded, and a scenario
     * declares it. Everything below the state is one presentation.
     */
    return {
      ...sourceHealth(policy, state, {
        lastSuccessAt: reading.lastSuccessAt,
        lastAttemptAt: reading.lastAttemptAt,
        ageMinutes,
        freshWithinMinutes: window,
        note,
      }),
      technical,
    };
  }
}

/** The newest of a list of instants, ignoring nulls and anything unparseable. */
function newest(values: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    if (value == null) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    best = value;
    bestMs = ms;
  }
  return best;
}

/**
 * A provider stand-in for the one read that needs a name and nothing else.
 *
 * `SeasonMarketService.status()` reads a stored snapshot and reports the
 * provider it was fetched from; it only falls back to `this.provider.name` when
 * nothing has ever been stored. A deployment that has never fetched a season
 * market and did not hand this service a provider gets the word `unknown`,
 * which is exactly what it is — and this cannot fetch, because it has no
 * method that does.
 */
function nullProvider(): VegasProvider {
  return {
    name: 'unknown',
    isConfigured: () => false,
    getGameLines: async () => ({ provider: 'unknown', fetchedAt: new Date(0).toISOString(), events: [] }),
  } as unknown as VegasProvider;
}
