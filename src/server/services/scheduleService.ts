/**
 * Ingesting the NFL fixture list, under the discipline every other published
 * file here already runs under.
 *
 * Nothing about the mechanism is new, and that is the point: a conditional GET
 * so the ordinary morning costs a round trip and no bytes, a compare-and-swap
 * lease that expires so a Worker killed mid-parse cannot wedge anything, a daily
 * write ceiling, and a `not_published` outcome that is a fact about the calendar
 * rather than an alarm. Four mechanisms proved in production by the injury,
 * usage and nflverse pipelines, inherited rather than re-invented — right down
 * to the state table, which this shares under a `source` key of its own.
 *
 * ## The cost, and why it fits on the free tier
 *
 * One conditional request a day. The fixture list is published in May and does
 * not move again except when the league flexes a Sunday-night game, so the
 * answer is 304 on nearly every tick of the season and the bytes are zero. When
 * it does move, a season is 272 games and therefore 544 rows, which is a tenth
 * of one day's write ceiling and happens a handful of times a year.
 *
 * **No new cron trigger.** The account has five and this needs none of them: it
 * rides the five-minute tick (and the `0 9 * * *` tick as a floor) in a try/catch of its own, after the
 * feeds a lineup actually depends on, because a fixture list that fails to
 * refresh costs a planning screen and must never take down the player
 * dictionary or the injury report.
 *
 * ## No read-path fetch, and last-known-good on failure
 *
 * Every read of a schedule goes to D1. This service is the only thing that
 * touches the network, and it is only ever called from the scheduled handler —
 * so a request cannot cause a fetch, and a slow or dead nflverse cannot make a
 * screen slow. When the fetch fails the stored rows are left exactly as they
 * are: the upsert is never reached, nothing is deleted, and the last good
 * fixture list stays readable. That is a property of the control flow rather
 * than a promise, and `tests/schedule.test.ts` asserts it.
 */

import { conditionalGet, type FetchLike } from '../../core/source/conditional.ts';
import { parseSchedule, SCHEDULE_URL, type ScheduleTeamWeek } from '../../core/nfl/schedule.ts';
import { NflScheduleRepo, ScheduleSourceRepo } from '../repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { invalidateKickoffClock } from './vegasKickoffClock.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import type { Database } from '../db.ts';

/** The feed's key in the shared state table. */
export const SCHEDULE_SOURCE = 'nflverse_schedule';

/** Seconds a schedule ingest lease is held for. The figure every other feed uses. */
export const SCHEDULE_LEASE_SECONDS = 120;

/**
 * What the state row says while a refresh is running -- and, if nothing ever
 * overwrites it, what it says about a refresh that was cut off.
 */
export const STARTED_NOTE = 'started and did not finish: cut off before it could record an outcome';

/**
 * Rows one day's schedule refreshes may write.
 *
 * A full season is 544. Three times that leaves room for a season boundary —
 * where the old season's last flex and the new season's release can land on the
 * same morning — without leaving room for a loop.
 */
export const SCHEDULE_WRITE_CEILING = 1_800;

/**
 * The longest this feed may go unasked: about once a day.
 *
 * It was six hours here, and ninety minutes while a game was on, and both
 * numbers were set by the **alarm** rather than by the file.
 * `DAILY_ATTEMPT_STALE_MINUTES` calls a daily feed unhealthy at 36 hours, and
 * the check used to run on the 09:00 tick alone, so a once-a-day cadence had
 * twelve hours of slack and one tick that did not land read as a degraded
 * pipeline. That is what the 37+ hour report was.
 *
 * What changed is where it runs. The check now lives on the five-minute tick,
 * which asks again every five minutes while it is overdue, so a missed tick
 * delays the next attempt by five minutes and not by a day, and the daily tick
 * is still the floor under it. The slack the six-hour interval bought is not
 * needed, and what it cost was a conditional GET four to eight times a day for
 * a file whose stored fields change only when the league flexes a game.
 *
 * Alex's call, in the round that moved the odds job onto the kickoff clock:
 * about once a day, plus a look after the league announces flexes. Those extra
 * looks are `core/nfl/flexCheck.ts`, and they bypass this interval.
 */
