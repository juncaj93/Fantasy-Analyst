/**
 * Per-manager bidding: how often somebody bids per real waiver run, and how big.
 *
 * The case that started this: a manager who placed one claim in three seasons
 * was described on the Competition row with the league's range and "claims
 * less than the room", the same shape as somebody who bids every week. These
 * tests pin the profile to real chances (waiver runs), count losing claims as
 * bids, blend thin records toward the room, and check the row reads differently.
 */

import { describe, expect, it } from 'vitest';
import { BIDDING_PRIOR, MAX_BID_SIZE_EFFECT, buildBiddingProfiles } from '../src/core/managers/biddingProfile.ts';
import type { LedgerTransaction } from '../src/core/managers/ledger.ts';
import { activityPhrase, namedBidders, type BidderTendency } from '../src/core/league/bidders.ts';
import { bidderTendencyFrom } from '../src/core/waivers/managerPressure.ts';
import { neutralTransactionProfile } from '../src/core/managers/transactionProfile.ts';
import { assessCompetition, teamNeedsFor, type TeamRoster } from '../src/core/league/competition.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';
import type { LeagueBudgetRule, RosterBudget } from '../src/core/faab/budget.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

let seq = 0;
function claim(
  userId: string,
  season: string,
  week: number,
  bid: number | null,
  status: 'complete' | 'failed' | 'pending' = 'complete',
): LedgerTransaction {
  seq++;
  return {
    transactionId: `t${seq}`,
    season,
    week,
    type: 'waiver',
    status,
    createdAtMs: null,
    userIds: [userId],
    rosterIds: [1],
    creatorUserId: userId,
    addsByUser: new Map([[userId, [`p${seq}`]]]),
    dropsByUser: new Map(),
    waiverBid: bid,
    faabTraded: 0,
    draftPicksMoved: 0,
  };
}

