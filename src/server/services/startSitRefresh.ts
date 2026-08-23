/**
 * One tap, every source that can honestly be refreshed on demand.
 *
 * The app already keeps itself current: injuries on a five-minute cron, usage
 * daily, Vegas on its own budgeted clock. This exists for the ninety seconds
 * before a Sunday lineup locks, when "it will update itself shortly" is not an
 * answer. It replaces the idea of a special Sunday mode with a button.
 *
 * ## What it is, precisely
 *
 * An **orchestrator**, not a pipeline. Every source below is refreshed by the
 * service that already owns it, with that service's own freshness rules, lease
 * and budget intact. Nothing here fetches anything itself, nothing here creates
 * a schedule, and nothing here can spend a penny the budget layer would have
 * refused — see `docs/VEGAS.md` for why that guarantee has to live in one place.
 *
 * ## Four rules it obeys
 *
 *   - **already fresh is not refetched.** Each source is asked only if its own
 *     staleness threshold has passed. The reply then says "current" rather than
 *     "updated", which is the truth and is also the honest thing to show.
 *   - **one at a time.** Rapid taps inside {@link DEDUPE_SECONDS} return the
 *     previous result rather than starting a second pass, so a double tap cannot
 *     double-spend.
 *   - **a failure is partial, never total.** Each source is caught on its own.
 *     One dead provider costs that source's freshness line and leaves every
 *     other answer, and the whole of the last-good data, exactly where it was.
 *   - **no new cron work.** This does not register schedules, mutate the
 *     scheduler, or start background jobs. It runs, it returns, it is done.
 */

import type { Database } from '../db.ts';
import { SleeperClient } from '../../core/sleeper/client.ts';
import type { VegasProvider } from '../../core/vegas/types.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PropsRepo } from '../repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { InjuryService } from './injuryService.ts';
import { SleeperSyncService } from './sleeperSync.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';
import { resolveWeek } from '../../core/matchup/build.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { UsageService } from './usageService.ts';
import { VegasRefreshService } from './vegasRefresh.ts';

/** Taps closer together than this share one answer. */
export const DEDUPE_SECONDS = 20;

/**
 * How stale each source has to be before a manual refresh will re-ask.
 *
 * These are the *on-demand* thresholds and they are deliberately shorter than
 * the cron intervals: somebody who taps refresh is telling you something has
 * changed. They are still thresholds rather than zero, because the point of the
 * button is freshness, not traffic.
 */
export const MANUAL_MIN_AGE_MINUTES = {
  /** Roster and designations. Cheap, unmetered, and the most likely to move. */
  sleeper: 1,
  /** The published injury report. Its own five-minute cron backs this up. */
  injury: 3,
  /** Weekly stats. Settled the moment a game ends, so there is rarely news. */
  usage: 180,
  /** Lines. The budget layer has the final say whatever this says. */
  vegas: 10,
} as const;

export type SourceOutcome = 'updated' | 'current' | 'unavailable' | 'skipped' | 'blocked';

export interface SourceStatus {
  source: 'sleeper' | 'injury' | 'usage' | 'vegas' | 'weather';
  outcome: SourceOutcome;
  /** One short clause for the status line. Never a stack trace. */
  detail: string;
  /** When this source was last known good, after the refresh. */
  freshAt: string | null;
}

export interface StartSitRefreshReport {
  startedAt: string;
  finishedAt: string;
  /** True when this call was collapsed into one already in flight or just done. */
  deduped: boolean;
  sources: SourceStatus[];
  /** `Updated · Vegas current · injury source delayed` — the whole line. */
  headline: string;
  /** True when every source that was asked answered. */
  complete: boolean;
}

/**
 * The last report, per database.
 *
 * Module state, keyed by the database object rather than global, so two
 * deployments (or two tests) sharing a process cannot collapse each other's
 * refreshes. A Worker isolate lives long enough for this to catch the double
 * tap it exists for and short enough that it never becomes a cache.
 */
const recent = new WeakMap<Database, { at: number; report: StartSitRefreshReport }>();

