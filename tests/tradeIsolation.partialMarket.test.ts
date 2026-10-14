/**
 * The trade ideas value a player on the week's number, and a partial market is
 * never a price.
 *
 * PR #285 defined "priced" for trades as "a betting market has produced a
 * number for his week", and from 24 September 2026 this file held that line
 * even for a *partial* market (some of a position's lines posted), on the
 * argument that the display path's completeness rule should stop at the Team
 * screen.
 *
 * Changed 15 October 2026, by the owner's decision: a partial line counted as a
 * full price is the same data bug the Team and Compare screens had fixed (a
 * Vegas fragment showing a player at 1.6 points), and it emptied the ideas board
 * every Tuesday and Wednesday. On the 14 October production board it priced
 * McConkey, Egbuka, Braelon Allen and Pierce at about two points each, and 62 of
 * 108 checked ideas then failed the value band. The ideas now read the same
 * per-week number Waivers and Compare do (`decisionPoints`, through
 * `weekValueOf` in `rosterUtility.ts`):
 *
 *   1. a complete market is the week, as before;
 *   2. a partial market with Sleeper's published week is valued on that week,
 *      with the same capped nudges;
 *   3. a partial market with nothing published is unpriced, exactly like no
 *      market at all;
 *   4. the published figure reaches the trade engine only as a plain map and
 *      only through `decisionPoints`: nothing under `core/trades/` reads the
 *      completeness rule or the published feed itself.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { marketIsComplete, weeklyProjection } from '../src/core/startsit/projection.ts';
import { buildRosterViews, weekValueOf } from '../src/core/trades/rosterUtility.ts';
import { decisionPoints } from '../src/core/startsit/decisionPoints.ts';
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

  it('is not a price on its own, and is valued on Sleeper’s week when there is one', () => {
    expect(weekValueOf(evaluation)).toBeNull();
    const withWeek = weekValueOf(evaluation, new Map([['stevenson', 9.8]]));
    expect(withWeek).not.toBeNull();
    expect(withWeek).toBe(decisionPoints(evaluation, new Map([['stevenson', 9.8]]))!.points);
    expect(weekValueOf(evaluatePlayer(UNPRICED, PROFILE), new Map([['nobody', 7]]))).toBeNull();
  });

  const pool = new Map<string, StartSitInput>([
    ['qb', pricedCandidate('qb', 'Passer', 'QB', 18, { now: NOW })],
    ['rb1', pricedCandidate('rb1', 'Back One', 'RB', 14, { now: NOW })],
    ['wr', pricedCandidate('wr', 'Receiver', 'WR', 11, { now: NOW })],
    ['te', pricedCandidate('te', 'Tight End', 'TE', 8, { now: NOW })],
    ['stevenson', STEVENSON],
    ['nobody', UNPRICED],
  ]);
  const view = (published?: Map<string, number>) =>
    buildRosterViews({
      rosters: [{ key: 'mine', playerIds: [...pool.keys()] }],
      pool,
      shape: SHAPE,
      profile: PROFILE,
      ...(published ? { published } : {}),
    }).get('mine')!;

  it('leaves a partial market with nothing published out, as unpriced', () => {
    const v = view();
    expect(v.valueOf.has('stevenson')).toBe(false);
    expect(v.unpriced.has('stevenson')).toBe(true);
    /* A complete market is the week, unchanged. */
    expect(v.valueOf.get('rb1')).toBe(decisionPoints(evaluatePlayer(pool.get('rb1')!, PROFILE))!.points);
    /* No market and no charge: nothing to score him on at all. */
    expect(v.unscored.has('nobody')).toBe(true);
    expect(v.valueOf.has('nobody')).toBe(false);
  });

  it('values a partial market on Sleeper’s published week, never on the fragment', () => {
    const v = view(new Map([['stevenson', 9.8]]));
    expect(v.valueOf.get('stevenson')).toBe(decisionPoints(evaluation, new Map([['stevenson', 9.8]]))!.points);
    expect(v.valueOf.get('stevenson')).not.toBe(evaluation.score);
    expect(v.unpriced.has('stevenson')).toBe(false);
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

  it('takes the published week only as a plain map, read only through decisionPoints', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'core', 'trades', 'rosterUtility.ts'), 'utf8');
    expect(source).toMatch(/import \{ decisionPoints \} from '\.\.\/startsit\/decisionPoints\.ts'/);
    /* No import of the published feed itself anywhere under core/trades. */
    const dir = join(__dirname, '..', 'src', 'core', 'trades');
    const feed = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /from '[^']*(sleeperProjection|weeklyProjections)[^']*'/.test(readFileSync(join(dir, f), 'utf8')));
    expect(feed).toEqual([]);
  });
});