describe('the bidding record', () => {
  it('counts waiver runs the league actually processed, not calendar weeks', () => {
    // Runs in weeks 2, 3 and 5 only. Week 4 had no claims from anybody.
    const txns = [claim('a', '2026', 2, 1), claim('a', '2026', 3, 1), claim('b', '2026', 5, 3)];
    const profiles = buildBiddingProfiles({
      transactions: txns,
      seasonsByUser: new Map([['a', ['2026']], ['b', ['2026']]]),
      budgetTotal: 100,
    });
    expect(profiles.get('a')!.opportunities).toBe(3);
    expect(profiles.get('a')!.bidRuns).toBe(2);
    expect(profiles.get('b')!.bidRuns).toBe(1);
  });

  it('counts a losing claim as a bid, and ignores pending ones', () => {
    const txns = [claim('a', '2026', 1, 4, 'failed'), claim('a', '2026', 2, 4, 'pending'), claim('b', '2026', 2, 1)];
    const a = buildBiddingProfiles({
      transactions: txns,
      seasonsByUser: new Map([['a', ['2026']], ['b', ['2026']]]),
      budgetTotal: 100,
    }).get('a')!;
    expect(a.bidRuns).toBe(1);
    expect(a.bids).toBe(1);
  });

  it('gives a current manager with no claims at all a "0 of N" record rather than nothing', () => {
    const txns = [claim('a', '2026', 1, 1), claim('a', '2026', 2, 1)];
    const quiet = buildBiddingProfiles({
      transactions: txns,
      seasonsByUser: new Map([['a', ['2026']], ['q', ['2026']]]),
      budgetTotal: 100,
    }).get('q')!;
    expect(quiet.opportunities).toBe(2);
    expect(quiet.bidRuns).toBe(0);
    expect(quiet.bids).toBe(0);
  });

  it('only counts seasons the manager was in the league for', () => {
    const txns = [claim('a', '2025', 1, 1), claim('a', '2025', 2, 1), claim('a', '2026', 1, 1)];
    const newcomer = buildBiddingProfiles({
      transactions: txns,
      seasonsByUser: new Map([['a', ['2025', '2026']], ['n', ['2026']]]),
      budgetTotal: 100,
    }).get('n')!;
    expect(newcomer.opportunities).toBe(1);
    expect(newcomer.since).toBe('2026');
  });

  it('blends a thin record toward the room by a fixed number of imaginary runs', () => {
    // Room: 'a' bids every run. 'q' has had 2 runs and bid in none.
    const txns = [claim('a', '2026', 1, 1), claim('a', '2026', 2, 1)];
    const q = buildBiddingProfiles({
      transactions: txns,
      seasonsByUser: new Map([['a', ['2026']], ['q', ['2026']]]),
      budgetTotal: 100,
    }).get('q')!;
    const room = q.roomRate;
    expect(room).toBeCloseTo(0.5, 3);
    expect(q.rate).toBeCloseTo((0 + BIDDING_PRIOR.runs * room) / (2 + BIDDING_PRIOR.runs), 3);
  });

  it('leans a bid-size reading on the room when the sample is thin, and bounds it', () => {
    const room = Array.from({ length: 20 }, (_, i) => claim('r', '2026', (i % 10) + 1, 1));
    const one = buildBiddingProfiles({
      transactions: [...room, claim('x', '2026', 1, 50)],
      seasonsByUser: new Map([['r', ['2026']], ['x', ['2026']]]),
      budgetTotal: 100,
    }).get('x')!;
    // One huge bid: weight 1/5, so the reading moves but nowhere near the raw ratio.
    expect(one.sizeWeight).toBeCloseTo(1 / (1 + BIDDING_PRIOR.bids), 3);
    expect(one.sizeRelative!).toBeLessThanOrEqual(1 + MAX_BID_SIZE_EFFECT);
    expect(one.sizeRelative!).toBeGreaterThan(1);

    const many = buildBiddingProfiles({
      transactions: [...room, ...Array.from({ length: 12 }, (_, i) => claim('x', '2026', i + 1, 50))],
      seasonsByUser: new Map([['r', ['2026']], ['x', ['2026']]]),
      budgetTotal: 100,
    }).get('x')!;
    expect(many.sizeRelative).toBeCloseTo(1 + MAX_BID_SIZE_EFFECT, 3);
  });

  it('survives a room whose median claim is $0', () => {
    const txns = [claim('a', '2026', 1, 0), claim('a', '2026', 2, 0), claim('b', '2026', 1, 5), claim('b', '2026', 2, 5),
      claim('a', '2026', 3, 0), claim('b', '2026', 3, 5), claim('a', '2026', 4, 0), claim('b', '2026', 4, 5), claim('a', '2026', 5, 0)];
    const b = buildBiddingProfiles({
      transactions: txns,
      seasonsByUser: new Map([['a', ['2026']], ['b', ['2026']]]),
      budgetTotal: 100,
    }).get('b')!;
    expect(Number.isFinite(b.sizeRelative!)).toBe(true);
    expect(b.sizeRelative!).toBeGreaterThan(1);
  });
});

describe('how often, in words', () => {
  const base = { seasonOpportunities: 4, since: '2024', roomRate: 0.5 };

  it('calls a manager rare only against the room, with the counts beside it', () => {
    const p = activityPhrase({ ...base, opportunities: 35, bidRuns: 1, seasonBidRuns: 0, rate: 0.078 })!;
    expect(p.rare).toBe(true);
    expect(p.phrase).toBe('rarely bids (1 of 35 waiver runs since 2024, none this season)');
  });

  it('describes a weekly bidder as one', () => {
    const p = activityPhrase({ ...base, opportunities: 35, bidRuns: 31, seasonBidRuns: 3, rate: 0.84 })!;
    expect(p.rare).toBe(false);
    expect(p.phrase).toBe('bids most weeks (31 of 35 waiver runs since 2024)');
  });

  it('says nothing about a typical bidder', () => {
    expect(activityPhrase({ ...base, opportunities: 35, bidRuns: 17, seasonBidRuns: 2, rate: 0.49 })).toBeNull();
  });

  it('claims nothing about habit below four runs, only the count', () => {
    const p = activityPhrase({ ...base, opportunities: 2, seasonOpportunities: 2, bidRuns: 0, seasonBidRuns: 0, rate: 0.4 })!;
    expect(p.rare).toBe(false);
    expect(p.phrase).toBe('only 2 waiver run(s) on record');
  });
});

