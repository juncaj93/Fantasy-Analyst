/**
 * The forecast, and the properties it is not allowed to lose.
 *
 * Every test here corresponds to a rule the brief states as a negative — a
 * thing the model must never do — because those are the failures that look
 * perfectly plausible on screen. A win probability that jitters, a finished
 * player still being simulated, a Sleeper projection wearing this app's name:
 * none of them produces an error, and all of them produce a number a person
 * would act on.
 */

import { describe, expect, it } from 'vitest';
import { buildForecast, forecastFingerprint } from '../src/core/matchup/model.ts';
import { buildDistribution, resolveGameClock, effectiveRemaining, projectedFinal } from '../src/core/matchup/distribution.ts';
import { buildFactorStructure, impliedCorrelation, MAX_IMPLIED_CORRELATION } from '../src/core/matchup/correlation.ts';
import { simulateMatchup } from '../src/core/matchup/simulate.ts';
import { matchupFingerprint } from '../src/core/matchup/fingerprint.ts';
import { lineups, player, slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const KICKOFF = '2026-12-20T18:00:00Z';
const BEFORE = new Date('2026-12-20T15:00:00Z');
const HALFTIME = new Date('2026-12-20T19:32:30Z');
const AFTER = new Date('2026-12-20T22:00:00Z');

function forecast(players: MatchupPlayerInput[], now: Date, over: Partial<Parameters<typeof buildForecast>[0]> = {}) {
  return buildForecast({ ...forecastInput(players, now), ...over });
}

/** The whole input, so the fingerprint and the forecast can be built from one. */
function forecastInput(players: MatchupPlayerInput[], now: Date): Parameters<typeof buildForecast>[0] {
  return {
    leagueId: 'l1',
    season: '2026',
    week: 16,
    matchupId: 3,
    players,
    teams: {
      mine: { rosterId: 1, name: 'Mine', avatar: null, record: '9-5' },
      theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: '9-5' },
    },
    actualScores: {
      mine: sum(players.filter((p) => p.side === 'mine' && p.starting).map((p) => p.actual)),
      theirs: sum(players.filter((p) => p.side === 'theirs' && p.starting).map((p) => p.actual)),
    },
    slots: slots(),
    now,
  };
}

function sum(values: number[]): number {
  return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
}

describe('the projected total is Fantasy Analyst’s own, built from its own player numbers', () => {
  it('sums the per-player projections rather than any figure handed in', () => {
    const players = lineups();
    const result = forecast(players, BEFORE);
    const mine = players.filter((p) => p.side === 'mine' && p.starting);
    const expected = sum(mine.map((p) => p.projection ?? 0));
    // Monte Carlo, so it is the mean of the simulated totals rather than the
    // arithmetic sum — but the two must agree to within sampling error, which
    // is the property that says the distributions are centred where the
    // projections are.
    expect(result.teams.mine.projectedFinal!).toBeGreaterThan(expected * 0.94);
    expect(result.teams.mine.projectedFinal!).toBeLessThan(expected * 1.06);
  });

  it('carries the league’s scoring through, because the projections already do', () => {
    const half = forecast(lineups({ mineProjections: [18, 12, 10, 14, 11, 8, 9] }), BEFORE);
    const ppr = forecast(lineups({ mineProjections: [21, 15, 13, 18, 15, 11, 12] }), BEFORE);
    expect(ppr.teams.mine.projectedFinal!).toBeGreaterThan(half.teams.mine.projectedFinal!);
  });

  it('never uses a projection as the actual score', () => {
    const players = lineups();
    const result = forecast(players, BEFORE);
    expect(result.teams.mine.actual).toBe(0);
    expect(result.teams.theirs.actual).toBe(0);
    expect(result.teams.mine.projectedFinal).not.toBe(result.teams.mine.actual);
  });
});

