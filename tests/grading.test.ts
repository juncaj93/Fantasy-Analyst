/**
 * Grading the decision rather than the bounce.
 *
 * The fixture that matters is the brief's own: a sensible call, beaten by a
 * seventy-yard touchdown. If that ever grades as a mistake, the model is one
 * season away from having learned to chase touchdowns — so it is asserted here
 * from both directions, alongside the mirror case where the opportunity really
 * was somewhere else and the miss is real.
 */

import { describe, expect, it } from 'vitest';
import { COUNTERFACTUAL, gradeRecommendation, type Grade } from '../src/core/grading/counterfactual.ts';
import { SELF_GRADE, buildSelfGrade } from '../src/core/grading/report.ts';
import {
  MODEL_VERSION,
  lookaheadViolations,
  type RecommendationRecord,
  type RecordOutcome,
} from '../src/core/grading/model.ts';

const DECIDED = '2025-10-05T15:00:00Z';

function record(over: Partial<RecommendationRecord> = {}): RecommendationRecord {
  return {
    id: 'r1',
    season: '2025',
    week: 5,
    kind: 'start_sit',
    modelVersion: MODEL_VERSION,
    decidedAt: DECIDED,
    mode: 'balanced',
    chosen: {
      playerId: 'a',
      name: 'The Pick',
      position: 'WR',
      score: 13,
      marketPoints: 12,
      components: [
        { key: 'vegas', value: 12, unknown: false },
        { key: 'usage_level', value: 1.2, unknown: false },
      ],
    },
    alternatives: [
      {
        playerId: 'b',
        name: 'The Other Guy',
        position: 'WR',
        score: 11,
        marketPoints: 10.5,
        components: [
          { key: 'vegas', value: 10.5, unknown: false },
          { key: 'usage_level', value: 0.2, unknown: false },
        ],
      },
    ],
    margin: 2,
    confidence: 'high',
    drivers: ['higher market expectation'],
    sources: [
      { key: 'vegas', state: 'fresh', observedAt: '2025-10-05T13:00:00Z', ageMinutes: 120 },
      { key: 'usage', state: 'fresh', observedAt: '2025-10-04T09:00:00Z', ageMinutes: 1800 },
    ],
    ...over,
  };
}

function outcome(chosen: { points: number; xfp: number; tds?: number }, other: { points: number; xfp: number; tds?: number }): RecordOutcome {
  return {
    recordId: 'r1',
    settledAt: '2025-10-06T04:00:00Z',
    players: [
      { playerId: 'a', actualPoints: chosen.points, xfp: chosen.xfp, touchdowns: chosen.tds ?? 0, inactive: false },
      { playerId: 'b', actualPoints: other.points, xfp: other.xfp, touchdowns: other.tds ?? 0, inactive: false },
    ],
  };
}

describe('no lookahead', () => {
  it('accepts a record whose sources all predate the decision', () => {
    expect(lookaheadViolations(record())).toEqual([]);
  });

  it('names a source that was observed after the decision was recorded', () => {
    const leaky = record({
      sources: [{ key: 'vegas', state: 'fresh', observedAt: '2025-10-05T22:00:00Z', ageMinutes: 0 }],
    });
    expect(lookaheadViolations(leaky)).toHaveLength(1);
    expect(lookaheadViolations(leaky)[0]).toMatch(/after the decision/);
  });
});