describe('the Competition row', () => {
  const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);
  const FAAB: LeagueBudgetRule = { total: 100, usesFaab: true, provenance: 'league settings' };
  const PRICES: PriceSummary = {
    sample: 30, median: 2, low: 1, high: 5, max: 40, highestLosing: 8, losingBidsComplete: false, confidence: 'medium',
  };

  function scenario() {
    const rosters: TeamRoster[] = [
      { rosterId: 1, displayName: 'Me', isMine: true, playerIds: ['m-rb'] },
      { rosterId: 2, displayName: 'Quiet', isMine: false, playerIds: ['q-wr'] },
      { rosterId: 3, displayName: 'Busy', isMine: false, playerIds: ['b-wr'] },
    ];
    const meta = new Map([
      ['m-rb', { position: 'RB' }],
      ['q-wr', { position: 'WR' }],
      ['b-wr', { position: 'WR' }],
    ]);
    const needs = teamNeedsFor('RB', rosters, meta, SHAPE);
    const budgets = new Map<number, RosterBudget>(
      [2, 3].map((id) => [id, { rosterId: id, ownerName: null, isMine: false, remaining: 100, spent: 0, share: 1 }]),
    );
    const competition = assessCompetition({ needs, budgets, expectedLow: PRICES.low, bidding: true });
    return { needs, competition };
  }

  function tendencyFor(rosterId: number, bidding: Parameters<typeof withBidding>[1]): BidderTendency {
    return bidderTendencyFrom(rosterId, withBidding(rosterId, bidding));
  }
  function withBidding(rosterId: number, b: { opportunities: number; bidRuns: number; bids: number; sizeRelative: number; sizeWeight: number; rate: number }) {
    return {
      ...neutralTransactionProfile(`u${rosterId}`),
      bidding: {
        ...b,
        seasonOpportunities: 4,
        seasonBidRuns: b.bidRuns > 10 ? 3 : 0,
        since: '2024',
        roomRate: 0.51,
        medianBidShare: 0.03,
        roomMedianBidShare: 0.01,
      },
    };
  }

  it('reads a rare bidder differently from an active one with the same league range', () => {
    const { needs, competition } = scenario();
    const tendencies = new Map<number, BidderTendency>([
      [2, tendencyFor(2, { opportunities: 35, bidRuns: 1, bids: 2, sizeRelative: 1.1, sizeWeight: 0.333, rate: 0.078 })],
      [3, tendencyFor(3, { opportunities: 35, bidRuns: 31, bids: 80, sizeRelative: 1.0, sizeWeight: 0.95, rate: 0.84 })],
    ]);
    const intel = namedBidders({ competition, needs, observations: [], prices: PRICES, rule: FAAB, position: 'RB', tendencies });
    const quiet = intel.named.find((b) => b.displayName === 'Quiet')!;
    const busy = intel.named.find((b) => b.displayName === 'Busy')!;

    expect(quiet.display).toContain('rarely bids (1 of 35 waiver runs since 2024, none this season)');
    expect(quiet.display).toMatch(/likely \$\d+–\d+ if bidding/);
    expect(quiet.confidence).toBe('low');
    expect(quiet.caveat).toContain('only 2 bid(s) on record, so this leans on the league’s range');
    expect(quiet.display).not.toContain('claims less than the room');

    expect(busy.display).toContain('bids most weeks (31 of 35 waiver runs since 2024)');
    expect(busy.display).not.toContain('if bidding');
    expect(busy.basis).toBe('manager_history');
    expect(busy.caveat).toBeNull();
  });

  it('widens a thin record’s range less as real bids accumulate', () => {
    const { needs, competition } = scenario();
    const width = (bids: number, weight: number): number => {
      const tendencies = new Map([[2, tendencyFor(2, { opportunities: 20, bidRuns: 10, bids, sizeRelative: 1, sizeWeight: weight, rate: 0.5 })]]);
      const quiet = namedBidders({ competition, needs, observations: [], prices: { ...PRICES, low: 4, high: 20 }, rule: FAAB, position: 'RB', tendencies })
        .named.find((b) => b.displayName === 'Quiet')!;
      return quiet.estimate!.high - quiet.estimate!.low;
    };
    expect(width(0, 0)).toBeGreaterThan(width(2, 1 / 3));
  });
});
