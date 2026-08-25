/**
 * Bye weeks a few weeks out, and playoff weeks once they are worth thinking
 * about.
 *
 * Both features share one restraint, and it is the hardest part of each: they
 * must be quiet. A bye-week planner that starts warning in week 1 about a
 * week-9 cluster has told the user something they can do nothing about yet, and
 * by week 8 they have stopped reading it. A playoff-schedule weighting applied
 * in August lets a December matchup move an August draft board, which is how a
 * ranking quietly stops meaning what it says.
 *
 * So: byes are only reported inside a lookahead window and only when a slot
 * genuinely cannot be filled, and playoff weeks arrive on a ramp that is zero
 * until the season has told us something about whether this team will be there.
 */

import type { RosterShape } from '../sleeper/scoring.ts';

/** How far ahead a bye is worth mentioning. Beyond this, nothing can be done. */
export const BYE_LOOKAHEAD_WEEKS = 4;

export interface ByeRosterPlayer {
  playerId: string;
  name: string;
  position: string;
  byeWeek: number | null;
  /** True when he is a current starter, which is what makes a bye a problem. */
  starter: boolean;
}

export interface ByeGap {
  week: number;
  position: string;
  /** Starters at the position who are out that week. */
  out: string[];
  /** Bodies left who could legally start there. */
  remaining: number;
  required: number;
  severity: 'unfillable' | 'thin';
}

export interface ByeOutlook {
  /** Only weeks inside the lookahead window with a real gap. */
  gaps: ByeGap[];
  /** One line per gap, safe to show. Empty when there is nothing to say. */
  alerts: string[];
  /** The window actually examined, so silence is explicable. */
  window: { from: number; to: number };
}

/**
 * Which starting slots a bye leaves unfilled.
 *
 * Counted against the roster's own remaining bodies rather than against a
 * general idea of depth: a team with four startable receivers loses nothing to
 * a receiver bye, and a team with exactly three loses a slot. `unfillable`
 * means no legal body remains; `thin` means the last one is playing.
 */
export function byeOutlook(opts: {
  roster: ByeRosterPlayer[];
  shape: RosterShape;
  currentWeek: number;
  lookahead?: number;
}): ByeOutlook {
  const lookahead = opts.lookahead ?? BYE_LOOKAHEAD_WEEKS;
  const from = opts.currentWeek;
  const to = opts.currentWeek + lookahead;

  const positions = new Set([
    ...Object.keys(opts.shape.starters),
    ...opts.shape.flex.flatMap((f) => f.positions),
  ]);

  const gaps: ByeGap[] = [];
  for (let week = from; week <= to; week++) {
    for (const position of positions) {
      const required = opts.shape.starters[position] ?? 0;
      if (required === 0) continue;

      const atPosition = opts.roster.filter((p) => p.position === position);
      const out = atPosition.filter((p) => p.byeWeek === week);
      if (out.length === 0) continue;

      const remaining = atPosition.length - out.length;
      if (remaining >= required + 1) continue;

      gaps.push({
        week,
        position,
        out: out.map((p) => p.name),
        remaining,
        required,
        severity: remaining < required ? 'unfillable' : 'thin',
      });
    }
  }

  gaps.sort((a, b) => a.week - b.week || a.position.localeCompare(b.position));

  return {
    gaps,
    alerts: gaps.map((g) =>
      g.severity === 'unfillable'
        ? `Week ${g.week}: ${g.out.join(', ')} on bye leaves ${g.remaining} of ${g.required} ${g.position} slots fillable — add cover before it is urgent`
        : `Week ${g.week}: ${g.out.join(', ')} on bye leaves you with no spare ${g.position}`,
    ),
    window: { from, to },
  };
}

/**
 * How much the playoff weeks are allowed to matter yet.
 *
 * Returns 0 to 1, and 0 is the answer for most of the year. The ramp has two
 * gates and needs both:
 *
 * - **Time.** Nothing before the season is a third old. A December schedule
 *   cannot be allowed to move an August board, and this is where that is
 *   enforced rather than in each consumer.
 * - **Standing.** A team that is not plausibly going to be there should not be
 *   planning for it; the pace it is on is the only evidence available, and it
 *   is used as a soft weight, not as a verdict.
 */
