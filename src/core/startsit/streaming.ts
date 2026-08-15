/**
 * Stream it, or keep hoarding a mediocre one.
 *
 * At quarterback, tight end and defence — the positions a league starts one of
 * and where the waiver wire is deep — the useful question is never "is my guy
 * good". It is "is my guy enough better than what is *always* available to be
 * worth the roster spot he is standing in". A twelve-point quarterback is not
 * an asset in a league where an eleven-point one can be had every Tuesday; he
 * is eleven points and a wasted bench slot.
 *
 * ## Replacement level, measured rather than assumed
 *
 * The comparison is against the pool that is actually free in **this** league,
 * scored through the same engine as everybody else. Not a published replacement
 * baseline, not a constant: a twelve-team league and a fourteen-team league have
 * genuinely different wires, and the whole recommendation turns on that
 * difference.
 *
 * The replacement level is the median of the top {@link STREAMING.poolDepth}
 * available options rather than the best one. The best free agent is one
 * player's good matchup; the median of the top few is what the wire will still
 * look like next week, which is what a *streaming* decision is actually about.
 *
 * ## What it will not do
 *
 * It never recommends dropping somebody. It says the gap is small enough that
 * streaming is viable, and which options make it so — the drop, the add and the
 * roster spot are the user's, made in Sleeper, by hand. And it declines
 * entirely at positions a league starts several of, because "stream a receiver"
 * is not a strategy, it is a symptom.
 */

import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import { evaluatePlayer, type StartSitInput } from './engine.ts';
import type { StartSitMode } from './mode.ts';

export const STREAMING = {
  /** Positions this is a sensible question about at all. */
  positions: ['QB', 'TE', 'DEF'] as readonly string[],
  /** How many of the best available options define replacement level. */
  poolDepth: 3,
  /**
   * Points by which the rostered player must beat replacement level to be
   * worth holding rather than streaming.
   *
   * Two and a half: the same bar `MEANINGFUL_UPGRADE_GAIN` sets for spending a
   * roster move, and for the same reason. Below it, the two players are the
   * same player and one of them is free.
   */
  holdMargin: 2.5,
  /** Slots at a position above which streaming stops being the question. */
  maxSlots: 1,
} as const;

export type StreamingVerdict = 'hold' | 'streamable' | 'upgrade_available' | 'unknown';

export const STREAMING_LABEL: Record<StreamingVerdict, string> = {
  hold: 'Worth the roster spot',
  streamable: 'Streamable — the wire is as good as this',
  upgrade_available: 'The wire is better than this',
  unknown: 'Not enough to compare',
};

export interface StreamingOption {
  playerId: string;
  name: string;
  team: string;
  score: number | null;
  /** Points against the rostered player. Positive means better. */
  edge: number | null;
}

export interface StreamingAssessment {
  position: string;
  verdict: StreamingVerdict;
  label: string;
  rosteredPlayerId: string | null;
  rosteredName: string | null;
  rosteredScore: number | null;
  /** Median of the top available options. Null when the pool is empty. */
  replacementLevel: number | null;
  poolConsidered: number;
  /** Best first, capped at `poolDepth`. */
  options: StreamingOption[];
  detail: string;
  notes: string[];
}

