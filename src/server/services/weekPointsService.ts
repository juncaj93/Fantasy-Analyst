/**
 * Last week's fantasy points, kept in one settings row per week.
 *
 * The bid model's main pull is what each player scored last week in this
 * league's scoring (see `core/waivers/bidModel.ts`). Sleeper publishes every
 * player's stat line for a week in one free request; this scores it with the
 * league's own settings (`core/sleeper/weekPoints.ts`) and keeps the result as
 * `sleeper.weekPoints.<season>.<week>`. No schema change, and the Waivers
 * screen reads one row.
 *
 * Fetched from the Waivers refresh and the three-hourly league read, never on a
 * page load. A week is fetched again until a copy taken a day after its games
 * is stored, which covers stat corrections from Monday night.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import {
  aheadPointsKey,
  buildSeasonPoints,
  scoreProjectionRows,
  scoreWeek,
  seasonPointsKey,
  weekPointsKey,
  type StoredSeasonPoints,
  type StoredWeekPoints,
} from '../../core/sleeper/weekPoints.ts';
import type { Database } from '../db.ts';
import { SettingsRepo } from '../repos/settings.ts';

/** A copy younger than this is not refetched. */
const REFRESH_HOURS = 6;

/**
 * A later week's projection moves slowly until that week arrives: twelve
 * hours, the same gate the shared projection feed keeps.
 */
const AHEAD_REFRESH_HOURS = 12;

/** The season row is rebuilt at least this often, for stat corrections. */
const SEASON_REFRESH_HOURS = 12;

/** Missing finished weeks fetched per run while the season row fills. */
export const SEASON_BACKFILL_PER_RUN = 2;

/** How many weeks past the current one are kept: the waiver window's reach. */
export const AHEAD_WEEKS = 3;

export class WeekPointsService {
  private readonly settings: SettingsRepo;

  constructor(
    db: Database,
    private readonly sleeper: SleeperClient,
  ) {
    this.settings = new SettingsRepo(db);
  }

  /** This week and last week, each behind its own gate. Sleeper only; never throws. */
  async refreshRecent(opts: { season: string; week: number; scoring: Readonly<Record<string, number>>; now?: Date }) {
    const out = [];
    for (const week of [opts.week - 1, opts.week]) {
      out.push(
        await this.refresh({ ...opts, week, currentWeek: opts.week }).catch((err: unknown) => ({
          week,
          stored: 0,
          skipped: err instanceof Error ? err.message : String(err),
        })),
      );
    }
    return out;
  }

  /**
   * The weeks after this one, for the waiver planner, each behind its own
   * twelve-hour gate: at most three Sleeper calls, usually none. Run from the
   * three-hourly league read only, so the Waivers pull-to-refresh asks Sleeper
   * for nothing it did not ask for before. Never throws.
   */
  async refreshAheadWeeks(opts: { season: string; week: number; scoring: Readonly<Record<string, number>>; now?: Date }) {
    const out = [];
    for (let week = opts.week + 1; week <= opts.week + AHEAD_WEEKS; week++) {
      out.push(
        await this.refreshAhead({ ...opts, week }).catch((err: unknown) => ({
          week,
          stored: 0,
          skipped: err instanceof Error ? err.message : String(err),
        })),
      );
    }
    return out;
  }

  /** The stored weeks ahead, week to player to points. One row read per week. */
  async readAhead(season: string, weeks: readonly number[]): Promise<Map<number, Map<string, number>>> {
    const out = new Map<number, Map<string, number>>();
    const rows = await Promise.all(
      weeks.map((week) => this.settings.get<StoredWeekPoints | null>(aheadPointsKey(season, week), null).catch(() => null)),
    );
    rows.forEach((row, k) => {
      if (row?.points) out.set(weeks[k]!, new Map(Object.entries(row.points)));
    });
    return out;
  }

  /**
   * Fetch and store Sleeper's projection for a week still to come, scored in
   * this league's rules, when the stored copy is missing or older than twelve
   * hours. Never written to the shared projection table.
   */
  async refreshAhead(opts: {
    season: string;
    week: number;
    scoring: Readonly<Record<string, number>>;
    now?: Date;
  }): Promise<{ week: number; stored: number; skipped: string | null }> {
    const now = opts.now ?? new Date();
    if (opts.week < 1 || opts.week > 18) return { week: opts.week, stored: 0, skipped: 'not a regular-season week' };
    const key = aheadPointsKey(opts.season, opts.week);
    const held = await this.settings.get<StoredWeekPoints | null>(key, null).catch(() => null);
    if (held && now.getTime() - Date.parse(held.fetchedAt) < AHEAD_REFRESH_HOURS * 3_600_000) {
      return { week: opts.week, stored: Object.keys(held.points).length, skipped: 'stored copy is recent' };
    }
    const points = scoreProjectionRows(await this.sleeper.getWeeklyProjections(opts.season, opts.week), opts.scoring);
    if (Object.keys(points).length === 0) return { week: opts.week, stored: 0, skipped: 'Sleeper had no projections for that week' };
    const row: StoredWeekPoints = { season: opts.season, week: opts.week, fetchedAt: now.toISOString(), points };
    await this.settings.set(key, row);
    return { week: opts.week, stored: Object.keys(points).length, skipped: null };
  }

