/**
 * Bilateral trade fit and trade timing.
 *
 * The two cases the brief singles out are the two failure modes of every trade
 * tool: a deal that is good for the user and bad for the partner (which is a
 * fantasy, not a trade), and a deal that is fair and implausible (which is a
 * trade nobody sends).
 */

import { describe, expect, it } from 'vitest';
import {
  TD_SPIKE_SHARE,
  USAGE_GAP,
  findTradeFits,
  plausibilityOf,
  sideValue,
  tradeTimingFor,
  type TradeAsset,
  type TradeTeam,
} from '../src/core/league/tradeFit.ts';
import { buildManagerProfiles, type ManagerProfile } from '../src/core/league/managers.ts';
import type { LeagueTransaction } from '../src/core/league/transactions.ts';

function asset(over: Partial<TradeAsset> & { playerId: string; position: string; value: number }): TradeAsset {
  return { name: over.playerId, surplus: false, ...over };
}

function team(over: Partial<TradeTeam> & { rosterId: number }): TradeTeam {
  return {
    userId: `u${over.rosterId}`,
    displayName: `Team ${over.rosterId}`,
    assets: [],
    needs: {},
    ...over,
  };
}

/** A manager with a visible trade record, so plausibility has something to read. */
function tradingProfile(count: number): ManagerProfile {
  const trades: LeagueTransaction[] = Array.from({ length: count }, (_, i) => ({
    sleeperLeagueId: 'L',
    transactionId: `t${i}`,
    season: '2026',
    week: 4,
    type: 'trade',
    status: 'complete',
    createdMs: 1,
    creatorUserId: 'u2',
    rosterIds: [2],
    adds: [],
    drops: [],
    waiverBid: null,
    budgetMoves: [],
    draftPicks: [],
    note: null,
  }));
  const [profile] = buildManagerProfiles({
    seats: [
      {
        sleeperLeagueId: 'L',
        season: '2026',
        rosterId: 2,
        userId: 'u2',
        displayName: 'Team 2',
        waiverBudgetUsed: 0,
        budget: 100,
        isMine: false,
      },
    ],
    transactions: trades,
    playerMeta: new Map(),
    currentSeason: '2026',
  });
  return profile!;
}

describe('both sides must gain', () => {
  const me = team({
    rosterId: 1,
    assets: [asset({ playerId: 'myRB2', position: 'RB', value: 12, surplus: true })],
    needs: { RB: 'covered', WR: 'urgent' },
  });

  it('finds a deal that helps both teams', () => {
    const partner = team({
      rosterId: 2,
      assets: [asset({ playerId: 'theirWR3', position: 'WR', value: 11, surplus: true })],
      needs: { WR: 'covered', RB: 'urgent' },
      profile: tradingProfile(4),
    });

    const [idea] = findTradeFits(me, [partner]);
    expect(idea).toBeDefined();
    expect(idea!.valueToUser).toBeGreaterThan(0);
    expect(idea!.valueToPartner).toBeGreaterThan(0);
    expect(idea!.reasons.join(' ')).toContain('fills your WR');
  });

  it('drops a deal that is good for the user and bad for the partner', () => {
    // The partner has no need at running back and is being asked to give up a
    // receiver he actually starts.
    const partner = team({
      rosterId: 2,
      assets: [asset({ playerId: 'theirWR1', position: 'WR', value: 18, surplus: false })],
      needs: { WR: 'urgent', RB: 'covered' },
      profile: tradingProfile(4),
    });

    const ideas = findTradeFits(me, [partner]);
    expect(ideas).toEqual([]);
  });

  it('scores the two sides separately and can disagree about who wins', () => {
    const partner = team({
      rosterId: 2,
      assets: [asset({ playerId: 'theirWR', position: 'WR', value: 14, surplus: true })],
      needs: { RB: 'urgent' },
      profile: tradingProfile(4),
    });
    const [idea] = findTradeFits(me, [partner]);
    expect(idea!.valueToUser).not.toBe(idea!.valueToPartner);
  });
});

