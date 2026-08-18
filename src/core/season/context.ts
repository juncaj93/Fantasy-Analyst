/**
 * Which season it is, answered once.
 *
 * Before this module, four services each worked it out for themselves, and all
 * four did it the same way:
 *
 *     String(now.getUTCMonth() >= 2 ? year : year - 1)
 *
 * — in `injuryService`, `usageService`, `playerDetailService` and
 * `seasonMarketService`, with a fifth spelling (`String(new Date().getFullYear())`)
 * in the Sleeper connect route and a sixth in the Setup screen. Six copies of a
 * calendar guess is six chances to disagree, and they already did: the connect
 * route would have asked Sleeper for the *2027* leagues on 1 January 2027, a
 * season that does not exist until March, and got back an empty list that reads
 * exactly like "you are in no leagues".
 *
 * The fix is not a better guess. It is to stop guessing: Sleeper publishes
 * `/state/nfl`, which says which season is being played and which week it is,
 * and the app already stores it. That is the authority. Everything else is a
 * fallback, and every fallback says so.
 *
 * **The ladder, strongest first.**
 *
 *   1. Sleeper's `/state/nfl` season. The same answer the NFL would give.
 *   2. The selected league's season, when state was never read.
 *   3. The calendar, marked `assumed`, so a brand-new install with no network
 *      still renders something rather than nothing.
 *
 * **What this module refuses to do** is infer the season from stored data. That
 * is the failure mode §5 of the resilience brief names: if the 2027 injury feed
 * has not been published, the newest rows in the table are 2026's, and a
 * "newest row wins" rule would quietly promote last season to current truth on
 * the first Sunday of the new year. The season is decided by the calendar
 * authority and the data is then asked for *that* season — missing is missing,
 * and missing says so.
 */

import type { NflState } from '../sleeper/phase.ts';

/** How the season was arrived at, weakest last. */
export type SeasonSource = 'sleeper_state' | 'league' | 'calendar';

/**
 * The month (0-based) in which the NFL league year rolls over.
 *
 * March. Free agency opens, Sleeper creates the new season's leagues, and the
 * published per-season files start carrying the new number. Used only by the
 * calendar fallback, and named rather than inlined so the one place it is
 * written down is the one place it would need changing.
 */
const LEAGUE_YEAR_ROLLOVER_MONTH = 2;

/**
 * How long Sleeper's cached state may stand before it stops being authority.
 *
 * `/state/nfl` changes once a week and is refreshed on every league sync, so a
 * stamp older than this means the app has not reached Sleeper in a fortnight —
 * long enough that a rollover could have happened behind its back. Past this
 * the state is still *used* (it is the best thing available) but it is reported
 * as stale, which is what the readiness check keys on.
 */
export const STATE_STALE_AFTER_DAYS = 14;

export interface SeasonContext {
  /** The season being played, e.g. `"2027"`. Never null: a fallback always fires. */
  season: string;
  /** The season before it — the finished one, whose files never change again. */
  previousSeason: string;
  /** Sleeper's `pre` | `regular` | `post` | `off`, when known. */
  seasonType: string | null;
  /** The week within that season type, when known. */
  week: number | null;
  /** Which rung of the ladder answered. */
  source: SeasonSource;
  /** True when only the calendar answered — nothing authoritative was known. */
  assumed: boolean;
  /** True when Sleeper's state answered but has not been refreshed in a while. */
  stateStale: boolean;
  /** When `/state/nfl` was last read, if ever. */
  stateFetchedAt: string | null;
  /** One sentence, in the user's language, for diagnostics panels. */
  reason: string;
}

export interface SeasonContextInput {
  state?: NflState | null;
  /** The league the user is actually looking at, if one is selected. */
  league?: { season?: string | null } | null;
  /** Injected for tests and for deterministic fixtures. */
  now?: Date;
}

/**
 * The season, and how confident the app is about it.
 *
 * Never throws and never returns null — a season is needed to render anything,
 * and "I do not know" is not a value the rest of the app can hold. What it does
 * instead is tell the truth about which rung answered, so a caller that cares
 * (the readiness check does; a cache key does not) can refuse to act on a guess.
 */
export function resolveSeasonContext(input: SeasonContextInput = {}): SeasonContext {
  const now = input.now ?? new Date();
  const state = input.state ?? null;
  const stateSeason = season(state?.season);
  const stateFetchedAt = state?.fetchedAt ?? null;
  const stateStale = isStale(stateFetchedAt, now);

  if (stateSeason) {
    return build({
      season: stateSeason,
      seasonType: normaliseType(state?.seasonType),
      week: numeric(state?.week),
      source: 'sleeper_state',
      assumed: false,
      stateStale,
      stateFetchedAt,
      reason: stateStale
        ? `Sleeper last reported the ${stateSeason} season, but not recently`
        : `Sleeper reports the ${stateSeason} season`,
    });
  }

  const leagueSeason = season(input.league?.season);
  if (leagueSeason) {
    return build({
      season: leagueSeason,
      seasonType: null,
      week: null,
      source: 'league',
      assumed: false,
      stateStale,
      stateFetchedAt,
      reason: `taken from the selected league's ${leagueSeason} season — Sleeper's own state has not been read`,
    });
  }

  const guess = calendarSeason(now);
  return build({
    season: guess,
    seasonType: null,
    week: null,
    source: 'calendar',
    assumed: true,
    stateStale,
    stateFetchedAt,
    reason: `assuming ${guess} from the date — nothing authoritative has been read yet`,
  });
}

/**
 * The season a date falls in, by the calendar alone.
 *
 * The last resort, and exported only so the one remaining copy of this
 * arithmetic is this one. January 2027 belongs to the 2026 season: the league
 * year does not roll over until March.
 */
export function calendarSeason(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  return String(now.getUTCMonth() >= LEAGUE_YEAR_ROLLOVER_MONTH ? year : year - 1);
}

/** The season before `season`, as a string. */
export function priorSeason(season: string): string {
  const n = Number.parseInt(season, 10);
  return Number.isFinite(n) ? String(n - 1) : season;
}

/**
 * Whether `candidate` is a season this app should treat as current.
 *
 * The guard §5 asks for, stated as a predicate: data stamped with any season
 * other than the current one is history, however new its rows are and however
 * empty the current season's table is.
 */
export function isCurrentSeason(candidate: string | null | undefined, context: SeasonContext): boolean {
  return !!candidate && String(candidate) === context.season;
}

function build(
  parts: Omit<SeasonContext, 'previousSeason'>,
): SeasonContext {
  return { ...parts, previousSeason: priorSeason(parts.season) };
}

function isStale(fetchedAt: string | null, now: Date): boolean {
  if (!fetchedAt) return true;
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > STATE_STALE_AFTER_DAYS * 86_400_000;
}

/** A season string, or null when the value is absent or not a year. */
function season(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^\d{4}$/.test(text)) return null;
  return text;
}

function normaliseType(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  return text || null;
}

function numeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
