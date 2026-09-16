/**
 * What a claim costs when the league has been measured and nobody else wants him.
 *
 * Production, 16 September 2026, one card:
 *
 *     BID Bryce Young  expected=$14-29  recommended=$7  worth=7
 *       reasons: [... "Contested: several funded rosters can use him."]
 *     CLAIM {add: "Bryce Young", drop: "KC Concepcion", bid: 7}
 *       why: [... "Nobody else needs him - 0 of 9 teams need QB."]
 *
 * The two sentences are on the same card, four lines apart, and they contradict
 * each other. The $14-29 was the widest band on a board whose four other rows
 * sat at $8-15 — the *least* contested player priced as the most.
 *
 * Two separate faults produced it and both are pinned here:
 *
 *   1. `rivalsFor` returned `null` for a measured zero, and `null` means *no
 *      information* to `demandLevel`, which then averaged nothing but global
 *      trending heat;
 *   2. demand never reached the recommendation at all — only the expected
 *      price — so an uncontested player was still advised at his full private
 *      valuation, which is money spent beating nobody.
 */

import { describe, expect, it } from 'vitest';
import { buildBudgetState } from '../src/core/faab/budget.ts';
import { demandLevel, recommendBid, UNCONTESTED_BID, type BidInputs } from '../src/core/faab/strategy.ts';
import { priceWaiverUpgrades } from '../src/core/waivers/pricing.ts';
import type { CompetitionAssessment } from '../src/core/league/competition.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';

const SEASON = { week: 2, finalWeek: 14 };

/** Nine rivals, every one of them holding the full budget, as in the league. */
function budgetState() {
  return buildBudgetState({
    leagueSettings: { waiver_type: 2, waiver_budget: 100 },
    rosters: [
      { rosterId: 1, ownerName: 'Me', isMine: true, settings: { waiver_budget_used: 0 } },
      ...Array.from({ length: 9 }, (_, i) => ({
        rosterId: i + 2,
        ownerName: `M${i + 2}`,
        isMine: false,
        settings: { waiver_budget_used: 0 },
      })),
    ],
  });
}

const NO_HISTORY: PriceSummary = {
  sample: 0,
  median: null,
  low: null,
  high: null,
  max: null,
  highestLosing: null,
  losingBidsComplete: true,
  confidence: 'none',
};

function inputs(over: Partial<BidInputs> = {}): BidInputs {
  return {
    playerId: '9228',
    name: 'Bryce Young',
    position: 'QB',
    weeklyGain: 3.2,
    gainOverReplacement: null,
    roleStability: 'unknown',
    shelfLife: 'unknown',
    futureOpportunity: 'normal',
    /* Hot everywhere, wanted nowhere here — the bargain this is all for. */
    marketHeat: 0.84,
    rivalsWithNeed: 0,
    ...over,
  };
}

function bid(over: Partial<BidInputs> = {}) {
  return recommendBid({ inputs: inputs(over), budgetState: budgetState(), prices: NO_HISTORY, season: SEASON });
}

describe('a measured zero is a reading, not an absence', () => {
  it('counts zero rivals as zero demand rather than as no information', () => {
    const measured = demandLevel(inputs({ rivalsWithNeed: 0 }), budgetState());
    const unmeasured = demandLevel(inputs({ rivalsWithNeed: null }), budgetState());

    /*
     * Heat alone is 0.84. Averaged with a local reading of nought it is 0.42,
     * and the gap between those two numbers is the whole defect: one is a
     * player the room wants, the other is a player only the internet wants.
     */
    expect(unmeasured).toBeCloseTo(0.84, 2);
    expect(measured).toBeCloseTo(0.42, 2);
    expect(measured).toBeLessThan(unmeasured);
  });

  it('prices an uncontested player below a contested one rather than above', () => {
    const uncontested = bid({ rivalsWithNeed: 0 });
    const contested = bid({ rivalsWithNeed: 4 });

    expect(uncontested.expected!.high).toBeLessThan(contested.expected!.high);
  });
});

