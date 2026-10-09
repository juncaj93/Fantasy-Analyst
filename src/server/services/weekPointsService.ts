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
import { scoreWeek, weekPointsKey, type StoredWeekPoints } from '../../core/sleeper/weekPoints.ts';
import type { Database } from '../db.ts';
import { SettingsRepo } from '../repos/settings.ts';

/** A copy younger than this is not refetched. */
const REFRESH_HOURS = 6;

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