describe('fair but implausible', () => {
  it('penalises asking for the best player on their roster', () => {
    const partner = team({
      rosterId: 2,
      assets: [
        asset({ playerId: 'stud', position: 'WR', value: 22, surplus: true }),
        asset({ playerId: 'depth', position: 'WR', value: 8, surplus: true }),
      ],
      needs: { RB: 'urgent' },
      profile: tradingProfile(4),
    });

    const forStud = plausibilityOf({
      partner,
      give: [asset({ playerId: 'myRB', position: 'RB', value: 20, surplus: true })],
      get: [partner.assets[0]!],
      valueToPartner: 5,
    });
    const forDepth = plausibilityOf({
      partner,
      give: [asset({ playerId: 'myRB', position: 'RB', value: 20, surplus: true })],
      get: [partner.assets[1]!],
      valueToPartner: 5,
    });

    expect(forStud.score).toBeLessThan(forDepth.score);
    expect(forStud.notes).toContain('it asks for the best player on their roster');
  });

  it('marks a manager who has never traded as untested rather than unwilling', () => {
    const partner = team({
      rosterId: 2,
      assets: [asset({ playerId: 'wr', position: 'WR', value: 10, surplus: true })],
      needs: { RB: 'urgent' },
    });
    const { score, notes } = plausibilityOf({
      partner,
      give: [asset({ playerId: 'rb', position: 'RB', value: 10, surplus: true })],
      get: [partner.assets[0]!],
      valueToPartner: 4,
    });

    expect(notes).toContain('no trade history on record — untested rather than unwilling');
    // Penalised, but nowhere near hidden.
    expect(score).toBeGreaterThan(0.25);
  });

  it('gives a deal the partner does not benefit from almost no chance', () => {
    const partner = team({ rosterId: 2, assets: [], needs: {} });
    expect(plausibilityOf({ partner, give: [], get: [], valueToPartner: 0 }).score).toBeLessThan(0.1);
  });
});

describe('need weighting is what makes a trade non-zero-sum', () => {
  it('values an incoming player more when he fills a hole', () => {
    const needy = team({ rosterId: 1, needs: { WR: 'urgent' } });
    const covered = team({ rosterId: 1, needs: { WR: 'covered' } });
    const incoming = [asset({ playerId: 'wr', position: 'WR', value: 10 })];
    expect(sideValue(needy, incoming, [])).toBeGreaterThan(sideValue(covered, incoming, []));
  });

  it('charges less for giving away genuine surplus', () => {
    const t = team({ rosterId: 1, needs: {} });
    const spare = [asset({ playerId: 'rb', position: 'RB', value: 10, surplus: true })];
    const starter = [asset({ playerId: 'rb', position: 'RB', value: 10, surplus: false })];
    expect(sideValue(t, [], spare)).toBeGreaterThan(sideValue(t, [], starter));
  });
});

describe('trade timing', () => {
  it('says buy before usage converts on a growing role', () => {
    const timing = tradeTimingFor(
      { xfpPerGame: 14, fpPerGame: 14 - USAGE_GAP - 1, roleTrend: 'rising_high' },
      'theirs',
    );
    expect(timing.map((t) => t.label)).toContain('Buy before usage converts to points');
  });

  it('says buy after a dip when the role is not growing but the opportunity held', () => {
    const timing = tradeTimingFor({ xfpPerGame: 14, fpPerGame: 8, roleTrend: 'stable' }, 'theirs');
    expect(timing.map((t) => t.label)).toContain('Buy after temporary box-score dip');
  });

  it('warns off a touchdown spike', () => {
    const timing = tradeTimingFor({ tdShare: TD_SPIKE_SHARE + 0.1 }, 'theirs');
    expect(timing.map((t) => t.label)).toContain('Avoid buying TD-driven spike');
  });

  it('says sell before the schedule turns, but only about my own player', () => {
    expect(tradeTimingFor({ scheduleTurn: 'hardening' }, 'mine').map((t) => t.label)).toContain(
      'Sell before schedule turns',
    );
    expect(tradeTimingFor({ scheduleTurn: 'hardening' }, 'theirs')).toEqual([]);
  });

  it('says sell before the injured starter returns', () => {
    expect(tradeTimingFor({ starterReturnsInWeeks: 2 }, 'mine').map((t) => t.label)).toContain(
      'Sell before injured starter returns',
    );
    expect(tradeTimingFor({ starterReturnsInWeeks: 9 }, 'mine')).toEqual([]);
  });

  it('says nothing at all when the signals are missing', () => {
    expect(tradeTimingFor({}, 'mine')).toEqual([]);
    expect(tradeTimingFor({ xfpPerGame: 12, fpPerGame: null }, 'mine')).toEqual([]);
  });

  it('reports every true call, including the unflattering one', () => {
    const timing = tradeTimingFor(
      { xfpPerGame: 16, fpPerGame: 10, roleTrend: 'rising_high', tdShare: 0.7 },
      'theirs',
    );
    expect(timing).toHaveLength(2);
  });
});
