/**
 * The week the app spent, graded by the app, in four separate registers.
 *
 * The brief is unusually specific about this one, and the specificity is the
 * feature: the four things below must never be run together into a paragraph
 * that reads like a conclusion, because three of them are facts and one of them
 * is an opinion.
 *
 *   1. **Observed evidence** — what was recommended and what happened. No
 *      interpretation at all.
 *   2. **Counterfactual reasoning** — whether each call was defensible on
 *      pregame information, from `counterfactual.ts`.
 *   3. **Suggested bounded changes** — what a person might consider, with the
 *      sample behind it and a hard cap on the size of the change.
 *   4. **Actual model changes** — which is always an empty list here, because a
 *      model change is a code change with a version bump, and this file cannot
 *      make one.
 *
 * ## Nothing is applied. Ever.
 *
 * {@link SelfGradeReport.appliedChanges} exists so that its emptiness is
 * visible rather than implied, and {@link SELF_GRADE.minDecisions} means a week
 * of ten start/sit calls does not get to have an opinion about a weight in the
 * first place. One week is a sample of one football Sunday; the signal it
 * carries about a coefficient is smaller than the noise it carries about a
 * seventy-yard screen pass.
 *
 * ## What "a signal performed well" means here
 *
 * For each component, over the graded decisions where it was known and not
 * zero: how often it pointed at the player who turned out to be right. That is
 * a hit rate, it is reported with its denominator attached, and it is only ever
 * a *suggestion* — a component can be right for the wrong reason as easily as a
 * manager can, which is exactly why the counterfactual verdicts are carried
 * alongside it rather than averaged into it.
 */

import type { Grade } from './counterfactual.ts';
import { MODEL_VERSION, type RecommendationRecord } from './model.ts';

export const SELF_GRADE = {
  /** Graded decisions below which no suggestion is made about anything. */
  minDecisions: 20,
  /** Decisions a single component must have moved before it is described. */
  minComponentSample: 8,
  /** Hit rate below which a component is worth a second look. */
  poorHitRate: 0.4,
  /** ...and above which it is worth saying it earned its weight. */
  goodHitRate: 0.6,
  /**
   * The most any suggestion may propose changing a weight by.
   *
   * Fifteen per cent. A suggestion big enough to change the app's behaviour on
   * its own would be a rewrite proposed by one weekend of football, which is
   * the failure mode the whole file is arranged around.
   */
  maxWeightChange: 0.15,
} as const;

export interface ObservedRow {
  recordId: string;
  week: number;
  chosen: string;
  bestAlternative: string | null;
  outcome: Grade['outcome'];
  pointsMargin: number | null;
  confidence: RecommendationRecord['confidence'];
}

export interface SignalPerformance {
  key: string;
  /** Decisions where this component was known and non-zero. */
  sample: number;
  /** Of those, how often it pointed at the player who turned out right. */
  hits: number;
  hitRate: number | null;
  verdict: 'earned_its_weight' | 'no_signal' | 'underperformed' | 'insufficient_sample';
}

export interface SourceHealth {
  key: string;
  fresh: number;
  stale: number;
  missing: number;
  /** Decisions made on a stale or missing version of this source. */
  degraded: number;
  verdict: 'useful' | 'often_stale' | 'often_missing';
}

export interface SuggestedChange {
  /** The component or policy the suggestion is about. */
  target: string;
  /** Signed, as a share of the current weight. Bounded by `maxWeightChange`. */
  proposedRelativeChange: number;
  rationale: string;
  sample: number;
  /** Always false. A suggestion is a sentence, not a deployment. */
  readonly applied: false;
  /** What it would take to act on it. */
  requires: 'code_change_and_version_bump';
}

export interface SelfGradeReport {
  season: string;
  week: number;
  modelVersion: string;
  /** Versions that produced the graded decisions. More than one is a warning. */
  versionsInSample: string[];
  observed: ObservedRow[];
  counterfactual: {
    grades: Grade[];
    counts: Record<Grade['process'], number>;
    /** Decisions the model got right for reasons it actually gave. */
    soundRate: number | null;
  };
  signals: SignalPerformance[];
  sources: SourceHealth[];
  suggestions: SuggestedChange[];
  /** Always empty here. Model changes are code, reviewed, versioned. */
  appliedChanges: never[];
  notes: string[];
}