  /**
   * The season row for Waivers round 2: every finished week (1 to the week
   * before Sleeper's current one), week by week. Rebuilt when it is missing,
   * behind, or twelve hours old (stat corrections). A finished week with no
   * stored row is fetched, at most {@link SEASON_BACKFILL_PER_RUN} per run, so
   * the first runs after a deploy fill the early weeks a couple at a time.
   * From the three-hourly league read only. Never throws.
   */
  async refreshSeasonPoints(opts: {
    season: string;
    week: number;
    scoring: Readonly<Record<string, number>>;
    now?: Date;
  }): Promise<{ through: number; weeks: number; fetched: number; skipped: string | null }> {
    const now = opts.now ?? new Date();
    const through = Math.min(17, opts.week - 1);
    if (through < 1) return { through: 0, weeks: 0, fetched: 0, skipped: 'no finished week yet' };
    const key = seasonPointsKey(opts.season);
    const held = await this.settings.get<StoredSeasonPoints | null>(key, null).catch(() => null);
    if (held && held.through >= through && now.getTime() - Date.parse(held.fetchedAt) < SEASON_REFRESH_HOURS * 3_600_000) {
      return { through: held.through, weeks: held.through, fetched: 0, skipped: 'stored copy is recent' };
    }
    const keys = Array.from({ length: through }, (_, i) => weekPointsKey(opts.season, i + 1));
    const stored = await this.settings.getMany<StoredWeekPoints>(keys).catch(() => new Map<string, StoredWeekPoints>());
    const weeks = new Map<number, Record<string, number>>();
    let fetched = 0;
    for (let w = 1; w <= through; w++) {
      const row = stored.get(weekPointsKey(opts.season, w));
      if (row?.points) {
        weeks.set(w, row.points);
        continue;
      }
      if (fetched >= SEASON_BACKFILL_PER_RUN) continue;
      const result = await this.refresh({ season: opts.season, week: w, currentWeek: opts.week, scoring: opts.scoring, now }).catch(() => null);
      fetched += 1;
      if (result && result.stored > 0) {
        const again = await this.settings.get<StoredWeekPoints | null>(weekPointsKey(opts.season, w), null).catch(() => null);
        if (again?.points) weeks.set(w, again.points);
      }
    }
    /* Only as far as the weeks run unbroken: a gap would read as a zero week. */
    let covered = 0;
    while (covered < through && weeks.has(covered + 1)) covered += 1;
    if (covered === 0) return { through: 0, weeks: 0, fetched, skipped: 'no finished week stored yet' };
    await this.settings.set(key, buildSeasonPoints(opts.season, covered, weeks, now));
    return { through: covered, weeks: weeks.size, fetched, skipped: null };
  }

  /** The season row, or null. One row read. */
  async readSeason(season: string): Promise<StoredSeasonPoints | null> {
    return this.settings.get<StoredSeasonPoints | null>(seasonPointsKey(season), null).catch(() => null);
  }

  /** The stored week, as a map, or null when nothing is stored. One row read. */
  async read(season: string, week: number): Promise<{ week: number; points: Map<string, number> } | null> {
    if (week < 1) return null;
    const stored = await this.settings.get<StoredWeekPoints | null>(weekPointsKey(season, week), null).catch(() => null);
    if (!stored || !stored.points) return null;
    return { week, points: new Map(Object.entries(stored.points)) };
  }

  /**
   * Fetch and store a finished week when the stored copy is missing or young.
   * Returns what happened, for the refresh report.
   */
  async refresh(opts: {
    season: string;
    week: number;
    /** Sleeper's current week. A week two or more behind it no longer changes. */
    currentWeek: number;
    scoring: Readonly<Record<string, number>>;
    now?: Date;
  }): Promise<{ week: number; stored: number; skipped: string | null }> {
    const now = opts.now ?? new Date();
    if (opts.week < 1) return { week: opts.week, stored: 0, skipped: 'no finished week yet' };
    const key = weekPointsKey(opts.season, opts.week);
    const held = await this.settings.get<StoredWeekPoints | null>(key, null).catch(() => null);
    if (held && opts.week < opts.currentWeek - 1) {
      return { week: opts.week, stored: Object.keys(held.points).length, skipped: 'week is final' };
    }
    if (held && now.getTime() - Date.parse(held.fetchedAt) < REFRESH_HOURS * 3_600_000) {
      return { week: opts.week, stored: Object.keys(held.points).length, skipped: 'stored copy is recent' };
    }
    const stats = await this.sleeper.getWeekStats(opts.season, opts.week);
    const points = scoreWeek(stats, opts.scoring);
    if (Object.keys(points).length === 0) return { week: opts.week, stored: 0, skipped: 'Sleeper had no stats for that week' };
    const row: StoredWeekPoints = { season: opts.season, week: opts.week, fetchedAt: now.toISOString(), points };
    await this.settings.set(key, row);
    return { week: opts.week, stored: Object.keys(points).length, skipped: null };
  }
}
