/**
 * Waiver competition: who needs the position, and who can pay for him.
 *
 * The cases the brief singles out are four needy teams and one needy team, and
 * the case that matters most in practice is the third: needy teams who are
 * broke. Counting those as bidders is how a tool tells you to spend $30 beating
 * somebody who cannot spend $3.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPETITION_UNKNOWN,
  assessCompetition,
  levelFor,
  teamNeedsFor,
  type RosterPlayerMeta,
  type TeamRoster,
} from '../src/core/league/competition.ts';
import type { RosterBudget } from '../src/core/faab/budget.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

function roster(rosterId: number, positions: string[], isMine = false): TeamRoster {
  return {
    rosterId,
    displayName: `Team ${rosterId}`,
    isMine,
    playerIds: positions.map((p, i) => `${rosterId}-${p}-${i}`),
  };
}

function metaFor(rosters: TeamRoster[], positions: Record<number, string[]>): Map<string, RosterPlayerMeta> {
  const meta = new Map<string, RosterPlayerMeta>();
  for (const r of rosters) r.playerIds.forEach((id, i) => meta.set(id, { position: positions[r.rosterId]![i]! }));
  return meta;
}

function wallets(remaining: Record<number, number | null>): Map<number, RosterBudget> {
  return new Map(
    Object.entries(remaining).map(([rosterId, left]) => [
      Number(rosterId),
      {
        rosterId: Number(rosterId),
        ownerName: `Team ${rosterId}`,
        isMine: false,
        remaining: left,
        spent: left == null ? null : 100 - left,
        share: left == null ? null : left / 100,
      },
    ]),
  );
}

describe('needs are counted against the league’s own slots', () => {
  it('never counts my own team as competition', () => {
    const rosters = [roster(1, [], true), roster(2, ['RB', 'RB', 'RB'])];
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, { 1: [], 2: ['RB', 'RB', 'RB'] }), SHAPE);
    expect(needs.map((n) => n.rosterId)).toEqual([2]);
  });

  it('separates cannot-start from could-use', () => {
    const rosters = [roster(1, [], true), roster(2, ['RB']), roster(3, ['RB', 'RB']), roster(4, ['RB', 'RB', 'RB'])];
    const needs = teamNeedsFor(
      'RB',
      rosters,
      metaFor(rosters, { 1: [], 2: ['RB'], 3: ['RB', 'RB'], 4: ['RB', 'RB', 'RB'] }),
      SHAPE,
    );
    expect(needs.map((n) => n.level)).toEqual(['urgent', 'thin', 'covered']);
  });

  it('treats an unavailable player as not covering the slot', () => {
    const rosters = [roster(1, [], true), roster(2, ['RB', 'RB'])];
    const meta = new Map<string, RosterPlayerMeta>([
      ['2-RB-0', { position: 'RB', unavailable: true }],
      ['2-RB-1', { position: 'RB', unavailable: false }],
    ]);
    const needs = teamNeedsFor('RB', rosters, meta, SHAPE);
    expect(needs[0]!.healthy).toBe(1);
    expect(needs[0]!.level).toBe('urgent');
  });
});

describe('the count that feeds the price model', () => {
  const fourNeedy = () => {
    const rosters = [
      roster(1, ['RB', 'RB'], true),
      roster(2, ['WR']),
      roster(3, ['WR']),
      roster(4, ['WR']),
      roster(5, ['WR']),
    ];
    return teamNeedsFor(
      'RB',
      rosters,
      metaFor(rosters, { 1: ['RB', 'RB'], 2: ['WR'], 3: ['WR'], 4: ['WR'], 5: ['WR'] }),
      SHAPE,
    );
  };

  it('calls four funded needy teams high pressure', () => {
    const assessment = assessCompetition({
      needs: fourNeedy(),
      budgets: wallets({ 2: 50, 3: 50, 4: 50, 5: 50 }),
      expectedLow: 5,
      bidding: true,
    });
    expect(assessment.needyTeams).toBe(4);
    expect(assessment.bidders).toHaveLength(4);
    expect(assessment.level).toBe('high');
    expect(assessment.label).toBe('High pressure');
  });

  it('drops needy teams who cannot afford the going rate, and says how many', () => {
    const assessment = assessCompetition({
      needs: fourNeedy(),
      budgets: wallets({ 2: 50, 3: 1, 4: 0, 5: 2 }),
      expectedLow: 10,
      bidding: true,
    });
    expect(assessment.needyTeams).toBe(4);
    expect(assessment.bidders).toHaveLength(1);
    expect(assessment.level).toBe('low');
    expect(assessment.detail).toContain('3 cannot afford');
  });

  it('excludes nobody for money in a priority league', () => {
    const assessment = assessCompetition({
      needs: fourNeedy(),
      budgets: wallets({ 2: 0, 3: 0, 4: 0, 5: 0 }),
      expectedLow: 10,
      bidding: false,
    });
    expect(assessment.bidders).toHaveLength(4);
  });

  it('keeps a manager whose budget is unknown rather than ruling them out', () => {
    const assessment = assessCompetition({
      needs: fourNeedy(),
      budgets: wallets({ 2: null, 3: null, 4: null, 5: null }),
      expectedLow: 40,
      bidding: true,
    });
    expect(assessment.bidders).toHaveLength(4);
  });

  it('reports one needy team as low competition', () => {
    const rosters = [roster(1, ['RB'], true), roster(2, ['WR']), roster(3, ['RB', 'RB', 'RB'])];
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, { 1: ['RB'], 2: ['WR'], 3: ['RB', 'RB', 'RB'] }), SHAPE);
    const assessment = assessCompetition({
      needs,
      budgets: wallets({ 2: 50, 3: 50 }),
      expectedLow: 5,
      bidding: true,
    });
    expect(assessment.needyTeams).toBe(1);
    expect(assessment.level).toBe('low');
  });

  it('says nobody wants him when every rival is covered', () => {
    const rosters = [roster(1, ['RB'], true), roster(2, ['RB', 'RB', 'RB'])];
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, { 1: ['RB'], 2: ['RB', 'RB', 'RB'] }), SHAPE);
    const assessment = assessCompetition({ needs, budgets: wallets({ 2: 50 }), expectedLow: 5, bidding: true });
    expect(assessment.bidders).toEqual([]);
    expect(assessment.label).toBe('Nobody else needs him');
  });
});

describe('the level and the label always agree', () => {
  it('maps bidder counts to the board’s own vocabulary', () => {
    expect(levelFor(0).level).toBe('low');
    expect(levelFor(1).level).toBe('low');
    expect(levelFor(2).level).toBe('medium');
    expect(levelFor(3).level).toBe('medium');
    expect(levelFor(4).level).toBe('high');
    expect(levelFor(2).label).toBe('Likely 2–3 bidders');
  });

  it('has an unknown that is genuinely unknown, not a quiet zero', () => {
    expect(COMPETITION_UNKNOWN.level).toBe('unknown');
    expect(COMPETITION_UNKNOWN.bidders).toEqual([]);
  });
});