/**
 * Build the week's self-grade.
 *
 * Records and grades are passed in already paired by the caller, because the
 * pairing is a persistence concern and this file is deliberately pure: it can
 * be run over one week, one month or one model version without knowing where
 * any of it is stored.
 */
export function buildSelfGrade(opts: {
  season: string;
  week: number;
  records: RecommendationRecord[];
  grades: Grade[];
}): SelfGradeReport {
  const gradeById = new Map(opts.grades.map((g) => [g.recordId, g]));
  const paired = opts.records
    .map((record) => ({ record, grade: gradeById.get(record.id) ?? null }))
    .filter((row): row is { record: RecommendationRecord; grade: Grade } => row.grade != null);

  const observed: ObservedRow[] = paired.map(({ record, grade }) => ({
    recordId: record.id,
    week: record.week,
    chosen: record.chosen.name,
    bestAlternative: grade.bestAlternativeName,
    outcome: grade.outcome,
    pointsMargin: grade.pointsMargin,
    confidence: record.confidence,
  }));

  const counts = countProcesses(paired.map((p) => p.grade));
  const judged = paired.filter(
    ({ grade }) => grade.process !== 'too_close_to_judge' && grade.process !== 'undetermined',
  );
  const soundRate =
    judged.length === 0
      ? null
      : round3(
          judged.filter(({ grade }) => grade.process === 'sound_and_right' || grade.process === 'sound_but_unlucky')
            .length / judged.length,
        );

  const signals = signalPerformance(judged);
  const sources = sourceHealth(paired.map((p) => p.record));
  const versionsInSample = [...new Set(paired.map((p) => p.record.modelVersion))].sort();

  const notes: string[] = [];
  if (paired.length < SELF_GRADE.minDecisions) {
    notes.push(
      `${paired.length} graded decision${paired.length === 1 ? '' : 's'} — below the ${SELF_GRADE.minDecisions} this report needs before it will suggest anything about the model.`,
    );
  }
  if (versionsInSample.length > 1) {
    notes.push(`this sample spans model versions ${versionsInSample.join(' and ')}, so the rates describe more than one model`);
  }
  notes.push('nothing in this report has been applied — every suggestion needs a code change and a version bump');

  return {
    season: opts.season,
    week: opts.week,
    modelVersion: MODEL_VERSION,
    versionsInSample,
    observed,
    counterfactual: { grades: paired.map((p) => p.grade), counts, soundRate },
    signals,
    sources,
    suggestions: paired.length < SELF_GRADE.minDecisions ? [] : suggestions(signals, sources),
    appliedChanges: [],
    notes,
  };
}

function countProcesses(grades: Grade[]): Record<Grade['process'], number> {
  const counts: Record<Grade['process'], number> = {
    sound_and_right: 0,
    sound_but_unlucky: 0,
    lucky: 0,
    process_miss: 0,
    too_close_to_judge: 0,
    undetermined: 0,
  };
  for (const grade of grades) counts[grade.process] += 1;
  return counts;
}

/**
 * Did each component point at the player who turned out to be right?
 *
 * Measured only where the component was **known and non-zero for at least one
 * of the two players**, because a component that said nothing cannot have been
 * right or wrong — counting its silence as a miss would slowly recommend
 * turning down every signal that is honest about missing data.
 */