describe('game state decides what is still uncertain', () => {
  it('gives a player who has not kicked off his full pregame distribution', () => {
    const clock = resolveGameClock(KICKOFF, BEFORE);
    const distribution = buildDistribution(player({ playerId: 'a', side: 'mine', projection: 14 }), clock);
    expect(clock.phase).toBe('not_started');
    expect(distribution.locked).toBe(false);
    expect(distribution.remainingMean).toBeCloseTo(14, 5);
    expect(distribution.ceiling).toBeGreaterThan(distribution.median);
    expect(distribution.floor).toBeLessThan(distribution.median);
  });

  it('conditions a live player on what he has already scored', () => {
    const clock = resolveGameClock(KICKOFF, HALFTIME);
    expect(clock.phase).toBe('live');
    const hot = buildDistribution(player({ playerId: 'a', side: 'mine', projection: 14, actual: 14 }), clock);
    const cold = buildDistribution(player({ playerId: 'b', side: 'mine', projection: 14, actual: 0 }), clock);
    // Both have roughly half a game left; the one who has done nothing is
    // expected to do less with it, and the one on fourteen more.
    expect(hot.remainingMean).toBeGreaterThan(cold.remainingMean);
    expect(cold.remainingMean).toBeGreaterThan(0);
    expect(hot.remainingMean).toBeLessThan(14);
  });

  it('locks a finished player: actual points, no variance, never simulated', () => {
    const clock = resolveGameClock(KICKOFF, AFTER);
    const distribution = buildDistribution(player({ playerId: 'a', side: 'mine', projection: 14, actual: 21.4 }), clock);
    expect(clock.phase).toBe('final');
    expect(distribution.locked).toBe(true);
    expect(distribution.remainingMean).toBe(0);
    expect(distribution.remainingCv).toBe(0);
    expect(distribution.floor).toBe(21.4);
    expect(distribution.ceiling).toBe(21.4);

    const result = simulateMatchup({
      players: [player({ playerId: 'a', side: 'mine', projection: 14, actual: 21.4 })],
      distributions: [distribution],
      seed: 'seed',
      draws: 200,
    });
    expect(result.samples.has('a')).toBe(false);
    expect(result.settledById.get('a')).toBe(21.4);
  });

  it('reports a matchup with every game finished as settled, with no residual doubt', () => {
    const players = lineups().map((p) => ({ ...p, actual: p.side === 'mine' ? 20 : 10 }));
    const result = forecast(players, AFTER);
    expect(result.phase).toBe('final');
    expect(result.teams.mine.winProbability).toBe(1);
    expect(result.clinch.mathematical).toBe(true);
  });
});

describe('the injury mixture', () => {
  it('does not reduce a questionable player to one flat projection', () => {
    const clock = resolveGameClock(KICKOFF, BEFORE);
    const certain = buildDistribution(
      player({ playerId: 'a', side: 'mine', projection: 14, availability: 'high_confidence_active' }),
      clock,
    );
    const doubtfulNow = buildDistribution(
      player({ playerId: 'b', side: 'mine', projection: 14, availability: 'uncertain' }),
      clock,
    );
    // The expectation falls and the floor collapses toward zero — two different
    // consequences of the same uncertainty, and both have to be visible.
    expect(effectiveRemaining(doubtfulNow)).toBeLessThan(effectiveRemaining(certain));
    expect(doubtfulNow.floor).toBeLessThan(certain.floor);
    expect(doubtfulNow.mixture.inactive).toBeGreaterThan(0);
  });

  it('collapses the branch once his game is running', () => {
    const clock = resolveGameClock(KICKOFF, HALFTIME);
    const distribution = buildDistribution(
      player({ playerId: 'a', side: 'mine', projection: 14, actual: 6, availability: 'uncertain' }),
      clock,
    );
    expect(distribution.mixture.inactive).toBe(0);
  });

  it('treats a ruled-out player as a fact rather than a branch', () => {
    const clock = resolveGameClock(KICKOFF, BEFORE);
    const distribution = buildDistribution(
      player({ playerId: 'a', side: 'mine', projection: 14, ruledOut: true, availability: 'inactive' }),
      clock,
    );
    expect(distribution.locked).toBe(true);
    expect(projectedFinal(distribution)).toBe(0);
  });
});

