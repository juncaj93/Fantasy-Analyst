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

  it('calls four funded needy teams high demand', () => {
    const assessment = assessCompetition({
      needs: fourNeedy(),
      budgets: wallets({ 2: 50, 3: 50, 4: 50, 5: 50 }),
      expectedLow: 5,
      bidding: true,
    });
    expect(assessment.needyTeams).toBe(4);
    expect(assessment.bidders).toHaveLength(4);
    expect(assessment.level).toBe('high');
    expect(assessment.label).toBe('High demand');
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

/*
 * 1 October 2026, the owner: "If a team has 2 RB slots and 1 of the RB slots
 * has a player projected to score less than 8 pts then they need an RB. Same
 * with WR and TE. QB ... 14, and defense ... 6." The live board had said
 * `0 of 9 teams need RB` because every rival had two healthy backs.
 */
describe('a weak starter is a need', () => {
  const rosters = [
    roster(1, [], true),
    roster(2, ['RB', 'RB', 'RB']),
    roster(3, ['RB', 'RB']),
    roster(4, ['RB', 'RB', 'RB']),
  ];
  const meta = metaFor(rosters, { 1: [], 2: ['RB', 'RB', 'RB'], 3: ['RB', 'RB'], 4: ['RB', 'RB', 'RB'] });
  const projections = new Map([
    // Team 2: two strong backs and a weak third. Covered: the third does not start.
    ['2-RB-0', 15],
    ['2-RB-1', 11],
    ['2-RB-2', 4],
    // Team 3: one back under 8. Needs one.
    ['3-RB-0', 14],
    ['3-RB-1', 6.5],
    // Team 4: second-best back has no projection this week (a bye). Needs one.
    ['4-RB-0', 12],
  ]);

  it('reads each team’s best starters by projection against the 8-point bar', () => {
    const needs = teamNeedsFor('RB', rosters, meta, SHAPE, projections);
    expect(needs.map((n) => [n.rosterId, n.level])).toEqual([
      [2, 'covered'],
      [3, 'thin'],
      [4, 'thin'],
    ]);
  });

  it('still calls an empty slot urgent', () => {
    const short = [roster(1, [], true), roster(5, ['RB'])];
    const needs = teamNeedsFor('RB', short, metaFor(short, { 1: [], 5: ['RB'] }), SHAPE, new Map([['5-RB-0', 20]]));
    expect(needs[0]!.level).toBe('urgent');
  });

  it('holds a quarterback to 14 points', () => {
    const qbs = [roster(1, [], true), roster(6, ['QB']), roster(7, ['QB'])];
    const needs = teamNeedsFor(
      'QB',
      qbs,
      metaFor(qbs, { 1: [], 6: ['QB'], 7: ['QB'] }),
      SHAPE,
      new Map([
        ['6-QB-0', 13.5],
        ['7-QB-0', 19],
      ]),
    );
    expect(needs.map((n) => n.level)).toEqual(['thin', 'covered']);
  });

  it('counts bodies, as before, when no projections are stored', () => {
    const needs = teamNeedsFor('RB', rosters, meta, SHAPE, new Map());
    expect(needs.map((n) => n.level)).toEqual(['covered', 'thin', 'covered']);
  });

  it('puts the count in the sentence the card prints', () => {
    const needs = teamNeedsFor('RB', rosters, meta, SHAPE, projections);
    const assessed = assessCompetition({ needs, budgets: wallets({}), expectedLow: null, bidding: true, position: 'RB' });
    expect(assessed.needyTeams).toBe(2);
    expect(assessed.detail).toBe('2 of 3 teams need RB');
  });
});