describe('counterfactual grading', () => {
  it('does not call a fluky 70-yard touchdown a mistake', () => {
    // The alternative scored more on much less opportunity.
    const grade = gradeRecommendation(record(), outcome({ points: 9, xfp: 12 }, { points: 18, xfp: 5, tds: 1 }));
    expect(grade.outcome).toBe('wrong');
    expect(grade.process).toBe('sound_but_unlucky');
    expect(grade.detail).toMatch(/reasonable and the football was not/);
  });

  it('does call a real miss a miss', () => {
    // The alternative got the opportunity too — that is not variance.
    const grade = gradeRecommendation(record(), outcome({ points: 6, xfp: 5 }, { points: 17, xfp: 14 }));
    expect(grade.outcome).toBe('wrong');
    expect(grade.process).toBe('process_miss');
  });

  it('records a win on thin opportunity as luck rather than as evidence', () => {
    const grade = gradeRecommendation(record(), outcome({ points: 20, xfp: 6, tds: 2 }, { points: 8, xfp: 13 }));
    expect(grade.outcome).toBe('right');
    expect(grade.process).toBe('lucky');
  });

  it('credits a win that the opportunity backs up', () => {
    const grade = gradeRecommendation(record(), outcome({ points: 18, xfp: 14 }, { points: 9, xfp: 7 }));
    expect(grade.process).toBe('sound_and_right');
  });

  it('refuses to judge a result inside the noise', () => {
    const grade = gradeRecommendation(record(), outcome({ points: 12, xfp: 11 }, { points: 10.5, xfp: 6 }));
    expect(Math.abs(grade.pointsMargin!)).toBeLessThan(COUNTERFACTUAL.noiseMargin);
    expect(grade.process).toBe('too_close_to_judge');
  });

  it('says undetermined rather than guessing when opportunity is unknown', () => {
    const partial: RecordOutcome = {
      recordId: 'r1',
      settledAt: '2025-10-06T04:00:00Z',
      players: [
        { playerId: 'a', actualPoints: 6, xfp: null, touchdowns: 0, inactive: false },
        { playerId: 'b', actualPoints: 17, xfp: null, touchdowns: 2, inactive: false },
      ],
    };
    const grade = gradeRecommendation(record(), partial);
    expect(grade.process).toBe('undetermined');
    expect(grade.caveats.join(' ')).toMatch(/no opportunity data/);
  });

  it('grades against the best alternative by outcome, not by the old ranking', () => {
    const twoAlternatives = record({
      alternatives: [
        { playerId: 'b', name: 'The Other Guy', position: 'WR', score: 11, marketPoints: 10, components: [] },
        { playerId: 'c', name: 'The Third Guy', position: 'WR', score: 4, marketPoints: 4, components: [] },
      ],
    });
    const result: RecordOutcome = {
      recordId: 'r1',
      settledAt: '2025-10-06T04:00:00Z',
      players: [
        { playerId: 'a', actualPoints: 8, xfp: 9, touchdowns: 0, inactive: false },
        { playerId: 'b', actualPoints: 9, xfp: 9, touchdowns: 0, inactive: false },
        { playerId: 'c', actualPoints: 22, xfp: 18, touchdowns: 1, inactive: false },
      ],
    };
    const grade = gradeRecommendation(twoAlternatives, result);
    expect(grade.bestAlternativeName).toBe('The Third Guy');
    expect(grade.process).toBe('process_miss');
  });

  it('says what a stale source did to the grade rather than hiding it', () => {
    const stale = record({
      sources: [{ key: 'vegas', state: 'stale', observedAt: '2025-10-03T13:00:00Z', ageMinutes: 3000 }],
    });
    const grade = gradeRecommendation(stale, outcome({ points: 6, xfp: 5 }, { points: 17, xfp: 14 }));
    expect(grade.caveats.join(' ')).toMatch(/vegas was stale/);
  });
});

