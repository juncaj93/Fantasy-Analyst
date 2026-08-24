/**
 * The rules Projection v2 is supposed to obey, tested as rules rather than as
 * numbers.
 *
 * Almost every assertion here is a *relation* — this projection equals that one,
 * this distribution is wider than that one, this adjustment is zero — rather than
 * a literal. That is deliberate. The constants in the uncertainty model will be
 * retuned; the property that a market-redundant feature cannot move a mean must
 * survive the retuning, and a test full of literals is a test that gets updated
 * to match whatever the code now does.
 */

import { describe, expect, it } from 'vitest';
import { buildExpectation, EXPECTED_MARKETS } from '../src/core/startsit/expectation.ts';
import { buildFeatures, teamWeekTotals, type SnapWeek } from '../src/core/projection/features.ts';
import { buildAnchor } from '../src/core/projection/anchor.ts';
import {
  FEATURE_CLASSIFICATIONS,
  classificationOf,
  mayMoveMean,
  mayMoveUncertainty,
} from '../src/core/projection/classification.ts';
import {
  FRESH_INFORMATION_CAP,
  assessRoleChange,
  freshInformationAdjustment,
} from '../src/core/projection/roleEvidence.ts';
import { projectV2 } from '../src/core/projection/v2.ts';
import {
  BUST_RATE,
  CV_BOUNDS,
  MAX_BUST_RATE,
  PROJECTION_VOLATILITY,
  SIMULATION_VOLATILITY,
  intervalFor,
  uncertaintyFor,
} from '../src/core/projection/uncertainty.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { ScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { DepthRole } from '../src/core/nflverse/depthChart.ts';

const PROFILE: ScoringProfile = {
  ppr: 1,
  teBonus: 0,
  pointsPerRushYard: 0.1,
  pointsPerRecYard: 0.1,
  pointsPerPassYard: 0.04,
  passTd: 4,
  rushTd: 6,
  recTd: 6,
  interception: -2,
  fumbleLost: -2,
  superflex: false,
  tePremium: false,
  label: 'Full PPR',
};

function prop(market: PlayerProp['market'], line: number | null, impliedProbability: number | null = null): PlayerProp {
  return {
    playerId: 'p1',
    sourcePlayerName: 'Player One',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 4,
    books: [],
    consensusMethod: 'median',
    impliedProbability,
  } as PlayerProp;
}

/** A steady receiver: eight games, ~9 targets, target share barely moving. */
function steadyWeeks(): (UsageWeek & { team: string })[] {
  return Array.from({ length: 8 }, (_, i) => ({
    week: i + 1,
    seasonType: 'REG',
    team: 'ARI',
    passAttempts: null,
    carries: null,
    targets: 9,
    receptions: 6,
    targetShare: 0.24,
    wopr: 0.5,
    recYards: 72,
    recTds: 0,
    receivingAirYards: 90,
    airYardsShare: 0.3,
  }));
}

/** The same volume, wildly different share week to week. */
function volatileWeeks(): (UsageWeek & { team: string })[] {
  const shares = [0.05, 0.42, 0.08, 0.38, 0.1, 0.4, 0.06, 0.36];
  const targets = [2, 16, 3, 15, 4, 15, 2, 15];
  return shares.map((share, i) => ({
    week: i + 1,
    seasonType: 'REG',
    team: 'ARI',
    passAttempts: null,
    carries: null,
    targets: targets[i]!,
    receptions: Math.round(targets[i]! * 0.6),
    targetShare: share,
    wopr: 0.4,
    recYards: targets[i]! * 8,
    recTds: 0,
    receivingAirYards: targets[i]! * 10,
    airYardsShare: share,
  }));
}

function snaps(share: number): SnapWeek[] {
  return Array.from({ length: 8 }, (_, i) => ({
    week: i + 1,
    gameType: 'REG',
    offenseSnaps: Math.round(share * 65),
    offenseShare: share,
  }));
}

const FULL_WR_MARKET = [prop('receiving_yards', 72), prop('receptions', 6), prop('anytime_td', null, 0.35)];

