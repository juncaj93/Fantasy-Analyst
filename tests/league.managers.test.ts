/**
 * Manager profiles: thresholds, cross-season identity, and the modifier cap.
 *
 * The tests that matter here are the negative ones. A profile engine that
 * always produces a number is easy to write and useless — the whole value is in
 * what it refuses to say.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_AGGRESSION_EFFECT,
  SAMPLE_THRESHOLDS,
  aggressionModifier,
  buildManagerProfiles,
  leagueMeanBidShare,
  type ManagerSeat,
} from '../src/core/league/managers.ts';
import type { LeagueTransaction } from '../src/core/league/transactions.ts';

const PLAYER_META = new Map([
  ['wr1', { position: 'WR', yearsExp: 4 }],
  ['qb1', { position: 'QB', yearsExp: 6 }],
  ['te1', { position: 'TE', yearsExp: 1 }],
  ['rb1', { position: 'RB', yearsExp: 0 }],
]);

function seat(over: Partial<ManagerSeat> = {}): ManagerSeat {
  return {
    sleeperLeagueId: 'L2026',
    season: '2026',
    rosterId: 1,
    userId: 'u1',
    displayName: 'Alice',
    waiverBudgetUsed: 20,
    budget: 100,
    isMine: false,
    ...over,
  };
}

let counter = 0;
function waiver(over: Partial<LeagueTransaction> = {}): LeagueTransaction {
  counter++;
  return {
    sleeperLeagueId: 'L2026',
    transactionId: `t${counter}`,
    season: '2026',
    week: 3,
    type: 'waiver',
    status: 'complete',
    createdMs: 1_700_000_000_000 + counter,
    creatorUserId: 'u1',
    rosterIds: [1],
    adds: [{ sleeperPlayerId: 'wr1', rosterId: 1 }],
    drops: [],
    waiverBid: 10,
    budgetMoves: [],
    draftPicks: [],
    note: null,
    ...over,
  };
}

describe('sample thresholds', () => {
  it('says nothing about a manager with no history at all', () => {
    const [profile] = buildManagerProfiles({
      seats: [seat()],
      transactions: [],
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });

    expect(profile!.aggression.sufficient).toBe(false);
    expect(profile!.aggression.value).toBeNull();
    expect(profile!.aggression.note).toBe('never observed');
    expect(profile!.summary).toContain('no trade history to speak of');
  });

  it('refuses to call a tendency from a sample below the threshold', () => {
    const bids = Array.from({ length: SAMPLE_THRESHOLDS.bids - 1 }, () => waiver({ waiverBid: 40 }));
    const [profile] = buildManagerProfiles({
      seats: [seat()],
      transactions: bids,
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });

    expect(profile!.aggression.sufficient).toBe(false);
    expect(profile!.aggression.value).toBeNull();
    expect(profile!.aggression.sample).toBe(SAMPLE_THRESHOLDS.bids - 1);
    // And the modifier a price model would apply is exactly none.
    expect(aggressionModifier(profile!, 0.1)).toBe(1);
  });

  it('reports a tendency once the threshold is cleared', () => {
    const bids = Array.from({ length: SAMPLE_THRESHOLDS.bids }, () => waiver({ waiverBid: 40 }));
    const [profile] = buildManagerProfiles({
      seats: [seat()],
      transactions: bids,
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });

    expect(profile!.aggression.sufficient).toBe(true);
    expect(profile!.aggression.value).toBeCloseTo(0.4, 3);
  });
});

describe('history depth', () => {
  const priorSeats = [
    seat({ sleeperLeagueId: 'L2025', season: '2025', rosterId: 7, waiverBudgetUsed: 90 }),
    seat(),
  ];

  it('joins seasons by user id, not by roster id', () => {
    // Alice sat in roster 7 last season and roster 1 this season. Roster 1 last
    // season belonged to somebody else entirely, and none of their bids may
    // land on her profile.
    const seats = [
      ...priorSeats,
      seat({ sleeperLeagueId: 'L2025', season: '2025', rosterId: 1, userId: 'u2', displayName: 'Bob' }),
    ];
    const transactions = [
      ...Array.from({ length: 4 }, () =>
        waiver({ sleeperLeagueId: 'L2025', season: '2025', waiverBid: 50, adds: [{ sleeperPlayerId: 'wr1', rosterId: 7 }], rosterIds: [7] }),
      ),
      ...Array.from({ length: 4 }, () =>
        waiver({ sleeperLeagueId: 'L2025', season: '2025', waiverBid: 1, adds: [{ sleeperPlayerId: 'wr1', rosterId: 1 }], rosterIds: [1] }),
      ),
    ];

    const profiles = buildManagerProfiles({ seats, transactions, playerMeta: PLAYER_META, currentSeason: '2026' });
    const alice = profiles.find((p) => p.userId === 'u1')!;
    const bob = profiles.find((p) => p.userId === 'u2')!;

    expect(alice.aggression.value).toBeCloseTo(0.5, 2);
    expect(bob.aggression.value).toBeCloseTo(0.01, 2);
  });

  it('carries multiple seasons on one profile', () => {
    const transactions = [
      ...Array.from({ length: 4 }, () =>
        waiver({ sleeperLeagueId: 'L2025', season: '2025', rosterIds: [7], adds: [{ sleeperPlayerId: 'wr1', rosterId: 7 }] }),
      ),
      ...Array.from({ length: 4 }, () => waiver()),
    ];
    const [profile] = buildManagerProfiles({
      seats: priorSeats,
      transactions,
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });
    expect(profile!.seasons.sort()).toEqual(['2025', '2026']);
    expect(profile!.aggression.sample).toBeGreaterThanOrEqual(8);
  });
});

describe('the current season outranks the record when they disagree', () => {
  it('uses this season and says so', () => {
    const transactions = [
      // Four seasons ago she was a $1 bidder...
      ...Array.from({ length: 5 }, () =>
        waiver({ sleeperLeagueId: 'L2025', season: '2025', rosterIds: [7], adds: [{ sleeperPlayerId: 'wr1', rosterId: 7 }], waiverBid: 2 }),
      ),
      // ...and this season she is spending half her budget on a player.
      ...Array.from({ length: 5 }, () => waiver({ waiverBid: 45 })),
    ];

    const [profile] = buildManagerProfiles({
      seats: [seat({ sleeperLeagueId: 'L2025', season: '2025', rosterId: 7 }), seat()],
      transactions,
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });

    expect(profile!.contradictsHistory).toBe(true);
    expect(profile!.aggression.value).toBeCloseTo(0.45, 2);
    expect(profile!.aggression.note).toContain('this season is used');
    expect(profile!.summary).toContain('their bidding this season does not match previous seasons');
  });

  it('does not flag a contradiction for a small drift', () => {
    const transactions = [
      ...Array.from({ length: 5 }, () =>
        waiver({ sleeperLeagueId: 'L2025', season: '2025', rosterIds: [7], adds: [{ sleeperPlayerId: 'wr1', rosterId: 7 }], waiverBid: 20 }),
      ),
      ...Array.from({ length: 5 }, () => waiver({ waiverBid: 25 })),
    ];
    const [profile] = buildManagerProfiles({
      seats: [seat({ sleeperLeagueId: 'L2025', season: '2025', rosterId: 7 }), seat()],
      transactions,
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });
    expect(profile!.contradictsHistory).toBe(false);
  });
});

describe('bounded effect', () => {
  it('never moves a price by more than the stated cap', () => {
    const transactions = Array.from({ length: 6 }, () => waiver({ waiverBid: 95 }));
    const [profile] = buildManagerProfiles({
      seats: [seat()],
      transactions,
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });

    // Ten times the league average, and it is still capped.
    expect(aggressionModifier(profile!, 0.095)).toBeCloseTo(1 + MAX_AGGRESSION_EFFECT, 5);
    expect(aggressionModifier(profile!, 20)).toBeCloseTo(1 - MAX_AGGRESSION_EFFECT, 5);
  });
});

describe('remaining budget', () => {
  it('subtracts spend from that season’s budget', () => {
    const [profile] = buildManagerProfiles({
      seats: [seat({ waiverBudgetUsed: 93, budget: 100 })],
      transactions: [],
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });
    expect(profile!.remainingFaab).toBe(7);
  });

  it('stays unknown rather than assuming a full wallet', () => {
    const [profile] = buildManagerProfiles({
      seats: [seat({ waiverBudgetUsed: null })],
      transactions: [],
      playerMeta: PLAYER_META,
      currentSeason: '2026',
    });
    expect(profile!.remainingFaab).toBeNull();
  });
});

describe('league mean bid share', () => {
  it('counts losing bids as well as winning ones', () => {
    const budgets = new Map([['2026', 100]]);
    const mean = leagueMeanBidShare(
      [waiver({ waiverBid: 10 }), waiver({ waiverBid: 30, status: 'failed' })],
      budgets,
    );
    expect(mean).toBeCloseTo(0.2, 3);
  });

  it('is null when no bid has a budget behind it', () => {
    expect(leagueMeanBidShare([waiver({ waiverBid: 10 })], new Map())).toBeNull();
  });
});
