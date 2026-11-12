/**
 * Round 22: the refresh button, as a job the server finishes on its own.
 *
 * Before this, a tap held one request open while five sources ran one after
 * another, and the phone had to stay on the page for the answer. Production's
 * own logs (Nov 5 to 11) put a real refresh at 65 to 69 seconds, nearly all of
 * it the odds provider's ten-a-minute pacer waiting out a minute; switching
 * apps or locking the phone lost the answer, and the screen never updated.
 *
 * Now a tap writes one settings row ("running"), answers at once, and the work
 * runs in the Worker's background slot (`waitUntil`), which Cloudflare keeps
 * alive after the reply and after the phone leaves. The phone asks for the job
 * row every couple of seconds while it is open and once when it comes back,
 * and reloads its screen when the row says done.
 *
 * ## Rules
 *
 *   - **Only what start/sit needs.** Team, Matchup and Data health run the
 *     `startsit` job: Alex's roster and lineup from Sleeper, the injury report,
 *     Vegas lines and the kickoff schedule. The matchup itself is read live from
 *     Sleeper by the Matchup screen. Waivers runs its own `waivers` job (league
 *     moves, trending lists, this week's projections, last week's points), the
 *     same Sleeper-only sources its old refresh used. Everything else keeps its
 *     own clock.
 *   - **One at a time, and a second tap joins.** A tap while a job is running,
 *     or within {@link JOIN_DONE_SECONDS} of one finishing, gets that job back.
 *     The claim is a compare-and-swap on the row, so two isolates cannot both
 *     start. Joining never awaits another request's promise (on Workers that
 *     hangs the request); it reads the row.
 *   - **Recent is not refetched.** Each source has a freshness window
 *     ({@link FRESHNESS_MINUTES}) and reports `current` inside it.
 *   - **Everything at once, under a deadline.** The sources are independent and
 *     run in parallel. Cloudflare allows background work about 30 seconds after
 *     the reply, so each source gets {@link STEP_DEADLINE_MS}; one that is still
 *     going is reported as not finished and the job ends on time.
 *   - **Small.** Starting reads one row and writes one; finishing writes one.
 *     The status read is one row. The job records D1's own rows read and
 *     written, so the cost is measured, not guessed.
 */

import type { Database } from '../db.ts';
import { nowIso, parseJson, toJson } from '../db.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { VegasProvider } from '../../core/vegas/types.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { LeagueRepo } from '../repos/league.ts';
import { InjurySourceRepo } from '../repos/injury.ts';
import { ScheduleSourceRepo } from '../repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { INJURY_SOURCE, InjuryService, injurySeason } from './injuryService.ts';
import { SCHEDULE_SOURCE, ScheduleService } from './scheduleService.ts';
import { SleeperSyncService } from './sleeperSync.ts';
import { VegasRefreshService } from './vegasRefresh.ts';
import { LeagueStrategyService } from './leagueStrategyService.ts';
import { WeekPointsService } from './weekPointsService.ts';
import { refreshPublishedWeek } from './startSitRefresh.ts';
import { usageSeason } from './usageService.ts';
import { costMeter, type RefreshCost } from './refreshCost.ts';

export type RefreshKind = 'startsit' | 'waivers';

export type RefreshSource =
  | 'roster'
  | 'injury'
  | 'vegas'
  | 'schedule'
  | 'transactions'
  | 'trending'
  | 'projections'
  | 'points';

/** `updated` moved data; `current` was fresh enough to skip; the rest are problems or nothing to do. */
export type RefreshOutcome = 'updated' | 'current' | 'unavailable' | 'skipped' | 'blocked';

export interface RefreshSourceStatus {
  source: RefreshSource;
  outcome: RefreshOutcome;
  /** One short clause. Never a stack trace. */
  detail: string;
  /** When this source was last known good, after the job. */
  freshAt: string | null;
  /** How long this source took inside the job. */
  ms: number;
}