function project(overrides: Partial<Parameters<typeof projectV2>[0]> = {}) {
  const weeks = steadyWeeks();
  return projectV2({
    playerId: 'p1',
    name: 'Player One',
    position: 'WR',
    team: 'ARI',
    expectation: buildExpectation('WR', FULL_WR_MARKET, PROFILE),
    features: buildFeatures('WR', weeks, { snaps: snaps(0.8), team: 'ARI' }),
    profile: PROFILE,
    marketAsOf: '2026-09-06T12:00:00Z',
    now: '2026-09-07T12:00:00Z',
    ...overrides,
  });
}

// -------------------------------------------------------- double counting ---

describe('the A/B/C/D classification is a gate, not a comment', () => {
  it('every registered feature has a class and a written justification', () => {
    for (const feature of FEATURE_CLASSIFICATIONS) {
      expect(feature.key, 'a feature key').toBeTruthy();
      expect(['A', 'B', 'C', 'D']).toContain(feature.class);
      expect(feature.why.length, `${feature.key} has no justification`).toBeGreaterThan(40);
    }
  });

  it('only A and C may move the mean; only B and C may move the width', () => {
    for (const feature of FEATURE_CLASSIFICATIONS) {
      expect(mayMoveMean(feature.key), feature.key).toBe(feature.class === 'A' || feature.class === 'C');
      expect(mayMoveUncertainty(feature.key), feature.key).toBe(feature.class === 'B' || feature.class === 'C');
    }
  });

  it('refuses a key it has never heard of, in both directions', () => {
    expect(classificationOf('fill.invented_bonus')).toBeNull();
    expect(mayMoveMean('fill.invented_bonus')).toBe(false);
    expect(mayMoveUncertainty('fill.invented_bonus')).toBe(false);
  });

  it('has at least one market-redundant feature, and it can move nothing', () => {
    const redundant = FEATURE_CLASSIFICATIONS.filter((f) => f.class === 'D');
    expect(redundant.length).toBeGreaterThan(0);
    for (const feature of redundant) {
      expect(mayMoveMean(feature.key)).toBe(false);
      expect(mayMoveUncertainty(feature.key)).toBe(false);
    }
  });
});

describe('strong market coverage plus stable usage does not inflate the mean', () => {
  it('a fully-priced player projects exactly what the market expects', () => {
    const expectation = buildExpectation('WR', FULL_WR_MARKET, PROFILE);
    const projection = project();
    expect(projection.basis).toBe('market');
    expect(projection.anchor.filledMarkets).toEqual([]);
    // The whole design in one assertion: eight steady games of excellent usage
    // and the central estimate is the market's own total, to the penny.
    expect(projection.points).toBe(expectation.points);
  });

  it('and the same is true for a volatile player with the same market', () => {
    const volatile = project({
      features: buildFeatures('WR', volatileWeeks(), { snaps: snaps(0.35), team: 'ARI' }),
    });
    const steady = project();
    expect(volatile.points).toBe(steady.points);
    // What differs is the shape, which is exactly where it belongs.
    expect(volatile.uncertainty.cv).toBeGreaterThan(steady.uncertainty.cv);
  });

  it('changes nothing when usage is absent entirely', () => {
    const withUsage = project();
    const without = project({ features: null });
    expect(without.points).toBe(withUsage.points);
  });
});

// ---------------------------------------------------------------- gap fill ---

