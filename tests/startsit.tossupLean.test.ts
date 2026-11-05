/**
 * Floor and Ceiling decide toss-ups and change no number (Alex's decision,
 * 5 November 2026; review S3).
 *
 * The mode comes from his 10-point rule. Inside a toss-up (a gap under two
 * points, never against a real hole) Floor leans to the safer player, Ceiling
 * to the one with more upside, Balanced to the higher number. Outside one the
 * higher number decides in every mode. Safe and upside are one shared reading
 * (`spread.ts`): his weekly points this season, shrunk toward his position,
 * averaged with what his betting lines say.
 *
 * Every case fails on the code before that date, where Floor multiplied the
 * Vegas part of a number by 0.9 and Ceiling by 1.2 and a toss-up always leaned
 * to the higher number.
 */

import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { isTossUp, tossUpLean } from '../src/core/startsit/tossup.ts';
import { gamesPlayed, linesShare, positionShare, readSpread, SPREAD } from '../src/core/startsit/spread.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { benchSummary } from '../src/web/benchSummary.ts';
import type { StartSitMode } from '../src/core/startsit/mode.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'BN', 'BN', 'BN']);
const NOW = new Date('2026-11-08T15:00:00Z');
const KICKOFF = '2026-11-08T18:00:00Z';
const MODES: StartSitMode[] = ['balanced', 'floor', 'ceiling'];

/** Eight steady weeks around 10.5, and eight boom-or-bust weeks around 11.9. */
const STEADY = [10, 11, 10, 11, 10, 11, 10, 11];
const BOOM_BUST = [2, 25, 3, 22, 1, 20, 4, 18];

const wr = (id: string, points: number, season: readonly number[]) => ({
  ...candidate(id, id.toUpperCase(), 'WR', points, { team: 'KC', kickoff: KICKOFF, fullBoard: true }),
  seasonPoints: season,
});
const fixed = () => [
  candidate('qb', 'QB', 'QB', 20, { team: 'BUF', kickoff: KICKOFF, fullBoard: true }),
  candidate('rb', 'RB', 'RB', 14, { team: 'DET', kickoff: KICKOFF, fullBoard: true }),
  candidate('te', 'TE', 'TE', 9, { team: 'SF', kickoff: KICKOFF, fullBoard: true }),
];

function team(mode: StartSitMode, players: ReturnType<typeof wr>[], starterWr: string) {
  return recommendLineup([...fixed(), ...players], SHAPE, HALF_PPR, {
    mode,
    now: NOW,
    currentStarterIds: ['qb', 'rb', 'te', starterWr],
  });
}

describe('the shared spread reading', () => {
  it('reads a boom-or-bust season wider than a steady one', () => {
    const steady = readSpread({ position: 'WR', seasonPoints: STEADY });
    const boom = readSpread({ position: 'WR', seasonPoints: BOOM_BUST });
    expect(boom.share).toBeGreaterThan(steady.share);
    expect(steady.basis).toBe('season');
    expect(steady.games).toBe(8);
  });

  it('pulls a player with two games toward his position, so two big weeks do not make a boom player', () => {
    const two = readSpread({ position: 'WR', seasonPoints: [2, 25] });
    const eight = readSpread({ position: 'WR', seasonPoints: BOOM_BUST });
    const own = (v: number[]) => {
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)) / m;
    };
    /* Two games: a third of his own, two thirds the position's. */
    expect(two.share).toBeCloseTo((2 * own([2, 25]) + SPREAD.priorGames * positionShare('WR')) / (2 + SPREAD.priorGames), 2);
    expect(Math.abs(two.share - positionShare('WR'))).toBeLessThan(Math.abs(own([2, 25]) - positionShare('WR')));
    expect(eight.games).toBe(8);
  });

  it('counts only the weeks he scored: a bye is not a bust', () => {
    expect(gamesPlayed([10, 0, 11, 0, 10])).toEqual([10, 11, 10]);
    expect(readSpread({ position: 'WR', seasonPoints: [10, 0, 11, 0, 10] }).games).toBe(3);
  });

  it('reads few long catches wider than many short ones, on the same total', () => {
    const lines = (catches: number, yards: number) =>
      linesShare({
        points: catches * 0.5 + yards * 0.1,
        contributions: [
          { market: 'receptions', line: catches, mean: catches, points: catches * 0.5, detail: '' },
          { market: 'receiving_yards', line: yards, mean: yards, points: yards * 0.1, detail: '' },
        ],
      })!;
    /* 3 catches for 85 yards and 8 catches for 60 yards both add up to 10. */
    expect(lines(3, 85)).toBeGreaterThan(lines(8, 60));
  });

  it('falls back to the position with nothing of his own', () => {
    const none = readSpread({ position: 'TE' });
    expect(none.basis).toBe('position');
    expect(none.share).toBe(positionShare('TE'));
  });
});

