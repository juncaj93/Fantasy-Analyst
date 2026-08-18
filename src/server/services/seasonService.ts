/**
 * The season, from storage, for everything that runs on the server.
 *
 * `core/season/context.ts` decides *which* season it is given the evidence;
 * this is the thing that goes and gets the evidence. It is deliberately thin —
 * two reads and no logic — because the logic belongs in core where it can be
 * tested without a database, and because the one thing this layer must not do
 * is develop opinions of its own about what year it is.
 *
 * **Why the services still take a `season` parameter.** Every ingest and read
 * path here already accepted one, defaulting to a calendar guess. Those
 * defaults now share a single implementation (see `calendarSeason`), but the
 * point of this module is that the *callers* — the cron ticks, the routes —
 * stop relying on the default and pass the authoritative answer instead. A
 * default that is only reached when nobody asked is a safety net; a default
 * that is the normal path is a hardcode with extra steps.
 */

import { resolveSeasonContext, type SeasonContext } from '../../core/season/context.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import type { Database } from '../db.ts';
import { LeagueRepo } from '../repos/league.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';

/**
 * Read the stored evidence and resolve the season.
 *
 * Never fetches. `/state/nfl` is refreshed by the league sync and by the
 * nightly cron; putting a network call behind this would put one behind every
 * route that needs to know the year, which is most of them.
 */
export async function currentSeasonContext(db: Database, now = new Date()): Promise<SeasonContext> {
  const settings = new SettingsRepo(db);
  const state = await settings.get<NflState | null>(SETTING_KEYS.nflState, null);

  /*
   * The selected league is only consulted when Sleeper's state is missing.
   *
   * It is a weaker witness than it looks: a user can have a 2026 league
   * selected in 2027 simply by not having switched yet, and taking the season
   * from it would then pin the whole app to last season — the exact failure §5
   * is about, arrived at from the other direction.
   */
  let league: { season: string | null } | null = null;
  if (!state?.season) {
    const leagues = await new LeagueRepo(db).listLeagues();
    const selected = leagues.find((l) => l.isSelected) ?? null;
    league = selected ? { season: selected.season } : null;
  }

  return resolveSeasonContext({ state, league, now });
}

/** Just the year, for callers that have no use for the provenance. */
export async function currentSeason(db: Database, now = new Date()): Promise<string> {
  return (await currentSeasonContext(db, now)).season;
}