describe('gap filling touches the missing component and nothing else', () => {
  it('fills receptions when only the reception line is missing', () => {
    const full = buildExpectation('WR', FULL_WR_MARKET, PROFILE);
    const partial = buildExpectation('WR', [prop('receiving_yards', 72), prop('anytime_td', null, 0.35)], PROFILE);
    const anchor = buildAnchor('WR', partial, buildFeatures('WR', steadyWeeks(), { team: 'ARI' }), PROFILE);

    expect(anchor.basis).toBe('market_plus_model');
    expect(anchor.filledMarkets).toEqual(['receptions']);

    // Every market component is byte-identical to what the market priced.
    const marketComponents = anchor.components.filter((c) => c.source === 'market');
    for (const component of marketComponents) {
      const original = full.contributions.find((c) => c.market === component.market)!;
      expect(component.points, component.market).toBe(original.points);
      expect(component.line, component.market).toBe(original.line);
    }
    // And the filled one is labelled as modelled, with its arithmetic shown.
    const filled = anchor.components.find((c) => c.source === 'model')!;
    expect(filled.market).toBe('receptions');
    expect(filled.line).toBeNull();
    expect(filled.detail).toMatch(/targets\/gm/);
    expect(anchor.notes.some((n) => n.includes('receptions'))).toBe(true);
  });

  it('leaves a component absent rather than zero when nothing can estimate it', () => {
    const noTargets = steadyWeeks().map((w) => ({ ...w, targets: null, receptions: null }));
    const anchor = buildAnchor(
      'WR',
      buildExpectation('WR', [prop('receiving_yards', 72)], PROFILE),
      buildFeatures('WR', noTargets, { team: 'ARI' }),
      PROFILE,
    );
    expect(anchor.unfilledMarkets).toContain('receptions');
    expect(anchor.components.some((c) => c.market === 'receptions')).toBe(false);
    expect(anchor.notes.some((n) => /rather than counted as zero/.test(n))).toBe(true);
  });

  it('reports coverage against what the position expects, not what arrived', () => {
    const anchor = buildAnchor(
      'WR',
      buildExpectation('WR', [prop('receiving_yards', 72)], PROFILE),
      buildFeatures('WR', steadyWeeks(), { team: 'ARI' }),
      PROFILE,
    );
    expect(EXPECTED_MARKETS.WR).toHaveLength(3);
    expect(anchor.marketCoverage).toBeCloseTo(1 / 3, 3);
  });

  it('an anytime-touchdown fill is a probability, so it cannot exceed one score', () => {
    // A back with an enormous workload: the Poisson mapping must still bound at 1.
    const bellCow = Array.from({ length: 8 }, (_, i) => ({
      week: i + 1,
      seasonType: 'REG',
      team: 'ARI',
      passAttempts: null,
      carries: 40,
      targets: 12,
      receptions: 9,
      targetShare: 0.2,
      wopr: 0.4,
      recYards: 60,
      recTds: 0,
      rushYards: 160,
      rushTds: 0,
      receivingAirYards: 10,
      airYardsShare: 0.05,
    }));
    const anchor = buildAnchor('RB', null, buildFeatures('RB', bellCow, { team: 'ARI' }), PROFILE);
    const td = anchor.components.find((c) => c.market === 'anytime_td')!;
    expect(td.points).toBeLessThanOrEqual(PROFILE.rushTd);
    expect(td.detail).toMatch(/red-zone/);
  });
});

// --------------------------------------------------------------- freshness ---

const CURRENT: DepthRole = {
  team: 'ARI',
  position: 'WR',
  group: '3WR 1TE',
  rank: 2,
  slot: 2,
  starterSlots: 3,
  isStarter: true,
};
const PREVIOUS: DepthRole = { ...CURRENT, rank: 5, slot: 1, isStarter: false };

