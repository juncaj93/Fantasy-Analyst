/**
 * How likely is he to actually be out there — as a state, not a number.
 *
 * The designation alone cannot answer this. Two players are both Questionable:
 * one went DNP, DNP, DNP and one went DNP, limited, full. They are the same
 * word and completely different lineup decisions, and the practice report is
 * the free, published evidence that separates them.
 *
 * Most of that machinery already exists — `core/injury/model.ts` normalises the
 * designation, folds the practice week into a trend and rates how fresh and how
 * corroborated the sources are, and `core/injury/startsit.ts` turns it into
 * bounded points. What was missing is the part a *person* reads: a small closed
 * set of states, so that "risky" means one thing across the whole app and the
 * replacement-quality and late-swap logic can branch on it rather than
 * re-deriving it from a penalty in points.
 *
 * This module adds no score of its own. It is an interpretation of a state that
 * is already scored, and scoring it again is the double-count the brief warns
 * about.
 *
 * No medicine, no return dates, no invented probabilities. Five states, each
 * traceable to something a source published.
 */

import { isRuledOut, type InjuryState } from '../injury/model.ts';

export type AvailabilityConfidence =
  | 'high_confidence_active'
  | 'moderate_confidence_active'
  | 'uncertain'
  | 'likely_inactive'
  | 'inactive'
  | 'unknown';

export const AVAILABILITY_LABEL: Record<AvailabilityConfidence, string> = {
  high_confidence_active: 'Expected to play',
  moderate_confidence_active: 'Likely to play',
  uncertain: 'Genuinely uncertain',
  likely_inactive: 'Unlikely to play',
  inactive: 'Not playing',
  unknown: 'Availability unknown',
};

export interface AvailabilityView {
  state: AvailabilityConfidence;
  label: string;
  /** The evidence, in the order a person would want it. */
  evidence: string[];
  /** One line for a card, or null when there is nothing to say. */
  detail: string | null;
  /** True when the state should make the lineup layer nervous. */
  risky: boolean;
}

const HEALTHY: AvailabilityView = {
  state: 'high_confidence_active',
  label: AVAILABILITY_LABEL.high_confidence_active,
  evidence: [],
  detail: null,
  risky: false,
};

const UNKNOWN: AvailabilityView = {
  state: 'unknown',
  label: AVAILABILITY_LABEL.unknown,
  evidence: [],
  detail: null,
  risky: false,
};

/**
 * Read the resolved injury state as a confidence state.
 *
 * The ordering is the same one `availabilityPenalty` uses, deliberately: a
 * player who is a hard gate there must not read as merely uncertain here, and
 * two different orderings of the same facts is how a card ends up disagreeing
 * with the score beside it.
 */
export function availabilityConfidence(state: InjuryState): AvailabilityView {
  const { designation } = state;
  if (designation === 'unknown') return UNKNOWN;
  if (designation === 'healthy') return HEALTHY;

  const evidence: string[] = [];
  if (state.practice.label) evidence.push(state.practice.label);
  if (state.bodyPart) evidence.push(state.bodyPart.toLowerCase());
  if (state.freshness === 'stale') evidence.push('report is out of date');
  if (state.conflict) evidence.push('sources disagree');

  if (isRuledOut(designation)) {
    return {
      state: 'inactive',
      label: AVAILABILITY_LABEL.inactive,
      evidence,
      detail: `${designation === 'ir' ? 'On injured reserve' : capitalise(designation)} — not a playable starter.`,
      risky: false,
    };
  }

  if (designation === 'doubtful') {
    return {
      state: 'likely_inactive',
      label: AVAILABILITY_LABEL.likely_inactive,
      evidence,
      detail: `Doubtful${state.practice.label ? ` and ${state.practice.label}` : ''} — treat him as unlikely to play.`,
      risky: true,
    };
  }

  /*
   * Questionable, which is the only designation that is genuinely a question.
   *
   * The practice week answers it as well as anything free can, and the answer
   * is pulled back toward "uncertain" when the report is stale or the sources
   * disagree — bad data is a reason to be less sure, never a reason to be more
   * confident in either direction.
   */
  const trusted = state.confidence === 'high' || state.confidence === 'moderate';
  const trend = state.practice.trend;

  if (trusted && (trend === 'full_participant' || trend === 'improving')) {
    return {
      state: 'high_confidence_active',
      label: AVAILABILITY_LABEL.high_confidence_active,
      evidence,
      detail: `Questionable, but ${state.practice.label} — the week points to him playing.`,
      risky: false,
    };
  }

  if (trend === 'not_practising' || trend === 'worsening') {
    return {
      state: 'likely_inactive',
      label: AVAILABILITY_LABEL.likely_inactive,
      evidence,
      detail: `Questionable and ${state.practice.label ?? 'trending the wrong way'} — plan for him being out.`,
      risky: true,
    };
  }

  if (trend === 'stable_limited' && trusted) {
    return {
      state: 'moderate_confidence_active',
      label: AVAILABILITY_LABEL.moderate_confidence_active,
      evidence,
      detail: `Questionable and ${state.practice.label ?? 'limited'} — probably playing, not settled.`,
      risky: true,
    };
  }

  return {
    state: 'uncertain',
    label: AVAILABILITY_LABEL.uncertain,
    evidence,
    detail:
      state.practice.days.length === 0
        ? 'Questionable with no practice report to read — genuinely uncertain.'
        : `Questionable${state.conflict ? ', and the sources disagree' : ''} — genuinely uncertain.`,
    risky: true,
  };
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
