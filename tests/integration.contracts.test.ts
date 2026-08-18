/**
 * The seam between this workstream and the screens that were waiting for it.
 *
 * These tests are deliberately about *shape and silence* rather than about
 * football. The arithmetic is tested where it lives; what can only be tested
 * here is that the translation satisfies the consuming module's own type, that
 * an absent answer stays absent all the way through, and that a value the
 * consumer would render as a confident chip is never produced from nothing.
 *
 * Each adapter is fed into the real consumer — `buildWeeklyCard`, `valueOfSlot`
 * — rather than being asserted against a copy of its interface, because a
 * matching field name is not the same thing as a working integration.
 */

import { describe, expect, it } from 'vitest';
import {
  advancedLines,
  benchHorizon,
  waiverMultiWeek,
  whatWouldChange,
} from '../src/core/contracts/integration.ts';
import { assessXfp } from '../src/core/xfp/model.ts';
import { findBoundaries } from '../src/core/startsit/boundary.ts';
import { valueOverWeeks } from '../src/core/value/multiWeek.ts';
import { assessStreaming } from '../src/core/startsit/streaming.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { valueOfSlot, type HeldPlayer } from '../src/core/roster/bench.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { RosterShape } from '../src/core/sleeper/scoring.ts';
import type { RoleAssessment } from '../src/core/startsit/decisions.ts';
import type { UsageAssessment } from '../src/core/startsit/usageTrend.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

const SHAPE: RosterShape = {
  starters: { QB: 1, WR: 2, TE: 1 },
  flex: [{ slot: 'FLEX', positions: ['WR', 'TE'] }],
  benchSlots: 5,
  irSlots: 1,
  totalStarters: 5,
  superflex: false,
};

function weeks(count: number, template: Omit<Partial<UsageWeek>, 'week'>): UsageWeek[] {
  return Array.from({ length: count }, (_, i) => ({
    week: i + 1,
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: null,
    receptions: null,
    targetShare: null,
    wopr: null,
    ...template,
  }));
}

const STABLE: RoleAssessment = {
  trend: 'stable',
  label: 'Role stable',
  detail: '',
  metrics: [],
  games: 8,
} as RoleAssessment;

const RISING: RoleAssessment = { ...STABLE, trend: 'rising_high', label: 'Role rising — high confidence' };

const BIG_ROLE: UsageAssessment = {
  perGame: 9,
  unit: 'targets',
  score: 0.6,
  points: 1.2,
  games: 6,
  display: '9.0 targets a game',
  driver: null,
  unknown: false,
} as UsageAssessment;

describe('the weekly card lights up', () => {
  const lucky = weeks(6, { targets: 6, receptions: 4, recYards: 55, recTds: 1.5, receivingAirYards: 60 });

  const evaluation = {
    playerId: 'wr1',
    name: 'A Receiver',
    position: 'WR',
    team: 'NE',
    score: 12.4,
    confidence: 'high',
    statusFlag: null,
    ruledOut: false,
    opponent: 'MIA',
  };

  it('adds exactly one advanced line, and the card prints it', () => {
    const lines = advancedLines(assessXfp('WR', lucky, HALF_PPR));
    expect(lines).toHaveLength(1);
    const card = buildWeeklyCard({ ...evaluation, advanced: lines }, { starting: true, slot: 'WR' });
    const printed = card.lines.find((l) => l.key === 'xfp')!;
    expect(printed.label).toBe('Expected points');
    expect(printed.value).toMatch(/pts\/gm$/);
    expect(printed.detail).toMatch(/TD regression risk/);
  });

  it('says nothing at all when there is no usage, and the card reports it once', () => {
    const lines = advancedLines(assessXfp('WR', weeks(2, { targets: 4 }), HALF_PPR));
    expect(lines).toEqual([]);
    const card = buildWeeklyCard({ ...evaluation, advanced: lines }, { starting: true });
    expect(card.lines.some((l) => l.key === 'xfp')).toBe(false);
    expect(card.pending).toContain('expected points');
  });

  it('never turns a missing expectation into a zero', () => {
    expect(advancedLines(null)).toEqual([]);
    expect(advancedLines(undefined)).toEqual([]);
  });

  it('hands the card the boundary sentences, and nothing else', () => {
    const report = findBoundaries(
      [candidate('a', 'A Starter', 'WR', 12), candidate('b', 'B Challenger', 'WR', 11)],
      HALF_PPR,
    );
    const changes = whatWouldChange(report);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);

    const card = buildWeeklyCard({ ...evaluation, whatWouldChange: changes }, { starting: true });
    expect(card.changes).toEqual(changes);
  });

  it('drops the "not a close call" note rather than printing it as a change', () => {
    const comfortable = findBoundaries(
      [candidate('a', 'Clear Starter', 'WR', 18), candidate('b', 'Bench Guy', 'WR', 6)],
      HALF_PPR,
    );
    expect(comfortable.note).toMatch(/not a close call/);
    expect(whatWouldChange(comfortable)).toEqual([]);
    expect(buildWeeklyCard({ ...evaluation, whatWouldChange: whatWouldChange(comfortable) }, { starting: true }).changes).toEqual([]);
  });
});