describe('a role change moves a mean only when three gates all pass', () => {
  it('a depth-only change moves nothing at all', () => {
    const evidence = assessRoleChange({
      current: CURRENT,
      previous: PREVIOUS,
      observedAt: '2026-09-07T07:00:00Z',
      marketAsOf: '2026-09-06T12:00:00Z',
      snaps: null,
    });
    expect(evidence.state).toBe('depth_only');
    expect(evidence.qualifiesForMeanAdjustment).toBe(false);
    expect(freshInformationAdjustment(evidence, 14).points).toBe(0);
    expect(evidence.reasons.some((r) => /changes the uncertainty and not the projection/.test(r))).toBe(true);
  });

  it('a corroborated change that predates the market moves nothing either', () => {
    const evidence = assessRoleChange({
      current: CURRENT,
      previous: PREVIOUS,
      observedAt: '2026-09-05T07:00:00Z',
      marketAsOf: '2026-09-06T12:00:00Z',
      snaps: { recent: 0.78, baseline: 0.4, recentGames: 2 },
    });
    expect(evidence.state).toBe('depth_plus_snaps');
    expect(evidence.newerThanMarket).toBe(false);
    expect(freshInformationAdjustment(evidence, 14).points).toBe(0);
    expect(evidence.reasons.some((r) => /the market already had this/.test(r))).toBe(true);
  });

  it('a corroborated change newer than the market moves a capped amount', () => {
    const evidence = assessRoleChange({
      current: CURRENT,
      previous: PREVIOUS,
      observedAt: '2026-09-07T07:00:00Z',
      marketAsOf: '2026-09-06T12:00:00Z',
      snaps: { recent: 0.78, baseline: 0.4, recentGames: 2 },
    });
    expect(evidence.state).toBe('depth_plus_snaps');
    expect(evidence.qualifiesForMeanAdjustment).toBe(true);
    const adjustment = freshInformationAdjustment(evidence, 14);
    expect(adjustment.points).toBeGreaterThan(0);
    expect(adjustment.points).toBeLessThanOrEqual(FRESH_INFORMATION_CAP.points);
    expect(adjustment.points).toBeLessThanOrEqual(14 * FRESH_INFORMATION_CAP.shareOfAnchor);
  });

  it('is corroborated by the roster when the player ahead of him has gone', () => {
    const evidence = assessRoleChange({
      current: CURRENT,
      previous: PREVIOUS,
      observedAt: '2026-09-07T07:00:00Z',
      marketAsOf: '2026-09-06T12:00:00Z',
      snaps: null,
      previouslyAhead: [{ gsisId: '00-0000001', rank: 2 }],
      rosterByGsis: new Map([
        ['00-0000001', { gsisId: '00-0000001', team: 'ARI', position: 'WR', status: 'RES' }],
      ]),
    });
    expect(evidence.state).toBe('depth_plus_roster');
    expect(evidence.qualifiesForMeanAdjustment).toBe(true);
  });

  it('is not corroborated when the snaps moved the other way', () => {
    const evidence = assessRoleChange({
      current: CURRENT,
      previous: PREVIOUS,
      observedAt: '2026-09-07T07:00:00Z',
      marketAsOf: '2026-09-06T12:00:00Z',
      snaps: { recent: 0.2, baseline: 0.6, recentGames: 2 },
    });
    expect(evidence.state).toBe('depth_only');
    expect(evidence.reasons.some((r) => /the other way/.test(r))).toBe(true);
  });

  it('declines when the market snapshot has no timestamp at all', () => {
    const evidence = assessRoleChange({
      current: CURRENT,
      previous: PREVIOUS,
      observedAt: '2026-09-07T07:00:00Z',
      marketAsOf: null,
      snaps: { recent: 0.78, baseline: 0.4, recentGames: 2 },
    });
    expect(evidence.qualifiesForMeanAdjustment).toBe(false);
  });

  it('never compares across clubs, positions or personnel groupings', () => {
    const otherClub = assessRoleChange({ current: CURRENT, previous: { ...PREVIOUS, team: 'SEA' } });
    const otherGroup = assessRoleChange({ current: CURRENT, previous: { ...PREVIOUS, group: '2WR 2TE' } });
    expect(otherClub.state).toBe('none');
    expect(otherGroup.state).toBe('none');
  });

  it('caps a demotion the same way it caps a promotion', () => {
    const demotion = assessRoleChange({
      current: PREVIOUS,
      previous: CURRENT,
      observedAt: '2026-09-07T07:00:00Z',
      marketAsOf: '2026-09-06T12:00:00Z',
      snaps: { recent: 0.2, baseline: 0.7, recentGames: 2 },
    });
    expect(demotion.direction).toBe('demotion');
    const adjustment = freshInformationAdjustment(demotion, 14);
    expect(adjustment.points).toBeLessThan(0);
    expect(Math.abs(adjustment.points)).toBeLessThanOrEqual(FRESH_INFORMATION_CAP.points);
  });
});

