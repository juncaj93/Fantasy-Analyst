/**
 * Expected FAAB cost and waiver competition.
 *
 * The two are tested together because they constrain each other: the price
 * decides who can afford to bid, and the count of bidders is an input to the
 * price. The cases below are the ones from the brief — no history, depleted
 * budgets, four needy teams, one needy team.
 */

import { describe, expect, it } from 'vitest';
import { MIN_PRICED_HISTORY, demandOf, expectedFaabCost, quantile, weightedBidShares } from '../src/core/league/faab.ts';
import { assessCompetition, labelFor, teamNeedsFor, type TeamRoster } from '../src/core/league/competition.ts';
import { buildManagerProfiles, type ManagerProfile, type ManagerSeat } from '../src/core/league/managers.ts';
import type { LeagueTransaction } from '../src/core/league/transactions.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const BUDGETS = new Map([
  ['2026', 100],
  ['2025', 100],
]);

let counter = 0;
function bid(dollars: number, over: Partial<LeagueTransaction> = {}): LeagueTransaction {
  counter++;
  return {
    sleeperLeagueId: 'L2026',
    transactionId: `b${counter}`,
    season: '2026',
    week: 4,
    type: 'waiver',
    status: 'complete',
    createdMs: 1_700_000_000_000 + counter,
    creatorUserId: 'u1',
    rosterIds: [1],
    adds: [{ sleeperPlayerId: 'wr1', rosterId: 1 }],
    drops: [],
    waiverBid: dollars,
    budgetMoves: [],
    draftPicks: [],
    note: null,
    ...over,
  };
}

/** A plausible league: lots of $1s, a few real prices. */
const HISTORY = [1, 1, 1, 2, 2, 3, 5, 8, 12, 18, 25, 44].map((d) => bid(d));

describe('no history', () => {
  it('refuses to price a league that has never spent', () => {
    const estimate = expectedFaabCost({
      demand: { value: 0.9, needyTeams: 3, totalTeams: 12 },
      transactions: [],
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: 100,
    });

    expect(estimate.known).toBe(false);
    expect(estimate.low).toBeNull();
    expect(estimate.high).toBeNull();
    expect(estimate.display).toBe('no priced waiver history in this league yet');
  });

  it('refuses to price from a sample below the floor', () => {
    const estimate = expectedFaabCost({
      demand: { value: 0.9, needyTeams: 3, totalTeams: 12 },
      transactions: HISTORY.slice(0, MIN_PRICED_HISTORY - 1),
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: 100,
    });
    expect(estimate.known).toBe(false);
    expect(estimate.display).toContain('not enough to price against');
  });

  it('says so when the league has no budget at all', () => {
    const estimate = expectedFaabCost({
      demand: { value: 0.5, needyTeams: 1, totalTeams: 12 },
      transactions: HISTORY,
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: null,
    });
    expect(estimate.known).toBe(false);
    expect(estimate.notes.join(' ')).toContain('no FAAB budget');
  });
});

describe('the range', () => {
  it('is a range, and a better player costs more than a worse one', () => {
    const cheap = expectedFaabCost({
      demand: { value: 0.1, needyTeams: 0, totalTeams: 12 },
      transactions: HISTORY,
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: 100,
    });
    const dear = expectedFaabCost({
      demand: { value: 1, needyTeams: 6, totalTeams: 12, immediateStarter: true },
      transactions: HISTORY,
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: 100,
    });

    expect(cheap.known && dear.known).toBe(true);
    expect(cheap.display).toMatch(/^\$\d+(–\d+)? expected$/);
    expect(dear.low!).toBeGreaterThan(cheap.low!);
    expect(dear.high!).toBeGreaterThan(dear.low!);
  });

  it('names the drivers behind the number', () => {
    const estimate = expectedFaabCost({
      demand: { value: 0.8, needyTeams: 4, totalTeams: 12, immediateStarter: true },
      transactions: HISTORY,
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: 100,
    });
    expect(estimate.drivers.length).toBeGreaterThan(1);
    expect(estimate.drivers.map((d) => d.label).join(' ')).toContain('need at the position');
  });

  it('marks down a player who only has the job while somebody is hurt', () => {
    const base = { value: 0.8, needyTeams: 3, totalTeams: 12 };
    const healthy = demandOf(base);
    const beneficiary = demandOf({ ...base, injuryBeneficiary: true });
    expect(beneficiary.demand).toBeLessThan(healthy.demand);
  });
});

