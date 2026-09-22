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
 * rides the existing `0 9 * * *` tick in a try/catch of its own, after the
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
import { gameWindowFrom } from '../../core/nfl/gameWindow.ts';
import { NflScheduleRepo, ScheduleSourceRepo } from '../repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import type { Database } from '../db.ts';

/** The feed's key in the shared state table. */
export const SCHEDULE_SOURCE = 'nflverse_schedule';

/** Seconds a schedule ingest lease is held for. The figure every other feed uses. */
export const SCHEDULE_LEASE_SECONDS = 120;

/**
 * Rows one day's schedule refreshes may write.
 *
 * A full season is 544. Three times that leaves room for a season boundary —
 * where the old season's last flex and the new season's release can land on the
 * same morning — without leaving room for a loop.
 */
export const SCHEDULE_WRITE_CEILING = 1_800;

/**
 * The longest this feed may go unasked on an ordinary day.
 *
 * Six hours, and the number is set by the **alarm** rather than by the file.
 * `DAILY_ATTEMPT_STALE_MINUTES` calls a daily feed unhealthy at 36 hours, and
 * this ran on the 09:00 tick and nowhere else — so a once-a-day check had
 * twelve hours of slack against it, and a single tick that did not land read
 * as a degraded pipeline. That is what happened: the source was reported at
 * 37+ hours, which is one missed tick and change, on a feed whose data was
 * perfectly good the whole time.
 *
 * Four checks a day puts five and a half missed ticks between healthy and the
 * alarm instead of one and a half. The cost of the extra three is three
 * conditional GETs that answer 304 with no body — see the header.
 */
export const SCHEDULE_CHECK_INTERVAL_MINUTES = 6 * 60;

/**
 * …and the longest while football is actually being played.
 *
 * Ninety minutes. **This buys pipeline liveness, not fresher numbers, and the
 * distinction is worth stating because the opposite was assumed.** Nothing in
 * this file's output changes during a game: the parser keeps season, week,
 * team, opponent, home, kickoff and roof, and the only one of those that ever
 * moves mid-season is a flexed kickoff, which the league announces days ahead
 * on a weekday. A defence's Sunday numbers come from the Vegas lines and the
 * injury check, not from here.
 *
 * What a game window genuinely is, for this feed, is when nflverse rebuilds
 * `games.csv` — it regenerates around the slate — so it is the part of the
 * week where a conditional GET is most likely to come back 200 rather than
 * 304, and the part where a stalled ingest is worth noticing soonest.
 *
 * The write ceiling above is what stops a run of 200s turning into a run of
 * 544-row writes; at four checks in a Sunday window the ceiling is reached
 * after three and the fourth is declined, recorded, and costs nothing.
 */
export const SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES = 90;

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
   * Retained for the week lookup `refreshIfDue` makes, and for nothing else.
   *
   * The two repositories above are still how every row is touched. This is
   * here because the cadence decision needs the stored NFL week, which lives
   * in settings rather than in either of them.
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
   * Check the fixture list, but only if it is due.
   *
   * The entry point the five-minute tick calls. `refresh` itself still does
   * exactly what it always did and is still what the daily tick calls; this
   * decides *whether*, and it is a separate method because the decision has a
   * cost of its own that the caller should be able to see.
   *
   * ## The reads, in the order they are worth paying for
   *
   * A five-minute trigger fires 288 times a day, so anything unconditional in
   * here is multiplied by 288 before it reaches the daily row allowance this
   * repository has exhausted three times. So the cheap question is asked
   * first and answers nearly every tick on its own:
   *
   *  1. **The state row.** One indexed read, every tick. If less time has
   *     passed than even the *live* interval, nothing else is read and the
   *     tick is over. At 90 minutes that is roughly 94% of ticks.
   *  2. **This week's kickoffs**, and only on the remaining ~16 ticks a day.
   *     One settings row for the week, then 32 rows on the primary key's own
   *     `(season, week)` prefix. Not a scan, and deliberately not a range
   *     query on `kickoff` — there is no index on that column, so asking the
   *     obvious question would read the whole season to answer it.
   *
   * Measured against the 5,000,000-row daily allowance: 288 + 16 × 33 ≈ 816
   * rows, or about 0.016% of a day. See `tests/schedule.cadence.test.ts`,
   * which counts them rather than trusting this paragraph.
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
    if (elapsedMinutes < SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES) return null;

    const due = (await this.footballIsOn(season, now))
      ? SCHEDULE_LIVE_CHECK_INTERVAL_MINUTES
      : SCHEDULE_CHECK_INTERVAL_MINUTES;
    if (elapsedMinutes < due) return null;

    return this.refresh(season);
  }

  /**
   * Is a game being played right now, according to the fixtures we stored?
   *
   * From this app's own schedule rather than from a table of Eastern kickoff
   * times, for the four reasons `core/nfl/gameWindow.ts` sets out — daylight
   * saving, London, Saturday football and Thanksgiving are each an hour or a
   * whole slot that a clock-arithmetic answer gets wrong.
   *
   * False whenever the week cannot be established or no fixture is stored,
   * which is the conservative direction: the slower cadence is the one that
   * costs nothing, so an unknown week keeps this feed on it.
   */
  private async footballIsOn(season: string, now: Date): Promise<boolean> {
    try {
      const state = await new SettingsRepo(this.db).get<{ week?: number } | null>(SETTING_KEYS.nflState, null);
      const week = Number(state?.week);
      if (!Number.isInteger(week) || week <= 0) return false;
      const fixtures = await this.schedule.forWeek(season, week);
      return gameWindowFrom(
        fixtures.map((f) => f.kickoff),
        now,
      ).live;
    } catch {
      return false;
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

    try {
      const known = await this.state.get(SCHEDULE_SOURCE, season);
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
        if (response.outcome === 'failed') {
          await this.state.recordIngestFailure(SCHEDULE_SOURCE, season, nowIso, response.note ?? 'fetch failed');
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
        return {
          outcome: 'not_published',
          season,
          games: 0,
          rowsWritten: 0,
          note: `no ${season} fixtures in the published schedule yet`,
        };
      }

      const rowsWritten = await this.schedule.save(parsed.rows, nowIso);
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
      await this.state
        .recordIngestFailure(SCHEDULE_SOURCE, season, nowIso, note)
        .catch(() => undefined);
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