export class StartSitRefreshService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      sleeper?: SleeperClient;
      vegas?: VegasProvider;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async refresh(): Promise<StartSitRefreshReport> {
    const now = this.now();
    const previous = recent.get(this.db);
    if (previous && now.getTime() - previous.at < DEDUPE_SECONDS * 1_000) {
      // The same answer, marked as the same answer. Returning a fresh-looking
      // report for work that did not happen would be the one lie this whole
      // feature cannot afford.
      return { ...previous.report, deduped: true };
    }

    const startedAt = now.toISOString();
    const settings = new SettingsRepo(this.db);
    const sources: SourceStatus[] = [];

    sources.push(await this.refreshSleeper(now));
    sources.push(await this.refreshInjuries(now));
    sources.push(await this.refreshUsage(now));
    sources.push(await this.refreshVegas(now, settings));
    sources.push(this.weatherStatus());

    const report: StartSitRefreshReport = {
      startedAt,
      finishedAt: this.now().toISOString(),
      deduped: false,
      sources,
      headline: headlineFor(sources),
      complete: sources.every((s) => s.outcome !== 'unavailable'),
    };
    recent.set(this.db, { at: now.getTime(), report });
    return report;
  }

  /**
   * Roster, starters and Sleeper's own designations.
   *
   * The one source with no quota and the highest chance of having changed in
   * the last hour: a manager who moved somebody out of their lineup, or a
   * status that flipped to Out overnight.
   */
  private async refreshSleeper(now: Date): Promise<SourceStatus> {
    const repo = new LeagueRepo(this.db);
    const league = await repo.getSelectedLeague().catch(() => null);
    if (!league) {
      return { source: 'sleeper', outcome: 'skipped', detail: 'no league selected', freshAt: null };
    }
    const sleeper = this.deps.sleeper;
    if (!sleeper) {
      return { source: 'sleeper', outcome: 'skipped', detail: 'Sleeper client unavailable', freshAt: null };
    }
    try {
      const result = await new SleeperSyncService(this.db, sleeper).syncLeague(league.id);
      /*
       * And, on the same tap, the published projections — from the same source.
       *
       * Not a sixth entry in the report. This is Sleeper, it is fetched from
       * Sleeper, and a status line that named it separately would imply a feed
       * that can fail on its own and be worth telling the user about; it cannot
       * and is not. It fills a column that is otherwise blank until the next
       * cron, and it has its own twelve-hour gate, so the ordinary tap declines
       * it for the price of one indexed read.
       *
       * Its outcome never changes this source's. A projection that could not be
       * fetched is a dash on a screen; a roster that could not be re-read is the
       * lineup being wrong, and reporting the first as though it were the second
       * would teach the reader to ignore the line.
       */
      let projections = '';
      try {
        const state = await new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null);
        const week = resolveWeek(null, state?.week ?? null, state?.seasonType ?? null);
        const report = await new SleeperProjectionService(this.db, sleeper).refresh(league.season, week);
        if (report.outcome === 'fetched') projections = `, ${report.rows} projection(s)`;
      } catch {
        // Deliberately silent — see above.
      }
      return {
        source: 'sleeper',
        outcome: 'updated',
        detail: `${result.rosters} roster(s) re-read${projections}`,
        freshAt: now.toISOString(),
      };
    } catch (err) {
      return { source: 'sleeper', outcome: 'unavailable', detail: reason(err), freshAt: null };
    }
  }

  /**
   * The published injury report, through the service that owns its lease.
   *
   * `refresh` here is conditional at the HTTP level — it sends the stored
   * validators and the source answers 304 on most calls — so a tap during a
   * quiet hour costs one request and no parse, and "not_modified" comes back as
   * `current` rather than as a failure.
   */
  private async refreshInjuries(now: Date): Promise<SourceStatus> {
    try {
      const service = new InjuryService(this.db);
      const health = await service.health().catch(() => null);
      const age = ageMinutes(health?.checkedAt ?? null, now);
      if (age != null && age < MANUAL_MIN_AGE_MINUTES.injury) {
        return {
          source: 'injury',
          outcome: 'current',
          detail: `checked ${Math.round(age)} min ago`,
          freshAt: health?.checkedAt ?? null,
        };
      }
      const run = await service.refresh();
      return {
        source: 'injury',
        outcome:
          run.outcome === 'failed' ? 'unavailable' : (run.changedPlayerIds?.length ?? 0) > 0 ? 'updated' : 'current',
        detail:
          run.outcome === 'failed'
            ? (run.note ?? 'injury source did not answer')
            : (run.changedPlayerIds?.length ?? 0) > 0
              ? `${run.changedPlayerIds!.length} designation(s) moved`
              : 'no change upstream',
        freshAt: run.outcome === 'failed' ? (health?.checkedAt ?? null) : run.fetchedAt,
      };
    } catch (err) {
      return { source: 'injury', outcome: 'unavailable', detail: reason(err), freshAt: null };
    }
  }

  /**
   * Weekly usage, and why the threshold here is three hours rather than one.
   *
   * A game's target count is settled when the game ends and never changes
   * again, and the file is republished a handful of times a week. Asking more
   * often than that cannot learn anything, and the conditional GET would answer
   * 304 every time — so the honest thing on a Sunday morning is to say the data
   * is current rather than to perform a check.
   */
  private async refreshUsage(now: Date): Promise<SourceStatus> {
    try {
      const service = new UsageService(this.db);
      const health = await service.health().catch(() => null);
      const age = ageMinutes(health?.checkedAt ?? null, now);
      if (age != null && age < MANUAL_MIN_AGE_MINUTES.usage) {
        return {
          source: 'usage',
          outcome: 'current',
          detail: `through week ${health?.latestWeek ?? '—'}`,
          freshAt: health?.checkedAt ?? null,
        };
      }
      const run = await service.refresh();
      return {
        source: 'usage',
        outcome: run.outcome === 'failed' ? 'unavailable' : run.rowsWritten > 0 ? 'updated' : 'current',
        detail:
          run.outcome === 'not_published'
            ? 'not published for this season yet'
            : run.outcome === 'failed'
              ? (run.note ?? 'usage source did not answer')
              : run.rowsWritten > 0
                ? `week ${run.week} · ${run.rowsWritten} row(s)`
                : 'no change upstream',
        freshAt: run.outcome === 'failed' ? (health?.checkedAt ?? null) : run.fetchedAt,
      };
    } catch (err) {
      return { source: 'usage', outcome: 'unavailable', detail: reason(err), freshAt: null };
    }
  }

  /**
   * Lines, through the budget layer and never around it.
   *
   * `VegasRefreshService.refresh` is the only thing in the app allowed to spend
   * quota, and it is called here exactly as the cron calls it — the `manual`
   * flag shortens the cache TTL for a game about to start and changes nothing
   * about the ceiling. A refusal comes back as `blocked` with the budget's own
   * words, which is the state the user needs to see: the lines on screen are
   * the last good ones and the app is not going to buy more this month.
   */
  private async refreshVegas(now: Date, settings: SettingsRepo): Promise<SourceStatus> {
    const provider = this.deps.vegas;
    if (!provider) {
      return { source: 'vegas', outcome: 'skipped', detail: 'no odds provider configured', freshAt: null };
    }
    const freshness = await new PropsRepo(this.db).freshness().catch(() => null);
    const last = await settings.get<string | null>(SETTING_KEYS.lastVegasRefresh, null).catch(() => null);
    const age = ageMinutes(last, now);
    if (age != null && age < MANUAL_MIN_AGE_MINUTES.vegas) {
      return {
        source: 'vegas',
        outcome: 'current',
        detail: `refreshed ${Math.round(age)} min ago`,
        freshAt: freshness?.fetchedAt ?? last,
      };
    }

    try {
      const report = await new VegasRefreshService(this.db, provider).refresh({ manual: true, now: now.getTime() });
      if (report.blocked.length > 0 && report.fetched === 0) {
        return { source: 'vegas', outcome: 'blocked', detail: report.blocked[0]!, freshAt: freshness?.fetchedAt ?? null };
      }
      if (report.errors.length > 0 && report.fetched === 0) {
        return { source: 'vegas', outcome: 'unavailable', detail: report.errors[0]!, freshAt: freshness?.fetchedAt ?? null };
      }
      const after = await new PropsRepo(this.db).freshness().catch(() => freshness);
      return {
        source: 'vegas',
        outcome: report.fetched > 0 ? 'updated' : 'current',
        detail: report.fetched > 0 ? `${report.fetched} game(s) re-priced` : 'lines already current',
        freshAt: after?.fetchedAt ?? null,
      };
    } catch (err) {
      return { source: 'vegas', outcome: 'unavailable', detail: reason(err), freshAt: freshness?.fetchedAt ?? null };
    }
  }

  /**
   * Weather, which this app does not have a source for.
   *
   * Reported rather than omitted, and reported as `skipped` rather than as
   * `current`. The weather model exists and is wired
   * (`core/startsit/weather.ts`); no free forecast feed is connected to it yet,
   * so every game's forecast is unknown and the component contributes nothing.
   * Saying so in the same list as the sources that did refresh is the difference
   * between a limitation and a silent gap.
   */
  private weatherStatus(): SourceStatus {
    return {
      source: 'weather',
      outcome: 'skipped',
      detail: 'no forecast source connected',
      freshAt: null,
    };
  }
}

/** `Updated · Vegas current · injury source delayed` */
function headlineFor(sources: SourceStatus[]): string {
  const updated = sources.filter((s) => s.outcome === 'updated');
  const problems = sources.filter((s) => s.outcome === 'unavailable' || s.outcome === 'blocked');
  const head = updated.length > 0 ? 'Updated' : 'Already current';
  const tail = [
    ...sources.filter((s) => s.outcome === 'current').map((s) => `${label(s.source)} current`),
    ...problems.map((s) => `${label(s.source)} ${s.outcome === 'blocked' ? 'over budget' : 'delayed'}`),
  ];
  return [head, ...tail].join(' · ');
}

const LABELS: Record<SourceStatus['source'], string> = {
  sleeper: 'roster',
  injury: 'injury',
  usage: 'usage',
  vegas: 'Vegas',
  weather: 'weather',
};

function label(source: SourceStatus['source']): string {
  return LABELS[source];
}

function ageMinutes(at: string | null | undefined, now: Date): number | null {
  if (!at) return null;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return null;
  const minutes = (now.getTime() - parsed) / 60_000;
  // A clock disagreement is not freshness. Treat the future as unknown.
  return minutes < -1 ? null : minutes;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
