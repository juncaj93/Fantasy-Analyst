/**
 * The stored NFL state with the app's week in it: the one read every
 * in-season screen (Team, Matchup, Compare, Waivers, Trades) makes instead of
 * reading Sleeper's state directly. See `core/season/appWeek.ts` for the rule.
 *
 * `week` is the app's week; `sleeperWeek` is Sleeper's own, for the callers
 * that ask Sleeper about its current week.
 *
 * Cost: the stored state (one row, read by every caller already) and, once per
 * season and Sleeper week per isolate for three hours, the last kickoff of that
 * week from the schedule (one statement on the primary key, about 32 rows).
 */

import type { Database } from '../db.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { appWeek } from '../../core/season/appWeek.ts';
import { SettingsRepo, SETTING_KEYS } from '../repos/settings.ts';

export type AppNflState = NflState & {
  /** Sleeper's own week, before the app's rollover. */
  sleeperWeek: number | null;
};

const KICKOFF_TTL_MS = 3 * 3_600_000;
const LAST_KICKOFF = new WeakMap<Database, Map<string, { at: number; kickoff: string | null }>>();

/** The last kickoff of a week, from the stored schedule, or null when it is not stored. */
export async function lastKickoffOf(db: Database, season: string, week: number, now: number = Date.now()): Promise<string | null> {
  const memo = LAST_KICKOFF.get(db) ?? LAST_KICKOFF.set(db, new Map()).get(db)!;
  const key = `${season}:${week}`;
  const held = memo.get(key);
  if (held && now - held.at < KICKOFF_TTL_MS) return held.kickoff;
  const row = await db
    .prepare('SELECT MAX(kickoff) AS kickoff FROM nfl_schedule WHERE season = ? AND week = ?')
    .bind(season, week)
    .first<{ kickoff: string | null }>()
    .catch(() => null);
  const kickoff = row?.kickoff ?? null;
  memo.set(key, { at: now, kickoff });
  return kickoff;
}

/** Sleeper's stored state with `week` set to the app's week. Null when no state is stored. */
export async function readAppNflState(db: Database, now: Date = new Date()): Promise<AppNflState | null> {
  const state = await new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null).catch(() => null);
  if (!state) return null;
  const sleeperWeek = state.week ?? null;
  if (!state.season || sleeperWeek == null) return { ...state, sleeperWeek };
  const lastKickoff = await lastKickoffOf(db, String(state.season), sleeperWeek, now.getTime());
  const week = appWeek({ sleeperWeek, seasonType: state.seasonType, lastKickoff, now });
  return { ...state, week, sleeperWeek };
}