export const SCHEDULE_CHECK_INTERVAL_MINUTES = 24 * 60;

export interface ScheduleRefresh {
  outcome: 'ok' | 'not_modified' | 'not_published' | 'failed' | 'skipped';
  season: string;
  games: number;
  rowsWritten: number;
  /** Why nothing happened, when nothing happened. Never an exception. */
  note: string | null;
}

export class ScheduleService {
  private readonly schedule: NflScheduleRepo;
  private readonly state: ScheduleSourceRepo;

  /**
   * Retained for the two settings reads this service makes: the stored NFL week
   * (to compare the kickoffs about to be written) and the odds job's gate.
   *
   * The two repositories above are still how every row is touched.
   */
  private readonly db: Database;

  constructor(
    db: Database,
    private readonly deps: { fetch?: FetchLike; now?: () => Date } = {},
  ) {
    this.db = db;
    this.schedule = new NflScheduleRepo(db);
    this.state = new ScheduleSourceRepo(db);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Check the fixture list, but only if it is due: about once a day.
   *
   * The entry point the five-minute tick calls. `refresh` itself still does
   * exactly what it always did and is still what the daily tick calls; this
   * decides *whether*, and it is a separate method because the decision has a
   * cost of its own that the caller should be able to see.
   *
   * ## The reads
   *
   * A five-minute trigger fires 288 times a day, so anything unconditional in
   * here is multiplied by 288 before it reaches the daily row allowance this
   * repository has exhausted three times. The decision is one indexed read of
   * the state row, every tick, and nothing else: a tick less than a day after
   * the last check returns on it. That was a two-step decision when the
   * interval was six hours and ninety minutes while a game was on; with one
   * interval there is nothing left to look up.
   *
   * Measured against the 5,000,000-row daily allowance: about 288 rows a day,
   * or 0.006%. See `tests/schedule.cadence.test.ts`, which counts them rather
   * than trusting this paragraph.
   *
   * The league flexes games on a known cadence, and the checks that follow the
   * announcement do not come through here: see {@link refreshAfterFlexAnnouncement}.
   *
   * Returns null when nothing was due, so a caller can tell "not yet" from
   * "checked, and here is what happened" without reading prose.
   */
  async refreshIfDue(season: string): Promise<ScheduleRefresh | null> {
    const now = this.now();
    const state = await this.state.get(SCHEDULE_SOURCE, season).catch(() => null);

    /*
     * Never checked at all is always due.
     *
     * A cold database, a new season key, or a state row that could not be
     * read: all three mean this app has no evidence the feed has ever run, and
     * the honest response to that is to run it rather than to wait six hours
     * to find out.
     */
    const checkedAt = state?.checkedAt ? Date.parse(state.checkedAt) : NaN;
    if (!Number.isFinite(checkedAt)) return this.refresh(season);

    const elapsedMinutes = (now.getTime() - checkedAt) / 60_000;
    /*
     * The clock running backwards is not a reason to hammer the source.
     *
     * A stored timestamp in the future means a clock skew or a hand-written
     * row, and treating a negative elapsed time as "not due" is the safe
     * reading: the alternative reads as overdue for ever.
     */
    if (elapsedMinutes < SCHEDULE_CHECK_INTERVAL_MINUTES) return null;

    return this.refresh(season);
  }

  /**
   * The check the flex windows make, whatever the daily interval says.
   *
   * Still one conditional request, still a 304 in every week nothing moved, and
   * still behind the lease and the daily write ceiling. What it skips is only
   * the wait.
   */
  async refreshAfterFlexAnnouncement(season: string): Promise<ScheduleRefresh> {
    return this.refresh(season);
  }

  /**
   * Did any kickoff this week or next change in what is about to be stored?
   *
   * The odds job plans from these kickoffs, so this is the one change that
   * matters to it. The file also changes when scores land, which is most days
   * of the season and moves no kickoff; invalidating the job's gate on those
   * would plan once a day to buy nothing. Reads the stored two weeks (64 rows)
   * by primary-key prefix, once, and only on the check that is about to write.
   *
   * Conservative on every doubt: an unknown week, an empty store or a read that
   * failed all say "moved", because planning once too often costs reads and
   * planning once too rarely costs a flexed game's lines.
   */
  private async upcomingKickoffsMoved(incoming: readonly ScheduleTeamWeek[]): Promise<boolean> {
    try {
      const state = await new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null);
      const week = Number(state?.week);
      if (!Number.isInteger(week) || week < 1) return true;
      const season = incoming[0]?.season ?? '';
      const [a, b] = await Promise.all([this.schedule.forWeek(season, week), this.schedule.forWeek(season, week + 1)]);
      const stored = new Map<string, string | null>();
      for (const row of [...a, ...b]) stored.set(`${row.week}|${row.team}`, row.kickoff);
      if (stored.size === 0) return true;
      for (const row of incoming) {
        if (row.week !== week && row.week !== week + 1) continue;
        const key = `${row.week}|${row.team}`;
        if (!stored.has(key) || stored.get(key) !== row.kickoff) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Check the fixture list, and store it if it moved.
   *
   * Returns rather than throws in every branch. A schedule that could not be
   * refreshed is a fact this app can carry — the stored one is still there and
   * is still correct, because a fixture list from yesterday and one from today
   * differ by at most a flexed kickoff — and a thrown error on a shared cron
   * tick is a way to take down the feeds that ran after it.
   */
  async refresh(season: string): Promise<ScheduleRefresh> {
    const now = this.now();
    const nowIso = now.toISOString();
    const day = nowIso.slice(0, 10);

    const spent = await this.state.writesToday(day);
    if (spent >= SCHEDULE_WRITE_CEILING) {
      const note = `daily write ceiling reached (${spent}/${SCHEDULE_WRITE_CEILING})`;
      /*
       * A declined write is still the pipeline running, and the freshness row
       * has to be told so.
       *
       * Data Health measures this source by *attempt* — the question it asks
       * is "has the pipeline stopped?", not "is the fixture list old?" — and
       * this branch used to return without recording anything. So a ceiling
       * doing exactly its job looked identical to a cron that had been
       * deleted, and would have raised the same alarm the cadence change
       * above exists to stop raising falsely. Back-pressure is health.
       */
      await this.state.recordCheck(SCHEDULE_SOURCE, season, {
        checkedAt: nowIso,
        outcome: 'skipped',
        note,
      });
      return { outcome: 'skipped', season, games: 0, rowsWritten: 0, note };
    }

    const owner = `schedule-${nowIso}`;
    const held = await this.state.acquireLock(SCHEDULE_SOURCE, season, owner, now, SCHEDULE_LEASE_SECONDS);
    if (!held) {
      return { outcome: 'skipped', season, games: 0, rowsWritten: 0, note: 'another ingest holds the lease' };
    }

    let claimed = false;
    try {
      const known = await this.state.get(SCHEDULE_SOURCE, season);

      /*
       * Say that this started before doing the part that can be cut off.
       *
       * A download and parse of this file is the heaviest thing the five-minute
       * tick does, and Cloudflare ends an invocation that runs over its CPU
       * allowance with no exception, no `finally` and no line after it. Every
       * record below this point is written *after* the work, so a run that was
       * killed left `checked_at` where it was and the very next tick found the
       * refresh just as overdue -- and was killed the same way. From 27
       * September 2026 09:15 UTC that happened on 246 consecutive ticks, for
       * twenty hours, until one squeezed through.
       *
       * So the attempt is written first, as a failure: `checked_at` moves, which
       * puts the next try a whole interval away instead of five minutes, and the
       * failure count goes up, which is what a run that never came back is.
       * Every way this call does come back overwrites both. Two small writes,
       * on the few ticks a day this runs at all.
       */
      await this.state.recordCheck(SCHEDULE_SOURCE, season, {
        checkedAt: nowIso,
        outcome: 'started',
        note: STARTED_NOTE,
      });
      await this.state.recordIngestFailure(SCHEDULE_SOURCE, season, nowIso, STARTED_NOTE);
      claimed = true;

      const response = await conditionalGet(SCHEDULE_URL, {
        fetch: this.deps.fetch,
        fingerprint: known ? { etag: known.etag, lastModified: known.lastModified } : null,
        describe: 'the NFL schedule',
      });

      if (response.outcome !== 'ok' || response.text == null) {
        /*
         * 304, 404 and a failure all land here, and all three leave the stored
         * schedule alone.
         *
         * They are recorded differently because they mean different things — an
         * unchanged file is the healthy answer, a missing one is a fact about
         * the calendar, and a 503 is neither — but none of them is a reason to
         * touch a row. The last known good fixture list is the fixture list.
         */
        await this.state.recordCheck(SCHEDULE_SOURCE, season, {
          checkedAt: nowIso,
          etag: response.fingerprint.etag,
          lastModified: response.fingerprint.lastModified,
          outcome: response.outcome,
          note: response.note,
        });
        // A failure was already counted when the attempt was claimed above; a
        // 304 or a 404 is the pipeline working, so it clears that count.
        if (response.outcome !== 'failed') {
          await this.state.recordIngestSuccess(SCHEDULE_SOURCE, season, null);
        }
        return { outcome: response.outcome, season, games: 0, rowsWritten: 0, note: response.note };
      }

      const parsed = parseSchedule(response.text, { season });
      if (parsed.rows.length === 0) {
        /*
         * A file that parsed to nothing for this season.
         *
         * Ordinary in the spring, when nflverse has published next season's
         * file but not next season's fixtures — and indistinguishable, from
         * here, from a truncated download. Either way the answer is the same
         * and it is not to write: an empty ingest that replaced a good schedule
         * would be the one failure this design cannot recover from on its own.
         */
        await this.state.recordCheck(SCHEDULE_SOURCE, season, {
          checkedAt: nowIso,
          etag: response.fingerprint.etag,
          lastModified: response.fingerprint.lastModified,
          sourceModifiedAt: response.publishedAt,
          outcome: 'not_published',
          note: `no ${season} fixtures in the published schedule yet`,
        });
        await this.state.recordIngestSuccess(SCHEDULE_SOURCE, season, null);
        return {
          outcome: 'not_published',
          season,
          games: 0,
          rowsWritten: 0,
          note: `no ${season} fixtures in the published schedule yet`,
        };
      }

      const moved = await this.upcomingKickoffsMoved(parsed.rows);
      const rowsWritten = await this.schedule.save(parsed.rows, nowIso);
      // After the write, so a pass that wakes on the flag reads the new kickoffs.
      if (moved) await invalidateKickoffClock(this.db).catch(() => undefined);
      await this.state.addWrites(day, rowsWritten, nowIso);
      await this.state.recordCheck(SCHEDULE_SOURCE, season, {
        checkedAt: nowIso,
        etag: response.fingerprint.etag,
        lastModified: response.fingerprint.lastModified,
        sourceModifiedAt: response.publishedAt,
        ingestedAt: nowIso,
        outcome: 'ok',
        note: `${parsed.games} games, ${rowsWritten} rows`,
      });
      await this.state.recordIngestSuccess(SCHEDULE_SOURCE, season, null);

      return { outcome: 'ok', season, games: parsed.games, rowsWritten, note: null };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      // Counted once: by the claim when it was written, here when it was not.
      await (claimed
        ? this.state.recordCheck(SCHEDULE_SOURCE, season, { checkedAt: nowIso, outcome: 'ingest_failed', note })
        : this.state.recordIngestFailure(SCHEDULE_SOURCE, season, nowIso, note)
      ).catch(() => undefined);
      return { outcome: 'failed', season, games: 0, rowsWritten: 0, note };
    } finally {
      await this.state.releaseLock(SCHEDULE_SOURCE, season, owner).catch(() => undefined);
    }
  }

  /** One team's stored season. A D1 read; never a fetch. */
  async forTeam(season: string, team: string): Promise<ScheduleTeamWeek[]> {
    return this.schedule.forTeam(season, team);
  }

  /** One sentence about how much schedule is stored, for the health surfaces. */
  async health(season: string): Promise<{ season: string; rows: number; weeks: number; teams: number; fetchedAt: string | null; dataHealth: string }> {
    const coverage = await this.schedule.coverage(season);
    const dataHealth =
      coverage.rows === 0
        ? `No ${season} schedule stored yet.`
        : `${coverage.teams} teams across ${coverage.weeks} weeks of ${season}.`;
    return { season, ...coverage, dataHealth };
  }
}
