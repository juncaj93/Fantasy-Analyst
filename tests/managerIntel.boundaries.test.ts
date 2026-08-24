/**
 * The three walls manager history is not allowed through.
 *
 * Every one of these is a prohibition rather than a preference, and every one of
 * them fails silently if it breaks — a bid that is three dollars higher than it
 * should be looks exactly like a bid. So they are asserted as equalities on the
 * numbers themselves, with the history switched on and off, rather than as
 * properties of the code that produces them.
 *
 *   1. **Waivers.** A rival's spending habit may move competition pressure,
 *      urgency and a cost *context*. It may not move `expected`, `recommended`
 *      or `doNotExceed`, and it may not move a player's gain, score or
 *      multi-week value — a manager who bids big does not make a player better.
 *   2. **Trades.** Behaviour may order and label. It may not change a verdict,
 *      an urgency or a confidence, and its whole weight is smaller than the
 *      smallest gap a fit score can express.
 *   3. **Drafts.** Covered next door in `managerTendencies.test.ts`, which pins
 *      `Score`, `ADP`, `DOG`, `Val` and `PTS` byte-identical and the `Next%`
 *      movement inside the ±5pp ceiling. Named here so the set is findable.
 */

import { describe, expect, it } from 'vitest';
import { waiverLeagueIntel, withCompetition } from '../src/core/waivers/intel.ts';
import { priceWaiverUpgrades } from '../src/core/waivers/pricing.ts';
import { neutralTransactionProfile, type LeagueTransactionBaseline } from '../src/core/managers/transactionProfile.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import { rankTrades } from '../src/core/trades/engine.ts';
import { partnerContext, type ManagerTradeTendencies } from '../src/core/managers/tradeTendencies.ts';
import type { WaiverAdvice } from '../src/core/startsit/waivers.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';
import type { LeagueBudgetState } from '../src/core/faab/budget.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

function player(id: string, position: string, name = `Player ${id}`): CanonicalPlayer {
  return {
    id,
    sleeperPlayerId: id,
    fullName: name,
    firstName: 'Player',
    lastName: id,
    team: 'SF',
    position,
    status: 'Active',
    active: true,
    normalizedName: name.toLowerCase(),
    aliases: [],
  };
}

const PLAYERS = [
  player('mine-rb', 'RB'),
  player('free-rb', 'RB'),
  player('free-rb2', 'RB'),
  player('rival-rb', 'RB'),
];

const ADVICE: WaiverAdvice = {
  upgrades: [
    {
      slot: 'RB',
      accepts: ['RB'],
      need: 'upgrade',
      currentPlayerId: 'mine-rb',
      currentName: 'Player mine-rb',
      currentScore: 8,
      bar: 8,
      candidates: [
        {
          playerId: 'free-rb',
          name: 'Player free-rb',
          position: 'RB',
          team: 'SF',
          score: 13,
          gain: 5,
          reasons: ['fills a slot'],
          statusFlag: null,
          role: { trend: 'rising_moderate', games: 4 },
        },
        {
          playerId: 'free-rb2',
          name: 'Player free-rb2',
          position: 'RB',
          team: 'SF',
          score: 10,
          gain: 2,
          reasons: [],
          statusFlag: null,
          role: { trend: 'stable', games: 4 },
        },
      ],
    },
  ],
  headline: null,
  notes: [],
  considered: 2,
  skipped: 0,
  threshold: 1.5,
};

const ROSTERS = [
  { rosterId: 1, ownerName: 'You', isMine: true, playerIds: ['mine-rb'] },
  { rosterId: 2, ownerName: 'Alice', isMine: false, playerIds: [] },
  { rosterId: 3, ownerName: 'Bob', isMine: false, playerIds: [] },
  { rosterId: 4, ownerName: 'Cara', isMine: false, playerIds: ['rival-rb'] },
];

const BUDGETS: LeagueBudgetState = {
  rule: { total: 100, usesFaab: true, provenance: 'league settings' },
  rosters: ROSTERS.map((r) => ({
    rosterId: r.rosterId,
    ownerName: r.ownerName,
    isMine: r.isMine,
    spent: 20,
    remaining: 80,
    share: 0.8,
  })),
  notes: [],
};

const PRICES: PriceSummary = {
  sample: 18,
  median: 12,
  low: 6,
  high: 22,
  max: 44,
  highestLosing: 9,
  losingBidsComplete: false,
  confidence: 'high',
};

const BASELINE: LeagueTransactionBaseline = {
  seasons: ['2024', '2025'],
  managers: 4,
  weeksRead: 28,
  claimsPerWeek: 0.4,
  addsPerWeek: 0.4,
  churnPerWeek: 1,
  usesFaab: true,
  medianBidShare: 0.12,
  bidSample: 60,
  positionShare: [{ position: 'RB', share: 0.45 }],
  sample: 180,
};

/** Three rivals who all, on real samples, bid and claim well above the room. */
function aggressiveHistory() {
  const hot = (userId: string) => ({
    ...neutralTransactionProfile(userId),
    usable: true,
    sample: 60,
    activeWeeks: 28,
    bidSample: 30,
    confidence: 0.82,
    spendConfidence: 0.88,
    activityRelative: 1.4,
    spendRelative: 1.4,
    medianBidShare: 0.24,
    bigBidRate: 0.5,
    earlySpendShare: 0.2,
    byPosition: [{ position: 'RB', adds: 18, claims: 14, medianBidShare: 0.26, relative: 1.4 }],
    timing: [{ window: 'waiver' as const, share: 0.8 }],
  });
  return {
    profiles: new Map([
      [2, hot('u2')],
      [3, hot('u3')],
      [4, hot('u4')],
    ]),
    baseline: BASELINE,
    week: 6,
    finalWeek: 14,
  };
}