export function playoffEmphasis(opts: {
  currentWeek: number;
  playoffStartWeek: number;
  wins: number;
  losses: number;
  playoffTeams: number;
  totalTeams: number;
}): { weight: number; reason: string } {
  const played = opts.wins + opts.losses;
  const seasonLength = Math.max(1, opts.playoffStartWeek - 1);
  const progress = Math.min(1, opts.currentWeek / seasonLength);

  if (progress < 0.35 || played < 3) {
    return { weight: 0, reason: 'too early in the season for playoff weeks to matter' };
  }

  const winRate = played > 0 ? opts.wins / played : 0;
  // The share of the league that makes the playoffs is the bar a team has to
  // beat. A six-of-twelve league needs about a .500 pace; a four-of-twelve one
  // needs considerably more, and the weighting should reflect that rather than
  // treating every league as the same race.
  const bar = 1 - opts.playoffTeams / Math.max(1, opts.totalTeams);
  const margin = winRate - bar;

  if (margin <= -0.2) {
    return { weight: 0, reason: 'the season is not currently heading for the playoffs' };
  }

  const standing = Math.min(1, Math.max(0, (margin + 0.2) / 0.4));
  const weight = round2(Math.min(1, progress * standing));
  return {
    weight,
    reason:
      weight === 0
        ? 'playoff weeks are not yet worth weighting'
        : `${Math.round(weight * 100)}% weight: ${opts.wins}-${opts.losses} through week ${opts.currentWeek}`,
  };
}

/** The weeks a league actually plays its playoffs, from its own settings. */
export function playoffWeeks(playoffStartWeek: number, rounds = 3): number[] {
  if (!Number.isFinite(playoffStartWeek) || playoffStartWeek <= 0) return [];
  return Array.from({ length: rounds }, (_, i) => playoffStartWeek + i);
}

/** The last week of the regular season when a league does not publish one. */
export const DEFAULT_FINAL_WEEK = 14;

/**
 * The last week of the regular season, from the league's own settings.
 *
 * The canonical reader, and it validates before it trusts: a real league was
 * found publishing a `playoff_week_start` that was not a usable week, survived
 * a `??` default, and produced an empty list of playoff weeks in production.
 */
export function readFinalWeek(settings: Record<string, unknown> | null | undefined): number {
  const raw = settings?.['playoff_week_start'];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 1 && value <= 19) return Math.round(value) - 1;
  return DEFAULT_FINAL_WEEK;
}

/**
 * The league's own playoff weeks, and how much they are allowed to matter yet.
 *
 * One reader, shared by the plan endpoint, the defence planner and Demo Mode,
 * because two callers that disagreed about when the playoffs start would
 * disagree about whether a stash is worth a bench spot — and one of them would
 * be wrong about a fact the league publishes.
 *
 * It lives here rather than beside the defence planner because nothing in it is
 * about defences: it reads a league's settings and its own record, which is
 * exactly what the rest of this file does.
 */
export function playoffContextFor(opts: {
  leagueSettings: Record<string, unknown> | null | undefined;
  rosters: readonly { settings?: Record<string, unknown> | null }[];
  mine: { settings?: Record<string, unknown> | null } | null;
  totalRosters: number;
  currentWeek: number;
}): {
  weeks: number[];
  emphasis: number;
  reason: string;
  startWeek: number;
  startWeekPublished: boolean;
  record: { wins: number; losses: number } | null;
} {
  const startWeek = readFinalWeek(opts.leagueSettings ?? {}) + 1;
  const raw = Number(opts.leagueSettings?.['playoff_week_start']);
  const startWeekPublished = Number.isFinite(raw) && raw > 1 && raw <= 19;
  const playoffTeams = Number(opts.leagueSettings?.['playoff_teams'] ?? 6);

  const settings = (opts.mine?.settings ?? null) as Record<string, unknown> | null;
  const record = {
    wins: Number(settings?.['wins'] ?? 0) || 0,
    losses: Number(settings?.['losses'] ?? 0) || 0,
  };

  const emphasis = playoffEmphasis({
    currentWeek: opts.currentWeek,
    playoffStartWeek: startWeek,
    wins: record.wins,
    losses: record.losses,
    playoffTeams,
    totalTeams: opts.rosters.length || opts.totalRosters,
  });

  return {
    weeks: playoffWeeks(startWeek),
    emphasis: emphasis.weight,
    reason: emphasis.reason,
    startWeek,
    startWeekPublished,
    record: settings ? record : null,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