export interface RefreshJob {
  id: string;
  kind: RefreshKind;
  state: 'running' | 'done';
  startedAt: string;
  finishedAt: string | null;
  /** Server time for the whole job, start to finish. */
  ms: number | null;
  sources: RefreshSourceStatus[];
  /** True when every source answered (fresh or current). */
  complete: boolean;
  /** D1's own count for this job. */
  cost: RefreshCost | null;
  /**
   * When each source was last actually asked, carried from job to job: the
   * freshness windows for the sources that keep no timestamp of their own.
   */
  checked: Partial<Record<RefreshSource, string>>;
}

/** A tap this close to a finished job gets that job: two taps never refresh twice. */
export const JOIN_DONE_SECONDS = 20;

/**
 * A running row older than this was cut off (the isolate died, a deploy landed).
 * Longer than the background allowance, so a live job is never mistaken for one.
 */
export const LEASE_SECONDS = 45;

/** Each source's share of the ~30 seconds Cloudflare allows after the reply. */
export const STEP_DEADLINE_MS = 20_000;

/**
 * How recent is recent enough, per source, from how fast each really changes.
 *
 *   - roster: lineups and pickups move any minute on a Sunday; one cheap
 *     Sleeper read set, so two minutes.
 *   - injury: the injury report's own cron checks every five minutes; a tap
 *     inside three minutes of a check would ask the same question again.
 *   - vegas: lines drift slowly midweek and the kickoff clock buys each game
 *     near its kickoff anyway; ten minutes, the same as before, and the odds
 *     budget still has the final say.
 *   - schedule: kickoffs move only when the league flexes a game (the flex
 *     windows have their own check); six hours.
 *   - transactions: claims and trades post any minute on Wednesday; two minutes.
 *   - trending: Sleeper's lists move over hours; ten minutes.
 *   - projections and points: their own gates (twelve and six hours) decide;
 *     ten minutes here only stops a burst of taps asking each time.
 */
export const FRESHNESS_MINUTES: Record<RefreshSource, number> = {
  roster: 2,
  injury: 3,
  vegas: 10,
  schedule: 6 * 60,
  transactions: 2,
  trending: 10,
  projections: 10,
  points: 10,
};

const KEYS: Record<RefreshKind, string> = {
  startsit: 'refresh.job.startsit',
  waivers: 'refresh.job.waivers',
};

export function parseRefreshKind(value: string | null | undefined): RefreshKind {
  return value === 'waivers' ? 'waivers' : 'startsit';
}

interface StoredRow {
  job: RefreshJob | null;
  updatedAt: string | null;
}

type StepResult = Omit<RefreshSourceStatus, 'source' | 'ms'>;
type Step = { source: RefreshSource; run: () => Promise<StepResult> };