describe('depleted budgets', () => {
  it('cannot be outbid by money that does not exist', () => {
    const estimate = expectedFaabCost({
      demand: { value: 1, needyTeams: 6, totalTeams: 12, immediateStarter: true, scarcePosition: true },
      transactions: HISTORY,
      budgetBySeason: BUDGETS,
      currentSeason: '2026',
      budget: 100,
      // Everybody else has spent down to pocket change.
      rivalRemaining: [3, 2, 1, 0],
    });

    expect(estimate.high).toBeLessThanOrEqual(3);
    expect(estimate.notes).toContain('capped by what the other managers can still afford');
    expect(estimate.drivers.some((d) => d.label.includes('$3 left to spend'))).toBe(true);
  });
});

describe('weighting and quantiles', () => {
  it('weights this season above previous seasons', () => {
    const shares = weightedBidShares(
      [bid(50), bid(2, { season: '2025', sleeperLeagueId: 'L2025' })],
      BUDGETS,
      '2026',
    );
    const current = shares.filter((s) => s === 0.5).length;
    const previous = shares.filter((s) => s === 0.02).length;
    expect(current).toBeGreaterThan(previous);
  });

  it('interpolates the quantile rather than snapping to a bucket', () => {
    expect(quantile([0, 1], 0.5)).toBeCloseTo(0.5, 5);
    expect(quantile([], 0.5)).toBe(0);
  });
});

// ------------------------------------------------------------- competition

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

function roster(rosterId: number, positions: string[], isMine = false): TeamRoster {
  return {
    rosterId,
    userId: `u${rosterId}`,
    displayName: `Team ${rosterId}`,
    isMine,
    playerIds: positions.map((p, i) => `${rosterId}-${p}-${i}`),
  };
}

function metaFor(rosters: TeamRoster[], positions: Record<number, string[]>) {
  const meta = new Map<string, { position: string | null; unavailable?: boolean }>();
  for (const r of rosters) {
    r.playerIds.forEach((id, i) => meta.set(id, { position: positions[r.rosterId]![i]! }));
  }
  return meta;
}

function profilesWith(remaining: Record<string, number | null>): Map<string, ManagerProfile> {
  const seats: ManagerSeat[] = Object.entries(remaining).map(([userId, left], i) => ({
    sleeperLeagueId: 'L2026',
    season: '2026',
    rosterId: i + 1,
    userId,
    displayName: `Team ${i + 1}`,
    waiverBudgetUsed: left == null ? null : 100 - left,
    budget: 100,
    isMine: false,
  }));
  const built = buildManagerProfiles({ seats, transactions: [], playerMeta: new Map(), currentSeason: '2026' });
  return new Map(built.map((p) => [p.userId, p]));
}

