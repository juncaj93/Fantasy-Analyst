/**
 * Who is still on waivers, and who is an instant add.
 *
 * Every date below is from this league's own week 3 and 4 transaction log, read
 * from Sleeper on 1 October 2026: the Wednesday run at 30 Sep 07:10 UTC,
 * Adonai Mitchell dropped 30 Sep 17:22 UTC, and a two-day clear window.
 */

import { describe, expect, it } from 'vitest';
import { nextWaiverRun, pickupStateFor, waiverRulesOf, type WaiverRules } from '../src/core/waivers/clearWindow.ts';
import { priceWaiverUpgrades } from '../src/core/waivers/pricing.ts';
import { buildBudgetState } from '../src/core/faab/budget.ts';
import { summarisePrices, type BidHistory } from '../src/core/faab/bids.ts';
import type { WaiverValueAdd } from '../src/core/startsit/waivers.ts';

const TONYS = {
  waiver_type: 2,
  waiver_budget: 100,
  waiver_bid_min: 0,
  waiver_clear_days: 2,
  waiver_day_of_week: 2,
  daily_waivers: 0,
};
const RULES = waiverRulesOf(TONYS) as WaiverRules;

describe('the league rules', () => {
  it('reads this league as FAAB, two clear days, Wednesday run', () => {
    expect(RULES).toEqual({ clearDays: 2, runDay: 2, usesFaab: true });
  });

  it('gives up on a league it cannot read, or one with daily waivers', () => {
    expect(waiverRulesOf(null)).toBeNull();
    expect(waiverRulesOf({})).toBeNull();
    expect(waiverRulesOf({ ...TONYS, daily_waivers: 1 })).toBeNull();
  });

  it('puts the run at midnight Pacific at the start of Wednesday', () => {
    expect(nextWaiverRun(new Date('2026-09-29T12:00:00Z'), RULES).toISOString()).toBe('2026-09-30T07:00:00.000Z');
    expect(nextWaiverRun(new Date('2026-09-30T08:00:00Z'), RULES).toISOString()).toBe('2026-10-07T07:00:00.000Z');
    /* Pacific standard time from 1 November: an hour later in UTC. */
    expect(nextWaiverRun(new Date('2026-11-09T12:00:00Z'), RULES).toISOString()).toBe('2026-11-11T08:00:00.000Z');
  });
});

describe('one free agent', () => {
  const now = new Date('2026-10-01T02:00:00Z');
  const thursday = '2026-10-02T00:15:00Z';

  it('is free to add when nobody dropped him and his game is ahead', () => {
    expect(pickupStateFor({ droppedAt: null, kickoff: '2026-10-04T17:00:00Z', hasTeam: true, now, rules: RULES })).toEqual({
      state: 'free',
      reason: null,
      until: null,
    });
  });

  it('is on waivers for two days after a drop: Adonai Mitchell', () => {
    const state = pickupStateFor({
      droppedAt: '2026-09-30T17:22:15Z',
      kickoff: '2026-10-04T17:00:00Z',
      hasTeam: true,
      now,
      rules: RULES,
    });
    expect(state).toEqual({ state: 'waivers', reason: 'dropped', until: '2026-10-02T17:22:15.000Z' });
  });

  it('is free again once the window has passed', () => {
    const later = new Date('2026-10-03T00:00:00Z');
    expect(
      pickupStateFor({ droppedAt: '2026-09-30T17:22:15Z', kickoff: '2026-10-04T17:00:00Z', hasTeam: true, now: later, rules: RULES }).state,
    ).toBe('free');
  });

  it('is on waivers until the weekly run once his game has kicked off', () => {
    const friday = new Date('2026-10-02T12:00:00Z');
    expect(pickupStateFor({ droppedAt: null, kickoff: thursday, hasTeam: true, now: friday, rules: RULES })).toEqual({
      state: 'waivers',
      reason: 'game_started',
      until: '2026-10-07T07:00:00.000Z',
    });
  });

  it('takes the later of the two when both apply: Woody Marks, dropped mid-game', () => {
    const monday = new Date('2026-09-28T12:00:00Z');
    const state = pickupStateFor({
      droppedAt: '2026-09-27T19:18:00Z',
      kickoff: '2026-09-27T17:00:00Z',
      hasTeam: true,
      now: monday,
      rules: RULES,
    });
    expect(state.until).toBe('2026-09-30T07:00:00.000Z');
  });

  it('counts as played on the eve of the run, once the stored week has moved on', () => {
    const tuesday = new Date('2026-09-29T18:00:00Z');
    const nextSunday = '2026-10-04T17:00:00Z';
    expect(pickupStateFor({ droppedAt: null, kickoff: nextSunday, hasTeam: true, now: tuesday, rules: RULES }).reason).toBe(
      'game_started',
    );
    /* A player with no team plays no game. */
    expect(pickupStateFor({ droppedAt: null, kickoff: null, hasTeam: false, now: tuesday, rules: RULES }).state).toBe('free');
  });
});

describe('a fresh drop the room rated', () => {
  const won = [1, 2, 10, 1, 15, 4, 1, 1, 8, 11, 5, 6, 11, 1, 2, 16, 1].map((amount, i) => ({
    transactionId: `t${i}`,
    week: 1,
    rosterId: 2,
    playerId: `p${i}`,
    amount,
    outcome: 'won' as const,
  }));
  const history: BidHistory = { observations: won, won, lost: [], losingBidsComplete: false, weeksRead: [1, 2, 3] };
  const budget = buildBudgetState({
    leagueSettings: TONYS,
    rosters: [
      { rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 22 } },
      { rosterId: 2, ownerName: 'Rival', isMine: false, settings: { waiver_budget_used: 40 } },
      { rosterId: 3, ownerName: 'Rival 2', isMine: false, settings: { waiver_budget_used: 10 } },
    ],
  });
  const add: WaiverValueAdd = {
    playerId: 'adonai',
    name: 'Adonai Mitchell',
    position: 'WR',
    team: 'NYJ',
    score: 9,
    gain: 5,
    reasons: [],
    statusFlag: null,
    role: { trend: 'stable', games: 4 },
    overPlayerId: 'jw',
    overName: 'Jaylen Wright',
    priority: 5,
    basis: {
      comparedTo: 'bench',
      bar: 1,
      projection: 9,
      overProjection: 3.47,
      projectionGap: 5.53,
      depth: { position: 'WR', held: 4, cap: null },
      attention: null,
      lean: 0,
    },
  };
  const price = (pickup: Parameters<typeof priceWaiverUpgrades>[0]['pickup']) =>
    priceWaiverUpgrades({
      advice: { upgrades: [], valueAdds: [add] },
      strategy: { week: 4, finalWeek: 14, budget, prices: summarisePrices(history), trending: new Map() },
      rosteredIds: new Set(),
      /* Measured: nobody else in the league needs a WR. */
      competition: new Map([['adonai', { effectiveBidders: 0 } as never]]),
      heldIds: new Map([['adonai', 'drafted around pick 70']]),
      ...(pickup ? { pickup } : {}),
    })[0]!;

  it('is a dollar when the need count alone prices him', () => {
    expect(price(undefined).recommended).toBe(1);
  });

  it('is priced as contested while he is still on waivers', () => {
    const bid = price({ adonai: { state: 'waivers', reason: 'dropped', until: '2026-10-02T17:22:15Z' } });
    expect(bid.recommended!).toBeGreaterThan(1);
    expect(bid.expected!.high).toBeGreaterThan(price(undefined).expected!.high);
    expect(bid.reasons.join(' ')).toMatch(/Just dropped and still on waivers/);
  });
});
