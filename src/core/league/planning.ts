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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
