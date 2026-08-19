/**
 * Proving the tests would actually notice.
 *
 * A suite that passes is worth nothing on its own — what matters is whether it
 * would go red if the model were wrong. §44 names eight specific ways this
 * feature could break, every one of which produces a screen that looks
 * completely normal, and this file breaks each of them deliberately and asserts
 * that the property under test fails.
 *
 * The mutation is applied to the model's *inputs or outputs*, not by editing
 * source at runtime: a real code change would be caught by the same assertion,
 * and simulating one here keeps the proof in the same file as the property it
 * is proving. Each test therefore reads as: correct behaviour holds, the broken
 * behaviour does not, and here is the assertion that separates them.
 */

import { describe, expect, it } from 'vitest';
import { buildForecast } from '../src/core/matchup/model.ts';
import { buildDistribution, resolveGameClock } from '../src/core/matchup/distribution.ts';
import { buildFactorStructure, impliedCorrelation } from '../src/core/matchup/correlation.ts';
import { simulateMatchup } from '../src/core/matchup/simulate.ts';
import { lineups, player, slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';

const BEFORE = new Date('2026-12-20T15:00:00Z');
const HALFTIME = new Date('2026-12-20T19:32:30Z');
const AFTER = new Date('2026-12-20T22:00:00Z');
const KICKOFF = '2026-12-20T18:00:00Z';

function forecast(players: MatchupPlayerInput[], now: Date, actual?: { mine: number; theirs: number }) {
  const totals =
    actual ??
    (['mine', 'theirs'] as const).reduce(
      (acc, side) => ({
        ...acc,
        [side]: round2(players.filter((p) => p.side === side && p.starting).reduce((a, p) => a + p.actual, 0)),
      }),
      { mine: 0, theirs: 0 },
    );
  return buildForecast({
    leagueId: 'l1',
    season: '2026',
    week: 16,
    matchupId: 3,
    players,
    teams: {
      mine: { rosterId: 1, name: 'Mine', avatar: null, record: null },
      theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: null },
    },
    actualScores: totals,
    slots: slots(),
    now,
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

describe('a Sleeper projection substituted for this app’s', () => {
  /**
   * The failure: somebody wires `custom_points` — Sleeper's own projection — in
   * where the start/sit score belongs. Nothing errors and the card looks right.
   *
   * What catches it: the projected total is the sum of *this app's* per-player
   * projections, and those come from the engine. A total built from a different
   * source cannot agree with the per-player numbers the same response carries.
   */
  it('is caught by the total having to equal the sum of the shown projections', () => {
    const players = lineups();
    const honest = forecast(players, BEFORE);
    const shown = honest.slots
      .map((row) => row.mine?.projectedFinal ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(Math.abs(honest.teams.mine.projectedFinal! - shown)).toBeLessThan(shown * 0.06);

    // The mutation: Sleeper's numbers, roughly a fifth higher across the board.
    const substituted = forecast(
      players.map((p) => ({ ...p, projection: (p.projection ?? 0) * 1.2 })),
      BEFORE,
    );
    expect(Math.abs(substituted.teams.mine.projectedFinal! - shown)).toBeGreaterThan(shown * 0.06);
  });
});

describe('a completed player left in the simulation', () => {
  /**
   * The failure: the `final` branch is dropped and a finished player keeps a
   * distribution. His actual points become an *average* instead of a fact, and
   * a matchup that is over reads as 94% instead of 100%.
   */
  it('is caught by a settled matchup having to be certain', () => {
    const players = lineups().map((p) => ({ ...p, actual: p.side === 'mine' ? 18 : 9 }));
    const settled = forecast(players, AFTER);
    expect(settled.teams.mine.winProbability).toBe(1);

    // The mutation: the same scores, but the games are treated as still to be
    // played — which is exactly what forgetting to lock them produces.
    const stillSimulated = forecast(players, BEFORE);
    expect(stillSimulated.teams.mine.winProbability).toBeLessThan(1);
  });

  it('is caught by a finished player having no sampled column at all', () => {
    const finished = player({ playerId: 'a', side: 'mine', projection: 14, actual: 21.4, kickoff: KICKOFF });
    const locked = buildDistribution(finished, resolveGameClock(KICKOFF, AFTER));
    const notLocked = buildDistribution(finished, resolveGameClock(KICKOFF, BEFORE));

    const of = (d: typeof locked) =>
      simulateMatchup({ players: [finished], distributions: [d], seed: 's', draws: 200 }).samples.has('a');
    expect(of(locked)).toBe(false);
    // The mutation, and the assertion that separates them.
    expect(of(notLocked)).toBe(true);
  });
});

describe('a stack treated as fully independent', () => {
  /**
   * The failure: the factor loadings are zeroed, or a player's club is not read,
   * so a quarterback and his own receiver become independent draws. Every
   * projected total stays identical and only the *spread* changes — which is
   * invisible on the card and is most of what a win probability is made of.
   */
  it('is caught by the implied correlation, and by the spread it produces', () => {
    const structure = buildFactorStructure([
      { playerId: 'qb', position: 'QB', team: 'PHI', opponent: 'DAL' },
      { playerId: 'wr', position: 'WR', team: 'PHI', opponent: 'DAL' },
    ]);
    const [qb, wr] = structure.assignments;
    expect(impliedCorrelation(qb!, wr!)).toBeGreaterThan(0.15);

    // The mutation: the same two players with no club on either of them, which
    // is what a dropped team lookup produces.
    const blind = buildFactorStructure([
      { playerId: 'qb', position: 'QB', team: '', opponent: null },
      { playerId: 'wr', position: 'WR', team: '', opponent: null },
    ]);
    expect(impliedCorrelation(blind.assignments[0]!, blind.assignments[1]!)).toBe(0);

    const stacked = spread(
      lineups({
        positions: ['QB', 'WR', 'WR', 'RB', 'RB', 'TE', 'WR'],
        mineTeams: ['PHI', 'PHI', 'PHI', 'SF', 'MIA', 'DET', 'LAR'],
      }),
    );
    const independent = spread(
      lineups({
        positions: ['QB', 'WR', 'WR', 'RB', 'RB', 'TE', 'WR'],
        mineTeams: ['PHI', 'PHI', 'PHI', 'SF', 'MIA', 'DET', 'LAR'],
      }).map((p) => ({ ...p, team: '', opponent: null })),
    );
    expect(stacked).toBeGreaterThan(independent);
  });
});

describe('a questionable player flattened to one projection', () => {
  /**
   * The failure: the mixture is dropped and a Questionable player is simply
   * projected a bit lower. His mean barely moves, so nothing on the card looks
   * wrong — and his *floor* silently stops being zero, which is the entire
   * reason the branch exists.
   */
  it('is caught by the floor having to collapse toward his banked points', () => {
    const clock = resolveGameClock(KICKOFF, BEFORE);
    const uncertain = buildDistribution(
      player({ playerId: 'a', side: 'mine', projection: 14, availability: 'uncertain' }),
      clock,
    );
    // The mutation: the same expected value, expressed as a lower flat
    // projection with no inactive branch at all.
    const flattened = buildDistribution(
      player({ playerId: 'a', side: 'mine', projection: 14 * 0.5, availability: 'high_confidence_active' }),
      clock,
    );

    expect(uncertain.mixture.inactive).toBeGreaterThan(0);
    expect(flattened.mixture.inactive).toBe(0);
    expect(uncertain.floor).toBeLessThan(flattened.floor);
  });
});

describe('a win probability that jitters', () => {
  /**
   * The failure: `Math.random` is used, or the seed stops depending on the
   * state. The number moves by a point or two on every poll, the reader learns
   * to ignore it, and the two points a touchdown genuinely moved disappear into
   * the noise.
   */
  it('is caught by identical state having to give an identical number', () => {
    const players = lineups();
    const a = forecast(players, BEFORE);
    const b = forecast(players, BEFORE);
    expect(a.teams.mine.winProbability).toBe(b.teams.mine.winProbability);

    // The mutation: a seed that varies while the state does not.
    const distributions = players.map((p) => buildDistribution(p, resolveGameClock(p.kickoff, BEFORE)));
    const one = simulateMatchup({ players, distributions, seed: 'seed-a', draws: 4000 }).winProbability;
    const two = simulateMatchup({ players, distributions, seed: 'seed-b', draws: 4000 }).winProbability;
    expect(one).not.toBe(two);
  });
});

describe('an actual score overwritten by a projection', () => {
  /**
   * The failure: the score card reads the forecast where it should read
   * Sleeper. It is the single most misleading thing this feature could do, and
   * it would look completely ordinary — a plausible number in the right place.
   */
  it('is caught by the actual score coming from the payload rather than the model', () => {
    const players = lineups().map((p) => ({ ...p, actual: 3 }));
    const result = forecast(players, HALFTIME, { mine: 21, theirs: 21 });
    // Sleeper said 21; the model's own sum of the same players is 21 too, and
    // its projection is far higher. The card must show Sleeper's.
    expect(result.teams.mine.actual).toBe(21);
    expect(result.teams.mine.projectedFinal).toBeGreaterThan(30);
    expect(result.teams.mine.actual).not.toBe(result.teams.mine.projectedFinal);
  });

  it('is caught by the actual total not being recomputed from the players', () => {
    // A league with a scoring rule this app does not model would make the two
    // disagree, and Sleeper's number is the one that is right.
    const players = lineups().map((p) => ({ ...p, actual: 5 }));
    const result = forecast(players, HALFTIME, { mine: 40.5, theirs: 33.25 });
    expect(result.teams.mine.actual).toBe(40.5);
    expect(result.teams.theirs.actual).toBe(33.25);
  });
});

describe('a hero engine that surfaces the trivial over the urgent', () => {
  /**
   * The failure: urgency stops being a tier and becomes another weight, so a
   * large-looking projection swing outranks a player who might not play.
   */
  it('is caught by the tiers having to be strictly ordered', () => {
    const players = lineups().map((p) =>
      p.playerId === 'mine-0'
        ? { ...p, availability: 'uncertain' as const, kickoff: '2026-12-20T21:25:00Z' }
        : p.playerId === 'mine-4'
          ? { ...p, actual: p.projection! + 8 }
          : p,
    );
    const insights = forecast(players, HALFTIME).insights;
    const injury = insights.find((i) => i.kind === 'injury');
    expect(injury).toBeDefined();

    for (const other of insights) {
      if (other.urgency === 'act_now') continue;
      expect(other.priority, `${other.kind} outranked an availability alert`).toBeLessThan(injury!.priority);
    }
  });
});

describe('a player row that grows into a stat dump', () => {
  /**
   * The failure: the row starts carrying the things the brief lists as
   * forbidden by default — targets, carries, xFP, prop lines, long injury text.
   * The check is on the *shape of the data* the row is handed, which is what
   * makes it impossible to render them by accident.
   */
  it('is caught by the row’s own fields being the only ones there are', () => {
    const row = forecast(lineups(), BEFORE).slots[0]!.mine!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'actual',
        'availabilityRisky',
        'fullName',
        'locked',
        'name',
        'opponent',
        'phase',
        'playerId',
        'position',
        'projectedFinal',
        'remaining',
        'side',
        'slot',
        'starting',
        'statusFlag',
        'team',
        /*
         * A comparison, not a statistic.
         *
         * It is one number saying how far ahead of his own projection he is
         * running, which is the thing the row colours; the fields this guard
         * exists to keep out are the raw ones — targets, carries, xFP, prop
         * lines, injury prose — that turn a row into a box score. Adding it
         * here is the deliberate act the guard is asking for.
         */
        'vsExpectation',
      ].sort(),
    );
  });
});

/** The standard deviation of the user's simulated totals. */
function spread(players: MatchupPlayerInput[]): number {
  const distributions = players.map((p) => buildDistribution(p, resolveGameClock(p.kickoff, BEFORE)));
  const values = simulateMatchup({ players, distributions, seed: 'fixed', draws: 6000 }).mine;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  const mean = total / values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i++) variance += (values[i]! - mean) ** 2;
  return Math.sqrt(variance / values.length);
}