function signalPerformance(paired: { record: RecommendationRecord; grade: Grade }[]): SignalPerformance[] {
  const stats = new Map<string, { sample: number; hits: number }>();

  for (const { record, grade } of paired) {
    if (grade.outcome !== 'right' && grade.outcome !== 'wrong') continue;
    const alternative = record.alternatives.find((a) => a.name === grade.bestAlternativeName);
    if (!alternative) continue;

    const chosenBy = componentMap(record.chosen.components);
    const otherBy = componentMap(alternative.components);
    for (const key of new Set([...chosenBy.keys(), ...otherBy.keys()])) {
      const mine = chosenBy.get(key);
      const theirs = otherBy.get(key);
      if (mine == null && theirs == null) continue;
      const edge = (mine ?? 0) - (theirs ?? 0);
      if (edge === 0) continue;
      const entry = stats.get(key) ?? { sample: 0, hits: 0 };
      entry.sample += 1;
      // The component preferred the chosen player when its edge is positive.
      const preferredChosen = edge > 0;
      const chosenWasRight = grade.outcome === 'right';
      if (preferredChosen === chosenWasRight) entry.hits += 1;
      stats.set(key, entry);
    }
  }

  return [...stats]
    .map(([key, { sample, hits }]) => {
      const hitRate = sample === 0 ? null : round3(hits / sample);
      const verdict: SignalPerformance['verdict'] =
        sample < SELF_GRADE.minComponentSample
          ? 'insufficient_sample'
          : (hitRate ?? 0) >= SELF_GRADE.goodHitRate
            ? 'earned_its_weight'
            : (hitRate ?? 0) <= SELF_GRADE.poorHitRate
              ? 'underperformed'
              : 'no_signal';
      return { key, sample, hits, hitRate, verdict };
    })
    .sort((a, b) => b.sample - a.sample);
}

function componentMap(components: { key: string; value: number; unknown: boolean }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const component of components) {
    if (component.unknown) continue;
    out.set(component.key, component.value);
  }
  return out;
}

/** How often each source was actually there when a decision needed it. */
function sourceHealth(records: RecommendationRecord[]): SourceHealth[] {
  const stats = new Map<string, SourceHealth>();
  for (const record of records) {
    for (const source of record.sources) {
      const entry = stats.get(source.key) ?? {
        key: source.key,
        fresh: 0,
        stale: 0,
        missing: 0,
        degraded: 0,
        verdict: 'useful' as const,
      };
      entry[source.state] += 1;
      if (source.state !== 'fresh') entry.degraded += 1;
      stats.set(source.key, entry);
    }
  }

  return [...stats.values()]
    .map((entry) => {
      const total = entry.fresh + entry.stale + entry.missing;
      const verdict: SourceHealth['verdict'] =
        total === 0 || entry.missing / total > 0.3 ? 'often_missing' : entry.stale / total > 0.3 ? 'often_stale' : 'useful';
      return { ...entry, verdict };
    })
    .sort((a, b) => b.degraded - a.degraded);
}

/**
 * What a person might consider, bounded and with its sample attached.
 *
 * Only two kinds of suggestion are ever produced: turn a component down a
 * little when it has been reliably pointing the wrong way over a real sample,
 * and fix a source that keeps arriving stale. There is deliberately no
 * suggestion that turns a component *up* on a good week — a signal that
 * happened to be right ten times is the exact thing this file exists not to
 * over-learn from.
 */
function suggestions(signals: SignalPerformance[], sources: SourceHealth[]): SuggestedChange[] {
  const out: SuggestedChange[] = [];

  for (const signal of signals) {
    if (signal.verdict !== 'underperformed') continue;
    // Scaled by how far below chance it is, and capped well short of a rewrite.
    const shortfall = SELF_GRADE.poorHitRate - (signal.hitRate ?? 0);
    const change = -Math.min(SELF_GRADE.maxWeightChange, round3(shortfall * 0.5 + 0.05));
    out.push({
      target: signal.key,
      proposedRelativeChange: change,
      rationale: `pointed at the player who turned out right ${signal.hits} of ${signal.sample} times — consider reducing its weight by up to ${Math.round(Math.abs(change) * 100)}%`,
      sample: signal.sample,
      applied: false,
      requires: 'code_change_and_version_bump',
    });
  }

  for (const source of sources) {
    if (source.verdict === 'useful') continue;
    out.push({
      target: source.key,
      proposedRelativeChange: 0,
      rationale:
        source.verdict === 'often_missing'
          ? `missing for ${source.missing} of the decisions this week — worth checking the feed before trusting anything built on it`
          : `stale for ${source.stale} of the decisions this week — the refresh schedule may not match when decisions are made`,
      sample: source.fresh + source.stale + source.missing,
      applied: false,
      requires: 'code_change_and_version_bump',
    });
  }

  return out;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
