/**
 * Game total and Team points for the Compare table (1 November 2026): read off
 * the game line the engine already holds, and part of no score.
 */
import { describe, expect, it } from 'vitest';
import { gameLineOf } from '../src/core/startsit/gameLine.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING } from '../src/core/demo/fixtures/dst.ts';
import { candidate, defence } from './helpers/startsit.ts';
import { gameRows } from '../src/web/compareTable.ts';
import type { StartSitEvaluation } from '../src/web/api.ts';

const PROFILE = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);

describe('gameLineOf', () => {
  it('splits a 47.5 game with a 3-point favourite into 25.25 and 22.25', () => {
    expect(gameLineOf({ total: 47.5, spread: -3 })).toEqual({ total: 47.5, teamPoints: 25.25 });
    expect(gameLineOf({ total: 47.5, spread: 3 })).toEqual({ total: 47.5, teamPoints: 22.25 });
  });

  it('prints them to one decimal on the table, the same total for both sides', () => {
    const side = (spread: number) =>
      ({ playerId: String(spread), name: 'X', position: 'WR', team: 'T', gameLine: gameLineOf({ total: 47.5, spread }), expectation: { points: 10, contributions: [], missingMarkets: [], coverage: 1, notes: [] }, components: [], score: 10, decision: { points: 10, basis: 'market', base: 10, adjustments: 0 } }) as unknown as StartSitEvaluation;
    const [total, team] = gameRows([side(-3), side(3)]);
    expect(total!.cells.map((c) => c.text)).toEqual(['47.5', '47.5']);
    expect(team!.cells.map((c) => c.text)).toEqual(['25.3', '22.3']);
  });

  it('keeps the total and leaves team points blank without a spread, and says nothing without a game', () => {
    expect(gameLineOf({ total: 44, spread: null })).toEqual({ total: 44, teamPoints: null });
    expect(gameLineOf({ total: null, spread: null })).toBeNull();
    expect(gameLineOf(null)).toBeNull();
  });
});

describe('the evaluation carries it', () => {
  it('for a player, without moving his score', () => {
    const base = candidate('wr1', 'Receiver One', 'WR', 16);
    const withGame = evaluatePlayer({ ...base, game: { spread: -7.5, total: 42.5, opponent: 'CAR' } }, PROFILE);
    expect(withGame.gameLine).toEqual({ total: 42.5, teamPoints: 25 });
    expect(evaluatePlayer(base, PROFILE).gameLine).toBeNull();
  });

  it('for a defence too', () => {
    const dst = evaluatePlayer(defence('d1', 'Jets Defense', { spread: 3, total: 41, opponent: 'BUF' }), PROFILE);
    expect(dst.gameLine).toEqual({ total: 41, teamPoints: 19 });
  });
});
