/**
 * Who gains when a starter is out.
 *
 * The two properties that matter: a measured answer beats an inferred one and
 * says which it is, and no answer at all is a legitimate result. The second is
 * the one worth protecting — a graph that always names somebody is a graph that
 * is guessing, and the brief asks for `unknown` instead.
 */

import { describe, expect, it } from 'vitest';
import {
  BENEFICIARY,
  buildBeneficiaryGraph,
  emergencyPivot,
  type TeammateUsage,
} from '../src/core/injury/beneficiaries.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';

function week(over: Partial<UsageWeek> & { week: number }): UsageWeek {
  return {
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: null,
    receptions: null,
    targetShare: null,
    wopr: null,
    ...over,
  };
}

function mate(
  playerId: string,
  name: string,
  position: string,
  weeks: (Partial<UsageWeek> & { week: number })[],
): TeammateUsage {
  return { playerId, name, position, weeks: weeks.map(week) };
}

describe('measured from prior absence', () => {
  /** The starter plays weeks 1–4 and misses 5 and 6. */
  const starter = mate('rb1', 'Star Back', 'RB', [
    { week: 1, carries: 18, targets: 4 },
    { week: 2, carries: 20, targets: 5 },
    { week: 3, carries: 17, targets: 3 },
    { week: 4, carries: 19, targets: 4 },
  ]);
  const backup = mate('rb2', 'Second Back', 'RB', [
    { week: 1, carries: 5, targets: 1 },
    { week: 2, carries: 4, targets: 2 },
    { week: 3, carries: 6, targets: 1 },
    { week: 4, carries: 5, targets: 2 },
    { week: 5, carries: 16, targets: 4 },
    { week: 6, carries: 15, targets: 5 },
  ]);
  const receiver = mate('wr1', 'A Receiver', 'WR', [
    { week: 1, targets: 8 },
    { week: 2, targets: 9 },
    { week: 3, targets: 7 },
    { week: 4, targets: 8 },
    { week: 5, targets: 9 },
    { week: 6, targets: 8 },
  ]);

  it('names the back who actually got the carries, with the sample behind it', () => {
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: starter, teammates: [backup, receiver] });
    expect(graph.unknown).toBe(false);
    expect(graph.beneficiaries[0]!.playerId).toBe('rb2');
    expect(graph.beneficiaries[0]!.basis).toBe('prior_absence');
    expect(graph.beneficiaries[0]!.gamesWithout).toBe(2);
    expect(graph.beneficiaries[0]!.carriesDelta).toBeGreaterThan(9);
    expect(graph.beneficiaries[0]!.display).toMatch(/expected carries \+/);
    expect(graph.notes.join(' ')).toMatch(/weeks 5, 6/);
  });

  it('leaves out a teammate whose role did not move', () => {
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: starter, teammates: [backup, receiver] });
    expect(graph.beneficiaries.map((b) => b.playerId)).not.toContain('wr1');
  });

  it('reports the opportunity actually in play', () => {
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: starter, teammates: [backup, receiver] });
    expect(graph.vacated.carries).toBeCloseTo(18.5, 1);
    expect(graph.vacated.targets).toBeCloseTo(4, 1);
  });

  it('holds a one-game sample to low confidence and says why', () => {
    const oneGame = mate('rb2', 'Second Back', 'RB', [
      { week: 1, carries: 5 },
      { week: 2, carries: 4 },
      { week: 3, carries: 6 },
      { week: 4, carries: 5 },
      { week: 5, carries: 17 },
    ]);
    const others = mate('wr1', 'A Receiver', 'WR', [
      { week: 1, targets: 8 },
      { week: 2, targets: 8 },
      { week: 3, targets: 8 },
      { week: 4, targets: 8 },
      { week: 5, targets: 8 },
    ]);
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: starter, teammates: [oneGame, others] });
    expect(graph.beneficiaries[0]!.confidence).toBe('low');
    expect(graph.notes.join(' ')).toMatch(/small sample/);
  });

  it('does not mistake the team bye for a game he missed', () => {
    // Nobody has a week 5 row: that is the bye, not an absence.
    const byeWeekBackup = mate('rb2', 'Second Back', 'RB', [
      { week: 1, carries: 5 },
      { week: 2, carries: 4 },
      { week: 3, carries: 6 },
      { week: 4, carries: 5 },
    ]);
    const byeWeekReceiver = mate('wr1', 'A Receiver', 'WR', [
      { week: 1, targets: 8 },
      { week: 2, targets: 8 },
      { week: 3, targets: 8 },
      { week: 4, targets: 8 },
    ]);
    const graph = buildBeneficiaryGraph({
      team: 'DET',
      absent: starter,
      teammates: [byeWeekBackup, byeWeekReceiver],
    });
    // No game was played without him, so this can only be an inference.
    expect(graph.beneficiaries.every((b) => b.basis === 'depth_inference')).toBe(true);
  });
});