describe('the waiver board gets its supplier', () => {
  const base = { playerId: 'p1', name: 'A Receiver', position: 'WR', currentWeek: 4, thisWeekScore: 11 };

  it('maps a growing role to season-long, with the horizon in the detail', () => {
    const intel = waiverMultiWeek(valueOverWeeks({ ...base, role: RISING, usage: BIG_ROLE }))!;
    expect(intel.level).toBe('season_long');
    expect(intel.label).toBe('Rising asset');
    expect(intel.detail).toMatch(/pts a week over 4 of the next 4/);
  });

  it('maps a starter returning next week to a streamer', () => {
    const intel = waiverMultiWeek(
      valueOverWeeks({
        ...base,
        role: STABLE,
        usage: BIG_ROLE,
        returningStarter: { name: 'The Starter', expectedWeek: 5, confidence: 'high' },
      }),
    )!;
    expect(intel.level).toBe('streamer');
  });

  it('keeps a sell-high above streamer, and puts the warning in the detail', () => {
    const value = valueOverWeeks({
      ...base,
      role: STABLE,
      usage: BIG_ROLE,
      xfp: {
        games: 6,
        xfpPerGame: 7,
        actualPerGame: 12,
        fpoePerGame: 5,
        tdOverExpectationPerGame: 0.6,
        interpretation: 'td_regression_risk',
        label: 'TD regression risk',
        display: '',
        driver: null,
        confidence: 'high',
        depthMeasured: true,
        perGame: [],
        points: 0,
      },
    });
    const intel = waiverMultiWeek(value)!;
    expect(value.verdict).toBe('sell_high');
    expect(intel.level).toBe('multi_week');
    expect(intel.detail).toMatch(/TD regression risk|Opportunity vs production/);
  });

  it('returns null rather than a confident Unknown when nothing can be valued', () => {
    const nothing = valueOverWeeks({ ...base, thisWeekScore: null });
    expect(nothing.verdict).toBe('unknown');
    expect(waiverMultiWeek(nothing)).toBeNull();
    expect(waiverMultiWeek(null)).toBeNull();
  });
});

describe('the bench slot gets a real horizon', () => {
  it('supplies four-week value and replacement level in the shape bench.ts wants', () => {
    const value = valueOverWeeks({
      playerId: 'te1',
      name: 'A Tight End',
      position: 'TE',
      currentWeek: 4,
      thisWeekScore: 9,
      role: STABLE,
      usage: BIG_ROLE,
    });
    const streaming = assessStreaming({
      position: 'TE',
      roster: [candidate('te1', 'A Tight End', 'TE', 9)],
      available: [candidate('fa1', 'Wire TE', 'TE', 7), candidate('fa2', 'Wire TE Two', 'TE', 6.5)],
      shape: SHAPE,
      profile: HALF_PPR,
    });

    const horizon = benchHorizon(value, streaming);
    expect(horizon.fourWeekValue).toBeCloseTo(value.nextFourPerWeek!, 5);
    expect(horizon.streamingReplacement).toBe(streaming.replacementLevel);

    // And it is genuinely a second number rather than this week's score again.
    const held: HeldPlayer = {
      playerId: 'te1',
      name: 'A Tight End',
      position: 'TE',
      role: 'bench',
      restOfSeasonValue: 9,
      insuranceValue: 0,
      upside: 'none',
      coversBye: false,
      ...horizon,
    };
    const slot = valueOfSlot(held);
    expect(slot.slotValue).toBeGreaterThan(0);
    expect(slot.components.find((c) => c.key === 'value')!.note).toMatch(/over four weeks/);
  });

  it('passes nulls through rather than substituting a score', () => {
    const horizon = benchHorizon(null, null);
    expect(horizon.fourWeekValue).toBeNull();
    expect(horizon.streamingReplacement).toBeNull();
  });
});
