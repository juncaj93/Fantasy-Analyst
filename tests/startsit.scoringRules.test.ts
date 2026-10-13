/**
 * The October 2026 scoring rules: Vegas first, everything else a nudge or text.
 */

import { describe, expect, it } from 'vitest';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { ALWAYS_TEXT_ONLY, LEGACY_RULES } from '../src/core/startsit/scoringRules.ts';
import { impliedTeamTotal, STALE_LINE, staleScale } from '../src/core/startsit/staleLine.ts';
import { STADIUM_ROOFS, tableRoofFor } from '../src/core/nfl/roofs.ts';
import { byWeekPoints, weekPoints } from '../src/core/startsit/weekPoints.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 6, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

function usage(week: number, extra: Partial<UsageWeek> = {}): UsageWeek {
  return {
    week,
    opponent: 'BUF',
    snaps: 50,
    snapShare: 0.8,
    targets: 9,
    targetShare: 0.26,
    receptions: 6,
    recYards: 80,
    recTds: 1,
    carries: 0,
    rushYards: 0,
    rushTds: 0,
    receivingAirYards: 90,
    ...extra,
  } as UsageWeek;
}

describe('what the market already prices adds nothing', () => {
  const busy: StartSitInput = {
    ...candidate('a', 'A', 'WR', 12),
    usageWeeks: [1, 2, 3, 4, 5, 6].map((w) => usage(w, { targets: 4 + w, receptions: 3 + w })),
    game: { spread: -9.5, total: 52.5, opponent: 'BUF' },
  };

  it('keeps the reading as text and scores it zero', () => {
    const e = evaluatePlayer(busy, HALF_PPR);
    for (const key of [...ALWAYS_TEXT_ONLY, 'usage_level']) {
      const c = e.components.find((x) => x.key === key)!;
      if (c.unknown) continue;
      expect(c.value, key).toBe(0);
      expect(c.textOnly, key).toBe(true);
    }
  });

  it('scored them before, which is what the backtest compares', () => {
    const legacy = evaluatePlayer(busy, HALF_PPR, LEGACY_RULES);
    const moved = legacy.components.filter((c) => [...ALWAYS_TEXT_ONLY].includes(c.key as never) && !c.unknown && c.value !== 0);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('leaves the score within 10% of the market number, availability aside', () => {
    const noisy = { ...busy, signal: { ...emptySignal('a'), last30: { positive: 0, negative: 9, net: -9, items: 9 }, raw: { positive: 0, negative: 9, net: -9, items: 9 } } };
    const e = evaluatePlayer(noisy, HALF_PPR);
    const vegas = e.components.find((c) => c.key === 'vegas')!.value;
    expect(Math.abs(e.score! - vegas)).toBeLessThanOrEqual(0.1 * vegas + 1e-9);
  });

  it('keeps availability outside the cap: Out is a gate, not a nudge', () => {
    const out = evaluatePlayer({ ...candidate('a', 'A', 'WR', 12, { status: 'Out' }) }, HALF_PPR);
    expect(out.ruledOut).toBe(true);
    expect(out.score!).toBeLessThan(0);
    const doubtful = evaluatePlayer({ ...candidate('a', 'A', 'WR', 12, { status: 'Doubtful' }) }, HALF_PPR);
    const vegas = doubtful.components.find((c) => c.key === 'vegas')!.value;
    expect(vegas - doubtful.score!).toBeGreaterThan(0.1 * vegas);
  });

  it('never names a text-only reading as a driver', () => {
    const e = evaluatePlayer(busy, HALF_PPR);
    const legacy = evaluatePlayer(busy, HALF_PPR, LEGACY_RULES);
    expect(legacy.drivers.length).toBeGreaterThan(0);
    for (const d of e.drivers) expect(legacy.drivers).toContain(d);
    expect(e.drivers.some((d) => /script|trend|TD-dependent/i.test(d))).toBe(false);
  });
});

describe('a prop older than the game line', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 11, h)).toISOString();

  it('reads the implied team total off the total and the spread', () => {
    expect(impliedTeamTotal({ total: 48, spread: -6 })).toBe(27);
    expect(impliedTeamTotal({ total: 48, spread: null })).toBeNull();
  });

  it('scales by how far the team total moved, and labels it', () => {
    const scale = staleScale({ total: 48, spread: -6, at: at(10) }, { total: 47, spread: -5, at: at(14) })!;
    expect(scale.factor).toBeCloseTo(26 / 27, 2);
    expect(scale.detail).toMatch(/27.0 then, 26.0 now/);
  });

  it('caps the move', () => {
    const scale = staleScale({ total: 50, spread: -10, at: at(10) }, { total: 40, spread: 3, at: at(14) })!;
    expect(scale.factor).toBe(1 - STALE_LINE.maxShift);
    expect(scale.detail).toMatch(/capped/);
  });

  it('does nothing when the props are as new as the line, or a side is missing', () => {
    expect(staleScale({ total: 48, spread: -6, at: at(14) }, { total: 45, spread: -3, at: at(14) })).toBeNull();
    expect(staleScale({ total: 48, spread: -6, at: at(10) }, { total: 45, spread: null, at: at(14) })).toBeNull();
    expect(staleScale(null, { total: 45, spread: -3, at: at(14) })).toBeNull();
    expect(staleScale({ total: 48, spread: -6, at: at(10) }, { total: 48.5, spread: -6, at: at(14) })).toBeNull();
  });

  it('moves the market number in the engine and says so on the row', () => {
    const base = candidate('a', 'A', 'WR', 12);
    const stale = evaluatePlayer(
      {
        ...base,
        game: { total: 45, spread: -3, opponent: 'BUF' },
        currentLinesAt: at(14),
        propLines: { total: 48, spread: -6, at: at(10) },
      },
      HALF_PPR,
    );
    const fresh = evaluatePlayer({ ...base, game: { total: 45, spread: -3, opponent: 'BUF' } }, HALF_PPR);
    expect(stale.expectation.points!).toBeLessThan(fresh.expectation.points!);
    expect(stale.expectation.staleScale).toBeDefined();
    expect(stale.components.find((c) => c.key === 'vegas')!.display).toMatch(/props older than the game line/);
  });
});

