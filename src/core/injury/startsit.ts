/**
 * What an injury is worth in a lineup decision.
 *
 * Start/Sit has always had an availability penalty, and it was a lookup table
 * on one word: Questionable cost 1.5 points, whoever the player was and
 * whatever else was known about him. That is the right shape for Out — a player
 * who is out is out — and the wrong shape for Questionable, which is the only
 * designation that is genuinely a question.
 *
 * So the table survives for the designations that are facts, and Questionable
 * becomes contextual: the same word costs a player who practised fully on
 * Friday much less than one who has not practised at all.
 *
 * ## Bounded on purpose
 *
 * The context can halve the penalty or nearly double it, and it can do no more
 * than that. A practice report is a real signal and it is not a medical
 * clearance; a player who practised fully and is still listed Questionable is
 * still listed Questionable, and this must not talk itself into forgetting
 * that.
 */

import {
  isRuledOut,
  type Confidence,
  type InjuryState,
  type PracticeTrend,
} from './model.ts';

/**
 * The anchors, unchanged from the table this replaces.
 *
 * `ruledOut` is not a penalty, it is a gate — large enough that no combination
 * of market expectation and news can lift a player over somebody available.
 */
export const AVAILABILITY = {
  ruledOut: -99,
  doubtful: -6,
  questionable: -1.5,
} as const;

/**
 * How much the week's practice moves a Questionable player, as a multiplier on
 * the base penalty.
 *
 * Full participation is the strongest evidence available here that the
 * designation is precautionary, and it still leaves a third of the penalty
 * standing. Not practising at all nearly doubles it.
 */
export const PRACTICE_WEIGHT: Record<PracticeTrend, number> = {
  full_participant: 0.35,
  improving: 0.6,
  stable_limited: 1,
  unknown: 1,
  worsening: 1.5,
  not_practising: 1.8,
};

/**
 * Uncertainty pulls the adjustment back toward the plain designation.
 *
 * A stale or contradicted practice note is not a reason to be confident in
 * either direction, so it gets half its say. This is the opposite of the usual
 * instinct — bad data should make the app less sure, not more cautious, because
 * "less sure" is what is actually true.
 */
export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  high: 1,
  moderate: 0.75,
  low: 0.5,
  unknown: 0,
};

export interface AvailabilityAssessment {
  /** Points, negative. Added to the Start/Sit score like any other component. */
  points: number;
  /** True when this player must not be recommended as a starter at all. */
  gate: boolean;
  /** What the component line says. Never a bare label. */
  display: string;
  /** A sentence for the recommendation, when it changed the answer. */
  note: string | null;
}

/** Nothing known and nothing wrong: no penalty, and nothing said. */
export const AVAILABLE: AvailabilityAssessment = {
  points: 0,
  gate: false,
  display: 'no designation',
  note: null,
};

/**
 * Turn the normalized state into points.
 *
 * The order matters and is the brief's: Out is a hard gate, Doubtful is a
 * near-gate, Questionable is contextual, and no designation costs nothing at
 * all — a player with a history and no current designation is a healthy player.
 */
export function availabilityPenalty(state: InjuryState): AvailabilityAssessment {
  const { designation } = state;
  if (designation === 'healthy' || designation === 'unknown') return AVAILABLE;

  if (isRuledOut(designation)) {
    return {
      points: AVAILABILITY.ruledOut,
      gate: true,
      display: describe(state),
      note: `${label(state)} — not a playable starter.`,
    };
  }

  if (designation === 'doubtful') {
    return {
      points: AVAILABILITY.doubtful,
      gate: false,
      display: describe(state),
      note: `${label(state)} — very unlikely to play.`,
    };
  }

  // Questionable: the only one where the rest of the week is worth reading.
  const practice = PRACTICE_WEIGHT[state.practice.trend];
  const trust = CONFIDENCE_WEIGHT[state.confidence];
  // Blend the practice multiplier toward 1 by how much the sources are trusted.
  const weight = 1 + (practice - 1) * trust;
  const points = round2(AVAILABILITY.questionable * weight);

  return {
    points,
    gate: false,
    display: describe(state),
    note: questionableNote(state, weight),
  };
}

/** `Questionable · hamstring · limited → full`, or as much of it as is known. */
function describe(state: InjuryState): string {
  const parts = [label(state)];
  if (state.bodyPart) parts.push(state.bodyPart.toLowerCase());
  if (state.practice.label) parts.push(state.practice.label);
  if (state.freshness === 'stale') parts.push('report is out of date');
  if (state.conflict) parts.push('sources disagree');
  return parts.join(' · ');
}

function label(state: InjuryState): string {
  return (
    { questionable: 'Questionable', doubtful: 'Doubtful', out: 'Out', ir: 'On IR', pup: 'On PUP', suspended: 'Suspended' }[
      state.designation as 'questionable' | 'doubtful' | 'out' | 'ir' | 'pup' | 'suspended'
    ] ?? 'Designated'
  );
}

/**
 * The sentence a recommendation quotes — and only when the context actually
 * changed something. "Questionable" on its own is on the card already.
 */
function questionableNote(state: InjuryState, weight: number): string | null {
  const body = state.bodyPart ? ` (${state.bodyPart.toLowerCase()})` : '';
  if (state.conflict) return `Questionable${body}, and the sources disagree — treat the status as unsettled.`;
  if (state.freshness === 'stale') return `Questionable${body} on a report that is out of date.`;
  if (weight <= 0.7 && state.practice.label) return `Questionable${body} but ${state.practice.label}.`;
  if (weight >= 1.3 && state.practice.label) return `Questionable${body} and ${state.practice.label}.`;
  return null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
