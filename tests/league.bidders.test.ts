/**
 * Named waiver bidders: who bids, roughly how much, and when to say nothing.
 *
 * The cases are the brief's own list. The two that matter most are negative:
 * a tendency is never fabricated from a thin sample, and the named pass never
 * moves the three numbers that price the bid — `expected`, `recommended` and
 * `doNotExceed` belong to `core/faab/strategy.ts` and this decomposes them.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_TENDENCY_EFFECT,
  MIN_BIDS_FOR_TENDENCY,
  namedBidders,
  summarize,
  tendencyFor,
} from '../src/core/league/bidders.ts';
import { assessCompetition, teamNeedsFor, type TeamRoster } from '../src/core/league/competition.ts';
import type { BidObservation, PriceSummary } from '../src/core/faab/bids.ts';
import type { LeagueBudgetRule, RosterBudget } from '../src/core/faab/budget.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);
const FAAB: LeagueBudgetRule = { total: 100, usesFaab: true, provenance: 'league settings' };

const PRICES: PriceSummary = {
  sample: 12,
  median: 10,
  low: 6,
  high: 20,
  max: 44,
  highestLosing: 18,
  losingBidsComplete: false,
  confidence: 'medium',
};

let seq = 0;
function bid(rosterId: number, amount: number, outcome: 'won' | 'lost' = 'won'): BidObservation {
  seq++;
  return { transactionId: `t${seq}`, week: 3, rosterId, playerId: `p${seq}`, amount, outcome };
}

function roster(rosterId: number, positions: string[], isMine = false): TeamRoster {
  return {
    rosterId,
    displayName: ['', 'Me', 'Joe', 'Ryan', 'Dave', 'Sam'][rosterId] ?? `Team ${rosterId}`,
    isMine,
    playerIds: positions.map((p, i) => `${rosterId}-${p}-${i}`),
  };
}

function metaFor(rosters: TeamRoster[], positions: Record<number, string[]>) {
  const meta = new Map<string, { position: string | null; unavailable?: boolean }>();
  for (const r of rosters) r.playerIds.forEach((id, i) => meta.set(id, { position: positions[r.rosterId]![i]! }));
  return meta;
}

function wallets(remaining: Record<number, number | null>): Map<number, RosterBudget> {
  return new Map(
    Object.entries(remaining).map(([rosterId, left]) => [
      Number(rosterId),
      {
        rosterId: Number(rosterId),
        ownerName: null,
        isMine: false,
        remaining: left,
        spent: left == null ? null : 100 - left,
        share: left == null ? null : left / 100,
      },
    ]),
  );
}

/** A league where Me has one RB, Joe and Ryan have none, Dave is stacked. */
function rbScenario(remaining: Record<number, number | null> = { 2: 41, 3: 30, 4: 50 }) {
  const rosters = [roster(1, ['RB'], true), roster(2, ['WR']), roster(3, ['WR']), roster(4, ['RB', 'RB', 'RB'])];
  const positions = { 1: ['RB'], 2: ['WR'], 3: ['WR'], 4: ['RB', 'RB', 'RB'] };
  const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);
  const competition = assessCompetition({ needs, budgets: wallets(remaining), expectedLow: PRICES.low, bidding: true });
  return { needs, competition };
}

describe('a manager’s own tendency', () => {
  it('is not claimed below the threshold', () => {
    const observations = Array.from({ length: MIN_BIDS_FOR_TENDENCY - 1 }, () => bid(2, 40));
    const tendency = tendencyFor(2, observations, 100, 0.1);
    expect(tendency.confident).toBe(false);
    expect(tendency.medianShare).toBeNull();
    expect(tendency.relative).toBeNull();
  });

  it('is the median rather than the mean, so one splash is not a habit', () => {
    const observations = [bid(2, 1), bid(2, 1), bid(2, 1), bid(2, 60)];
    const tendency = tendencyFor(2, observations, 100, 0.1);
    expect(tendency.confident).toBe(true);
    // Median of 1,1,1,60 is 1 — the mean would have said ~16.
    expect(tendency.medianShare).toBeCloseTo(0.01, 3);
  });

  it('is bounded however extreme the record', () => {
    const observations = Array.from({ length: 6 }, () => bid(2, 95));
    const high = tendencyFor(2, observations, 100, 0.01);
    expect(high.relative).toBeCloseTo(1 + MAX_TENDENCY_EFFECT, 5);

    const cheap = tendencyFor(2, Array.from({ length: 6 }, () => bid(2, 1)), 100, 0.5);
    expect(cheap.relative).toBeCloseTo(1 - MAX_TENDENCY_EFFECT, 5);
  });

  it('says nothing when the league has no budget to measure against', () => {
    const observations = Array.from({ length: 6 }, () => bid(2, 20));
    expect(tendencyFor(2, observations, null, 0.1).confident).toBe(false);
  });
});