describe('the stadium table', () => {
  it('answers for the host club', () => {
    expect(tableRoofFor('DET', 'GB', true)).toBe('dome');
    expect(tableRoofFor('GB', 'DET', false)).toBe('dome');
    expect(tableRoofFor('BUF', 'MIA', true)).toBeNull();
    expect(tableRoofFor('BUF', 'MIA', null)).toBeNull();
  });

  it('never calls a retractable roof a dome', () => {
    expect(tableRoofFor('DAL', 'NYG', true)).toBe('retractable');
    expect(Object.values(STADIUM_ROOFS).filter((r) => r === 'dome').length).toBe(6);
  });
});

describe('one number per player per week', () => {
  it('is the decision number, a dash when there is none, and lower confidence off the market', () => {
    const priced = evaluatePlayer(candidate('a', 'Priced', 'WR', 12, { fullBoard: true }), HALF_PPR);
    const partial = evaluatePlayer(candidate('b', 'Partial', 'WR', 9), HALF_PPR);
    const nobody = evaluatePlayer(candidate('c', 'Nobody', 'WR', null), HALF_PPR);
    const published = new Map([['b', 11]]);
    expect(weekPoints(priced).lowerConfidence).toBe(false);
    expect(weekPoints(priced).points).toBe(priced.score);
    expect(weekPoints(partial, published)).toMatchObject({ basis: 'published', lowerConfidence: true });
    expect(weekPoints(nobody).points).toBeNull();
  });

  it('sorts priced first by points, then the fallbacks, then nobody', () => {
    const rows = [
      { name: 'Fallback big', week: { points: 15, basis: 'published' as const, lowerConfidence: true } },
      { name: 'Nobody', week: { points: null, basis: 'none' as const, lowerConfidence: true } },
      { name: 'Priced small', week: { points: 8, basis: 'market' as const, lowerConfidence: false } },
      { name: 'Priced big', week: { points: 14, basis: 'market' as const, lowerConfidence: false } },
    ];
    expect([...rows].sort(byWeekPoints).map((r) => r.name)).toEqual(['Priced big', 'Priced small', 'Fallback big', 'Nobody']);
  });
});
