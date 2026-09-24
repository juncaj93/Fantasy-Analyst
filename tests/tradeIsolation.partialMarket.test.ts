/**
 * The trade engine's "priced" still means a real market number, full stop.
 *
 * PR #285 defined it: a player is priced for a trade when a betting market has
 * produced a number for his week, and the Rotowire and preseason tiers never
 * enter a trade. On 24 September 2026 the display and lineup paths learned to
 * treat a *partial* market — some of a position's lines posted, some not — as
 * not good enough to print, and to fall back to the published figure instead.
 *
 * That change must stop at the display and the Team screen's ranking. These
 * hold the line from the trade side:
 *
 *   1. a partial market is still priced, and still valued on its own score;
 *   2. no published figure can reach a trade value, because the trade engine
 *      has no way to be handed one;
 *   3. nothing under `core/trades/` reads the completeness rule at all.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { marketIsComplete, weeklyProjection } from '../src/core/startsit/projection.ts';
import { buildRosterViews, isPriced } from '../src/core/trades/rosterUtility.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { MarketKey, PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';
import { pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'TE', 'FLEX', 'BN', 'BN']);
const NOW = '2026-09-24T02:00:00Z';

function prop(id: string, market: MarketKey, line: number | null, impliedProbability: number | null = null): PlayerProp {
  return {
    playerId: id,
    sourcePlayerName: id,
    market,
    line,
    overPrice: -110,
    underPrice: null,
    bookCount: 6,
    consensusMethod: 'single',
    books: ['sportsgameodds'],
    impliedProbability,
  };
}

/* Stevenson as production held him: a touchdown line and nothing else. */
const STEVENSON: StartSitInput = {
  player: player({ id: 'stevenson', fullName: 'Rhamondre Stevenson', position: 'RB', team: 'NE' }),
  props: [prop('stevenson', 'anytime_td', null, 0.125)],
  signal: null,
  injuryStatus: null,
  propsStale: false,
  now: NOW,
};

/* Nobody has priced this one at all. */
const UNPRICED: StartSitInput = {
  player: player({ id: 'nobody', fullName: 'Unquoted Back', position: 'RB', team: 'NE' }),
  props: [],
  signal: null,
  injuryStatus: 'Questionable',
  propsStale: false,
  now: NOW,
};

describe('a partial market in a trade', () => {
  const evaluation = evaluatePlayer(STEVENSON, PROFILE);

  it('is the display path’s partial market: not complete, printed from the published tier', () => {
    expect(marketIsComplete(evaluation)).toBe(false);
    expect(weeklyProjection(evaluation, 9.8).source).toBe('sleeper');
  });

  it('is still priced for a trade', () => {
    expect(isPriced(evaluation)).toBe(true);
    expect(isPriced(evaluatePlayer(UNPRICED, PROFILE))).toBe(false);
  });

  it('is valued on his own market-based score, never on a published figure', () => {
    const pool = new Map<string, StartSitInput>([
      ['qb', pricedCandidate('qb', 'Passer', 'QB', 18, { now: NOW })],
      ['rb1', pricedCandidate('rb1', 'Back One', 'RB', 14, { now: NOW })],
      ['wr', pricedCandidate('wr', 'Receiver', 'WR', 11, { now: NOW })],
      ['te', pricedCandidate('te', 'Tight End', 'TE', 8, { now: NOW })],
      ['stevenson', STEVENSON],
      ['nobody', UNPRICED],
    ]);
    const views = buildRosterViews({
      rosters: [{ key: 'mine', playerIds: [...pool.keys()] }],
      pool,
      shape: SHAPE,
      profile: PROFILE,
    });
    const view = views.get('mine')!;
    expect(view.valueOf.get('stevenson')).toBe(evaluation.score);
    expect(view.unpriced.has('stevenson')).toBe(false);
    expect(view.unpriced.has('nobody')).toBe(true);
    expect(view.valueOf.has('nobody')).toBe(false);
  });
});

describe('the trade engine cannot reach the completeness rule', () => {
  it('has no import of it anywhere under core/trades', () => {
    const dir = join(__dirname, '..', 'src', 'core', 'trades');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\b(marketIsComplete|completeMarketProjection|weeklyProjection)\b/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('takes no published figure: buildRosterViews has no such argument', () => {
    /*
     * A compile-time fact checked at run time: the options object is the whole
     * of what a trade valuation can be told, and a published map is not in it.
     */
    const source = readFileSync(join(__dirname, '..', 'src', 'core', 'trades', 'rosterUtility.ts'), 'utf8');
    const signature = source.slice(source.indexOf('export function buildRosterViews('), source.indexOf('): Map<string, RosterView>'));
    expect(signature).not.toMatch(/published/);
  });
});
