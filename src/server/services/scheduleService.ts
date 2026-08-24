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
import { NflScheduleRepo, ScheduleSourceRepo } from '../repos/nflSchedule.ts';
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

  constructor(
    db: Database,
    private readonly deps: { fetch?: FetchLike; now?: () => Date } = {},
  ) {
    this.schedule = new NflScheduleRepo(db);
    this.state = new ScheduleSourceRepo(db);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
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
      return {
        outcome: 'skipped',
        season,
        games: 0,
        rowsWritten: 0,
        note: `daily write ceiling reached (${spent}/${SCHEDULE_WRITE_CEILING})`,
      };
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