describe('naming the rivals', () => {
  it('names a known rival with an amount, a wallet and a reason', () => {
    const { needs, competition } = rbScenario();
    const observations = Array.from({ length: 5 }, () => bid(2, 20));

    const intel = namedBidders({ competition, needs, observations, prices: PRICES, rule: FAAB, position: 'RB' });

    expect(intel.namesShown).toBe(true);
    const joe = intel.named.find((b) => b.displayName === 'Joe')!;
    expect(joe.estimate).not.toBeNull();
    expect(joe.remaining).toBe(41);
    expect(joe.needReason).toBe('needs RB1');
    expect(joe.basis).toBe('manager_history');
    expect(joe.display).toContain('Joe');
    expect(joe.display).toContain('$41 left');
  });

  it('handles multiple rivals, ranked with the urgent ones first', () => {
    const { needs, competition } = rbScenario();
    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: FAAB, position: 'RB' });
    expect(intel.named.length).toBeGreaterThanOrEqual(2);
    expect(intel.named.every((b) => b.need === 'urgent')).toBe(true);
  });

  it('falls back to the league range when a rival has no history of his own', () => {
    const { needs, competition } = rbScenario();
    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: FAAB, position: 'RB' });
    const joe = intel.named.find((b) => b.displayName === 'Joe')!;
    expect(joe.basis).toBe('league_price');
    expect(joe.tendency).toBeNull();
    expect(joe.caveat).toContain('league');
    // Widened rather than shifted: it still straddles the league range.
    expect(joe.estimate!.low).toBeLessThanOrEqual(PRICES.low!);
    expect(joe.estimate!.high).toBeGreaterThanOrEqual(PRICES.high!);
  });

  it('withholds the amount entirely when the league has never priced anything', () => {
    const { needs, competition } = rbScenario();
    const unpriced: PriceSummary = { ...PRICES, sample: 0, median: null, low: null, high: null, max: null };
    const intel = namedBidders({ competition, needs, observations: [], prices: unpriced, rule: FAAB, position: 'RB' });

    expect(intel.namesShown).toBe(true);
    expect(intel.named.every((b) => b.estimate === null)).toBe(true);
    expect(intel.named.every((b) => b.basis === 'none')).toBe(true);
    expect(intel.notes.join(' ')).toContain('withheld rather than estimated');
  });

  it('caps a rival’s estimate at the money he actually has', () => {
    const { needs, competition } = rbScenario({ 2: 4, 3: 30, 4: 50 });
    const observations = Array.from({ length: 5 }, () => bid(2, 40));
    const intel = namedBidders({ competition, needs, observations, prices: PRICES, rule: FAAB, position: 'RB' });

    const joe = intel.named.find((b) => b.displayName === 'Joe');
    // He is either excluded for affordability or capped — never estimated above
    // a wallet he does not have.
    if (joe?.estimate) {
      expect(joe.estimate.high).toBeLessThanOrEqual(4);
      expect(joe.caveat).toContain('capped');
    }
  });

  it('names nobody when the need disappears', () => {
    const rosters = [roster(1, ['RB'], true), roster(2, ['RB', 'RB', 'RB']), roster(3, ['RB', 'RB', 'RB'])];
    const positions = { 1: ['RB'], 2: ['RB', 'RB', 'RB'], 3: ['RB', 'RB', 'RB'] };
    const needs = teamNeedsFor('RB', rosters, metaFor(rosters, positions), SHAPE);
    const competition = assessCompetition({
      needs,
      budgets: wallets({ 2: 50, 3: 50 }),
      expectedLow: PRICES.low,
      bidding: true,
    });

    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: FAAB, position: 'RB' });
    expect(intel.namesShown).toBe(false);
    expect(intel.named).toEqual([]);
    expect(intel.notes.join(' ')).toContain('no rival to name');
  });

  it('withholds names when no rival can be told apart from any other', () => {
    const { needs, competition } = rbScenario({ 2: null, 3: null, 4: null });
    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: FAAB, position: 'RB' });

    expect(intel.namesShown).toBe(false);
    expect(intel.notes.join(' ')).toContain('cannot be told apart');
  });

  it('names who wants him, without amounts, in a priority league', () => {
    const { needs, competition } = rbScenario();
    const priority: LeagueBudgetRule = { total: null, usesFaab: false, provenance: 'rolling priority' };
    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: priority, position: 'RB' });

    expect(intel.namesShown).toBe(true);
    expect(intel.named.every((b) => b.estimate === null)).toBe(true);
    expect(intel.notes.join(' ')).toContain('does not bid');
  });

  it('counts a failed claim as evidence about the bidder', () => {
    const losing = Array.from({ length: 5 }, () => bid(2, 30, 'lost'));
    const tendency = tendencyFor(2, losing, 100, 0.1);
    expect(tendency.confident).toBe(true);
    expect(tendency.sample).toBe(5);
  });
});

