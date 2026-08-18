/**
 * Manager profiles, and the sample thresholds that keep them honest.
 *
 * The pin the brief names is the threshold one: below it, nothing may be called
 * a tendency. Every other test here exists to stop a plausible shortcut — using
 * proposals instead of completed trades, letting a three-season-old habit
 * describe today's manager, or measuring run-following on one manager's picks.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTradeProfile,
  collectTrades,
  MIN_TRADE_SAMPLE,
  type TradeEvent,
} from '../src/core/managers/tradeProfile.ts';
import {
  buildManagerDraftProfile,
  buildRoomProfile,
  type HistoricalPick,
} from '../src/core/managers/draftProfile.ts';
import type { SleeperTransaction } from '../src/core/sleeper/types.ts';

function trade(over: Partial<SleeperTransaction> = {}): SleeperTransaction {
  return {
    transaction_id: 'tr1',
    type: 'trade',
    status: 'complete',
    leg: 4,
    roster_ids: [1, 2],
    adds: { pA: 1, pB: 2 },
    drops: { pA: 2, pB: 1 },
    ...over,
  };
}

const POSITIONS: Record<string, string> = { pA: 'RB', pB: 'WR', pC: 'RB', pD: 'TE' };
const positionOf = (id: string) => POSITIONS[id] ?? null;

function tradesFor(count: number, season = '2025'): TradeEvent[] {
  return collectTrades(
    Array.from({ length: count }, (_, i) => trade({ transaction_id: `tr${i}` })),
    season,
  );
}

describe('historical trade economics (§10)', () => {
  it('counts only completed trades, never proposals', () => {
    const events = collectTrades(
      [trade(), trade({ transaction_id: 'tr2', status: 'failed' }), trade({ transaction_id: 'tr3', status: 'pending' })],
      '2025',
    );
    expect(events).toHaveLength(1);
  });

  it('reads players, picks and FAAB out of a trade', () => {
    const [event] = collectTrades(
      [
        trade({
          draft_picks: [{ season: '2026', round: 2, roster_id: 2, owner_id: 1 }],
          waiver_budget: [{ sender: 1, receiver: 2, amount: 15 }],
        }),
      ],
      '2025',
    );
    expect(event?.picksMoved).toBe(1);
    expect(event?.faabMoved).toBe(15);
    expect(event?.received.get(1)).toEqual(['pA']);
    expect(event?.sent.get(1)).toEqual(['pB']);
  });

  it('leaves the initiator unknown without a user-to-roster mapping', () => {
    const [withoutMap] = collectTrades([trade({ creator: 'u9' })], '2025');
    expect(withoutMap?.initiatorRosterId).toBeNull();
    const [withMap] = collectTrades([trade({ creator: 'u9' })], '2025', new Map([['u9', 2]]));
    expect(withMap?.initiatorRosterId).toBe(2);
  });

  it('calls nothing a tendency below the sample threshold', () => {
    const profile = buildTradeProfile({
      rosterId: 1,
      trades: tradesFor(MIN_TRADE_SAMPLE - 1),
      positionOf,
      latestSeason: '2025',
    });
    expect(profile.confident).toBe(false);
    expect(profile.initiationRate).toBeNull();
    expect(profile.prefersConsolidation).toBe(false);
    expect(profile.acquiresPositions).toEqual([]);
    expect(profile.notes.join(' ')).toContain('not enough to describe a tendency');
  });

  it('describes a manager once the sample clears the threshold', () => {
    const trades = collectTrades(
      Array.from({ length: 5 }, (_, i) =>
        trade({
          transaction_id: `tr${i}`,
          creator: 'u1',
          adds: { pA: 1 },
          drops: { pB: 1, pC: 1 },
        }),
      ),
      '2025',
      new Map([['u1', 1]]),
    );
    const profile = buildTradeProfile({ rosterId: 1, trades, positionOf, latestSeason: '2025' });
    expect(profile.confident).toBe(true);
    expect(profile.initiationRate).toBe(1);
    expect(profile.prefersConsolidation).toBe(true);
    expect(profile.notes.join(' ')).toContain('two players for one');
    expect(profile.notes.join(' ')).toContain('Based on 5 trade(s)');
  });

  it('weights an old season down rather than throwing it away', () => {
    const recent = [...tradesFor(4, '2025')];
    const stale = collectTrades(
      Array.from({ length: 4 }, (_, i) => trade({ transaction_id: `old${i}` })),
      '2022',
    );
    const nowProfile = buildTradeProfile({ rosterId: 1, trades: recent, positionOf, latestSeason: '2025' });
    const thenProfile = buildTradeProfile({ rosterId: 1, trades: stale, positionOf, latestSeason: '2025' });
    expect(thenProfile.sample).toBe(4); // still observed
    expect(thenProfile.tradesPerSeason!).toBeLessThan(nowProfile.tradesPerSeason!);
  });

  it('says so plainly when a manager has never traded', () => {
    const profile = buildTradeProfile({ rosterId: 7, trades: tradesFor(4), positionOf, latestSeason: '2025' });
    expect(profile.sample).toBe(0);
    expect(profile.notes).toEqual(['No completed trades on record for this manager.']);
  });
});

function picks(over: Partial<HistoricalPick> & { draftId: string; pickNo: number }): HistoricalPick {
  return {
    season: '2025',
    round: Math.ceil(over.pickNo / 12),
    rosterId: ((over.pickNo - 1) % 12) + 1,
    position: 'WR',
    ...over,
  };
}

/** Two full drafts where quarterbacks always start in round 4. */
function twoDrafts(): HistoricalPick[] {
  const out: HistoricalPick[] = [];
  for (const draftId of ['d1', 'd2']) {
    for (let pickNo = 1; pickNo <= 60; pickNo++) {
      const round = Math.ceil(pickNo / 12);
      const position = round >= 4 && pickNo % 12 === 1 ? 'QB' : round === 5 && pickNo % 12 === 2 ? 'TE' : pickNo % 2 === 0 ? 'RB' : 'WR';
      out.push(picks({ draftId, pickNo, position, yearsExp: 3, marketRank: pickNo }));
    }
  }
  return out;
}