export function assessStreaming(opts: {
  position: string;
  /** The rostered players at this position. The best of them is the incumbent. */
  roster: StartSitInput[];
  /** Unrostered players at the position, bounded by the caller. */
  available: StartSitInput[];
  shape: RosterShape;
  profile: ScoringProfile;
  mode?: StartSitMode;
  now?: string | Date;
}): StreamingAssessment {
  const position = opts.position.toUpperCase();
  const base: StreamingAssessment = {
    position,
    verdict: 'unknown',
    label: STREAMING_LABEL.unknown,
    rosteredPlayerId: null,
    rosteredName: null,
    rosteredScore: null,
    replacementLevel: null,
    poolConsidered: opts.available.length,
    options: [],
    detail: '',
    notes: [],
  };

  const slots = opts.shape.starters[position] ?? 0;
  if (!STREAMING.positions.includes(position) || slots > STREAMING.maxSlots) {
    return {
      ...base,
      detail: `This league starts ${slots} at ${position} — streaming is a question about a position you start one of.`,
      notes: ['not a streaming position in this league'],
    };
  }

  const evaluate = (input: StartSitInput) =>
    evaluatePlayer({ ...input, mode: input.mode ?? opts.mode ?? 'balanced', now: input.now ?? opts.now }, opts.profile);

  const rostered = opts.roster
    .filter((r) => r.player.position.toUpperCase() === position)
    .map(evaluate)
    .filter((e) => e.score != null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  const pool = opts.available
    .filter((a) => a.player.position.toUpperCase() === position)
    .map(evaluate)
    .filter((e) => e.score != null && !e.ruledOut)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (!rostered) {
    return {
      ...base,
      poolConsidered: pool.length,
      options: pool.slice(0, STREAMING.poolDepth).map((e) => option(e, null)),
      detail:
        pool.length === 0
          ? `No ${position} on the roster, and nobody available who can be scored.`
          : `No ${position} on the roster — the wire's best is ${pool[0]!.name}.`,
      notes: ['no rostered player at this position to compare against'],
    };
  }

  if (pool.length === 0) {
    return {
      ...base,
      verdict: 'hold',
      label: STREAMING_LABEL.hold,
      rosteredPlayerId: rostered.playerId,
      rosteredName: rostered.name,
      rosteredScore: rostered.score,
      poolConsidered: 0,
      detail: `Nobody available at ${position} can be scored this week, so there is nothing to stream to.`,
      notes: ['the free-agent pool is empty or unscorable'],
    };
  }

  const top = pool.slice(0, STREAMING.poolDepth);
  const replacementLevel = median(top.map((e) => e.score ?? 0));
  const gap = round2((rostered.score ?? 0) - replacementLevel);
  const bestFree = top[0]!;

  const verdict: StreamingVerdict =
    (bestFree.score ?? 0) > (rostered.score ?? 0) + STREAMING.holdMargin
      ? 'upgrade_available'
      : gap >= STREAMING.holdMargin
        ? 'hold'
        : 'streamable';

  const notes: string[] = [];
  if (top.length < STREAMING.poolDepth) {
    notes.push(`replacement level is set by ${top.length} available option${top.length === 1 ? '' : 's'} rather than ${STREAMING.poolDepth}`);
  }

  return {
    position,
    verdict,
    label: STREAMING_LABEL[verdict],
    rosteredPlayerId: rostered.playerId,
    rosteredName: rostered.name,
    rosteredScore: rostered.score,
    replacementLevel: round2(replacementLevel),
    poolConsidered: pool.length,
    options: top.map((e) => option(e, rostered.score)),
    detail: detailFor(verdict, rostered.name, gap, bestFree.name, round2((bestFree.score ?? 0) - (rostered.score ?? 0))),
    notes,
  };
}

function option(evaluation: { playerId: string; name: string; team: string; score: number | null }, against: number | null): StreamingOption {
  return {
    playerId: evaluation.playerId,
    name: evaluation.name,
    team: evaluation.team,
    score: evaluation.score,
    edge: against == null || evaluation.score == null ? null : round2(evaluation.score - against),
  };
}

function detailFor(verdict: StreamingVerdict, name: string, gap: number, bestFree: string, bestEdge: number): string {
  switch (verdict) {
    case 'upgrade_available':
      return `${bestFree} is available and projects ${bestEdge.toFixed(1)} pts better than ${name} this week.`;
    case 'hold':
      return `${name} is ${gap.toFixed(1)} pts clear of what the wire offers — worth the roster spot.`;
    case 'streamable':
      return `${name} is only ${gap.toFixed(1)} pts clear of freely available options, so this spot can be streamed week to week rather than held.`;
    default:
      return '';
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
