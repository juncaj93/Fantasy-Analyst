/**
 * A market with lines missing is real, and it is not a projection.
 *
 * Measured on production on 24 September 2026, off a Patriots snapshot bought
 * on the Tuesday before most of the board was posted:
 *
 *     Rhamondre Stevenson   0.75   anytime TD only      the full board: 8.79
 *     TreVeyon Henderson    0.69   anytime TD only      the full board: 7.76
 *     Drake Maye           11.19   no passing-TD line   the full board: 20.21
 *
 * Every screen printed those as the player's week, labelled Market. These pin
 * the three players' shapes: the partial sum stays the market number (the
 * trade engine's definition of "priced" rests on it), and every screen's
 * projection drops to the next tier instead, and the card says what is missing.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import {
  completeMarketProjection,
  marketIsComplete,
  marketProjection,
  weeklyProjection,
} from '../src/core/startsit/projection.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { EXPECTED_GAMES } from '../src/core/nfl/expectedGames.ts';
import type { MarketKey, PlayerProp } from '../src/core/vegas/types.ts';
import { player } from './helpers/players.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
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

function input(id: string, name: string, position: string, props: PlayerProp[]): StartSitInput {
  return {
    player: player({ id, fullName: name, position, team: 'NE' }),
    props,
    signal: null,
    injuryStatus: null,
    propsStale: false,
    now: NOW,
  };
}

/* The three players as production held them. */
const stevenson = evaluatePlayer(input('stevenson', 'Rhamondre Stevenson', 'RB', [prop('stevenson', 'anytime_td', null, 0.125)]), PROFILE);
const maye = evaluatePlayer(
  input('maye', 'Drake Maye', 'QB', [prop('maye', 'pass_yards', 218.5), prop('maye', 'rush_yards', 24.5)]),
  PROFILE,
);
/* And Stevenson on the board that was actually up. */
const stevensonFull = evaluatePlayer(
  input('stevenson', 'Rhamondre Stevenson', 'RB', [
    prop('stevenson', 'rush_yards', 37.5),
    prop('stevenson', 'receiving_yards', 14.5),
    prop('stevenson', 'receptions', 2.5),
    prop('stevenson', 'anytime_td', null, 0.39),
  ]),
  PROFILE,
);

describe('the market number itself does not move', () => {
  it('is still the partial sum, because trades price on it', () => {
    expect(marketProjection(stevenson)).toBe(0.75);
    expect(marketProjection(maye)).toBe(11.19);
  });

  it('knows which markets are missing', () => {
    expect(marketIsComplete(stevenson)).toBe(false);
    expect(stevenson.expectation.missingMarkets).toEqual(['rush_yards', 'receiving_yards', 'receptions']);
    expect(maye.expectation.missingMarkets).toEqual(['pass_tds']);
    expect(marketIsComplete(stevensonFull)).toBe(true);
    expect(completeMarketProjection(stevenson)).toBeNull();
  });
});

describe('what a screen prints for him', () => {
  it('prints the complete market as the market', () => {
    expect(weeklyProjection(stevensonFull, 9.8)).toEqual({ points: marketProjection(stevensonFull), source: 'market' });
  });

  it('drops a partial market to the published figure', () => {
    expect(weeklyProjection(stevenson, 9.8)).toEqual({ points: 9.8, source: 'sleeper' });
  });

  it('drops a partial quarterback to the preseason tier when the feed is refused him', () => {
    /* This league's six-point passing TD is why Rotowire's QB total is refused. */
    expect(weeklyProjection(maye, null, 300)).toEqual({
      points: Math.round((300 / EXPECTED_GAMES) * 100) / 100,
      source: 'preseason',
    });
  });

  it('says nothing rather than print the partial sum when there is no other tier', () => {
    expect(weeklyProjection(stevenson, null, null)).toEqual({ points: null, source: null });
  });

  it('keeps the real lines on the card and says which are missing', () => {
    const card = buildWeeklyCard(stevenson, { starting: true, published: 9.8 });
    expect(card.score).toBe(9.8);
    expect(card.projectionSource).toBe('sleeper');
    const market = card.lines.find((l) => l.key === 'market');
    expect(market?.value).toBe('0.8 pts');
    expect(market?.detail).toBe('Partial: no rushing yards, receiving yards, receptions line yet');

    const qb = buildWeeklyCard(maye, { starting: true }).lines.find((l) => l.key === 'market');
    expect(qb?.detail).toBe('Partial: no passing TD line yet');
  });
});