function intelFor(history?: ReturnType<typeof aggressiveHistory>) {
  return waiverLeagueIntel({
    advice: ADVICE,
    rosters: ROSTERS,
    players: PLAYERS,
    shape: SHAPE,
    budgets: BUDGETS,
    prices: PRICES,
    observations: [],
    history,
  });
}

function pricedFor(history?: ReturnType<typeof aggressiveHistory>) {
  const intel = intelFor(history);
  return {
    intel,
    bids: priceWaiverUpgrades({
      advice: ADVICE,
      strategy: { week: 6, finalWeek: 14, budget: BUDGETS, prices: PRICES, trending: new Map() },
      rosteredIds: new Set(['mine-rb', 'rival-rb']),
      competition: intel.competition,
    }),
  };
}

describe('waiver history moves the context and never the price', () => {
  it('leaves every recommended bid byte-identical with history on and off', () => {
    const without = pricedFor();
    const withHistory = pricedFor(aggressiveHistory());

    expect(withHistory.bids).toEqual(without.bids);
    for (const [i, bid] of withHistory.bids.entries()) {
      const base = without.bids[i]!;
      expect(bid.expected).toEqual(base.expected);
      expect(bid.recommended).toEqual(base.recommended);
      expect(bid.doNotExceed).toEqual(base.doNotExceed);
    }
  });

  it('leaves the competition count and label untouched', () => {
    const without = intelFor();
    const withHistory = intelFor(aggressiveHistory());
    expect([...withHistory.competition]).toEqual([...without.competition]);
  });

  it('leaves the candidate rows identical apart from the pressure field', () => {
    const without = withCompetition([...ADVICE.upgrades], intelFor().competition);
    const history = intelFor(aggressiveHistory());
    const withHistory = withCompetition([...ADVICE.upgrades], history.competition, history.bidders, history.pressure);

    for (const [u, upgrade] of withHistory.entries()) {
      for (const [c, candidate] of upgrade.candidates.entries()) {
        const base = without[u]!.candidates[c]! as unknown as Record<string, unknown>;
        const shown = candidate as unknown as Record<string, unknown>;
        for (const key of ['playerId', 'score', 'gain', 'reasons', 'position', 'role']) {
          expect(shown[key]).toEqual(base[key]);
        }
      }
    }
  });

  it('does say something, so the equalities above are not vacuous', () => {
    const history = intelFor(aggressiveHistory());
    const pressure = history.pressure.get('free-rb')!;
    expect(pressure.contested).toBe('likely_contested');
    expect(pressure.costFactor).toBeGreaterThan(1);
    expect(pressure.costContext!.high).toBeGreaterThan(PRICES.high!);
    expect(pressure.detail).toMatch(/RB/);

    // And with no history at all, it says nothing rather than something bland.
    expect(intelFor().pressure.get('free-rb')!.contested).toBe('unknown');
  });

  it('reports a rival cost context that is a context and not a recommendation', () => {
    const withHistory = pricedFor(aggressiveHistory());
    const pressure = withHistory.intel.pressure.get('free-rb')!;
    const bid = withHistory.bids[0]!;
    // They are allowed to differ. What is not allowed is the one moving the other.
    expect(pressure.costContext).not.toBeNull();
    expect(bid.recommended).toBe(pricedFor().bids[0]!.recommended);
  });
});

// ---------------------------------------------------------------------------

function tendencies(over: Partial<ManagerTradeTendencies> = {}): ManagerTradeTendencies {
  return {
    userId: 'u2',
    displayName: 'Alice',
    seasons: ['2024', '2025'],
    sample: 9,
    tradesPerSeason: 4.5,
    usable: true,
    plausibility: 'plausible',
    medianWeek: 6,
    preseasonShare: 0,
    meanReceived: 1,
    meanSent: 2,
    typicalShape: 'depth_for_starter',
    consolidationRate: 0.6,
    acquires: ['RB'],
    sends: ['WR'],
    repeatPartners: [{ userId: 'me', displayName: 'You', trades: 3 }],
    includesPicks: true,
    includesFaab: false,
    confidence: 0.6,
    notes: [],
    ...over,
  };
}

describe('trade history orders and labels, and decides nothing', () => {
  it('cannot outweigh a bilateral fit, by construction', () => {
    const best = partnerContext({
      tendencies: tendencies(),
      askingUserId: 'me',
      wantPosition: 'WR',
      seasonsObserved: 2,
    });
    const worst = partnerContext({
      tendencies: tendencies({ sample: 1, plausibility: 'thin_history', acquires: [], sends: [], repeatPartners: [] }),
      seasonsObserved: 3,
    });

    /*
     * The whole spread between the most and least promising partner this module
     * can describe. A fit score separates a good trade from a bad one by far
     * more than a tenth of a point, which is the sense in which behaviour cannot
     * rescue a poor fit — it is not a policy applied downstream, it is that the
     * number is too small to do it.
     */
    expect(Math.abs(best.orderingWeight - worst.orderingWeight)).toBeLessThanOrEqual(0.1);
  });

  it('leaves the verdict, urgency and confidence of a suggestion alone', () => {
    /*
     * `rankTrades` is the bilateral engine, and the partner context is attached
     * *after* it by `TradeService`. This asserts the separation is real: the
     * engine takes no history input, so ranking a board twice produces the same
     * verdicts whatever any manager has ever done.
     */
    const candidates = [
      {
        player: player('rival-rb', 'RB'),
        signal: null,
        ownership: 'other' as const,
        injury: null,
        outlook: null,
      },
    ];
    const first = rankTrades(candidates);
    const second = rankTrades(candidates);
    expect(second).toEqual(first);
    expect(Object.keys(first[0] ?? {})).not.toContain('partner');
  });
});
