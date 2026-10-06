/**
 * Which weeks a trade is worth anything in.
 *
 * A trade value is "points over the rest of the fantasy season", and the fantasy
 * season is not the NFL's. It ends when the league's own playoffs end, and
 * Sleeper publishes everything needed to find that week: the first playoff
 * week, how many teams make it, and whether a round is one week or two.
 *
 * Read for Tony's Pizza Fantasy on 6 October 2026:
 *
 *     playoff_week_start 15, playoff_teams 6, playoff_round_type 0
 *     -> three one-week rounds, weeks 15, 16 and 17
 *     trade_deadline 11
 *
 * So from week 5 a trade is worth thirteen weeks of lineups, and it can only be
 * made for seven more of them. Both facts are printed on the card rather than
 * assumed, because a league that changes either setting should change the
 * answer without a code change.
 *
 * Nothing here knows who is in the playoffs. Only six of ten teams play weeks
 * 15 to 17, and which six is unknowable in October, so every week counts the
 * same. That is a stated simplification, not an oversight; see
 * `docs/TRADE_VALUES.md`.
 */

import { readFinalWeek } from '../league/planning.ts';

/** The last week Sleeper will score, whatever a league's settings say. */
export const LAST_NFL_WEEK = 18;

export interface TradeHorizon {
  /** The week a trade made now first affects. */
  currentWeek: number;
  /** The last fantasy week, the end of the championship round. */
  lastWeek: number;
  /** Every week in the horizon, oldest first. Empty once the season is over. */
  weeks: number[];
  regularSeasonEnd: number;
  playoffWeeks: number[];
  /** The last week trades are allowed, or null when the league sets none. */
  deadlineWeek: number | null;
  deadlinePassed: boolean;
  /** Weeks left to make a trade, counting this one. Null with no deadline. */
  weeksToDeadline: number | null;
  /** True when the playoff start week came from the league, not a default. */
  playoffsPublished: boolean;
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/**
 * How many weeks a league's playoffs run.
 *
 * Rounds are the number of times the bracket halves: six teams play three
 * rounds because the top two seeds skip the first. `playoff_round_type` 1 makes
 * the championship two weeks long and 2 makes every round two weeks long. Type 0
 * is the common one and the only one confirmed against a real league; the other
 * two follow Sleeper's own labels and are the least tested path here.
 */
export function playoffLength(settings: Record<string, unknown> | null | undefined): number {
  const teams = numberOf(settings?.['playoff_teams']);
  const rounds = Number.isFinite(teams) && teams >= 2 ? Math.ceil(Math.log2(teams)) : 3;
  const type = numberOf(settings?.['playoff_round_type']);
  if (type === 1) return rounds + 1;
  if (type === 2) return rounds * 2;
  return rounds;
}

export function tradeHorizon(opts: {
  leagueSettings: Record<string, unknown> | null | undefined;
  currentWeek: number;
}): TradeHorizon {
  const settings = opts.leagueSettings ?? {};
  const currentWeek = Math.max(1, Math.round(opts.currentWeek));
  const regularSeasonEnd = readFinalWeek(settings);
  const rawStart = numberOf(settings['playoff_week_start']);
  const playoffsPublished = Number.isFinite(rawStart) && rawStart > 1 && rawStart <= 19;

  const length = playoffLength(settings);
  const lastWeek = Math.min(LAST_NFL_WEEK, regularSeasonEnd + length);
  const playoffWeeks = Array.from({ length: Math.max(0, lastWeek - regularSeasonEnd) }, (_, i) => regularSeasonEnd + 1 + i);

  const weeks: number[] = [];
  for (let week = currentWeek; week <= lastWeek; week++) weeks.push(week);

  const rawDeadline = numberOf(settings['trade_deadline']);
  const deadlineWeek = Number.isFinite(rawDeadline) && rawDeadline > 0 && rawDeadline <= LAST_NFL_WEEK ? Math.round(rawDeadline) : null;

  return {
    currentWeek,
    lastWeek,
    weeks,
    regularSeasonEnd,
    playoffWeeks,
    deadlineWeek,
    deadlinePassed: deadlineWeek != null && currentWeek > deadlineWeek,
    weeksToDeadline: deadlineWeek == null ? null : Math.max(0, deadlineWeek - currentWeek + 1),
    playoffsPublished,
  };
}

/**
 * Whether, and when, a club has its bye inside the horizon.
 *
 * Derived from the fixture list rather than stored, because a bye is the absence
 * of a row. That makes a hole in the list look exactly like a bye, so the answer
 * is only trusted when it is consistent: a club with no fixtures at all is
 * unknown, one with every week present has no bye in range, one missing exactly
 * one week has that week as its bye, and one missing more than one has a gap in
 * the data and is unknown rather than guessed at.
 */
export function byeOf(
  fixtures: readonly { team: string; week: number }[],
  team: string,
  range: { from: number; to: number },
): { known: boolean; byeWeek: number | null } {
  const wanted = team.toUpperCase();
  const present = new Set<number>();
  for (const row of fixtures) if (row.team.toUpperCase() === wanted && row.week >= range.from && row.week <= range.to) present.add(row.week);
  const expected = range.to - range.from + 1;
  if (expected <= 0 || present.size === 0) return { known: false, byeWeek: null };
  const missing: number[] = [];
  for (let week = range.from; week <= range.to; week++) if (!present.has(week)) missing.push(week);
  if (missing.length === 0) return { known: true, byeWeek: null };
  if (missing.length === 1) return { known: true, byeWeek: missing[0]! };
  return { known: false, byeWeek: null };
}