export class RefreshJobService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      sleeper?: SleeperClient;
      vegas?: VegasProvider;
      now?: () => Date;
      /** `ctx.waitUntil` in the Worker. Absent: the work runs detached. */
      background?: (task: Promise<unknown>) => void;
      log?: (line: string) => void;
    } = {},
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The job as a screen should see it: a running row past its lease reads as cut off. */
  async status(kind: RefreshKind): Promise<RefreshJob | null> {
    const { job } = await this.read(kind);
    return job ? this.settle(job) : null;
  }

  /**
   * Start a refresh, or join the one already running or just finished.
   *
   * Returns at once. `finished` resolves when the background work is done; the
   * route never awaits it (that is the point), tests do.
   */
  async start(
    kind: RefreshKind,
    opts: { allowNew?: () => boolean } = {},
  ): Promise<{ job: RefreshJob; joined: boolean; finished: Promise<RefreshJob | null> }> {
    const now = this.now();
    const current = await this.read(kind);
    const existing = current.job ? this.settle(current.job) : null;
    if (existing && this.joinable(existing, now)) {
      return { job: existing, joined: true, finished: Promise.resolve(existing) };
    }
    // The route's rate limit: when it says no, the last job comes back as it is.
    if (existing && opts.allowNew && !opts.allowNew()) {
      return { job: existing, joined: true, finished: Promise.resolve(existing) };
    }

    const job: RefreshJob = {
      id: `${kind}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      state: 'running',
      startedAt: now.toISOString(),
      finishedAt: null,
      ms: null,
      sources: [],
      complete: false,
      cost: null,
      checked: existing?.checked ?? {},
    };
    const claimed = await this.claim(kind, job, current.updatedAt);
    if (!claimed) {
      // Another tap won the race between our read and our write: join it.
      const winner = (await this.read(kind)).job;
      if (winner) return { job: this.settle(winner), joined: true, finished: Promise.resolve(winner) };
    }

    const finished = this.run(job).catch((err) => {
      this.deps.log?.(`refresh-job kind=${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (this.deps.background) this.deps.background(finished);
    return { job, joined: false, finished };
  }

  /** Running and alive, or finished a moment ago. */
  private joinable(job: RefreshJob, now: Date): boolean {
    if (job.state === 'running') return true;
    const done = Date.parse(job.finishedAt ?? '');
    return Number.isFinite(done) && now.getTime() - done >= -1_000 && now.getTime() - done < JOIN_DONE_SECONDS * 1_000;
  }

  /** A running job whose lease ran out never finished; say so instead of spinning for ever. */
  private settle(job: RefreshJob): RefreshJob {
    if (job.state !== 'running') return job;
    const started = Date.parse(job.startedAt);
    if (Number.isFinite(started) && this.now().getTime() - started > LEASE_SECONDS * 1_000) {
      return { ...job, state: 'done', finishedAt: null, complete: false };
    }
    return job;
  }

  private async read(kind: RefreshKind): Promise<StoredRow> {
    const row = await this.db
      .prepare('SELECT value_json, updated_at FROM settings WHERE key = ?')
      .bind(KEYS[kind])
      .first<{ value_json: string; updated_at: string }>()
      .catch(() => null);
    if (!row) return { job: null, updatedAt: null };
    return { job: parseJson<RefreshJob | null>(row.value_json, null), updatedAt: row.updated_at };
  }

  /**
   * Write the running row only if nobody else has written it since we read it.
   *
   * With no row yet, the insert is the claim and a racer's insert makes ours a
   * no-op; with a row, the `updated_at` we read is the version we expect.
   */
  private async claim(kind: RefreshKind, job: RefreshJob, expected: string | null): Promise<boolean> {
    const stamp = nowIso();
    const result = await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
         WHERE settings.updated_at = ?`,
      )
      .bind(KEYS[kind], toJson(job), stamp, expected ?? '')
      .run();
    return (result.meta?.changes ?? 1) > 0;
  }

  private async write(job: RefreshJob): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(KEYS[job.kind], toJson(job), nowIso())
      .run();
  }

  /** The background half: every source at once, each under its deadline, then one write. */
  private async run(job: RefreshJob): Promise<RefreshJob> {
    const started = Date.now();
    const meter = costMeter(this.db);
    const steps = job.kind === 'waivers' ? this.waiverSteps(meter.db, job) : this.startSitSteps(meter.db, job);
    const sources = await Promise.all(steps.map((step) => timed(step)));

    const checked = { ...job.checked };
    for (const s of sources) {
      if (s.outcome === 'updated' || (s.outcome === 'current' && s.detail !== FRESH_DETAIL)) checked[s.source] = job.startedAt;
    }
    const done: RefreshJob = {
      ...job,
      state: 'done',
      finishedAt: this.now().toISOString(),
      ms: Date.now() - started,
      sources,
      complete: sources.every((s) => s.outcome === 'updated' || s.outcome === 'current' || s.outcome === 'skipped'),
      cost: null,
      checked,
    };
    // The final write is part of the cost, so count it, then record the total.
    done.cost = { ...meter.cost(), statements: meter.cost().statements + 1, rowsWritten: meter.cost().rowsWritten + 1 };
    await this.write(done);
    this.deps.log?.(
      `refresh-job kind=${job.kind} ms=${done.ms} rowsRead=${done.cost.rowsRead} rowsWritten=${done.cost.rowsWritten} ` +
        sources.map((s) => `${s.source}=${s.outcome}/${s.ms}ms`).join(' '),
    );
    return done;
  }

  // ------------------------------------------------------------- start/sit

  private startSitSteps(db: Database, job: RefreshJob): Step[] {
    const now = Date.parse(job.startedAt);
    return [
      { source: 'roster', run: () => this.roster(db, job, now) },
      { source: 'injury', run: () => this.injury(db, now) },
      { source: 'vegas', run: () => this.vegas(db, now) },
      { source: 'schedule', run: () => this.schedule(db, now) },
    ];
  }

  /** Alex's roster and lineup (starters) and the league, from Sleeper. */
  private async roster(db: Database, job: RefreshJob, now: number): Promise<StepResult> {
    const fresh = within(job.checked.roster, now, FRESHNESS_MINUTES.roster);
    if (fresh) return current(job.checked.roster!, now);
    const league = await new LeagueRepo(db).getSelectedLeague().catch(() => null);
    if (!league) return { outcome: 'skipped', detail: 'no league selected', freshAt: null };
    if (!this.deps.sleeper) return { outcome: 'skipped', detail: 'Sleeper client unavailable', freshAt: null };
    const result = await new SleeperSyncService(db, this.deps.sleeper).syncLeague(league.id);
    return { outcome: 'updated', detail: `${result.rosters} roster(s) re-read`, freshAt: new Date(now).toISOString() };
  }

  /** The published injury report (nflverse), through the service that owns its lease. */
  private async injury(db: Database, now: number): Promise<StepResult> {
    const season = injurySeason(new Date(now));
    const state = await new InjurySourceRepo(db).get(INJURY_SOURCE, season).catch(() => null);
    if (within(state?.checkedAt, now, FRESHNESS_MINUTES.injury)) return current(state!.checkedAt!, now);
    const run = await new InjuryService(db).refresh(season);
    if (run.outcome === 'failed') {
      return { outcome: 'unavailable', detail: run.note ?? 'injury report did not answer', freshAt: state?.checkedAt ?? null };
    }
    const moved = run.changedPlayerIds?.length ?? 0;
    return {
      outcome: moved > 0 ? 'updated' : 'current',
      detail: moved > 0 ? `${moved} designation(s) moved` : 'no change upstream',
      freshAt: run.fetchedAt,
    };
  }

  /**
   * Lines, through the budget layer and never around it.
   *
   * The provider handed in here paces without waiting out a minute: the free
   * plan allows ten requests a minute, and a pass that needs more used to sleep
   * about sixty seconds, which no background slot allows. Games past the tenth
   * are left for the next pass exactly as a provider refusal already leaves
   * them (`vegasRefresh.ts`), and the kickoff clock buys each game near its
   * kickoff regardless.
   */
  private async vegas(db: Database, now: number): Promise<StepResult> {
    const provider = this.deps.vegas;
    if (!provider) return { outcome: 'skipped', detail: 'no odds provider configured', freshAt: null };
    const last = await new SettingsRepo(db).get<string | null>(SETTING_KEYS.lastVegasRefresh, null).catch(() => null);
    if (within(last, now, FRESHNESS_MINUTES.vegas)) return current(last!, now);
    const report = await new VegasRefreshService(db, provider).refresh({ manual: true, now });
    if (report.blocked.length > 0 && report.fetched === 0) {
      return { outcome: 'blocked', detail: report.blocked[0]!, freshAt: last };
    }
    if (report.errors.length > 0 && report.fetched === 0) {
      return { outcome: 'unavailable', detail: report.errors[0]!, freshAt: last };
    }
    const left = report.leftover > 0 ? `, ${report.leftover} left for the next pass` : '';
    return {
      outcome: report.fetched > 0 ? 'updated' : 'current',
      detail: report.fetched > 0 ? `${report.fetched} game(s) re-priced${left}` : `lines already current${left}`,
      freshAt: new Date(now).toISOString(),
    };
  }

  /** Kickoff times (and so which games are on), from the stored fixture list's feed. */
  private async schedule(db: Database, now: number): Promise<StepResult> {
    const season = usageSeason(new Date(now));
    const state = await new ScheduleSourceRepo(db).get(SCHEDULE_SOURCE, season).catch(() => null);
    if (within(state?.checkedAt, now, FRESHNESS_MINUTES.schedule)) return current(state!.checkedAt!, now);
    const run = await new ScheduleService(db).refresh(season);
    if (run.outcome === 'failed') return { outcome: 'unavailable', detail: run.note ?? 'schedule did not answer', freshAt: state?.checkedAt ?? null };
    return {
      outcome: run.outcome === 'ok' && (run.rowsWritten ?? 0) > 0 ? 'updated' : 'current',
      detail: run.outcome === 'not_published' ? 'not published yet' : (run.rowsWritten ?? 0) > 0 ? 'kickoffs updated' : 'no change upstream',
      freshAt: new Date(now).toISOString(),
    };
  }

  // --------------------------------------------------------------- waivers

  private waiverSteps(db: Database, job: RefreshJob): Step[] {
    const now = Date.parse(job.startedAt);
    const context = async () => {
      const league = await new LeagueRepo(db).getSelectedLeague().catch(() => null);
      const state = await new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null).catch(() => null);
      return { league, week: state?.week ?? 1 };
    };
    // Read once, and only when some source is actually due.
    let shared: ReturnType<typeof context> | null = null;
    const sleeper = this.deps.sleeper;
    const guard = async (source: RefreshSource, work: (league: NonNullable<Awaited<ReturnType<typeof context>>['league']>, week: number) => Promise<StepResult>) => {
      if (within(job.checked[source], now, FRESHNESS_MINUTES[source])) return current(job.checked[source]!, now);
      shared ??= context();
      const { league, week } = await shared;
      if (!league) return { outcome: 'skipped' as const, detail: 'no league selected', freshAt: null };
      if (!sleeper) return { outcome: 'skipped' as const, detail: 'Sleeper client unavailable', freshAt: null };
      return work(league, week);
    };
    const at = new Date(now).toISOString();
    return [
      {
        source: 'transactions',
        run: () =>
          guard('transactions', async (league, week) => {
            const r = await new LeagueStrategyService(db, { sleeper: sleeper! }).syncTransactions({
              leagueId: league.id,
              sleeperLeagueId: league.sleeperLeagueId,
              season: league.season,
              week,
              maxWeeks: 2,
            });
            return { outcome: 'updated', detail: `${r.transactions} move(s) read`, freshAt: at };
          }),
      },
      {
        source: 'trending',
        run: () =>
          guard('trending', async () => {
            const r = await new LeagueStrategyService(db, { sleeper: sleeper! }).captureTrending();
            return { outcome: 'updated', detail: `${r.captured} trending player(s)`, freshAt: r.capturedAt };
          }),
      },
      {
        source: 'projections',
        run: () =>
          guard('projections', async (league) => {
            const rows = await refreshPublishedWeek(db, sleeper!, league.season);
            return { outcome: rows > 0 ? 'updated' : 'current', detail: rows > 0 ? `${rows} projection(s)` : 'week already current', freshAt: at };
          }),
      },
      {
        source: 'points',
        run: () =>
          guard('points', async (league, week) => {
            await new WeekPointsService(db, sleeper!).refreshRecent({ season: league.season, week, scoring: league.scoringSettings });
            return { outcome: 'current', detail: 'last week checked', freshAt: at };
          }),
      },
    ];
  }
}

/** The detail a source skipped for freshness carries, so the job does not restamp it. */
const FRESH_DETAIL = 'checked recently';

function within(at: string | null | undefined, now: number, minutes: number): boolean {
  if (!at) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  // A stamp from the future is a clock problem, not freshness.
  return age >= -60_000 && age < minutes * 60_000;
}

function current(at: string, _now: number): StepResult {
  return { outcome: 'current', detail: FRESH_DETAIL, freshAt: at };
}

async function timed(step: Step): Promise<RefreshSourceStatus> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<StepResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ outcome: 'unavailable', detail: 'still running when the refresh ended', freshAt: null }),
      STEP_DEADLINE_MS,
    );
  });
  try {
    const result = await Promise.race([
      step.run().catch((err: unknown): StepResult => ({
        outcome: 'unavailable',
        detail: err instanceof Error ? err.message : String(err),
        freshAt: null,
      })),
      deadline,
    ]);
    return { source: step.source, ...result, ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
