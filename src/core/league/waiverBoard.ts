/**
 * The waiver view-model: one row per available player, six dimensions each.
 *
 * The brief's constraint is the design: *do not collapse all dimensions into
 * unexplained one-number magic*. So there is a `priority`, because a list has
 * to be in some order and pretending otherwise just moves the ranking into the
 * reader's head — but priority is a sum of named, separately-visible parts, and
 * every part is also published on its own. A row can always be read as "third
 * because he starts for me this week and costs $4", never as "third".
 *
 * Nothing in this file decides how good a player is. `thisWeek` and `next4`
 * arrive already scored by the weekly engine; the work here is league-specific:
 * what he is *for*, what he will cost, who else wants him, and whether the
 * answer is to stream the position instead of paying for him.
 */

import type { RoleTrend } from '../startsit/decisions.ts';
import type { CompetitionAssessment } from './competition.ts';
import type { FaabEstimate } from './faab.ts';

/**
 * What the add is actually for.
 *
 * The distinction the brief asks for, and it changes the advice completely: the
 * same player can be a correct $1 emergency claim and an incorrect $25 one, and
 * a board that cannot tell the two apart will happily talk somebody into
 * spending a quarter of their season's budget on one Sunday.
 */
export type WaiverHorizon =
  | 'direct_starter'
  | 'multi_week_hold'
  | 'temporary_beneficiary'
  | 'emergency_streamer'
  | 'stash';

export const HORIZON_LABELS: Record<WaiverHorizon, string> = {
  direct_starter: 'Starts for you now',
  multi_week_hold: 'Multi-week hold',
  temporary_beneficiary: 'Injury beneficiary — shelf life',
  emergency_streamer: 'One-week streamer',
  stash: 'Stash / upside',
};

export type NeedFit = 'fills_hole' | 'upgrade' | 'depth' | 'none';

export const NEED_FIT_LABELS: Record<NeedFit, string> = {
  fills_hole: 'Fills a slot you cannot start',
  upgrade: 'Upgrades a starting slot',
  depth: 'Bench depth',
  none: 'No fit on your roster',
};

export interface WaiverValue {
  /** Fantasy points, when the weekly engine could score him. */
  points: number | null;
  display: string;
  known: boolean;
}

export interface StreamingVerdict {
  /** True when the position is deep enough that paying up is a mistake. */
  streamable: boolean;
  /** Comparable free agents within `STREAM_BAND` points of this one. */
  comparable: number;
  note: string;
}

/** How close another free agent has to be to count as the same answer. */
export const STREAM_BAND = 1.5;

/** Positions where a deep pool genuinely means "stream it". */
export const STREAMABLE_POSITIONS = new Set(['QB', 'TE', 'DEF', 'K']);

/** Comparable bodies above which the position is called deep. */
export const STREAM_DEPTH = 3;

export interface PriorityPart {
  key: string;
  label: string;
  /** Signed contribution to the 0–100 priority. */
  value: number;
}

export interface WaiverCandidateInput {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** This week's projection from the weekly engine. */
  thisWeek: WaiverValue;
  /** The same, averaged over the next four weeks. */
  next4: WaiverValue;
  needFit: NeedFit;
  /** Points the add would gain over the current occupant of the slot. */
  gain: number | null;
  roleTrend?: RoleTrend;
  /** He has the job because a starter is hurt. */
  injuryBeneficiary?: boolean;
  /** Weeks until that starter is expected back, when it is known. */
  starterReturnsInWeeks?: number | null;
  /** He covers a bye the roster cannot otherwise cover. */
  coversBye?: boolean;
  /** Points of the best comparable free agents left at his position. */
  replacementPool?: number[];
  expectedCost: FaabEstimate;
  competition: CompetitionAssessment;
}

export interface WaiverRow extends Omit<WaiverCandidateInput, 'replacementPool'> {
  priority: number;
  priorityParts: PriorityPart[];
  horizon: WaiverHorizon;
  horizonLabel: string;
  needFitLabel: string;
  streaming: StreamingVerdict | null;
  reasons: string[];
}

/**
 * What kind of add this is.
 *
 * Order matters and is deliberate. An injury beneficiary is classified as one
 * *even when he would start for you*, because the return date is the fact that
 * governs how much he is worth; calling him a direct starter would be true this
 * week and misleading for the three after it. The one exception is a return
 * date far enough out that the rest of the fantasy season is inside it, which
 * is a job, not a loan.
 */
export function classifyHorizon(input: {
  needFit: NeedFit;
  next4: WaiverValue;
  thisWeek: WaiverValue;
  injuryBeneficiary?: boolean;
  starterReturnsInWeeks?: number | null;
  coversBye?: boolean;
  roleTrend?: RoleTrend;
}): WaiverHorizon {
  const returns = input.starterReturnsInWeeks ?? null;

  if (input.injuryBeneficiary && (returns == null || returns <= 6)) {
    return 'temporary_beneficiary';
  }

  const startsNow = input.needFit === 'fills_hole' || input.needFit === 'upgrade';
  const holdsUp = input.next4.known && input.next4.points != null && input.next4.points > 0;

  if (startsNow && holdsUp) return 'direct_starter';
  if (startsNow && input.coversBye) return 'emergency_streamer';
  if (startsNow) return 'emergency_streamer';
  if (holdsUp && (input.roleTrend === 'rising_high' || input.roleTrend === 'rising_moderate')) {
    return 'multi_week_hold';
  }
  if (holdsUp) return 'multi_week_hold';
  return 'stash';
}

