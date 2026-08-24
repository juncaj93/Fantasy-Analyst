/**
 * What the ledger is allowed to conclude, and what it is allowed to change.
 *
 * The derivations are pure, so they are tested without a database. Three
 * boundaries are the point of the file, and each one is a rule the brief states
 * as a prohibition rather than a preference:
 *
 *   - a transaction tendency is measured **against the room** and shrunk toward
 *     it, so an aggressive league does not make all twelve of its managers look
 *     individually aggressive;
 *   - trade history produces a **label and a tiebreak**, never an acceptance
 *     probability and never enough weight to rescue a poor bilateral fit;
 *   - waiver history moves **cost context, pressure and urgency** inside a
 *     documented cap, and cannot touch what a player is worth.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RELATIVE,
  buildLeagueTransactionBaseline,
  buildTransactionProfiles,
  neutralTransactionProfile,
  timingWindows,
  type TransactionProfileInput,
} from '../src/core/managers/transactionProfile.ts';
import {
  PLAUSIBILITY_LABELS,
  TRADE_TENDENCY,
  buildLeagueTradeBaseline,
  buildTradeTendencies,
  partnerContext,
  plausibilityFor,
} from '../src/core/managers/tradeTendencies.ts';
import {
  MAX_MANAGER_COST_EFFECT,
  MAX_MANAGER_URGENCY_EFFECT,
  MIN_RIVALS_WITH_HISTORY,
  NEUTRAL_PRESSURE,
  bidderTendencyFrom,
  waiverManagerPressure,
} from '../src/core/waivers/managerPressure.ts';
import type { LedgerTransaction } from '../src/core/managers/ledger.ts';
import type { CompetitionAssessment } from '../src/core/league/competition.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';

const POSITIONS: Record<string, string> = {
  rb1: 'RB',
  rb2: 'RB',
  rb3: 'RB',
  wr1: 'WR',
  wr2: 'WR',
  qb1: 'QB',
  te1: 'TE',
};
const positionOf = (id: string): string | null => POSITIONS[id] ?? null;

function txn(over: Partial<LedgerTransaction> & { transactionId: string }): LedgerTransaction {
  return {
    season: '2025',
    week: 4,
    type: 'waiver',
    status: 'complete',
    createdAtMs: null,
    userIds: [],
    rosterIds: [],
    creatorUserId: null,
    addsByUser: new Map(),
    dropsByUser: new Map(),
    waiverBid: null,
    faabTraded: 0,
    draftPicksMoved: 0,
    ...over,
  };
}

/** A claim by one manager, at one price, for one player. */
function claim(id: string, userId: string, bid: number, playerId = 'rb1', week = 4): LedgerTransaction {
  return txn({
    transactionId: id,
    userIds: [userId],
    week,
    waiverBid: bid,
    addsByUser: new Map([[userId, [playerId]]]),
  });
}

function inputFor(transactions: LedgerTransaction[], over: Partial<TransactionProfileInput> = {}): TransactionProfileInput {
  const users = new Set(transactions.flatMap((t) => t.userIds));
  return {
    transactions,
    weeksBySeason: new Map([['2025', 14]]),
    seasonsByUser: new Map([...users].map((u) => [u, ['2025']])),
    budgetTotal: 100,
    positionOf,
    finalWeek: 14,
    ...over,
  };
}