describe('the one lean function', () => {
  const steady = { points: 11, position: 'WR', spread: readSpread({ position: 'WR', seasonPoints: STEADY }) };
  const boom = { points: 11.5, position: 'WR', spread: readSpread({ position: 'WR', seasonPoints: BOOM_BUST }) };

  it('Balanced leans to the higher number, with no word', () => {
    expect(tossUpLean(boom, steady, 'balanced')).toEqual({ lean: 'a', tag: null });
  });

  it('Floor leans to the safer player, Ceiling to the one with more upside', () => {
    expect(tossUpLean(boom, steady, 'floor')).toEqual({ lean: 'b', tag: 'safer' });
    expect(tossUpLean(boom, steady, 'ceiling')).toEqual({ lean: 'a', tag: 'more upside' });
  });

  it('ranks a Sleeper-only number two points lower here too', () => {
    /* 12.5 on Sleeper's week ranks 10.5, behind a priced 11 in Balanced. */
    expect(tossUpLean({ ...boom, points: 12.5, borrowed: true }, steady, 'balanced').lean).toBe('b');
  });
});

describe('Team: the lean inside a toss-up', () => {
  /* Bench BOOM 11.5 edges Sleeper's STEADY 11.0: a toss-up the optimiser finds. */
  const players = () => [wr('steady', 11, STEADY), wr('boom', 11.5, BOOM_BUST)];

  it('Balanced: toss-up, lean the higher number (the bench boom player), no word', () => {
    const lineup = team('balanced', players(), 'steady');
    expect(lineup.swaps).toEqual([]);
    expect(lineup.tossUps!.map((t) => [t.inPlayerId, t.outPlayerId, t.leanTag ?? null])).toEqual([['boom', 'steady', null]]);
  });

  it('Floor: leans back to Sleeper\'s steady starter, "safer"', () => {
    const lineup = team('floor', players(), 'steady');
    expect(lineup.swaps).toEqual([]);
    expect(lineup.tossUps!.map((t) => [t.inPlayerId, t.outPlayerId, t.leanTag])).toEqual([['steady', 'boom', 'safer']]);
  });

  it('Ceiling: leans to the boom player, "more upside"', () => {
    const lineup = team('ceiling', players(), 'steady');
    expect(lineup.tossUps!.map((t) => [t.inPlayerId, t.outPlayerId, t.leanTag])).toEqual([['boom', 'steady', 'more upside']]);
  });

  it('Floor names a toss-up Balanced does not: a steady bench man just behind a boom starter', () => {
    /* Sleeper starts BOOM 11.5; STEADY 11.0 sits. Balanced keeps BOOM and says nothing. */
    expect(team('balanced', players(), 'boom').tossUps).toEqual([]);
    const floor = team('floor', players(), 'boom');
    expect(floor.swaps).toEqual([]);
    expect(floor.tossUps!.map((t) => [t.inPlayerId, t.outPlayerId, t.leanTag])).toEqual([['steady', 'boom', 'safer']]);
    expect(team('ceiling', players(), 'boom').tossUps).toEqual([]);
  });

  it('never changes the lineup: the starters are the same in every mode', () => {
    const read = MODES.map((mode) => team(mode, players(), 'steady').slots.map((s) => s.playerId));
    expect(read[1]).toEqual(read[0]);
    expect(read[2]).toEqual(read[0]);
  });

  it('prints the same number for every player in every mode', () => {
    const numbers = MODES.map((mode) => {
      const lineup = team(mode, players(), 'steady');
      return [...lineup.starters, ...lineup.bench].map((e) => [e.playerId, e.score, e.decision?.points]).sort();
    });
    expect(numbers[1]).toEqual(numbers[0]);
    expect(numbers[2]).toEqual(numbers[0]);
  });

  it('the bench line says "Toss-up" whenever Best move does, in every mode', () => {
    for (const mode of MODES) {
      for (const starter of ['steady', 'boom']) {
        const lineup = { ...team(mode, players(), starter), found: true };
        const expected = (lineup.tossUps?.length ?? 0) > 0 && lineup.swaps.length === 0 ? 'Toss-up' : 'No better option';
        expect(benchSummary(lineup), `${mode}, Sleeper starts ${starter}`).toBe(expected);
      }
    }
    expect(benchSummary({ ...team('floor', players(), 'boom'), found: true })).toBe('Toss-up');
  });
});