describe('correlation is present and bounded', () => {
  const structure = buildFactorStructure([
    { playerId: 'qb', position: 'QB', team: 'PHI', opponent: 'DAL' },
    { playerId: 'wr', position: 'WR', team: 'PHI', opponent: 'DAL' },
    { playerId: 'rival-wr', position: 'WR', team: 'DAL', opponent: 'PHI' },
    { playerId: 'rb1', position: 'RB', team: 'PHI', opponent: 'DAL' },
    { playerId: 'rb2', position: 'RB', team: 'PHI', opponent: 'DAL' },
    { playerId: 'elsewhere', position: 'WR', team: 'KC', opponent: 'BUF' },
  ]);
  const at = (id: string) => structure.assignments.find((a) => a.playerId === id)!;

  it('correlates a quarterback with his own pass catcher', () => {
    expect(impliedCorrelation(at('qb'), at('wr'))).toBeGreaterThan(0.15);
  });

  it('correlates him weakly with the other side of the same game', () => {
    const same = impliedCorrelation(at('qb'), at('wr'));
    const across = impliedCorrelation(at('qb'), at('rival-wr'));
    expect(across).toBeGreaterThan(0);
    expect(across).toBeLessThan(same);
  });

  it('makes teammates competing for the same carries negatively correlated', () => {
    expect(impliedCorrelation(at('rb1'), at('rb2'))).toBeLessThan(0);
  });

  it('leaves players in different games independent', () => {
    expect(impliedCorrelation(at('qb'), at('elsewhere'))).toBe(0);
  });

  it('keeps every implied correlation conservative', () => {
    for (const a of structure.assignments) {
      for (const b of structure.assignments) {
        if (a.playerId === b.playerId) continue;
        expect(Math.abs(impliedCorrelation(a, b))).toBeLessThanOrEqual(MAX_IMPLIED_CORRELATION);
      }
    }
  });

  it('widens the spread of a stacked lineup relative to an unstacked one', () => {
    const stacked = lineups({
      positions: ['QB', 'WR', 'WR', 'RB', 'RB', 'TE', 'WR'],
      mineTeams: ['PHI', 'PHI', 'PHI', 'SF', 'MIA', 'DET', 'LAR'],
    });
    const spread = lineups({
      positions: ['QB', 'WR', 'WR', 'RB', 'RB', 'TE', 'WR'],
      mineTeams: ['PHI', 'BUF', 'KC', 'SF', 'MIA', 'DET', 'LAR'],
    });
    expect(sd(simulate(stacked).mine)).toBeGreaterThan(sd(simulate(spread).mine));
  });
});

describe('the simulation is stable and converged', () => {
  it('returns identical numbers for identical state', () => {
    const players = lineups();
    const a = forecast(players, BEFORE);
    const b = forecast(players, BEFORE);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.teams.mine.winProbability).toBe(b.teams.mine.winProbability);
    expect(a.teams.mine.projectedFinal).toBe(b.teams.mine.projectedFinal);
  });

  it('converges: independent seeds agree to within the stated sampling error', () => {
    const players = lineups();
    const probabilities = ['a', 'b', 'c', 'd'].map(
      (salt) =>
        simulateMatchup({
          players,
          distributions: distributionsFor(players, BEFORE),
          seed: `${salt}-seed`,
          draws: 4000,
        }).winProbability,
    );
    const spread = Math.max(...probabilities) - Math.min(...probabilities);
    // Four thousand draws puts the standard error at 0.0079 at p = 0.5; four
    // seeds should sit inside three of those.
    expect(spread).toBeLessThan(0.03);
  });

  it('moves the right way when a player on your side scores', () => {
    const players = lineups();
    const before = forecast(players, HALFTIME);
    const after = forecast(
      players.map((p) => (p.playerId === 'mine-0' ? { ...p, actual: p.actual + 14 } : p)),
      HALFTIME,
    );
    expect(after.teams.mine.winProbability!).toBeGreaterThan(before.teams.mine.winProbability!);
  });

  it('moves the other way when the opponent scores', () => {
    const players = lineups();
    const before = forecast(players, HALFTIME);
    const after = forecast(
      players.map((p) => (p.playerId === 'theirs-0' ? { ...p, actual: p.actual + 14 } : p)),
      HALFTIME,
    );
    expect(after.teams.mine.winProbability!).toBeLessThan(before.teams.mine.winProbability!);
  });

  it('counts each player exactly once', () => {
    const players = lineups();
    const result = forecast(players, BEFORE);
    const ids = result.slots.flatMap((row) => [row.mine?.playerId, row.theirs?.playerId]).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(14);
  });

  it('gives two identical lineups an even matchup', () => {
    const result = forecast(lineups(), BEFORE);
    expect(result.teams.mine.winProbability!).toBeGreaterThan(0.44);
    expect(result.teams.mine.winProbability!).toBeLessThan(0.56);
  });

  it('gives the two sides complementary odds', () => {
    const result = forecast(lineups({ mineProjections: [24, 16, 14, 18, 15, 12, 13] }), BEFORE);
    expect(result.teams.mine.winProbability! + result.teams.theirs.winProbability!).toBeCloseTo(1, 3);
  });
});