/**
 * Whether the honest answer is "stream it".
 *
 * Only asked at the positions where streaming is a real strategy, and only
 * answered from *this league's* actual pool — the same free agents the user can
 * claim next week. A quarterback who is three points clear of everyone left is
 * worth paying for; one of five within a point and a half of each other is a
 * position, not a player, and bidding against the league for one of them is
 * spending money to be no better off.
 */
export function streamingVerdict(
  position: string,
  points: number | null,
  pool: number[] | undefined,
): StreamingVerdict | null {
  if (!STREAMABLE_POSITIONS.has(position) || points == null || !pool) return null;
  const comparable = pool.filter((p) => p >= points - STREAM_BAND).length;
  if (comparable >= STREAM_DEPTH) {
    return {
      streamable: true,
      comparable,
      note: `${comparable} other free agents grade within ${STREAM_BAND} pts — stream the position rather than pay for him`,
    };
  }
  return {
    streamable: false,
    comparable,
    note:
      comparable === 0
        ? 'nobody left on waivers grades close to him at the position'
        : `only ${comparable} comparable option(s) left at the position`,
  };
}

/**
 * Priority, as a sum of parts that are each shown.
 *
 * The weights are the argument, so they are here in one place rather than
 * scattered: what he does for the lineup leads, what he is worth over the next
 * month is next, and price and competition are *tie-breakers* — a cheap player
 * nobody wants is not thereby a good add, and this ordering is what stops the
 * board filling up with free nobodies.
 */
export function priorityOf(input: WaiverCandidateInput, streaming: StreamingVerdict | null): PriorityPart[] {
  const parts: PriorityPart[] = [];

  const fitPoints: Record<NeedFit, number> = { fills_hole: 34, upgrade: 24, depth: 8, none: 0 };
  parts.push({ key: 'need_fit', label: NEED_FIT_LABELS[input.needFit], value: fitPoints[input.needFit] });

  if (input.gain != null && input.gain > 0) {
    parts.push({
      key: 'gain',
      label: `${input.gain.toFixed(1)} pts better than what you would start`,
      value: Math.min(20, round1(input.gain * 2.5)),
    });
  }

  if (input.next4.known && input.next4.points != null) {
    parts.push({
      key: 'next4',
      label: `${input.next4.points.toFixed(1)} pts a week over the next four`,
      value: Math.min(22, round1(input.next4.points * 1.1)),
    });
  } else {
    parts.push({ key: 'next4', label: 'no four-week outlook', value: 0 });
  }

  if (input.roleTrend === 'rising_high') parts.push({ key: 'role', label: 'role climbing fast', value: 8 });
  else if (input.roleTrend === 'rising_moderate') parts.push({ key: 'role', label: 'role climbing', value: 4 });
  else if (input.roleTrend === 'falling_high' || input.roleTrend === 'falling_moderate') {
    parts.push({ key: 'role', label: 'role shrinking', value: -6 });
  }

  if (input.coversBye) parts.push({ key: 'bye', label: 'covers a bye you cannot otherwise cover', value: 6 });

  /*
   * Price is a discount, never a reason.
   *
   * A player who will go cheap is worth a little more than the same player who
   * will go for a quarter of the budget, and that is all — the sign is
   * deliberately small, so the board can never rank a $1 nobody above a $30
   * starter on price alone.
   */
  if (input.expectedCost.known && input.expectedCost.high != null) {
    const share = input.expectedCost.high / 100;
    parts.push({
      key: 'cost',
      label: `${input.expectedCost.display}`,
      value: round1(-Math.min(8, share * 24)),
    });
  }

  if (input.competition.label === 'High pressure') {
    parts.push({ key: 'competition', label: 'high competition — claim or lose him', value: 4 });
  }

  if (streaming?.streamable) {
    parts.push({ key: 'streaming', label: 'the position is streamable', value: -10 });
  }

  if (input.injuryBeneficiary) {
    const weeks = input.starterReturnsInWeeks;
    parts.push({
      key: 'shelf_life',
      label: weeks != null ? `starter is due back in about ${weeks} week(s)` : 'holds the job only while a starter is out',
      value: weeks != null && weeks <= 2 ? -8 : -4,
    });
  }

  return parts;
}

export function buildWaiverRow(input: WaiverCandidateInput): WaiverRow {
  const streaming = streamingVerdict(input.position, input.thisWeek.points, input.replacementPool);
  const parts = priorityOf(input, streaming);
  const priority = Math.max(0, Math.min(100, round1(parts.reduce((a, p) => a + p.value, 0))));
  const horizon = classifyHorizon(input);

  const reasons: string[] = [];
  reasons.push(NEED_FIT_LABELS[input.needFit]);
  if (input.thisWeek.known) reasons.push(`this week ${input.thisWeek.display}`);
  if (input.next4.known) reasons.push(`next four ${input.next4.display}`);
  reasons.push(input.expectedCost.display);
  reasons.push(input.competition.label.toLowerCase());
  if (streaming?.streamable) reasons.push(streaming.note);

  const { replacementPool: _pool, ...rest } = input;
  return {
    ...rest,
    priority,
    priorityParts: parts.filter((p) => p.value !== 0),
    horizon,
    horizonLabel: HORIZON_LABELS[horizon],
    needFitLabel: NEED_FIT_LABELS[input.needFit],
    streaming,
    reasons,
  };
}

/**
 * The board, ordered.
 *
 * Priority leads; a tie is broken by what he does this week, then by name, so
 * the list is stable between refreshes that changed nothing.
 */
export function buildWaiverBoard(candidates: WaiverCandidateInput[]): WaiverRow[] {
  return candidates
    .map(buildWaiverRow)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.thisWeek.points ?? -1) - (a.thisWeek.points ?? -1) ||
        a.name.localeCompare(b.name),
    );
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