describe('Team: outside a toss-up the mode moves nothing', () => {
  it('a clear 3-point call is the same swap in every mode, never a toss-up', () => {
    for (const mode of MODES) {
      const lineup = team(mode, [wr('steady', 11, STEADY), wr('boom', 14, BOOM_BUST)], 'steady');
      expect(lineup.swaps.map((s) => [s.inPlayerId, s.outPlayerId]), mode).toEqual([['boom', 'steady']]);
      expect(lineup.tossUps, mode).toEqual([]);
    }
  });

  it('a real hole still headlines: an Out or Doubtful starter is replaced in every mode', () => {
    for (const status of ['Out', 'Doubtful']) {
      for (const mode of MODES) {
        const hurt = { ...wr('steady', 11.6, STEADY), injuryStatus: status, player: { ...wr('steady', 11.6, STEADY).player, status } };
        const lineup = team(mode, [hurt, wr('boom', 11, BOOM_BUST)], 'steady');
        expect(lineup.swaps.map((s) => [s.inPlayerId, s.outPlayerId]), `${status}, ${mode}`).toEqual([['boom', 'steady']]);
        expect(lineup.tossUps, `${status}, ${mode}`).toEqual([]);
      }
    }
  });
});

describe('Compare: the same lean, from the same function', () => {
  const pair = () => [wr('steady', 11, STEADY), wr('boom', 11.5, BOOM_BUST)];

  it('leans with the mode inside a toss-up, and never says Start', () => {
    const balanced = compareStartSit(pair(), HALF_PPR, { mode: 'balanced' });
    const floor = compareStartSit(pair(), HALF_PPR, { mode: 'floor' });
    const ceiling = compareStartSit(pair(), HALF_PPR, { mode: 'ceiling' });
    for (const c of [balanced, floor, ceiling]) expect(c.recommendedPlayerId).toBeNull();
    expect([balanced.tossUp?.leanPlayerId, balanced.tossUp?.leanTag]).toEqual(['boom', undefined]);
    expect([floor.tossUp?.leanPlayerId, floor.tossUp?.leanTag]).toEqual(['steady', 'safer']);
    expect([ceiling.tossUp?.leanPlayerId, ceiling.tossUp?.leanTag]).toEqual(['boom', 'more upside']);
  });

  it('agrees with Team on the same two players', () => {
    for (const mode of MODES) {
      const t = team(mode, pair(), 'steady').tossUps![0]!;
      expect(compareStartSit(pair(), HALF_PPR, { mode }).tossUp?.leanPlayerId, mode).toBe(t.inPlayerId);
    }
  });

  it('a clear call is a Start in every mode, with the same numbers', () => {
    const clear = () => [wr('steady', 11, STEADY), wr('boom', 14, BOOM_BUST)];
    const read = MODES.map((mode) => compareStartSit(clear(), HALF_PPR, { mode }));
    for (const c of read) {
      expect(c.recommendedPlayerId).toBe('boom');
      expect(c.tossUp).toBeUndefined();
    }
    const numbers = read.map((c) => c.evaluations.map((e) => [e.playerId, e.decision?.points]));
    expect(numbers[1]).toEqual(numbers[0]);
    expect(numbers[2]).toEqual(numbers[0]);
  });

  it('the bar itself did not move', () => {
    expect(isTossUp({ points: 12.99 }, { points: 11 })).toBe(true);
    expect(isTossUp({ points: 13 }, { points: 11 })).toBe(false);
  });
});