describe('the summary never contradicts the aggregate', () => {
  it('reports the same count the competition label was built from', () => {
    const { needs, competition } = rbScenario();
    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: FAAB, position: 'RB' });

    expect(intel.summary).toContain(`${competition.bidders.length} likely`);
    expect(intel.named.length).toBeLessThanOrEqual(competition.bidders.length);
  });

  it('names two and counts the rest', () => {
    const named = ['Joe', 'Ryan', 'Dave'].map((displayName, i) => ({
      rosterId: i + 2,
      displayName,
      need: 'urgent' as const,
      needReason: 'needs RB1',
      remaining: 40,
      estimate: { low: 6, high: 20 },
      basis: 'league_price' as const,
      confidence: 'medium' as const,
      tendency: null,
      caveat: null,
      display: displayName,
    }));
    const line = summarize(named, {
      level: 'medium',
      label: 'Likely 2–3 bidders',
      detail: null,
      needyTeams: 3,
      bidders: named.map((n) => ({ rosterId: n.rosterId, displayName: n.displayName, need: n.need, remaining: 40 })),
    });
    expect(line).toBe('3 likely bidders · Joe, Ryan +1');
  });

  it('says nothing at all when nobody is bidding', () => {
    expect(
      summarize([], { level: 'low', label: 'Nobody else needs him', detail: null, needyTeams: 0, bidders: [] }),
    ).toBeNull();
  });
});

/*
 * A guard on the guard.
 *
 * The browser suite asserts that no control offers to transact, and that check
 * was loosened from a substring scan to whole words so that describing a bid
 * stops reading as offering one. Loosening a safety check deserves a proof that
 * it still catches what it exists for, and the browser cannot run one — so the
 * pattern's semantics are pinned here instead.
 */
describe('the transaction-control check still catches controls', () => {
  const forbidden = ['add', 'drop', 'claim', 'bid', 'submit'];
  const trips = (text: string) => forbidden.some((word) => new RegExp(`\\b${word}\\b`).test(text.toLowerCase()));

  it('fails any control that offers the action', () => {
    for (const label of ['Add', 'Drop player', 'Place bid', 'Submit claim', 'Claim', 'Bid $20', 'ADD']) {
      expect(trips(label), label).toBe(true);
    }
  });

  it('passes text that merely describes competition', () => {
    for (const label of [
      'Likely 2–3 bidders',
      '3 likely bidders · Joe, Ryan +1',
      'Joe · likely $17–22 · $41 left · needs RB2',
      'High pressure',
    ]) {
      expect(trips(label), label).toBe(false);
    }
  });
});