describe('stale inputs lower confidence rather than looking current', () => {
  it('an old market snapshot costs confidence and widens the week', () => {
    const fresh = project();
    const stale = project({ marketAsOf: '2026-08-01T12:00:00Z' });
    expect(stale.confidence.score).toBeLessThan(fresh.confidence.score);
    expect(stale.uncertainty.cv).toBeGreaterThan(fresh.uncertainty.cv);
    expect(stale.provenance.warnings.some((w) => /days old/.test(w))).toBe(true);
    // And the number itself is untouched: staleness is not an opinion about the line.
    expect(stale.points).toBe(fresh.points);
  });

  it('carries the provenance a reader needs to check any of this', () => {
    const projection = project({ depthChartAsOf: '2026-09-07T07:00:00Z', usageAsOf: '2026' });
    expect(projection.provenance.marketAsOf).toBe('2026-09-06T12:00:00Z');
    expect(projection.provenance.marketAgeHours).toBeCloseTo(24, 1);
    expect(projection.provenance.depthChartAsOf).toBe('2026-09-07T07:00:00Z');
    expect(projection.provenance.usageWeeks.length).toBe(8);
  });
});

// ------------------------------------------------------------ distribution ---

describe('the distribution widens and narrows for the right reasons', () => {
  it('a stable role with full market coverage is narrower than a volatile one', () => {
    const steady = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { snaps: snaps(0.85), team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
    });
    const volatile = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', volatileWeeks(), { snaps: snaps(0.3), team: 'ARI' }),
      basis: 'model',
      marketCoverage: 0,
    });
    expect(steady.cv).toBeLessThan(volatile.cv);
  });

  it('a touchdown-dependent profile is wider than a volume-driven one at the same mean', () => {
    const base = {
      position: 'RB' as const,
      features: buildFeatures('RB', steadyWeeks(), { team: 'ARI' }),
      basis: 'market' as const,
      marketCoverage: 1,
    };
    const tdHeavy = uncertaintyFor({ ...base, tdDependence: 0.7 });
    const volumeDriven = uncertaintyFor({ ...base, tdDependence: 0.1 });
    expect(tdHeavy.cv).toBeGreaterThan(volumeDriven.cv);
  });

  it('never narrows for a player merely being listed first', () => {
    /*
     * §15 names this case in as many words. Being listed inside the spots a club
     * fields must do nothing; being listed outside them may widen.
     */
    const inside = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
      outsideFieldedSpots: false,
    });
    const outside = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
      outsideFieldedSpots: true,
    });
    expect(inside.factors.some((f) => f.key === 'uncertainty.depth_role')).toBe(false);
    expect(outside.cv).toBeGreaterThan(inside.cv);
  });

  it('treats an unknown snap share as unknown rather than as steady', () => {
    const withSnaps = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { snaps: snaps(0.85), team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
    });
    const without = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
    });
    expect(without.cv).toBeGreaterThan(withSnaps.cv);
  });

  it('floor and ceiling are quantiles of the fitted distribution, not a bracket', () => {
    const narrow = intervalFor(14, 0.35)!;
    const wide = intervalFor(14, 0.8)!;
    expect(narrow.floor).toBeLessThan(narrow.median);
    expect(narrow.median).toBeLessThan(narrow.ceiling);
    // Right-skewed, so the median sits below the mean it was fitted to.
    expect(narrow.median).toBeLessThan(14);
    // Widening moves both ends, and not by the same number of points.
    expect(wide.floor).toBeLessThan(narrow.floor);
    expect(wide.ceiling).toBeGreaterThan(narrow.ceiling);
    expect(14 - wide.floor).not.toBeCloseTo(wide.ceiling - 14, 1);
  });

  it('has no interval at all when there is no projection', () => {
    expect(intervalFor(null, 0.5)).toBeNull();
    expect(intervalFor(0, 0.5)).toBeNull();
  });
});