describe('the weekly self-grade', () => {
  /** `count` decisions where the named component always pointed the wrong way. */
  function week(count: number, componentKey: string, componentWins: boolean): { records: RecommendationRecord[]; grades: Grade[] } {
    const records: RecommendationRecord[] = [];
    const grades: Grade[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `r${i}`;
      records.push(
        record({
          id,
          chosen: {
            playerId: 'a',
            name: 'The Pick',
            position: 'WR',
            score: 13,
            marketPoints: 12,
            components: [{ key: componentKey, value: 1, unknown: false }],
          },
          alternatives: [
            {
              playerId: 'b',
              name: 'The Other Guy',
              position: 'WR',
              score: 11,
              marketPoints: 10,
              components: [{ key: componentKey, value: -1, unknown: false }],
            },
          ],
        }),
      );
      grades.push({
        recordId: id,
        week: 5,
        modelVersion: MODEL_VERSION,
        chosenName: 'The Pick',
        bestAlternativeName: 'The Other Guy',
        outcome: componentWins ? 'right' : 'wrong',
        process: componentWins ? 'sound_and_right' : 'process_miss',
        label: '',
        pointsMargin: componentWins ? 6 : -6,
        opportunityMargin: componentWins ? 4 : -4,
        alternativeTdLuck: null,
        detail: '',
        caveats: [],
      });
    }
    return { records, grades };
  }

  it('says nothing about the model from a small week', () => {
    const { records, grades } = week(5, 'usage_level', false);
    const report = buildSelfGrade({ season: '2025', week: 5, records, grades });
    expect(report.suggestions).toEqual([]);
    expect(report.notes.join(' ')).toMatch(new RegExp(`below the ${SELF_GRADE.minDecisions}`));
  });

  it('reports what happened whether or not it will suggest anything', () => {
    const { records, grades } = week(5, 'usage_level', false);
    const report = buildSelfGrade({ season: '2025', week: 5, records, grades });
    expect(report.observed).toHaveLength(5);
    expect(report.observed[0]!.chosen).toBe('The Pick');
    expect(report.counterfactual.counts.process_miss).toBe(5);
  });

  it('suggests a bounded reduction for a component that kept pointing the wrong way', () => {
    const { records, grades } = week(SELF_GRADE.minDecisions, 'usage_level', false);
    const report = buildSelfGrade({ season: '2025', week: 5, records, grades });
    const signal = report.signals.find((s) => s.key === 'usage_level')!;
    expect(signal.verdict).toBe('underperformed');
    const suggestion = report.suggestions.find((s) => s.target === 'usage_level')!;
    expect(suggestion.proposedRelativeChange).toBeLessThan(0);
    expect(Math.abs(suggestion.proposedRelativeChange)).toBeLessThanOrEqual(SELF_GRADE.maxWeightChange);
    expect(suggestion.applied).toBe(false);
    expect(suggestion.requires).toBe('code_change_and_version_bump');
  });

  it('never proposes turning a component up on a good week', () => {
    const { records, grades } = week(SELF_GRADE.minDecisions, 'usage_level', true);
    const report = buildSelfGrade({ season: '2025', week: 5, records, grades });
    expect(report.signals.find((s) => s.key === 'usage_level')!.verdict).toBe('earned_its_weight');
    expect(report.suggestions.every((s) => s.proposedRelativeChange <= 0)).toBe(true);
  });

  it('applies nothing, and shows that it applied nothing', () => {
    const { records, grades } = week(SELF_GRADE.minDecisions, 'usage_level', false);
    const report = buildSelfGrade({ season: '2025', week: 5, records, grades });
    expect(report.appliedChanges).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/nothing in this report has been applied/);
  });

  it('warns when the sample spans two model versions', () => {
    const { records, grades } = week(4, 'usage_level', false);
    records[0] = { ...records[0]!, modelVersion: '0.9.0' };
    const report = buildSelfGrade({ season: '2025', week: 5, records, grades });
    expect(report.versionsInSample).toHaveLength(2);
    expect(report.notes.join(' ')).toMatch(/spans model versions/);
  });

  it('reports source health, worst first', () => {
    const { records, grades } = week(4, 'usage_level', false);
    const degraded = records.map((r) => ({
      ...r,
      sources: [
        { key: 'vegas', state: 'stale' as const, observedAt: '2025-10-01T00:00:00Z', ageMinutes: 6000 },
        { key: 'usage', state: 'fresh' as const, observedAt: '2025-10-04T00:00:00Z', ageMinutes: 600 },
      ],
    }));
    const report = buildSelfGrade({ season: '2025', week: 5, records: degraded, grades });
    expect(report.sources[0]!.key).toBe('vegas');
    expect(report.sources[0]!.verdict).toBe('often_stale');
  });
});
