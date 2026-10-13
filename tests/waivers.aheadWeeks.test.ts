/**
 * Each later week of the waiver window has its own number.
 *
 * The case that started it, 9 October 2026 (week 5, this week still open):
 * Joe Burrow on bye in week 6. Aaron Rodgers was valued on a week-5 figure of
 * 20.5 and Jordan Love on 18.9, for all three weeks, so Rodgers ranked first.
 * Sleeper had Love at 23.0 and 23.6 for weeks 6 and 7, the weeks the move is
 * for, and Rodgers at 19.7 and 15.8. See `core/waivers/aheadWeeks.ts`.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverTiers, TIER_RULES, type TierCandidate, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { weekNumbers, vegasAheadPoints, type AheadNumbers } from '../src/core/waivers/aheadWeeks.ts';
import { scoreProjectionRows } from '../src/core/sleeper/weekPoints.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { ScoringProfile } from '../src/core/sleeper/scoring.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const WEEKS = [5, 6, 7];

const ahead = (sleeper: Record<number, Record<string, number>>, vegas: Record<number, Record<string, number>> = {}): AheadNumbers => ({
  sleeper: new Map(Object.entries(sleeper).map(([w, m]) => [Number(w), new Map(Object.entries(m))])),
  vegas: new Map(Object.entries(vegas).map(([w, m]) => [Number(w), new Map(Object.entries(m))])),
});

function p(id: string, position: string, rate: number | null, numbers: AheadNumbers | null, over: Partial<TierPlayer> = {}): TierPlayer {
  const n = weekNumbers({ playerId: id, rate, weeks: WEEKS, currentWeek: 5, ahead: numbers });
  return {
    playerId: id,
    name: id,
    position,
    team: 'XX',
    rate,
    weekly: [1, 1, 1],
    weekValues: n.map((x) => x.points),
    weekSources: n.map((x) => x.source),
    designation: 'healthy',
    byeWeek: null,
    ...over,
  };
}

function request(numbers: AheadNumbers | null): TierRequest {
  const roster = [
    p('Burrow', 'QB', 19.24, numbers, { byeWeek: 6, weekly: [1, 0, 1] }),
    p('RB1', 'RB', 16, numbers),
    p('RB2', 'RB', 13, numbers),
    p('WR1', 'WR', 15, numbers),
    p('WR2', 'WR', 13, numbers),
    p('WR3', 'WR', 11, numbers),
    p('TE1', 'TE', 9, numbers),
    p('RB3', 'RB', 10, numbers),
    p('WR4', 'WR', 10, numbers),
    p('DEF1', 'DEF', 7, numbers),
    p('TE2', 'TE', 7, numbers),
    p('RB4', 'RB', 8, numbers),
    p('WR5', 'WR', 8, numbers),
    p('RB5', 'RB', 6, numbers),
    p('WR6', 'WR', 6, numbers),
    p('Dead', 'RB', 3, numbers),
  ];
  const candidates: TierCandidate[] = [p('Rodgers', 'QB', 20.5, numbers), p('Love', 'QB', 18.87, numbers)];
  return {
    shape: SHAPE,
    weeks: WEEKS,
    weights: TIER_RULES.openWeights,
    leadWeeks: 2,
    roster,
    candidates,
    openSpots: 0,
    openReserve: 0,
    protections: new Map(),
    excludedPositions: new Set(['DEF']),
    replacement: new Map([
      ['QB', 15],
      ['RB', 7],
      ['WR', 7],
      ['TE', 6],
    ]),
  };
}

const SLEEPER = { 6: { Rodgers: 19.7, Love: 23.0 }, 7: { Rodgers: 15.8, Love: 23.6, Burrow: 20.1 } };

describe('the ladder for one week', () => {
  it('keeps this week exactly as it was and gives a later week its own number', () => {
    const n = weekNumbers({ playerId: 'Love', rate: 18.87, weeks: WEEKS, currentWeek: 5, ahead: ahead(SLEEPER) });
    expect(n).toEqual([
      { week: 5, points: 18.87, source: 'this_week' },
      { week: 6, points: 23, source: 'sleeper' },
      { week: 7, points: 23.6, source: 'sleeper' },
    ]);
  });

  it('takes a complete Vegas week over Sleeper, and falls back to this week’s figure when neither is posted', () => {
    const n = weekNumbers({ playerId: 'Love', rate: 18.87, weeks: [5, 6, 7, 8], currentWeek: 5, ahead: ahead(SLEEPER, { 6: { Love: 21.4 } }) });
    expect(n.map((x) => [x.points, x.source])).toEqual([
      [18.87, 'this_week'],
      [21.4, 'vegas'],
      [23.6, 'sleeper'],
      [18.87, 'current'],
    ]);
  });

  it('passes over a later-week projection under one point: that is a game he is not expected to play', () => {
    const n = weekNumbers({ playerId: 'X', rate: 12, weeks: [5, 6], currentWeek: 5, ahead: ahead({ 6: { X: 0.4 } }) });
    expect(n[1]).toEqual({ week: 6, points: 12, source: 'current' });
  });

  it('leaves a player with no number this week unvalued, whatever a later week says', () => {
    const n = weekNumbers({ playerId: 'X', rate: null, weeks: [5, 6], currentWeek: 5, ahead: ahead({ 6: { X: 14 } }) });
    expect(n.map((x) => x.points)).toEqual([null, null]);
  });

  it('without later-week numbers, is this week’s figure for every week, as before', () => {
    const n = weekNumbers({ playerId: 'X', rate: 12, weeks: [5, 6, 7], currentWeek: 5, ahead: null });
    expect(n.every((x) => x.points === 12 && x.source === 'this_week')).toBe(true);
  });
});

describe('the bye fill ranks on the bye week’s own numbers', () => {
  it('before: one week-5 figure for all three weeks puts Rodgers first', () => {
    const plan = planWaiverTiers(request(null));
    expect(plan.doThis?.name).toBe('Rodgers');
    expect(plan.doThis?.alternatives).toContain('Love');
  });

  it('after: Love first, on Sleeper’s 23.0 for week 6 and 23.6 for week 7, each labelled', () => {
    const plan = planWaiverTiers(request(ahead(SLEEPER)));
    expect(plan.doThis?.name).toBe('Love');
    expect(plan.doThis?.reason).toBe('Your QB Burrow is on bye in week 6');
    expect(plan.doThis?.weekNumbers).toEqual([
      { week: 5, points: 18.87, source: 'this_week' },
      { week: 6, points: 23, source: 'sleeper' },
      { week: 7, points: 23.6, source: 'sleeper' },
    ]);
    /* Week 6 fills the hole; week 7 he starts over Burrow's 20.1. */
    expect(plan.doThis?.byWeek.map((w) => w.change)).toEqual([0, 23, 3.5]);
    const rodgers = plan.all.find((m) => m.name === 'Rodgers');
    expect(rodgers!.gain).toBeLessThan(plan.doThis!.gain);
  });
});

