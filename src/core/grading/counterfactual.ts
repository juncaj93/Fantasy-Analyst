/**
 * Was that a good decision, or did it merely work out?
 *
 * The instinct is to grade a start/sit call by who scored more. That instinct,
 * applied every week for a season, produces a model that has learned football's
 * noise: the seventy-yard screen that went the distance, the fumble at the one,
 * the third-string tight end who caught two touchdowns and then nothing for a
 * month. A model trained on those is worse than one that never grades itself at
 * all, because it is confidently worse.
 *
 * So every decision gets **two** verdicts, and they are kept apart:
 *
 *   - the **outcome**: who actually scored more. A fact, recorded, never
 *     argued with.
 *   - the **process**: whether the call was reasonable on what was knowable
 *     before kickoff. That is the one that may eventually change a weight.
 *
 * ## How the process is judged without hindsight
 *
 * By opportunity, not by points. The record already knows what the model
 * thought; the outcome knows what each player was actually *given* — targets,
 * carries and the expected points those were worth (`xFP`). Then:
 *
 *   - the alternative got more opportunity too → the model missed something
 *     real. **Process wrong.**
 *   - the alternative got less opportunity and still outscored the pick → the
 *     difference is efficiency and touchdowns, which is the part nobody
 *     predicts. **Process sound, outcome unlucky.**
 *   - the pick got more opportunity and outscored him → **sound and right**,
 *     and worth exactly as much attention as it sounds.
 *   - the pick got less opportunity and outscored him anyway → **lucky**, and
 *     recorded as such, because a model that counts its lucky wins as evidence
 *     is the same model that counts its unlucky losses as evidence.
 *
 * ## The other half: it must have been a real decision
 *
 * A call the model made at high confidence with a four-point margin that lost
 * by a point is not a mistake worth learning from — the margin was inside the
 * noise. Anything closer than {@link COUNTERFACTUAL.noiseMargin} points is
 * graded `too_close_to_judge`, which keeps a season of coin flips from being
 * read as a season of skill in either direction.
 *
 * Nothing here changes a weight. It produces a grade with its reasoning
 * attached; `report.ts` aggregates those, and a human changes the model.
 */

import type { PlayerOutcome, RecommendationRecord, RecordOutcome } from './model.ts';

export const COUNTERFACTUAL = {
  /**
   * Points of realised difference below which nothing is claimed either way.
   *
   * Three: a weekly fantasy score is a distribution several points wide, and a
   * two-point margin is which end of it a bounce landed on.
   */
  noiseMargin: 3,
  /**
   * Points of expected-points difference at which opportunity genuinely
   * disagreed with the model.
   */
  opportunityMargin: 2,
} as const;

export type OutcomeVerdict = 'right' | 'wrong' | 'tie' | 'unknown';

export type ProcessVerdict =
  | 'sound_and_right'
  | 'sound_but_unlucky'
  | 'lucky'
  | 'process_miss'
  | 'too_close_to_judge'
  | 'undetermined';

export const PROCESS_LABEL: Record<ProcessVerdict, string> = {
  sound_and_right: 'Right, and for the right reasons',
  sound_but_unlucky: 'Reasonable call, beaten by variance',
  lucky: 'Right, but not for the reasons given',
  process_miss: 'The opportunity was elsewhere — a real miss',
  too_close_to_judge: 'Too close to judge',
  undetermined: 'Not enough of the outcome is known',
};

export interface Grade {
  recordId: string;
  week: number;
  modelVersion: string;
  chosenName: string;
  bestAlternativeName: string | null;
  outcome: OutcomeVerdict;
  process: ProcessVerdict;
  label: string;
  /** Chosen minus best alternative, in points actually scored. */
  pointsMargin: number | null;
  /** The same margin in expected points from opportunity. */
  opportunityMargin: number | null;
  /** Touchdowns above what the opportunity expected, for the alternative. */
  alternativeTdLuck: number | null;
  detail: string;
  /** Anything that made the grade less trustworthy. */
  caveats: string[];
}

/**
 * Grade one recommendation against what happened.
 *
 * The comparison is always against the **best alternative by outcome**, not
 * against the one the model ranked second: the question being asked is "was
 * there a better choice available", and the model's own ordering of the
 * candidates it rejected is not evidence about that.
 */
