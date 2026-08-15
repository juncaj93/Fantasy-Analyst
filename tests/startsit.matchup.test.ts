/**
 * Opponent tendency, by role rather than by position.
 *
 * The test that matters most here is the negative one: a defence that is soft
 * against underneath receivers and hard against downfield ones must produce two
 * *different* answers for two of your receivers. A model that returns the same
 * number for both has quietly collapsed back into "defence versus WR", which is
 * the statistic this whole module exists to replace.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFENSE,
  assessMatchup,
  buildDefenseTendencies,
  type DefenseGame,
} from '../src/core/startsit/defense.ts';
import type { RoleBucket } from '../src/core/startsit/roleProfile.ts';

/** `n` games a defence gave up to one role, each `points` above baseline. */
function allowed(
  defense: string,
  bucket: RoleBucket,
  position: string,
  games: number,
  opts: { points: number; baseline: number; fromWeek?: number },
): DefenseGame[] {
  const first = opts.fromWeek ?? 1;
  return Array.from({ length: games }, (_, i) => ({
    defense,
    week: first + i,
    position,
    bucket,
    points: opts.points,
    baseline: opts.baseline,
  }));
}

describe('a defence is described by role, not by position', () => {
  const games = [
    // Generous to short throws, miserly downfield. The raw totals are similar;
    // the residuals are not, which is the whole point of the baseline.
    ...allowed('NYJ', 'underneath_receiver', 'WR', 6, { points: 16, baseline: 11 }),
    ...allowed('NYJ', 'deep_receiver', 'WR', 6, { points: 9, baseline: 14 }),
  ];
  const index = buildDefenseTendencies(games, 6);

  it('gives opposite answers to two receivers with different roles', () => {
    const underneath = assessMatchup(
      { position: 'WR', bucket: 'underneath_receiver', defense: 'NYJ' },
      index,
    );
    const deep = assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'NYJ' }, index);

    expect(underneath.points).toBeGreaterThan(0);
    expect(deep.points).toBeLessThan(0);
    expect(underneath.rating).toBe('soft');
    expect(deep.rating).toBe('tough');
  });

  it('names the role it answered about', () => {
    const deep = assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'NYJ' }, index);
    expect(deep.display).toContain('downfield receivers');
    expect(deep.driver).toMatch(/matchup/i);
  });

  it('stays inside its cap', () => {
    const extreme = buildDefenseTendencies(
      allowed('NYJ', 'deep_receiver', 'WR', 6, { points: 40, baseline: 5 }),
      6,
    );
    const result = assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'NYJ' }, extreme);
    expect(Math.abs(result.points)).toBeLessThanOrEqual(DEFENSE.maxPoints);
  });
});

describe('opponent quality is divided out', () => {
  it('does not call a defence soft for having faced good players', () => {
    // Twenty points a game allowed, to players who average twenty.
    const facedStars = buildDefenseTendencies(
      allowed('DAL', 'deep_receiver', 'WR', 6, { points: 20, baseline: 20 }),
      6,
    );
    const result = assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'DAL' }, facedStars);
    expect(result.rating).toBe('neutral');
    expect(Math.abs(result.points)).toBeLessThan(0.2);
  });

  it('does call a defence soft when ordinary players beat their own average', () => {
    const beaten = buildDefenseTendencies(
      allowed('DAL', 'deep_receiver', 'WR', 6, { points: 18, baseline: 9 }),
      6,
    );
    expect(assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'DAL' }, beaten).rating).toBe('soft');
  });
});

describe('sample size', () => {
  it('says nothing at all below the minimum', () => {
    const thin = buildDefenseTendencies(
      allowed('SEA', 'receiving_back', 'RB', DEFENSE.minSample - 1, { points: 18, baseline: 8 }),
      3,
    );
    const result = assessMatchup({ position: 'RB', bucket: 'receiving_back', defense: 'SEA' }, thin);
    expect(result.unknown).toBe(true);
    expect(result.points).toBe(0);
  });

  it('says nothing when the games are all from one week', () => {
    const oneWeek: DefenseGame[] = Array.from({ length: 6 }, (_, i) => ({
      defense: 'SEA',
      week: 4,
      position: 'WR',
      bucket: 'deep_receiver',
      points: 20,
      baseline: 8,
      // Six different players, one Sunday. Not a tendency.
      ...{ index: i },
    }));
    const index = buildDefenseTendencies(oneWeek, 4);
    expect(assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'SEA' }, index).unknown).toBe(true);
  });

  it('falls back to the position when the role bucket is thin, and says so', () => {
    const games = [
      ...allowed('MIA', 'underneath_receiver', 'WR', 6, { points: 17, baseline: 10 }),
      ...allowed('MIA', 'deep_receiver', 'WR', 2, { points: 12, baseline: 11, fromWeek: 1 }),
    ];
    const index = buildDefenseTendencies(games, 6);
    const deep = assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: 'MIA' }, index);
    expect(deep.unknown).toBe(false);
    // The generic figure answered, and the wording says "WRs" rather than
    // claiming to know anything about downfield receivers specifically.
    expect(deep.display).toContain('WRs');
  });

  it('answers generically for a player whose own role is unclassified', () => {
    const index = buildDefenseTendencies(
      allowed('MIA', 'underneath_receiver', 'WR', 6, { points: 17, baseline: 10 }),
      6,
    );
    const result = assessMatchup({ position: 'WR', bucket: 'unclassified', defense: 'MIA' }, index);
    expect(result.unknown).toBe(false);
    expect(result.display).toContain('WRs');
  });

  it('is unknown when the opponent is not known', () => {
    const index = buildDefenseTendencies(
      allowed('MIA', 'deep_receiver', 'WR', 6, { points: 17, baseline: 10 }),
      6,
    );
    expect(assessMatchup({ position: 'WR', bucket: 'deep_receiver', defense: null }, index).unknown).toBe(true);
  });
});

describe('recency', () => {
  it('weighs the recent weeks more than the early ones', () => {
    const improving = buildDefenseTendencies(
      [
        ...allowed('BUF', 'rushing_back', 'RB', 4, { points: 20, baseline: 10, fromWeek: 1 }),
        ...allowed('BUF', 'rushing_back', 'RB', 4, { points: 6, baseline: 10, fromWeek: 5 }),
      ],
      8,
    );
    const worsening = buildDefenseTendencies(
      [
        ...allowed('BUF', 'rushing_back', 'RB', 4, { points: 6, baseline: 10, fromWeek: 1 }),
        ...allowed('BUF', 'rushing_back', 'RB', 4, { points: 20, baseline: 10, fromWeek: 5 }),
      ],
      8,
    );
    const a = assessMatchup({ position: 'RB', bucket: 'rushing_back', defense: 'BUF' }, improving).points;
    const b = assessMatchup({ position: 'RB', bucket: 'rushing_back', defense: 'BUF' }, worsening).points;
    expect(b).toBeGreaterThan(a);
  });
});