describe('a later week’s Vegas lines', () => {
  const profile = { pointsPerPassYard: 0.04, passTd: 6, pointsPerRushYard: 0.1, pointsPerRecYard: 0.1, ppr: 0.5, teBonus: 0 } as unknown as ScoringProfile;
  const prop = (market: PlayerProp['market'], line: number): PlayerProp => ({
    playerId: 'Love',
    sourcePlayerName: 'Jordan Love',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: [],
    impliedProbability: null,
  });

  it('converts a complete QB market with this league’s values', () => {
    const points = vegasAheadPoints(
      new Map([['Love', [prop('pass_yards', 250), prop('pass_tds', 1.5), prop('rush_yards', 10)]]]),
      () => 'QB',
      profile,
    );
    /* 250 × 0.04 + 1.5 × 6 + 10 × 0.1 */
    expect(points.get('Love')).toBeCloseTo(20, 1);
  });

  it('leaves out a partial market: one line of three is not a week', () => {
    const points = vegasAheadPoints(new Map([['Love', [prop('pass_tds', 1.5)]]]), () => 'QB', profile);
    expect(points.has('Love')).toBe(false);
  });
});

describe('Sleeper’s projection for a later week, in this league’s scoring', () => {
  it('scores six for a passing touchdown and minus two for an interception, and skips a defence', () => {
    const scoring = { pass_yd: 0.04, pass_td: 6, pass_int: -2, rush_yd: 0.1 };
    const rows = [
      { player_id: '6804', player: { position: 'QB' }, stats: { pass_yd: 271.31, pass_td: 1.93, pass_int: 0.59, rush_yd: 10, pts_half_ppr: 19.87 } },
      { player_id: 'GB', player: { position: 'DEF' }, stats: { pass_int: 1 } },
    ];
    const points = scoreProjectionRows(rows, scoring);
    expect(points['6804']).toBeCloseTo(271.31 * 0.04 + 1.93 * 6 - 0.59 * 2 + 1, 2);
    expect(points['GB']).toBeUndefined();
  });
});