export function gradeRecommendation(record: RecommendationRecord, outcome: RecordOutcome): Grade {
  const byId = new Map(outcome.players.map((p) => [p.playerId, p]));
  const chosen = byId.get(record.chosen.playerId) ?? null;
  const alternatives = record.alternatives
    .map((a) => ({ record: a, outcome: byId.get(a.playerId) ?? null }))
    .filter((a): a is { record: typeof a.record; outcome: PlayerOutcome } => a.outcome != null);

  const base: Grade = {
    recordId: record.id,
    week: record.week,
    modelVersion: record.modelVersion,
    chosenName: record.chosen.name,
    bestAlternativeName: null,
    outcome: 'unknown',
    process: 'undetermined',
    label: PROCESS_LABEL.undetermined,
    pointsMargin: null,
    opportunityMargin: null,
    alternativeTdLuck: null,
    detail: '',
    caveats: [],
  };

  if (!chosen || chosen.actualPoints == null || alternatives.length === 0) {
    return {
      ...base,
      detail: !chosen
        ? 'No outcome was recorded for the player who was started.'
        : alternatives.length === 0
          ? 'No alternative has an outcome to compare against.'
          : 'The chosen player has no recorded score.',
    };
  }

  const scored = alternatives.filter((a) => a.outcome.actualPoints != null);
  if (scored.length === 0) {
    return { ...base, detail: 'No alternative has a recorded score to compare against.' };
  }

  const best = scored.sort((a, b) => (b.outcome.actualPoints ?? 0) - (a.outcome.actualPoints ?? 0))[0]!;
  const pointsMargin = round2((chosen.actualPoints ?? 0) - (best.outcome.actualPoints ?? 0));
  const opportunity =
    chosen.xfp == null || best.outcome.xfp == null ? null : round2(chosen.xfp - best.outcome.xfp);
  const tdLuck =
    best.outcome.touchdowns == null || best.outcome.xfp == null || best.outcome.actualPoints == null
      ? null
      : round2((best.outcome.actualPoints ?? 0) - (best.outcome.xfp ?? 0));

  const caveats: string[] = [];
  if (chosen.inactive) caveats.push(`${record.chosen.name} did not play — this grades the availability read, not the projection`);
  if (opportunity == null) caveats.push('no opportunity data for one of the players, so only the box score could be compared');
  for (const source of record.sources) {
    if (source.state === 'stale') caveats.push(`${source.key} was stale when the call was made`);
    if (source.state === 'missing') caveats.push(`${source.key} was missing when the call was made`);
  }

  const outcomeVerdict: OutcomeVerdict =
    Math.abs(pointsMargin) < 0.05 ? 'tie' : pointsMargin > 0 ? 'right' : 'wrong';

  const process = judgeProcess(pointsMargin, opportunity);

  return {
    ...base,
    bestAlternativeName: best.record.name,
    outcome: outcomeVerdict,
    process,
    label: PROCESS_LABEL[process],
    pointsMargin,
    opportunityMargin: opportunity,
    alternativeTdLuck: tdLuck,
    detail: describe(record, best.record.name, pointsMargin, opportunity, process),
    caveats,
  };
}

/**
 * The two-axis judgement, in one place.
 *
 * Read it as a table: the sign of the box-score margin against the sign of the
 * opportunity margin. Everything inside the noise band on the first axis is
 * refused outright, before the second axis is even consulted — a decision that
 * cost a point is not evidence about anything.
 */
function judgeProcess(pointsMargin: number, opportunityMargin: number | null): ProcessVerdict {
  if (Math.abs(pointsMargin) < COUNTERFACTUAL.noiseMargin) return 'too_close_to_judge';
  if (opportunityMargin == null) return 'undetermined';

  const opportunityDisagreed = opportunityMargin <= -COUNTERFACTUAL.opportunityMargin;

  // The pick won: sound unless the opportunity says he had no business winning.
  if (pointsMargin > 0) return opportunityDisagreed ? 'lucky' : 'sound_and_right';
  // The pick lost. Whether that is a miss depends entirely on the opportunity.
  return opportunityDisagreed ? 'process_miss' : 'sound_but_unlucky';
}

function describe(
  record: RecommendationRecord,
  alternativeName: string,
  pointsMargin: number,
  opportunityMargin: number | null,
  process: ProcessVerdict,
): string {
  const chosen = record.chosen.name;
  const gap = Math.abs(pointsMargin).toFixed(1);
  switch (process) {
    case 'too_close_to_judge':
      return `${chosen} and ${alternativeName} finished within ${gap} pts — inside the week-to-week noise, so this says nothing about the call.`;
    case 'sound_but_unlucky':
      return `${alternativeName} outscored ${chosen} by ${gap} pts on ${opportunityMargin == null ? 'unknown' : `${Math.abs(opportunityMargin).toFixed(1)} pts less`} of opportunity — the call was reasonable and the football was not.`;
    case 'process_miss':
      return `${alternativeName} outscored ${chosen} by ${gap} pts and had the better opportunity too — the model missed a real difference.`;
    case 'lucky':
      return `${chosen} won by ${gap} pts on less opportunity than ${alternativeName} had — right answer, and not for the reason the card gave.`;
    case 'sound_and_right':
      return `${chosen} beat ${alternativeName} by ${gap} pts, with the opportunity to match.`;
    default:
      return `Not enough of the outcome is known to judge ${chosen} against ${alternativeName}.`;
  }
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