describe('transaction tendencies are measured against the room', () => {
  it('shrinks a thin sample almost all the way back to the league', () => {
    const busy = Array.from({ length: 40 }, (_, i) => claim(`b${i}`, 'busy', 10, 'rb1', (i % 14) + 1));
    const quiet = [claim('q1', 'quiet', 40)];
    const input = inputFor([...busy, ...quiet]);
    const profiles = buildTransactionProfiles(input);

    const thin = profiles.get('quiet')!;
    const thick = profiles.get('busy')!;

    // One $40 claim is not a habit: it is dragged back toward the room's $10.
    expect(thin.usable).toBe(false);
    expect(thin.medianBidShare!).toBeLessThan(0.4);
    // And a manager with forty claims is allowed to be himself.
    expect(thick.usable).toBe(true);
    /*
     * The *spending* confidence is the one that separates them. Both managers
     * were watched for the same fourteen weeks, so their rate confidence is
     * identical and correctly so — a rate measured over fourteen weeks is well
     * measured whether the answer is forty claims or one. What differs is how
     * much is known about how each of them *bids*.
     */
    expect(thick.spendConfidence).toBeGreaterThan(thin.spendConfidence);
    expect(thick.confidence).toBe(thin.confidence);
  });

  it('does not let an aggressive room make everybody look aggressive', () => {
    // A whole league that bids big. Nobody in it is above their own room.
    const rich = ['a', 'b', 'c'].flatMap((user) =>
      Array.from({ length: 12 }, (_, i) => claim(`${user}${i}`, user, 45, 'rb1', (i % 14) + 1)),
    );
    const profiles = buildTransactionProfiles(inputFor(rich));
    for (const profile of profiles.values()) {
      expect(profile.spendRelative).toBeCloseTo(1, 1);
      expect(Math.abs((profile.spendRelative ?? 1) - 1)).toBeLessThanOrEqual(MAX_RELATIVE);
    }
  });

  it('separates the manager who bids big from the one who does not, in the same room', () => {
    /*
     * Three managers, so the room has a middle. A two-manager room is bimodal
     * and its median sits between the two habits, which makes "twice the room's
     * median" a threshold neither of them can clear — a property of the fixture
     * rather than of the model, and the reason this one has a third manager.
     */
    const big = Array.from({ length: 14 }, (_, i) => claim(`big${i}`, 'big', 40, 'rb1', (i % 14) + 1));
    const mid = Array.from({ length: 14 }, (_, i) => claim(`mid${i}`, 'mid', 10, 'rb1', (i % 14) + 1));
    const small = Array.from({ length: 14 }, (_, i) => claim(`sm${i}`, 'small', 2, 'rb1', (i % 14) + 1));
    const profiles = buildTransactionProfiles(inputFor([...big, ...mid, ...small]));

    expect(profiles.get('big')!.spendRelative!).toBeGreaterThan(profiles.get('small')!.spendRelative!);
    expect(profiles.get('big')!.bigBidRate!).toBeGreaterThan(0);
    // Bounded either way, however extreme the difference.
    for (const profile of profiles.values()) {
      expect(profile.spendRelative!).toBeGreaterThanOrEqual(1 - MAX_RELATIVE);
      expect(profile.spendRelative!).toBeLessThanOrEqual(1 + MAX_RELATIVE);
    }
  });

  it('withholds a position claim that rests on one or two adds', () => {
    const mostly = Array.from({ length: 14 }, (_, i) => claim(`m${i}`, 'chaser', 5, 'wr1', (i % 14) + 1));
    const twoBacks = [claim('r1', 'chaser', 5, 'rb1', 2), claim('r2', 'chaser', 5, 'rb2', 3)];
    const profiles = buildTransactionProfiles(inputFor([...mostly, ...twoBacks]));
    const rb = profiles.get('chaser')!.byPosition.find((p) => p.position === 'RB');
    expect(rb?.adds).toBe(2);
    // Two adds is not "he chases running backs".
    expect(rb?.relative).toBeNull();
  });

  it('says nothing at all about a manager with no history', () => {
    const neutral = neutralTransactionProfile('nobody');
    expect(neutral.usable).toBe(false);
    expect(neutral.spendRelative).toBeNull();
    expect(neutral.activityRelative).toBe(1);
  });

  it('reports no timing at all when nothing carries a timestamp', () => {
    expect(timingWindows([claim('a', 'x', 1)])).toEqual([]);
    const stamped = timingWindows([
      { ...claim('a', 'x', 1), createdAtMs: Date.UTC(2025, 9, 8) },
      { ...claim('b', 'x', 1), createdAtMs: Date.UTC(2025, 9, 12) },
    ]);
    expect(stamped.reduce((sum, w) => sum + w.share, 0)).toBeCloseTo(1, 5);
  });

  it('divides a newcomer by his own weeks, not by the whole ledger', () => {
    const input = inputFor(
      [claim('a', 'new', 5, 'rb1', 1), claim('b', 'new', 5, 'rb2', 2), claim('c', 'new', 5, 'wr1', 3)],
      {
        weeksBySeason: new Map([
          ['2024', 18],
          ['2025', 4],
        ]),
        seasonsByUser: new Map([['new', ['2025']]]),
      },
    );
    // Four weeks, three claims — not twenty-two weeks and three claims.
    expect(buildTransactionProfiles(input).get('new')!.activeWeeks).toBe(4);
  });

  it('does not price a league that publishes no bid', () => {
    const noFaab = [claim('a', 'x', 0), claim('b', 'y', 0)].map((t) => ({ ...t, waiverBid: null }));
    const baseline = buildLeagueTransactionBaseline(inputFor(noFaab, { budgetTotal: null }));
    expect(baseline.usesFaab).toBe(false);
    expect(baseline.medianBidShare).toBeNull();
    const profiles = buildTransactionProfiles(inputFor(noFaab, { budgetTotal: null }));
    for (const profile of profiles.values()) expect(profile.spendRelative).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function trade(id: string, users: string[], over: Partial<LedgerTransaction> = {}): LedgerTransaction {
  return txn({ transactionId: id, type: 'trade', userIds: users, ...over });
}

describe('trade tendencies label rather than predict', () => {
  const dealer = Array.from({ length: 8 }, (_, i) =>
    trade(`t${i}`, ['dealer', i % 2 === 0 ? 'partner' : 'other'], {
      season: i < 4 ? '2024' : '2025',
      week: 5 + i,
      addsByUser: new Map([['dealer', ['rb1']], [i % 2 === 0 ? 'partner' : 'other', ['wr1', 'wr2']]]),
      dropsByUser: new Map([['dealer', ['wr1', 'wr2']], [i % 2 === 0 ? 'partner' : 'other', ['rb1']]]),
    }),
  );

  const input = {
    transactions: dealer,
    seasonsByUser: new Map([
      ['dealer', ['2024', '2025']],
      ['partner', ['2024', '2025']],
      ['other', ['2024', '2025']],
    ]),
    positionOf,
    latestSeason: '2025',
  };

  it('never produces an acceptance probability, only a four-valued label', () => {
    const tendencies = buildTradeTendencies(input).get('dealer')!;
    const context = partnerContext({ tendencies, askingUserId: 'partner', wantPosition: 'WR' });

    expect(Object.keys(PLAUSIBILITY_LABELS)).toContain(context.plausibility);
    expect(context.label).toBe(PLAUSIBILITY_LABELS[context.plausibility]);
    // No probability-shaped field exists to be misread as one.
    expect(Object.keys(context)).not.toContain('acceptanceProbability');
    expect(Object.keys(context)).not.toContain('probability');
  });

  it('bounds the ordering weight far below anything that could rescue a bad fit', () => {
    const tendencies = buildTradeTendencies(input).get('dealer')!;
    const best = partnerContext({ tendencies, askingUserId: 'partner', wantPosition: 'WR' });
    expect(Math.abs(best.orderingWeight)).toBeLessThanOrEqual(TRADE_TENDENCY.maxOrderingWeight);
    expect(TRADE_TENDENCY.maxOrderingWeight).toBeLessThanOrEqual(0.05);
  });

  it('tells a rare trader from a manager nobody has measured', () => {
    // Four seasons in the league and no completed trade: that is a finding.
    expect(plausibilityFor(0, 4)).toBe('rare_trader');
    // First season and no completed trade: that is not.
    expect(plausibilityFor(0, 1)).toBe('thin_history');
    expect(plausibilityFor(0, 0)).toBe('thin_history');
  });

  it('says nothing and weighs nothing for a manager with no trade history', () => {
    const context = partnerContext({ tendencies: null, seasonsObserved: 1 });
    expect(context.orderingWeight).toBe(0);
    expect(context.suggestedShape).toBe('unknown');
    expect(context.explanation).toBeNull();
  });

  it('reads the shape and the repeat partner out of the counts', () => {
    const tendencies = buildTradeTendencies(input).get('dealer')!;
    expect(tendencies.sample).toBe(8);
    expect(tendencies.typicalShape).toBe('depth_for_starter');
    expect(tendencies.repeatPartners.map((p) => p.userId)).toContain('partner');
    expect(tendencies.acquires).toContain('RB');
    expect(tendencies.sends).toContain('WR');

    const context = partnerContext({ tendencies, askingUserId: 'partner', wantPosition: 'WR' });
    expect(context.hasTradedWithYou).toBe(true);
    expect(context.explanation).toMatch(/has dealt with you before/);
  });

  it('never describes a manager in anything but neutral terms', () => {
    const tendencies = buildTradeTendencies(input).get('dealer')!;
    const context = partnerContext({ tendencies, wantPosition: 'RB' });
    const prose = [context.label, context.explanation ?? '', ...tendencies.notes].join(' ').toLowerCase();
    for (const banned of ['taco', 'sucker', 'fleece', 'bad ', 'irrational', 'stupid', 'easy mark']) {
      expect(prose).not.toContain(banned);
    }
  });

  it('describes the room as well as the manager', () => {
    const baseline = buildLeagueTradeBaseline(input);
    expect(baseline.trades).toBe(8);
    expect(baseline.traders).toBe(3);
    expect(baseline.medianWeek).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

function competitionWith(rosterIds: number[]): CompetitionAssessment {
  return {
    level: 'medium',
    label: 'Likely 2–3 bidders',
    detail: null,
    needyTeams: rosterIds.length,
    bidders: rosterIds.map((rosterId) => ({
      rosterId,
      displayName: `Roster ${rosterId}`,
      need: 'urgent' as const,
      remaining: 60,
    })),
  };
}

function profileFor(overrides: Partial<ReturnType<typeof neutralTransactionProfile>>) {
  return { ...neutralTransactionProfile('u'), usable: true, confidence: 0.7, ...overrides };
}

const PRICES: PriceSummary = {
  sample: 20,
  median: 12,
  low: 6,
  high: 22,
  max: 41,
  highestLosing: 9,
  losingBidsComplete: false,
  confidence: 'high',
};

const BASELINE = {
  seasons: ['2025'],
  managers: 12,
  weeksRead: 14,
  claimsPerWeek: 0.5,
  addsPerWeek: 0.5,
  churnPerWeek: 1,
  usesFaab: true,
  medianBidShare: 0.12,
  bidSample: 40,
  positionShare: [{ position: 'RB', share: 0.4 }],
  sample: 200,
};

describe('waiver pressure is bounded, and cannot touch player value', () => {
  it('says nothing when too few rivals have any history', () => {
    const pressure = waiverManagerPressure({
      competition: competitionWith([2, 3]),
      profilesByRoster: new Map([[2, profileFor({})]]),
      baseline: BASELINE,
      prices: PRICES,
      position: 'RB',
      week: 5,
      finalWeek: 14,
    });
    expect(pressure.contested).toBe('unknown');
    expect(pressure.costFactor).toBe(1);
    expect(pressure.rivalsWithHistory).toBeLessThan(MIN_RIVALS_WITH_HISTORY);
  });

  it('keeps the cost factor inside its documented cap however extreme the room', () => {
    const extreme = new Map([
      [2, profileFor({ spendRelative: 99, confidence: 1, byPosition: [{ position: 'RB', adds: 20, claims: 20, medianBidShare: 0.9, relative: 99 }] })],
      [3, profileFor({ spendRelative: 99, confidence: 1, byPosition: [{ position: 'RB', adds: 20, claims: 20, medianBidShare: 0.9, relative: 99 }] })],
      [4, profileFor({ spendRelative: 99, confidence: 1, byPosition: [{ position: 'RB', adds: 20, claims: 20, medianBidShare: 0.9, relative: 99 }] })],
    ]);
    const pressure = waiverManagerPressure({
      competition: competitionWith([2, 3, 4]),
      profilesByRoster: extreme,
      baseline: BASELINE,
      prices: PRICES,
      position: 'RB',
      week: 5,
      finalWeek: 14,
    });

    expect(pressure.costFactor).toBeLessThanOrEqual(1 + MAX_MANAGER_COST_EFFECT);
    expect(pressure.urgencyDelta).toBeLessThanOrEqual(MAX_MANAGER_URGENCY_EFFECT);
    expect(pressure.contested).toBe('likely_contested');
    // And the context stays a context: it is a range, not a recommendation.
    expect(pressure.costContext!.high).toBeLessThanOrEqual(Math.round(PRICES.high! * (1 + MAX_MANAGER_COST_EFFECT)));
  });

  it('moves the other way for a room that historically does not spend', () => {
    const quiet = new Map([
      [2, profileFor({ spendRelative: 0.7, activityRelative: 0.7, confidence: 1 })],
      [3, profileFor({ spendRelative: 0.7, activityRelative: 0.7, confidence: 1 })],
    ]);
    const pressure = waiverManagerPressure({
      competition: competitionWith([2, 3]),
      profilesByRoster: quiet,
      baseline: BASELINE,
      prices: PRICES,
      position: 'RB',
      week: 5,
      finalWeek: 14,
    });
    expect(pressure.costFactor).toBeLessThan(1);
    expect(pressure.costFactor).toBeGreaterThanOrEqual(1 - MAX_MANAGER_COST_EFFECT);
    expect(pressure.contested).toBe('quiet');
  });

  it('withholds a dollar range in a league that has never published a bid', () => {
    const pressure = waiverManagerPressure({
      competition: competitionWith([2, 3]),
      profilesByRoster: new Map([
        [2, profileFor({ spendRelative: 1.3, confidence: 1 })],
        [3, profileFor({ spendRelative: 1.3, confidence: 1 })],
      ]),
      baseline: { ...BASELINE, usesFaab: false, medianBidShare: null },
      prices: null,
      position: 'RB',
      week: 5,
      finalWeek: 14,
    });
    // Pressure is still knowable; the amount is not, and is not invented.
    expect(pressure.costContext).toBeNull();
    expect(pressure.contested).not.toBe('unknown');
  });

  it('only reads late-season budget conservation in the back half', () => {
    const savers = new Map([
      [2, profileFor({ earlySpendShare: 0.1, confidence: 1 })],
      [3, profileFor({ earlySpendShare: 0.1, confidence: 1 })],
    ]);
    const args = {
      competition: competitionWith([2, 3]),
      profilesByRoster: savers,
      baseline: BASELINE,
      prices: PRICES,
      position: 'RB',
      finalWeek: 14,
    };
    expect(waiverManagerPressure({ ...args, week: 3 }).fundedLateRivals).toBe(0);
    expect(waiverManagerPressure({ ...args, week: 11 }).fundedLateRivals).toBe(2);
  });

  it('is neutral rather than absent when nothing is known', () => {
    expect(NEUTRAL_PRESSURE.costFactor).toBe(1);
    expect(NEUTRAL_PRESSURE.urgencyDelta).toBe(0);
    expect(NEUTRAL_PRESSURE.costContext).toBeNull();
    expect(NEUTRAL_PRESSURE.contested).toBe('unknown');
  });

  it('hands the bidder pass a tendency only when the bid sample supports one', () => {
    const thin = bidderTendencyFrom(2, profileFor({ bidSample: 1, spendRelative: 1.4 }));
    expect(thin.confident).toBe(false);
    expect(thin.relative).toBeNull();

    const thick = bidderTendencyFrom(2, profileFor({ bidSample: 22, spendRelative: 1.3, medianBidShare: 0.2 }));
    expect(thick.confident).toBe(true);
    expect(thick.relative).toBe(1.3);
    expect(thick.note).toBe('bids above the room');
  });
});