describe('inferred from depth, and labelled as inference', () => {
  const ironMan = mate('rb1', 'Iron Back', 'RB', [
    { week: 1, carries: 18, targets: 4 },
    { week: 2, carries: 20, targets: 4 },
    { week: 3, carries: 19, targets: 4 },
  ]);
  const backup = mate('rb2', 'Second Back', 'RB', [
    { week: 1, carries: 6 },
    { week: 2, carries: 5 },
    { week: 3, carries: 7 },
  ]);
  const third = mate('rb3', 'Third Back', 'RB', [
    { week: 1, carries: 2 },
    { week: 2, carries: 3 },
    { week: 3, carries: 2 },
  ]);

  it('hands the work to the man already getting the most of it, and says it is a guess', () => {
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: ironMan, teammates: [backup, third] });
    expect(graph.beneficiaries[0]!.playerId).toBe('rb2');
    expect(graph.beneficiaries[0]!.basis).toBe('depth_inference');
    expect(graph.beneficiaries[0]!.confidence).toBe('low');
    expect(graph.beneficiaries[0]!.gamesWithout).toBe(0);
    expect(graph.beneficiaries[0]!.display).toMatch(/not measured/);
    expect(graph.notes.join(' ')).toMatch(/inference, not measurement/);
  });

  it('never hands one man the whole workload', () => {
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: ironMan, teammates: [backup, third] });
    const vacated = graph.vacated.carries!;
    expect(graph.beneficiaries[0]!.carriesDelta!).toBeLessThan(vacated);
    expect(graph.beneficiaries[0]!.carriesDelta!).toBeCloseTo(vacated * BENEFICIARY.depthInferenceShare, 1);
  });
});

describe('the refusal', () => {
  it('says unknown when there is nobody at his position and no absence to read', () => {
    const ironMan = mate('rb1', 'Iron Back', 'RB', [
      { week: 1, carries: 18 },
      { week: 2, carries: 20 },
    ]);
    const receiver = mate('wr1', 'A Receiver', 'WR', [
      { week: 1, targets: 8 },
      { week: 2, targets: 9 },
    ]);
    const graph = buildBeneficiaryGraph({ team: 'DET', absent: ironMan, teammates: [receiver] });
    expect(graph.unknown).toBe(true);
    expect(graph.beneficiaries).toEqual([]);
    expect(graph.notes.join(' ')).toMatch(/unknown/);
  });

  it('says unknown when there is no usage stored for the team at all', () => {
    const graph = buildBeneficiaryGraph({
      team: 'DET',
      absent: mate('rb1', 'Iron Back', 'RB', []),
      teammates: [],
    });
    expect(graph.unknown).toBe(true);
    expect(graph.vacated.carries).toBeNull();
  });
});

describe('emergency pivot', () => {
  const starter = mate('rb1', 'Star Back', 'RB', [
    { week: 1, carries: 18 },
    { week: 2, carries: 20 },
    { week: 3, carries: 19 },
    { week: 4, carries: 18 },
  ]);
  const backup = mate('rb2', 'Second Back', 'RB', [
    { week: 1, carries: 4 },
    { week: 2, carries: 5 },
    { week: 3, carries: 4 },
    { week: 4, carries: 5 },
    { week: 5, carries: 17 },
    { week: 6, carries: 16 },
  ]);
  const receiver = mate('wr1', 'A Receiver', 'WR', [
    { week: 1, targets: 8 },
    { week: 2, targets: 8 },
    { week: 3, targets: 8 },
    { week: 4, targets: 8 },
    { week: 5, targets: 8 },
    { week: 6, targets: 8 },
  ]);
  const graph = buildBeneficiaryGraph({ team: 'DET', absent: starter, teammates: [backup, receiver] });

  it('suggests the beneficiary only when he is actually available', () => {
    expect(emergencyPivot(graph, ['rb2'])!.playerId).toBe('rb2');
    expect(emergencyPivot(graph, ['someone-else'])).toBeNull();
  });

  it('carries the confidence of the claim it came from', () => {
    expect(emergencyPivot(graph, ['rb2'])!.confidence).toBe('medium');
  });
});
