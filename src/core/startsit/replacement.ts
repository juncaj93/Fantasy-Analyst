/**
 * If he cannot go, what actually happens?
 *
 * A questionable player is not a risk in isolation. He is a risk relative to
 * two things the projection does not contain: **when his game starts**, and
 * **who would take his place**.
 *
 *   - A questionable receiver in the late window with a solid alternative on
 *     the bench is barely a risk at all. The news lands before either game, and
 *     the swap costs nothing.
 *   - The same receiver in the late window whose only alternative plays at one
 *     o'clock is a real problem: to keep the option you must start the
 *     alternative before the news arrives, and once one o'clock passes, an
 *     inactive receiver means an empty slot.
 *
 * That second case is the one this module exists to price, and the price is
 * deliberately small: {@link REPLACEMENT.maxPenaltyPoints} of a score that
 * routinely runs to fifteen. It is a tie-breaker and a sentence on the card,
 * not a veto — the user, who knows things this app does not, makes the call.
 *
 * Nothing here changes a lineup, and nothing here overrides the availability
 * penalty, which has already been charged for the designation itself. This is
 * only the *structural* part of the risk: timing and the bench.
 */

import { lockState } from './decisions.ts';
import type { AvailabilityConfidence } from './availabilityConfidence.ts';

export const REPLACEMENT = {
  /** Hours of kickoff separation before "later" is a different decision. */
  minGapHours: 3,
  /** The most the structural risk can cost, in fantasy points. */
  maxPenaltyPoints: 0.9,
  /**
   * How much of that each availability state carries.
   *
   * `uncertain` is the worst, not `likely_inactive`: a player you expect to be
   * out is one you have already planned around, while a genuine coin flip is
   * the one that strands a lineup.
   */
  byState: {
    uncertain: 1,
    moderate_confidence_active: 0.6,
    likely_inactive: 0.8,
    high_confidence_active: 0,
    inactive: 0,
    unknown: 0,
  } as Record<AvailabilityConfidence, number>,
} as const;

export type ReplacementVerdict =
  | 'no_risk'
  | 'covered'
  | 'late_swap_exposed'
  | 'thin_bench'
  | 'unknown';

export interface ReplacementCandidate {
  playerId: string;
  name: string;
  kickoff: string | null;
  /** The Start/Sit score. Null when he cannot be scored at all. */
  score: number | null;
}

export interface ReplacementInput {
  player: { name: string; kickoff: string | null; score: number | null; availability: AvailabilityConfidence };
  /** Everyone eligible for the same slot who is not already starting elsewhere. */
  alternatives: ReplacementCandidate[];
  now?: string | Date;
}

export interface ReplacementAssessment {
  verdict: ReplacementVerdict;
  /** Negative points, added to the score like any other component. */
  points: number;
  /** The alternative the verdict is about. */
  fallbackName: string | null;
  /** How far the fallback's score trails his, when both are known. */
  dropoff: number | null;
  display: string;
  driver: string | null;
}

export const NO_REPLACEMENT_RISK: ReplacementAssessment = {
  verdict: 'no_risk',
  points: 0,
  fallbackName: null,
  dropoff: null,
  display: 'no availability risk to cover',
  driver: null,
};

/**
 * Price the structural half of an availability risk.
 *
 * The fallback considered is the **best alternative that is still swappable
 * after his game would have started** where one exists, because that is the
 * one whose existence removes the problem entirely. Where the only alternatives
 * lock earlier, the exposure is real and is measured against the best of them —
 * the one whose slot would actually be spent by waiting.
 */
export function assessReplacement(input: ReplacementInput): ReplacementAssessment {
  const severity = REPLACEMENT.byState[input.player.availability] ?? 0;
  if (severity === 0) return NO_REPLACEMENT_RISK;

  const now = input.now ?? new Date();
  const usable = input.alternatives.filter((a) => a.score != null && !lockState(a.kickoff, now).locked);
  if (usable.length === 0) {
    return {
      verdict: 'thin_bench',
      points: round2(-REPLACEMENT.maxPenaltyPoints * severity),
      fallbackName: null,
      dropoff: null,
      display: 'nobody eligible left to cover him',
      driver: 'Risky · no cover on the bench if he sits',
    };
  }

  const best = [...usable].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]!;
  const dropoff = input.player.score == null ? null : round1((input.player.score ?? 0) - (best.score ?? 0));

  /*
   * Does the news arrive in time?
   *
   * Only kickoff times decide this. An alternative that plays at the same time
   * or later can be swapped in once his status is announced, so the option
   * survives; one that plays meaningfully earlier has to be started blind.
   */
  const playerStart = input.player.kickoff ? Date.parse(input.player.kickoff) : Number.NaN;
  const laterOrEqual = usable.filter((a) => {
    if (!a.kickoff || !Number.isFinite(playerStart)) return false;
    return Date.parse(a.kickoff) >= playerStart - REPLACEMENT.minGapHours * 3_600_000;
  });

  if (!Number.isFinite(playerStart)) {
    return {
      verdict: 'unknown',
      points: round2(-REPLACEMENT.maxPenaltyPoints * severity * 0.5),
      fallbackName: best.name,
      dropoff,
      display: `kickoff times unknown · ${best.name} is the fallback`,
      driver: null,
    };
  }

  if (laterOrEqual.length > 0) {
    const cover = [...laterOrEqual].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]!;
    const gap = input.player.score == null ? null : round1((input.player.score ?? 0) - (cover.score ?? 0));
    return {
      verdict: 'covered',
      points: 0,
      fallbackName: cover.name,
      dropoff: gap,
      display: `${cover.name} does not lock before him, so the swap stays available`,
      driver: null,
    };
  }

  /*
   * Exposed: every alternative locks first.
   *
   * How much that costs depends on how far the drop is. Losing two points of
   * projection to protect against a coin flip is a decision; losing eight is
   * the situation this sentence is for.
   */
  const scaled = dropoff == null ? 0.6 : clamp01(dropoff / 8);
  return {
    verdict: 'late_swap_exposed',
    points: round2(-REPLACEMENT.maxPenaltyPoints * severity * (0.4 + 0.6 * scaled)),
    fallbackName: best.name,
    dropoff,
    display: `${best.name} locks first, so his slot is committed before the status is known`,
    driver: `Late-swap risk · ${best.name} is the only cover and locks first`,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