describe('the fingerprint', () => {
  it('changes when a score changes', () => {
    const players = lineups();
    const a = fingerprintFor(players, BEFORE);
    const b = fingerprintFor(
      players.map((p) => (p.playerId === 'mine-0' ? { ...p, actual: 6.2 } : p)),
      BEFORE,
    );
    expect(a).not.toBe(b);
  });

  it('changes when an availability changes', () => {
    const players = lineups();
    const a = fingerprintFor(players, BEFORE);
    const b = fingerprintFor(
      players.map((p) => (p.playerId === 'mine-3' ? { ...p, availability: 'uncertain' as const } : p)),
      BEFORE,
    );
    expect(a).not.toBe(b);
  });

  it('does not change for a second of wall clock inside a live game', () => {
    const players = lineups();
    const a = fingerprintFor(players, HALFTIME);
    const b = fingerprintFor(players, new Date(HALFTIME.getTime() + 1000));
    expect(a).toBe(b);
  });

  /**
   * The cheap answer and the expensive one have to agree.
   *
   * `forecastFingerprint` is what lets a poll skip the simulation entirely, and
   * it is only safe if it produces exactly what the simulation would have
   * stamped on its own output. If the two ever drift, the cache starts serving
   * a forecast computed for a different afternoon — which looks completely
   * normal and is wrong.
   */
  it('is the same whether or not the forecast is actually built', () => {
    const players = lineups().map((p) => (p.playerId === 'mine-2' ? { ...p, actual: 7.4 } : p));
    for (const now of [BEFORE, HALFTIME, AFTER]) {
      const input = forecastInput(players, now);
      expect(forecastFingerprint(input)).toBe(buildForecast(input).fingerprint);
    }
  });

  it('separates the same week in two different seasons', () => {
    const players = lineups();
    const clocks = clocksFor(players, BEFORE);
    const a = matchupFingerprint({ leagueId: 'l1', season: '2026', week: 16, matchupId: 1, players, clocks });
    const b = matchupFingerprint({ leagueId: 'l1', season: '2027', week: 16, matchupId: 1, players, clocks });
    expect(a).not.toBe(b);
  });
});

describe('the degraded state', () => {
  it('keeps the Sleeper scoreboard and withholds the forecast', () => {
    const players = lineups().map((p) => ({ ...p, projection: null, actual: p.side === 'mine' ? 11 : 9 }));
    const result = forecast(players, HALFTIME);
    expect(result.degraded).toBe(true);
    expect(result.teams.mine.actual).toBe(77);
    expect(result.teams.mine.projectedFinal).toBeNull();
    expect(result.teams.mine.winProbability).toBeNull();
    expect(result.insights[0]!.kind).toBe('degraded');
    expect(result.insights[0]!.headline).toMatch(/temporarily unavailable/i);
  });

  it('still forecasts when only some starters are unscorable', () => {
    const players = lineups().map((p) => (p.playerId === 'mine-6' ? { ...p, projection: null } : p));
    const result = forecast(players, BEFORE);
    expect(result.degraded).toBe(false);
    expect(result.teams.mine.winProbability).not.toBeNull();
    expect(result.freshness.missingProjection).toBe(1);
    expect(result.freshness.level).not.toBe('high');
  });
});

function distributionsFor(players: MatchupPlayerInput[], now: Date) {
  return players.map((p) =>
    buildDistribution(p, resolveGameClock(p.kickoff, now, { hasPoints: p.actual > 0 })),
  );
}

function clocksFor(players: MatchupPlayerInput[], now: Date) {
  return new Map(
    players.map((p) => [p.playerId, resolveGameClock(p.kickoff, now, { hasPoints: p.actual > 0 })]),
  );
}

function fingerprintFor(players: MatchupPlayerInput[], now: Date): string {
  return matchupFingerprint({
    leagueId: 'l1',
    season: '2026',
    week: 16,
    matchupId: 1,
    players,
    clocks: clocksFor(players, now),
  });
}

function simulate(players: MatchupPlayerInput[]) {
  return simulateMatchup({
    players,
    distributions: distributionsFor(players, BEFORE),
    seed: 'fixed-seed',
    draws: 4000,
  });
}

function sd(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  const mean = total / values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i++) variance += (values[i]! - mean) ** 2;
  return Math.sqrt(variance / values.length);
}
