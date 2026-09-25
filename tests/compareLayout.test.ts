/**
 * The compare sheet's layout rules: which rows collapse, which card a factor
 * lands in, and what the line under the score names as the reason for a gap.
 *
 * The fixture is the FLEX comparison the redesign was drawn from (Rashod
 * Bateman against Nico Collins, 25 September 2026), with the same component
 * values the old sheet printed.
 */

import { describe, expect, it } from 'vitest';
import {
  BAR_FLOOR,
  barWidths,
  explainGap,
  layoutFactors,
  shortName,
  type LayoutComponent,
  type LayoutEvaluation,
} from '../src/web/compareLayout.ts';

const c = (key: string, label: string, value: number | null): LayoutComponent => ({
  key,
  label,
  value: value ?? 0,
  unknown: value == null,
});

const components = (values: Record<string, number | null>): LayoutComponent[] =>
  [
    ['vegas', 'Vegas market expectation'],
    ['news_recent', 'Recent news (30d)'],
    ['news_raw', 'Lifetime news'],
    ['status', 'Availability'],
    ['uncertainty', 'Uncertainty penalty'],
    ['usage_level', 'Opportunity'],
    ['role_trend', 'Role trend'],
    ['td_dependency', 'Touchdown dependency'],
    ['game_script', 'Game script'],
    ['weather', 'Weather'],
    ['matchup_role', 'Opponent by role'],
    ['explosiveness', 'Explosive role'],
  ].map(([key, label]) => c(key!, label!, values[key!] ?? null));

const bateman: LayoutEvaluation = {
  playerId: 'bateman',
  name: 'Rashod Bateman',
  score: 9.14,
  projection: 8.7,
  components: components({ vegas: 8.66, status: 0, uncertainty: -0.5, usage_level: 0.4, game_script: 0.58 }),
};

const collins: LayoutEvaluation = {
  playerId: 'collins',
  name: 'Nico Collins',
  score: -0.28,
  projection: 12.3,
  components: components({
    vegas: 0.55,
    news_recent: 0.35,
    news_raw: 0.52,
    status: -2.1,
    uncertainty: -1.5,
    usage_level: 2,
    game_script: -0.1,
  }),
};

describe('layoutFactors', () => {
  it('pulls out the five factors neither player has, and keeps the rest in engine order', () => {
    const { groups, untracked } = layoutFactors([bateman, collins]);
    expect(untracked.map((f) => f.key)).toEqual(['role_trend', 'td_dependency', 'weather', 'matchup_role', 'explosiveness']);
    expect(groups.map((g) => [g.id, g.factors.map((f) => f.key)])).toEqual([
      ['market', ['vegas']],
      ['risk', ['news_recent', 'news_raw', 'status', 'uncertainty']],
      ['context', ['usage_level', 'game_script']],
    ]);
  });

  it('keeps a row when only one player has a value', () => {
    const { groups } = layoutFactors([bateman, collins]);
    expect(groups.find((g) => g.id === 'risk')!.factors.map((f) => f.key)).toContain('news_recent');
  });

  it('treats a genuine zero as a value, not as a dash', () => {
    const zero = { ...bateman, components: [c('status', 'Availability', 0)] };
    const none = { ...collins, components: [c('status', 'Availability', null)] };
    expect(layoutFactors([zero, none]).untracked).toEqual([]);
  });

  it('never drops a factor it has not been told about', () => {
    const odd = { ...bateman, components: [c('something_new', 'Something new', 1)] };
    const { groups } = layoutFactors([odd]);
    expect(groups.find((g) => g.id === 'context')!.factors.map((f) => f.key)).toEqual(['something_new']);
  });

  it('counts a factor only one player is scored on as tracked when he has it', () => {
    const defence = { ...bateman, components: [c('vegas', 'Defense market expectation', 7)] };
    const { groups, untracked } = layoutFactors([defence, collins]);
    expect(untracked.map((f) => f.key)).not.toContain('news_raw');
    expect(groups.find((g) => g.id === 'market')!.factors).toHaveLength(1);
  });
});

describe('explainGap', () => {
  it('says the leader has the lower projection, and by how much', () => {
    expect(explainGap(bateman, collins).projectionShortfall).toBe(3.6);
  });

  it('names the factors that make up the gap, biggest first, from the components themselves', () => {
    expect(explainGap(bateman, collins).drivers).toEqual([
      { label: 'Vegas market expectation', delta: 8.11 },
      { label: 'Availability', delta: 2.1 },
    ]);
  });

  it('adds up: every favourable and unfavourable delta sums to the score gap', () => {
    const all = explainGap(bateman, collins, 99);
    const against = explainGap(collins, bateman, 99);
    const net = all.drivers.reduce((a, d) => a + d.delta, 0) - against.drivers.reduce((a, d) => a + d.delta, 0);
    expect(net).toBeCloseTo(bateman.score! - collins.score!, 1);
  });

  it('has no shortfall when the leader also leads on projection', () => {
    expect(explainGap({ ...bateman, projection: 14 }, collins).projectionShortfall).toBeNull();
    expect(explainGap({ ...bateman, projection: null }, collins).projectionShortfall).toBeNull();
  });
});

describe('barWidths', () => {
  it('draws the largest positive value full length and a negative as a sliver', () => {
    expect(barWidths([9.14, -0.28])).toEqual([100, BAR_FLOOR]);
  });

  it('draws nothing for a missing number', () => {
    expect(barWidths([8.7, null])).toEqual([100, null]);
  });

  it('puts every value on the same scale', () => {
    expect(barWidths([8.7, 12.3])).toEqual([70.7, 100]);
  });

  it('copes with nothing positive at all', () => {
    expect(barWidths([-1, -2])).toEqual([BAR_FLOOR, BAR_FLOOR]);
  });
});

describe('shortName', () => {
  it('takes the surname, skipping a suffix', () => {
    expect(shortName('Rashod Bateman')).toBe('Bateman');
    expect(shortName('Marvin Harrison Jr.')).toBe('Harrison');
    expect(shortName('Kenneth Walker III')).toBe('Walker');
    expect(shortName('Texans')).toBe('Texans');
  });
});
