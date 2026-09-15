/**
 * Weighting trade frequency, in the two places it was not being weighted.
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
import { candidate } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews, type RosterView } from '../src/core/trades/rosterUtility.ts';
import { OFFERS_BY_ACTIVITY, TRADE_BOUNDS, findBilateralTrades } from '../src/core/trades/bilateral.ts';
import { EDGE_TO_ACTIVE_TRADER, MANAGER_FIT_CAP, managerFitFor } from '../src/core/trades/managerFit.ts';
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
 * more good ideas than the cap allows — otherwise every activity class returns
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
    ['rb3', 'RB', 16],
    ['rb4', 'RB', 14],
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
  it('raises the per-partner cap for an active trader, and lowers it for a measured non-trader', () => {
    expect(OFFERS_BY_ACTIVITY.active).toBeGreaterThan(TRADE_BOUNDS.offersPerPartner);
    expect(OFFERS_BY_ACTIVITY.selective).toBeGreaterThan(OFFERS_BY_ACTIVITY.low_activity);
    expect(OFFERS_BY_ACTIVITY.effectively_inactive).toBeLessThan(TRADE_BOUNDS.offersPerPartner);
  });

  it('leaves a manager nobody has measured exactly where he was', () => {
    // §10, and the rule the previous round was written to restore: an
    // unmeasured manager must never be treated as a measured non-trader, and
    // must not be penalised for a backfill nobody has run.
    expect(OFFERS_BY_ACTIVITY.unknown).toBe(TRADE_BOUNDS.offersPerPartner);
    expect(boardFor(UNMEASURED).offers.length).toBeLessThanOrEqual(TRADE_BOUNDS.offersPerPartner);
  });

  it('actually sends more ideas to the manager who trades, on one league', () => {
    const active = boardFor(ACTIVE).offers;
    const quiet = boardFor(QUIET).offers;

    expect(active.length).toBeGreaterThan(quiet.length);
    expect(active.every((o) => o.partner.userId === 'u2')).toBe(true);
  });
});

describe('lean: an edge in your favour is worth more against somebody who replies', () => {
  const shaped = (activityFit: typeof ACTIVE | typeof QUIET, edgeToUser: boolean) =>
    managerFitFor({
      ...activityFit,
      askingUserId: 'u1',
      offer: { giving: 1, getting: 1, partnerReceives: ['WR'], partnerSends: ['RB'], edgeToUser },
    });

  it('pays an active trader for an edged offer, and pays nothing for an even one', () => {
    const edged = shaped(ACTIVE, true);
    const even = shaped(ACTIVE, false);

    expect(edged.contribution).toBeGreaterThan(even.contribution);
    expect(edged.terms.some((t) => t.key === 'edge_to_active_trader')).toBe(true);
    expect(even.terms.some((t) => t.key === 'edge_to_active_trader')).toBe(false);
  });

  it('does not nudge an edged offer toward a manager who does not trade', () => {
    // The suggestion least likely to land is the last one worth promoting.
    expect(shaped(QUIET, true).terms.some((t) => t.key === 'edge_to_active_trader')).toBe(false);
    expect(shaped(QUIET, true).contribution).toBe(shaped(QUIET, false).contribution);
  });

  it('stays inside the one cap the whole channel is bounded by', () => {
    for (const fit of [ACTIVE, QUIET]) {
      for (const edge of [true, false]) {
        expect(Math.abs(shaped(fit, edge).contribution)).toBeLessThanOrEqual(MANAGER_FIT_CAP);
      }
    }
    // A fraction of the cap, not a second cap beside it.
    expect(EDGE_TO_ACTIVE_TRADER).toBeLessThan(1);
    expect(EDGE_TO_ACTIVE_TRADER).toBeGreaterThan(0);
  });

  it('cannot widen what counts as fair, because it is never asked about that', () => {
    /*
     * `edgeToUser` is set only for the `edge_user` band, and anything past
     * `FAIRNESS_BANDS.edge` is rejected at gate 1 before a profile is read. So
     * the lean applies to offers the objective gates already permitted, and
     * there is no value of this term that reaches one they did not.
     */
    for (const offer of boardFor(ACTIVE).offers) {
      expect(offer.fairness.band).not.toBe('outside_range');
    }
  });
});

describe('and behaviour still reaches the score through one channel only', () => {
  it('leaves the objective part of every offer untouched, whoever the partner is', () => {
    /*
     * The invariant the whole reweighting rests on, and the reason the lean is
     * a term in `managerFit` rather than an adjustment to the fairness score.
     * An activity-aware fairness term would have been a second behavioural
     * channel wearing the first one's name — the double-count `RANK_WEIGHTS`
     * records as a real defect rather than a design choice.
     */
    const objective = [ACTIVE, QUIET, UNMEASURED].map((fit) => {
      const offer = boardFor(fit).offers[0]!;
      return Math.round((offer.breakdown.total - offer.breakdown.managerFit) * 1e6) / 1e6;
    });
    expect(new Set(objective).size).toBe(1);
  });
});
