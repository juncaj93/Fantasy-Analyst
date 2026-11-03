/**
 * Weighting trade frequency.
 *
 * November 2026 (review T3, T7, T11): Alex's rule is now partners who trade
 * often, fair to both sides. A measured manager who almost never trades gets
 * no idea at all, and the "lean my way for an active trader" term below is
 * gone: an idea more than 10% his way is outside the range for everybody.
 * The history of the September rule is kept for context.
 *
 * Alex, 15 September 2026: *managers who trade often should receive a higher
 * volume of suggested trades, and those trades should lean toward what benefits
 * me even if only mildly fair to the other side — a frequent trader is more
 * likely to engage with an imperfect-but-plausible offer than a rare trader is
 * with a perfect one.*
 *
 * A previous round raised `MANAGER_FIT_CAP` from 0.08 to 0.18 against the same
 * instruction, and that was half the change. Activity moved the *ordering* and
 * nothing else: every partner still got at most two offers, and an offer edged
 * in Alex's favour ranked exactly the same against a manager who trades weekly
 * as against one who has never replied. So a board of five reached five people
 * with two ideas each, which is not "a higher volume of suggested trades" for
 * anybody.
 *
 * Both halves are tested here, and so is the rule they had to be built around:
 * behaviour reaches the composite through exactly one capped channel, and
 * `total minus managerFit` is identical whoever the partner is.
 */

import { describe, expect, it } from 'vitest';
import { pricedCandidate as candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews, type RosterView } from '../src/core/trades/rosterUtility.ts';
import { OFFERS_BY_ACTIVITY, TRADE_BOUNDS, findBilateralTrades } from '../src/core/trades/bilateral.ts';
import { MANAGER_FIT_CAP, managerFitFor } from '../src/core/trades/managerFit.ts';
import type { ManagerTradeTendencies } from '../src/core/managers/tradeTendencies.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];
const profile = buildScoringProfile({}, POSITIONS);
const shape = buildRosterShape(POSITIONS);

type Spec = [id: string, position: string, points: number];

function tendencies(over: Partial<ManagerTradeTendencies> = {}): ManagerTradeTendencies {
  return {
    userId: 'u2',
    displayName: 'Two',
    sample: 9,
    tradesPerSeason: 4.5,
    acquires: [],
    sends: [],
    repeatPartners: [],
    shapes: [],
    ...over,
  } as unknown as ManagerTradeTendencies;
}

/** A manager the ledger has watched trade often, across complete seasons. */
const ACTIVE = { tendencies: tendencies(), seasonsObserved: 3, historyComplete: true, leagueRate: 1 };
/** One it has watched not trade at all. */
const QUIET = {
  tendencies: tendencies({ sample: 0, tradesPerSeason: 0 }),
  seasonsObserved: 3,
  historyComplete: true,
  leagueRate: 1,
};
/** And one nobody has measured. */
const UNMEASURED = { tendencies: null, seasonsObserved: 0, historyComplete: false, leagueRate: null };

/**
 * One league where several offers are genuinely viable against one partner.
 *
 * The per-partner cap is what this file is about, so the fixture has to have
 * more good, fair ideas (within 10% the user's way) than the cap allows — otherwise every activity class returns
 * the same board and the test passes by having nothing to measure.
 */
const DEEP: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['rb1', 'RB', 15],
    ['rb2', 'RB', 12],
    ['wr1', 'WR', 14],
    ['wr2', 'WR', 12],
    ['te1', 'TE', 9],
    ['wr3', 'WR', 11],
    ['wr6', 'WR', 10],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb3', 'RB', 15],
    ['rb4', 'RB', 13],
    ['rb5', 'RB', 12],
    ['rb6', 'RB', 11],
    ['wr4', 'WR', 13],
    ['te2', 'TE', 9],
    ['wr7', 'WR', 6],
  ],
};

function boardFor(fit: typeof ACTIVE | typeof QUIET | typeof UNMEASURED) {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(DEEP)) {
    for (const [id, position, points] of specs) pool.set(id, candidate(id, id.toUpperCase(), position, points));
  }
  const views: Map<string, RosterView> = buildRosterViews({
    rosters: Object.entries(DEEP).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
    pool,
    shape,
    profile,
  });
  return findBilateralTrades({
    me: views.get('1')!,
    partners: [
      {
        view: views.get('2')!,
        partner: { key: '2', rosterId: 2, displayName: 'Two', userId: 'u2' },
        fit: { ...fit, askingUserId: 'u1' },
      },
    ],
  });
}

describe('volume: a manager who trades gets more ideas', () => {
  it('raises the per-partner cap for an active trader, and sends a measured rare trader nothing', () => {
    expect(OFFERS_BY_ACTIVITY.active).toBeGreaterThan(TRADE_BOUNDS.offersPerPartner);
    expect(OFFERS_BY_ACTIVITY.selective).toBeGreaterThan(OFFERS_BY_ACTIVITY.low_activity);
    expect(OFFERS_BY_ACTIVITY.low_activity).toBe(0);
    expect(OFFERS_BY_ACTIVITY.effectively_inactive).toBe(0);
  });

  it('leaves a manager nobody has measured exactly where he was', () => {
    // A data gap is not a finding: an unmeasured manager is not skipped.
    expect(OFFERS_BY_ACTIVITY.unknown).toBe(TRADE_BOUNDS.offersPerPartner);
    expect(boardFor(UNMEASURED).offers.length).toBeLessThanOrEqual(TRADE_BOUNDS.offersPerPartner);
  });

  it('sends ideas to the manager who trades, and none to one who never does (review T11)', () => {
    const active = boardFor(ACTIVE);
    const quiet = boardFor(QUIET);

    expect(active.offers.length).toBeGreaterThan(0);
    expect(active.offers.every((o) => o.partner.userId === 'u2')).toBe(true);
    expect(quiet.offers).toEqual([]);
    expect(quiet.rejections.some((r) => r.reason === 'rare_trader')).toBe(true);
  });
});

describe('no lean: fair to both sides for every partner (review T3)', () => {
  const shaped = (activityFit: typeof ACTIVE | typeof QUIET) =>
    managerFitFor({
      ...activityFit,
      askingUserId: 'u1',
      offer: { giving: 1, getting: 1, partnerReceives: ['WR'], partnerSends: ['RB'] },
    });

  it('has no term that pays an active trader for an offer edged the user’s way', () => {
    expect(shaped(ACTIVE).terms.some((t) => t.key === 'edge_to_active_trader')).toBe(false);
  });

  it('stays inside the one cap the whole channel is bounded by', () => {
    for (const fit of [ACTIVE, QUIET]) expect(Math.abs(shaped(fit).contribution)).toBeLessThanOrEqual(MANAGER_FIT_CAP);
  });

  it('shows an active trader nothing more than 10% the user’s way', () => {
    for (const offer of boardFor(ACTIVE).offers) {
      expect(offer.fairness.band).not.toBe('outside_range');
      expect(offer.fairness.gap).toBeLessThanOrEqual(0.105);
    }
  });
});

describe('and behaviour still reaches the score through one channel only', () => {
  it('leaves the objective part of every offer untouched, whoever the partner is', () => {
    const objective = [ACTIVE, UNMEASURED].map((fit) => {
      const offer = boardFor(fit).offers[0]!;
      return Math.round((offer.breakdown.total - offer.breakdown.managerFit) * 1e6) / 1e6;
    });
    expect(new Set(objective).size).toBe(1);
  });
});
