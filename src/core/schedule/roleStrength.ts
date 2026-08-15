/**
 * The next month, read for the role this player actually plays.
 *
 * "Easy schedule" is the same broken statistic as "defence versus WR", one week
 * at a time: a run of opponents who cannot cover a downfield receiver is not a
 * run of opponents who cannot cover a checkdown back, and a table that rolls
 * them together tells a tight end what a wide receiver's month looks like.
 *
 * So this is the existing matchup read, applied forward. Every future week is
 * looked up under the same key the weekly card uses — the player's role bucket,
 * falling back to his position — through the same {@link assessMatchup}, so a
 * three-week outlook and this Sunday's card can never disagree about the same
 * defence. There is no second tendency table here, and no second definition of
 * "soft".
 *
 * ## What the honesty rules are
 *
 *   - **a bye is not a hard week.** It is a week with no game, counted
 *     separately and excluded from the average, because averaging a zero into a
 *     schedule strength invents a difficult opponent out of a week off.
 *   - **an unknown week is not a neutral week.** A defence the tendency table
 *     cannot describe is counted as unrated and left out of the mean, and the
 *     outlook reports how much of the window it could actually see.
 *   - **nothing rated, nothing said.** With no rated week the verdict is
 *     `unknown` rather than `neutral`.
 *
 * This feeds Waivers, Trades, streaming, bye planning and playoff planning. It
 * changes no lineup: a schedule three weeks out is not a reason to bench
 * somebody this Sunday, and nothing here is wired into the Start/Sit score.
 */

import { assessMatchup, type DefenseTendencyIndex } from '../startsit/defense.ts';
import type { RoleBucket } from '../startsit/roleProfile.ts';

export const ROLE_SCHEDULE = {
  /** Weeks of outlook. Three to five is the brief; four is the default. */
  defaultWeeks: 4,
  /** Mean matchup points above which a stretch is genuinely favourable. */
  favourable: 0.35,
  /** ...and below which it is genuinely difficult. */
  difficult: -0.35,
} as const;

/** One future week of the player's team. `opponent: null` is the bye. */
export interface ScheduleWeek {
  week: number;
  opponent: string | null;
}

export interface RoleScheduleWeek {
  week: number;
  opponent: string | null;
  bye: boolean;
  /** Matchup points for this role against this defence. Null when unrated. */
  points: number | null;
  rating: 'soft' | 'neutral' | 'tough' | 'insufficient_data';
  /** Which key answered: the role bucket, or the position fallback. */
  resolvedKey: string | null;
}

export type ScheduleVerdict = 'favourable' | 'neutral' | 'difficult' | 'unknown';

export interface RoleScheduleOutlook {
  position: string;
  bucket: RoleBucket;
  weeks: RoleScheduleWeek[];
  /** Mean matchup points across the weeks that could be rated. */
  averagePoints: number | null;
  rated: number;
  byes: number;
  /** Weeks in the window, including byes and unrated ones. */
  total: number;
  verdict: ScheduleVerdict;
  display: string;
  driver: string | null;
  notes: string[];
}

export function noRoleSchedule(position: string, bucket: RoleBucket): RoleScheduleOutlook {
  return {
    position,
    bucket,
    weeks: [],
    averagePoints: null,
    rated: 0,
    byes: 0,
    total: 0,
    verdict: 'unknown',
    display: 'no schedule available',
    driver: null,
    notes: [],
  };
}

/**
 * Rate the next few weeks for one player.
 *
 * `fromWeek` is exclusive: the outlook is about what is *coming*, and this
 * week's game is already on this week's card. Including it would double-count
 * the same defence in two places on the same screen.
 */
export function roleScheduleOutlook(opts: {
  position: string;
  bucket: RoleBucket;
  schedule: ScheduleWeek[];
  tendencies: DefenseTendencyIndex;
  fromWeek: number;
  weeks?: number;
}): RoleScheduleOutlook {
  const horizon = opts.weeks ?? ROLE_SCHEDULE.defaultWeeks;
  const upcoming = opts.schedule
    .filter((w) => w.week > opts.fromWeek)
    .sort((a, b) => a.week - b.week)
    .slice(0, horizon);

  if (upcoming.length === 0) return noRoleSchedule(opts.position, opts.bucket);

  const weeks: RoleScheduleWeek[] = upcoming.map((week) => {
    if (!week.opponent) {
      return { week: week.week, opponent: null, bye: true, points: null, rating: 'insufficient_data', resolvedKey: null };
    }
    const matchup = assessMatchup(
      { position: opts.position, bucket: opts.bucket, defense: week.opponent },
      opts.tendencies,
    );
    return {
      week: week.week,
      opponent: week.opponent,
      bye: false,
      points: matchup.unknown ? null : matchup.points,
      rating: matchup.rating,
      resolvedKey: matchup.resolvedKey,
    };
  });

  const rated = weeks.filter((w) => w.points != null);
  const byes = weeks.filter((w) => w.bye).length;
  const averagePoints = rated.length === 0 ? null : round2(rated.reduce((a, w) => a + (w.points ?? 0), 0) / rated.length);

  const verdict: ScheduleVerdict =
    averagePoints == null
      ? 'unknown'
      : averagePoints >= ROLE_SCHEDULE.favourable
        ? 'favourable'
        : averagePoints <= ROLE_SCHEDULE.difficult
          ? 'difficult'
          : 'neutral';

  const notes: string[] = [];
  if (byes > 0) notes.push(`week ${weeks.filter((w) => w.bye).map((w) => w.week).join(', ')} is a bye and is not counted as a matchup`);
  if (rated.length < weeks.length - byes) {
    notes.push(`${weeks.length - byes - rated.length} of the next ${weeks.length - byes} opponents cannot be described for this role yet`);
  }
  // A role read and a position read are different claims; say which this is.
  if (rated.length > 0 && rated.every((w) => w.resolvedKey?.endsWith(':any'))) {
    notes.push('rated at position level — no defence in the window has faced enough of his specific role');
  }

  return {
    position: opts.position,
    bucket: opts.bucket,
    weeks,
    averagePoints,
    rated: rated.length,
    byes,
    total: weeks.length,
    verdict,
    display: describe(weeks, averagePoints, verdict),
    driver: driverFor(weeks, verdict),
    notes,
  };
}

function describe(weeks: RoleScheduleWeek[], averagePoints: number | null, verdict: ScheduleVerdict): string {
  if (averagePoints == null) return `next ${weeks.length} weeks: no opponent can be described for this role yet`;
  const label = { favourable: 'favourable', neutral: 'about average', difficult: 'difficult', unknown: 'unknown' }[verdict];
  const opponents = weeks.map((w) => (w.bye ? 'BYE' : w.opponent)).join(', ');
  return `next ${weeks.length} weeks ${label} for his role · ${opponents}`;
}

function driverFor(weeks: RoleScheduleWeek[], verdict: ScheduleVerdict): string | null {
  if (verdict === 'unknown' || verdict === 'neutral') return null;
  const notable = weeks
    .filter((w) => !w.bye && w.points != null)
    .sort((a, b) => (verdict === 'favourable' ? (b.points ?? 0) - (a.points ?? 0) : (a.points ?? 0) - (b.points ?? 0)))
    .slice(0, 2)
    .map((w) => `${w.opponent} (wk ${w.week})`);
  if (notable.length === 0) return null;
  return verdict === 'favourable'
    ? `Schedule opens up for his role · ${notable.join(', ')}`
    : `Difficult stretch for his role · ${notable.join(', ')}`;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