describe('historical draft tendencies (§11)', () => {
  it('says nothing about a room it has seen once', () => {
    const profile = buildRoomProfile(twoDrafts().filter((p) => p.draftId === 'd1'));
    expect(profile.confident).toBe(false);
    expect(profile.timing).toEqual([]);
    expect(profile.notes.join(' ')).toContain('not enough to describe how this room drafts');
  });

  it('learns when the room takes its quarterbacks', () => {
    const profile = buildRoomProfile(twoDrafts());
    expect(profile.confident).toBe(true);
    const qb = profile.timing.find((t) => t.position === 'QB');
    expect(qb?.medianFirstRound).toBe(4);
    expect(profile.notes.join(' ')).toContain('First QB usually goes in round 4');
  });

  it('measures reaching against the market, and withholds it without one', () => {
    const withMarket = buildRoomProfile(twoDrafts());
    expect(withMarket.reachTendency).toBe(0);
    const withoutMarket = buildRoomProfile(twoDrafts().map((p) => ({ ...p, marketRank: null })));
    expect(withoutMarket.reachTendency).toBeNull();
  });

  it('subtracts the position mix before calling a streak a run', () => {
    /*
     * A draft that alternates RB, WR, RB, WR has zero runs but a 50/50 mix, so
     * a naive "how often does a pick match the one before" reads 0 against an
     * expectation of 0.5 — negative, correctly.
     */
    const alternating = buildRoomProfile(twoDrafts().map((p, i) => ({ ...p, position: i % 2 === 0 ? 'RB' : 'WR' })));
    expect(alternating.runFollowing!).toBeLessThan(0);
  });

  it('does not pretend one manager’s picks are a sequence', () => {
    const profile = buildManagerDraftProfile({ rosterId: 1, picks: twoDrafts() });
    expect(profile.runFollowing).toBeNull();
  });

  it('needs enough picks before describing a manager', () => {
    const thin = buildManagerDraftProfile({ rosterId: 1, picks: twoDrafts().slice(0, 12) });
    expect(thin.confident).toBe(false);
    expect(thin.notes.join(' ')).toContain('not enough to describe a tendency');
  });

  it('produces a reusable profile contract without touching Next%', () => {
    /*
     * Ownership pin: the profile is evidence handed to the draft modules, and it
     * exposes no field a Next% calculation could consume directly.
     */
    const profile = buildRoomProfile(twoDrafts());
    expect(profile.scope).toBe('room');
    expect(Object.keys(profile)).not.toContain('nextPercent');
    expect(Object.keys(profile)).not.toContain('survivalMultiplier');
  });
});