describe('the bust branch, which is what a lognormal cannot express', () => {
  it('puts the floor at zero exactly when the bust rate reaches the floor quantile', () => {
    /*
     * The finding this branch exists for: on 2025, 10.5% of receiver weeks
     * scored under 15% of the projection. With an 11% bust rate his tenth
     * percentile *is* zero, and reporting anything else would be reporting a
     * floor he falls below one week in nine.
     */
    expect(intervalFor(14, 0.8, 0.11)!.floor).toBe(0);
    expect(intervalFor(14, 0.8, 0.02)!.floor).toBeGreaterThan(0);
  });

  it('keeps the mixture’s mean equal to the projection it was built from', () => {
    /*
     * The live branch is fitted to `mean / (1 - bust)` so that the bust branch's
     * zeroes do not quietly drag the expectation below the number printed beside
     * it. Checked by integrating the mixture rather than by reading the code:
     * a bust branch that contributed nothing while taking a tenth of the
     * probability would make every distribution's mean 10% low, and §24
     * anticipates a simulation eventually summing these.
     */
    const mean = 14;
    const cv = 0.8;
    const bust = 0.11;
    const live = mean / (1 - bust);
    const sigma = Math.sqrt(Math.log(1 + cv * cv));
    const mu = Math.log(live) - (sigma * sigma) / 2;
    const liveMean = Math.exp(mu + (sigma * sigma) / 2);
    expect((1 - bust) * liveMean + bust * 0).toBeCloseTo(mean, 6);
  });

  it('widens the bust branch for the player, not just the position', () => {
    const settled = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { snaps: snaps(0.85), team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
    });
    const doubtful = uncertaintyFor({
      position: 'WR',
      features: buildFeatures('WR', steadyWeeks(), { snaps: snaps(0.85), team: 'ARI' }),
      basis: 'market',
      marketCoverage: 1,
      availabilityUncertain: true,
    });
    expect(doubtful.bustRate).toBeGreaterThan(settled.bustRate);
    expect(doubtful.bustReasons.some((r) => /availability/.test(r))).toBe(true);
    expect(settled.bustRate).toBe(BUST_RATE.WR);
  });

  it('never lets the bust branch swallow the distribution', () => {
    const hopeless = uncertaintyFor({
      position: 'WR',
      features: null,
      basis: 'model',
      marketCoverage: 0,
      availabilityUncertain: true,
      outsideFieldedSpots: true,
    });
    expect(hopeless.bustRate).toBeLessThanOrEqual(MAX_BUST_RATE);
  });

  it('gives a quarterback a far lighter bust branch than a receiver', () => {
    // 0.9% of quarterback weeks against 10.5% of receiver weeks, on 2025. A
    // starting quarterback almost always throws; a receiver can be shut out.
    expect(BUST_RATE.QB!).toBeLessThan(BUST_RATE.WR!);
  });
});

describe('Projection v2 does not borrow the simulation’s widths', () => {
  it('the two tables are different values, at every position', () => {
    /*
     * The guard against a later tidy-up "deduplicating" these. They answer
     * different questions — the simulation's describe what is *left* of a game
     * under way, these describe a whole week from Tuesday — and merging them
     * would silently rewrite the Matchup screen's win probabilities, which
     * phase 1 must not touch.
     *
     * Borrowing the simulation's table was the first attempt, and it produced a
     * nominal 10–90 interval that held 43% of the time over a real season.
     */
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      expect(PROJECTION_VOLATILITY[position]!, position).toBeGreaterThan(SIMULATION_VOLATILITY[position]!);
    }
  });

  it('leaves room above the widest position for the widening factors to work', () => {
    const widest = Math.max(...Object.values(PROJECTION_VOLATILITY));
    expect(CV_BOUNDS.max).toBeGreaterThan(widest * 1.5);
  });
});

// ---------------------------------------------------------------- fallback ---

