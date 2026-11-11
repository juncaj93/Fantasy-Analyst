/**
 * Round 17: blend tune (Alex's decisions, 11 November 2026, after the Round 16
 * backtest in `docs/backtest/`).
 *
 *  1. The rest-of-season rate is 75 percent next-four-weeks projection and 25
 *     percent season average per game (it was 50/50). One setting,
 *     `REST_OF_SEASON.productionShare`, which names the SEASON AVERAGE side.
 *  2. A Sleeper-only number ranks one point lower (it was two) on every screen,
 *     through the one `rankingNumber`. One constant, no second copy.
 *
 * Every case below fails on the code before the round. The Waivers and Matchup
 * edges live next to their own fixtures (`waivers.round5.test.ts`,
 * `matchup.holeFill.test.ts`); Trades takes no Sleeper-only discount of its
 * own and is checked below by the scan for a second copy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blendRate, REST_OF_SEASON, restOfSeasonBlend } from '../src/core/value/restOfSeason.ts';
import { BORROWED_RANKING_DISCOUNT, rankingNumber } from '../src/core/startsit/decisionPoints.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { solveLineup } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

describe('the blend gives projection 75 percent and the season average 25', () => {
  it('the one setting is the season-average share, 0.25', () => {
    expect(REST_OF_SEASON.productionShare).toBe(0.25);
  });

  it('a veteran (4+ games) at projection 10 and season average 20 is 12.5, not 15', () => {
    const b = blendRate({ projections: [10, 10, 10, 10], production: [20, 20, 20, 20, 20, 20] });
    expect(b.productionShare).toBe(0.25);
    expect(b.rate).toBe(12.5);
  });

  it('the projection weight is exactly 75 percent: it moves the rate three times as far as the average does', () => {
    const base = blendRate({ projections: [10], production: [10, 10, 10, 10] }).rate!;
    const projMoved = blendRate({ projections: [14], production: [10, 10, 10, 10] }).rate! - base;
    const avgMoved = blendRate({ projections: [10], production: [14, 14, 14, 14] }).rate! - base;
    expect(projMoved).toBeCloseTo(3, 10);
    expect(avgMoved).toBeCloseTo(1, 10);
  });

  it('the ramp is a share of the new setting: two games count an eighth', () => {
    const b = blendRate({ projections: [10], production: [20, 20] });
    expect(b.productionShare).toBe(0.13);
    expect(b.rate).toBe(11.25);
  });

  it('the shared Trades and Waivers function applies it to this week plus the next three weeks', () => {
    const { blend } = restOfSeasonBlend({
      thisWeek: { rate: 16, fromThisWeek: true },
      ahead: new Map([[11, 12], [12, 12], [13, 12]]),
      production: [20, 20, 20, 20, 20, 20, 20, 20],
      weeks: [10, 11, 12, 13],
      byeWeek: null,
      floor: 1,
    });
    expect(blend.projectionWeeks).toBe(4);
    expect(blend.projection).toBe(13);
    /* 0.75 * 13 + 0.25 * 20 = 14.75. At 50/50 it was 16.5. */
    expect(blend.rate).toBe(14.75);
  });
});

describe('a Sleeper-only number takes exactly minus 1 on every screen that picks', () => {
  const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
  const ONE_WR = buildRosterShape(['WR', 'BN', 'BN']);

  it('the constant is 1 and rankingNumber reads it', () => {
    expect(BORROWED_RANKING_DISCOUNT).toBe(1);
    expect(rankingNumber(12, true)).toBe(11);
    expect(rankingNumber(12, false)).toBe(12);
  });

  it('Team: a Sleeper-only number 1.2 above a priced one starts; 0.8 above does not', () => {
    const priced = pricedCandidate('p', 'Priced Receiver', 'WR', 10);
    const sleeper = candidate('s', 'Sleeper Receiver', 'WR', 3);
    const base = assembleLineup({ inputs: [priced], shape: ONE_WR, profile: PROFILE, currentStarterIds: ['p'], mode: 'balanced', published: new Map() }).starters[0]!.decision!.points;
    const run = (extra: number) =>
      assembleLineup({ inputs: [priced, sleeper], shape: ONE_WR, profile: PROFILE, currentStarterIds: ['p'], mode: 'balanced', published: new Map([['s', base + extra]]) }).slots.find((x) => x.slot === 'WR')?.playerId;
    expect(run(1.2)).toBe('s');
    expect(run(0.8)).toBe('p');
  });

  it('Best move (solveLineup): 10 + 1.2 beats 10; 10 + 0.8 does not', () => {
    const shape = buildRosterShape(['WR', 'BN']);
    const run = (points: number) =>
      [...solveLineup([{ playerId: 'p', name: 'P', position: 'WR', points: 10, borrowed: false }, { playerId: 's', name: 'S', position: 'WR', points, borrowed: true }], shape).starterIds];
    expect(run(11.2)).toEqual(['s']);
    expect(run(10.8)).toEqual(['p']);
  });

  it('Compare: 4.55 ahead raw is a clear Start (3.55 ranked, Round 18 bar); 2.95 ahead is a toss-up that leans to the priced player', () => {
    const compare = (published: Record<string, number>, inputs: Parameters<typeof compareStartSit>[0]) =>
      compareStartSit(inputs, PROFILE, { published: new Map(Object.entries(published)) });
    const w = pricedCandidate('w', 'Garrett Wilson', 'WR', 12);
    const base = compare({}, [w]).evaluations.find((e) => e.playerId === 'w')!.decision!.points;
    const m = candidate('m', 'Ladd McConkey', 'WR', 3);
    const clear = compare({ m: base + 4.55 }, [w, m]);
    expect(clear.recommendedPlayerId).toBe('m');
    const close = compare({ m: base + 2.95 }, [w, m]);
    expect(close.recommendedPlayerId).toBeNull();
    expect(close.tossUp?.leanPlayerId).not.toBeUndefined();
  });
});

describe('one constant, no second copy', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });

  it('only decisionPoints.ts defines the discount, and nothing else subtracts a literal from a borrowed number', () => {
    const files = walk('src');
    const definers = files.filter((f) => /BORROWED_RANKING_DISCOUNT\s*=/.test(readFileSync(f, 'utf8')));
    expect(definers).toEqual([join('src', 'core', 'startsit', 'decisionPoints.ts')]);
    const copies = files.filter((f) => /borrowed\w*\s*\?[^:;]*-\s*\d/i.test(readFileSync(f, 'utf8')));
    expect(copies).toEqual([]);
  });

  it('Trades and the trade value code have no Sleeper-only ranking of their own', () => {
    const files = [...walk(join('src', 'core', 'trades')), ...walk(join('src', 'core', 'tradeValue'))];
    const mentions = files.filter((f) => /rankingNumber|BORROWED_RANKING_DISCOUNT|borrowed/i.test(readFileSync(f, 'utf8')));
    expect(mentions).toEqual([]);
  });
});