describe('the recommendation, not just the forecast', () => {
  it('bids the minimum when nobody else in the league needs the position', () => {
    expect(bid({ rivalsWithNeed: 0 }).recommended).toBe(UNCONTESTED_BID);
  });

  it('still bids his full worth when the competition read is absent', () => {
    const unmeasured = bid({ rivalsWithNeed: null });
    expect(unmeasured.recommended).toBe(unmeasured.worth);
    expect(unmeasured.recommended).toBeGreaterThan(UNCONTESTED_BID);
  });

  it('keeps the ceiling at what he is worth, so a reader who disagrees can see how far to go', () => {
    const uncontested = bid({ rivalsWithNeed: 0 });
    expect(uncontested.recommended).toBe(UNCONTESTED_BID);
    expect(uncontested.doNotExceed!).toBeGreaterThan(UNCONTESTED_BID);
    expect(uncontested.worth!).toBeGreaterThan(UNCONTESTED_BID);
  });

  it('never advises more than a player is worth just because he is uncontested', () => {
    /* A player worth nothing stays at nothing; the floor is not a raise. */
    const worthless = bid({ rivalsWithNeed: 0, weeklyGain: 0, gainOverReplacement: 0 });
    expect(worthless.recommended).toBe(0);
  });
});

describe('the sentence on the card', () => {
  it('says nobody needs him instead of saying he is contested', () => {
    const reasons = bid({ rivalsWithNeed: 0 }).reasons.join(' ');
    expect(reasons).toContain('Nobody else in this league needs the position');
    expect(reasons).not.toContain('Contested');
  });

  it('still says contested when the league actually is', () => {
    expect(bid({ rivalsWithNeed: 4, marketHeat: 0.9 }).reasons.join(' ')).toContain('Contested');
  });
});

describe('the pricing pass hands the zero over', () => {
  const upgrade = {
    slot: 'QB',
    accepts: ['QB'],
    need: 'upgrade' as const,
    currentPlayerId: 'burrow',
    currentName: 'Joe Burrow',
    currentScore: 21.8,
    bar: 3,
    candidates: [
      {
        playerId: '9228',
        name: 'Bryce Young',
        position: 'QB',
        team: 'CAR',
        score: 24.98,
        gain: 3.18,
        reasons: ['Market rising — 25.1 vs 19.6 pts expected'],
        statusFlag: null,
        role: { trend: 'insufficient_data' as const, games: 1 },
      },
    ],
  };

  const strategy = {
    week: 2,
    finalWeek: 14,
    budget: budgetState(),
    prices: NO_HISTORY,
    trending: new Map([
      [
        '9228',
        {
          playerId: '9228',
          rank: 3,
          count: 4000,
          addsPerHour: 166,
          rankMovement: 4,
          acceleration: 2.1,
          entered: false,
          heat: 0.84,
        },
      ],
    ]),
  };

  function assessed(effectiveBidders: number): Map<string, CompetitionAssessment> {
    return new Map([
      [
        '9228',
        {
          level: 'none',
          label: 'No competition',
          detail: '0 of 9 teams need QB',
          needyTeams: 0,
          bidders: [],
          effectiveBidders,
        } as unknown as CompetitionAssessment,
      ],
    ]);
  }

  it('reaches the bid, and not only the expected band', () => {
    const [priced] = priceWaiverUpgrades({
      advice: { upgrades: [upgrade] },
      strategy,
      rosteredIds: new Set<string>(),
      competition: assessed(0),
    });

    expect(priced!.recommended).toBe(UNCONTESTED_BID);
    expect(priced!.reasons.join(' ')).toContain('Nobody else in this league needs the position');
  });

  it('leaves a genuinely contested claim alone', () => {
    const [priced] = priceWaiverUpgrades({
      advice: { upgrades: [upgrade] },
      strategy,
      rosteredIds: new Set<string>(),
      competition: assessed(3),
    });

    expect(priced!.recommended).toBeGreaterThan(UNCONTESTED_BID);
  });

  it('falls back to the blunt roster count when nothing was assessed', () => {
    const [priced] = priceWaiverUpgrades({
      advice: { upgrades: [upgrade] },
      strategy,
      rosteredIds: new Set<string>(),
    });

    /* Nine funded rivals, capped at four — the behaviour that predates the pass. */
    expect(priced!.recommended).toBeGreaterThan(UNCONTESTED_BID);
  });
});