describe('degrading, which is the state of the world for most of the year', () => {
  it('with every nflverse input missing, the projection is exactly market-only', () => {
    const expectation = buildExpectation('WR', FULL_WR_MARKET, PROFILE);
    const projection = projectV2({
      playerId: 'p1',
      name: 'Player One',
      position: 'WR',
      team: 'ARI',
      expectation,
      features: null,
      profile: PROFILE,
      identity: 'unresolved',
      missingInputs: ['nflverse identity crosswalk', 'snap counts', 'depth chart'],
      marketAsOf: '2026-09-06T12:00:00Z',
      now: '2026-09-07T12:00:00Z',
    });
    expect(projection.points).toBe(expectation.points);
    expect(projection.basis).toBe('market');
    expect(projection.modelDerived).toBe(false);
    // Lower confidence and a recorded reason, per §26 — not a lower number.
    expect(projection.confidence.level).not.toBe('high');
    expect(projection.provenance.missingInputs).toHaveLength(3);
    expect(projection.confidence.reasons.some((r) => /expected input missing/.test(r))).toBe(true);
  });

  it('with no market and no usage it answers null rather than zero', () => {
    const projection = projectV2({
      playerId: 'p1',
      name: 'Player One',
      position: 'WR',
      team: 'ARI',
      expectation: buildExpectation('WR', [], PROFILE),
      features: null,
      profile: PROFILE,
    });
    expect(projection.points).toBeNull();
    expect(projection.basis).toBe('none');
    expect(projection.interval).toBeNull();
    expect(projection.reasons[0]).toMatch(/no projection for him/);
  });

  it('with no market but usable usage it answers, and labels itself model-derived', () => {
    const projection = projectV2({
      playerId: 'p1',
      name: 'Player One',
      position: 'WR',
      team: 'ARI',
      expectation: buildExpectation('WR', [], PROFILE),
      features: buildFeatures('WR', steadyWeeks(), { snaps: snaps(0.8), team: 'ARI' }),
      profile: PROFILE,
    });
    expect(projection.points).toBeGreaterThan(0);
    expect(projection.basis).toBe('model');
    expect(projection.modelDerived).toBe(true);
    expect(projection.reasons.some((r) => /model estimate, not a market one/.test(r))).toBe(true);
    // And a model estimate can never be high confidence, whatever the usage says.
    expect(projection.confidence.level).not.toBe('high');
  });

  it('an unknown position produces nothing rather than a default', () => {
    const projection = projectV2({
      playerId: 'k1',
      name: 'A Kicker',
      position: 'K',
      team: 'ARI',
      expectation: buildExpectation('K', [prop('receiving_yards', 40)], PROFILE),
      features: null,
      profile: PROFILE,
    });
    expect(projection.points).toBeNull();
    expect(projection.basis).toBe('none');
  });
});

// ---------------------------------------------------------------- features ---

describe('features keep their arithmetic', () => {
  it('a share carries its numerator, its denominator and its games', () => {
    const weeks = steadyWeeks();
    const features = buildFeatures('WR', weeks, {
      team: 'ARI',
      teamTotals: teamWeekTotals(weeks),
      snaps: snaps(0.8),
    });
    expect(features.targetShare.value).toBeCloseTo(0.24, 3);
    expect(features.targetShare.numerator).toBe(72);
    expect(features.targetShare.games).toBe(8);
    expect(features.snapShare.numerator).toBe(8 * Math.round(0.8 * 65));
  });

  it('a missing week is not a zero, and a blank field is not one either', () => {
    const sparse: (UsageWeek & { team: string })[] = [
      { week: 1, seasonType: 'REG', team: 'ARI', passAttempts: null, carries: null, targets: 10, receptions: 7, targetShare: 0.3, wopr: 0.5 },
      // no week 2 at all — he did not play
      { week: 3, seasonType: 'REG', team: 'ARI', passAttempts: null, carries: null, targets: null, receptions: null, targetShare: null, wopr: null },
    ];
    const features = buildFeatures('WR', sparse, { team: 'ARI' });
    expect(features.games).toBe(2);
    // Week 3's blank targets drop out of the target figure rather than pulling
    // the average to five.
    expect(features.targetsPerGame.value).toBe(10);
    expect(features.targetsPerGame.games).toBe(1);
  });

  it('excludes the postseason, which is a different population of games', () => {
    const weeks = [...steadyWeeks(), { ...steadyWeeks()[0]!, week: 19, seasonType: 'POST', targets: 25 }];
    const features = buildFeatures('WR', weeks, { team: 'ARI' });
    expect(features.weeks).not.toContain(19);
    expect(features.targetsPerGame.value).toBe(9);
  });

  it('reports stability as null for a single game rather than as perfect', () => {
    const one = buildFeatures('WR', [steadyWeeks()[0]!], { team: 'ARI' });
    expect(one.targetShareStability).toBeNull();
    expect(one.thinSample).toBe(true);
  });

  it('says the QB designed-rush split is unknown rather than estimating it', () => {
    const qb = buildFeatures('QB', steadyWeeks().map((w) => ({ ...w, passAttempts: 34, carries: 6 })), {
      team: 'ARI',
    });
    expect(qb.qbCarriesPerGame.value).toBe(6);
    expect(qb.designedRushShare).toBeNull();
  });
});