describe('waiver competition', () => {
  it('reports low competition when nobody else needs the position', () => {
    const rosters = [roster(1, ['RB', 'RB', 'RB'], true), roster(2, ['RB', 'RB', 'RB']), roster(3, ['RB', 'RB', 'RB'])];
    const positions = { 1: ['RB', 'RB', 'RB'], 2: ['RB', 'RB', 'RB'], 3: ['RB', 'RB', 'RB'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);

    const assessment = assessCompetition({
      needs,
      profiles: profilesWith({ u2: 50, u3: 50 }),
      expectedLow: 5,
      faabLeague: true,
    });

    expect(assessment.needyTeams).toBe(0);
    expect(assessment.label).toBe('Low competition');
    expect(assessment.reasons).toContain('nobody else has a hole at the position');
  });

  it('counts one needy team as low competition', () => {
    const rosters = [roster(1, ['RB'], true), roster(2, ['WR']), roster(3, ['RB', 'RB', 'RB'])];
    const positions = { 1: ['RB'], 2: ['WR'], 3: ['RB', 'RB', 'RB'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);

    const assessment = assessCompetition({
      needs,
      profiles: profilesWith({ u2: 50, u3: 50 }),
      expectedLow: 5,
      faabLeague: true,
    });

    expect(assessment.needyTeams).toBe(1);
    expect(assessment.label).toBe('Low competition');
  });

  it('calls four needy teams high pressure, and names them', () => {
    const rosters = [
      roster(1, ['RB', 'RB'], true),
      roster(2, ['WR']),
      roster(3, ['WR']),
      roster(4, ['WR']),
      roster(5, ['WR']),
    ];
    const positions = { 1: ['RB', 'RB'], 2: ['WR'], 3: ['WR'], 4: ['WR'], 5: ['WR'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);

    const assessment = assessCompetition({
      needs,
      profiles: profilesWith({ u2: 50, u3: 50, u4: 50, u5: 50 }),
      expectedLow: 5,
      faabLeague: true,
    });

    expect(assessment.needyTeams).toBe(4);
    expect(assessment.label).toBe('High pressure');
    expect(assessment.bidders).toHaveLength(4);
    expect(assessment.bidders[0]!.reason).toContain('cannot start the position');
  });

  it('drops needy teams who cannot afford the going rate', () => {
    const rosters = [roster(1, ['RB', 'RB'], true), roster(2, ['WR']), roster(3, ['WR']), roster(4, ['WR']), roster(5, ['WR'])];
    const positions = { 1: ['RB', 'RB'], 2: ['WR'], 3: ['WR'], 4: ['WR'], 5: ['WR'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);

    const assessment = assessCompetition({
      needs,
      profiles: profilesWith({ u2: 50, u3: 1, u4: 0, u5: 2 }),
      expectedLow: 10,
      faabLeague: true,
    });

    expect(assessment.needyTeams).toBe(4);
    expect(assessment.bidders).toHaveLength(1);
    expect(assessment.label).toBe('Low competition');
    expect(assessment.reasons).toContain('3 of them cannot afford the going rate');
  });

  it('keeps a manager whose budget is unknown, rather than ruling them out', () => {
    const rosters = [roster(1, ['RB', 'RB'], true), roster(2, ['WR']), roster(3, ['WR'])];
    const positions = { 1: ['RB', 'RB'], 2: ['WR'], 3: ['WR'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);

    const assessment = assessCompetition({
      needs,
      profiles: profilesWith({ u2: null, u3: null }),
      expectedLow: 40,
      faabLeague: true,
    });

    expect(assessment.bidders).toHaveLength(2);
  });

  it('uses the brief’s exact labels', () => {
    expect(labelFor(0)).toBe('Low competition');
    expect(labelFor(1)).toBe('Low competition');
    expect(labelFor(2)).toBe('Likely 2–3 bidders');
    expect(labelFor(3)).toBe('Likely 2–3 bidders');
    expect(labelFor(4)).toBe('High pressure');
  });

  it('never counts my own team as competition', () => {
    const rosters = [roster(1, [], true), roster(2, ['RB', 'RB', 'RB'])];
    const positions = { 1: [], 2: ['RB', 'RB', 'RB'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);
    expect(needs.map((n) => n.rosterId)).toEqual([2]);
  });

  it('treats an unavailable player as not covering the slot', () => {
    const rosters = [roster(1, [], true), roster(2, ['RB', 'RB'])];
    const meta = new Map([
      ['2-RB-0', { position: 'RB', unavailable: true }],
      ['2-RB-1', { position: 'RB', unavailable: false }],
    ]);
    const needs = teamNeedsFor('RB', rosters, meta, SHAPE);
    expect(needs[0]!.healthy).toBe(1);
    expect(needs[0]!.level).toBe('urgent');
  });
});
