/**
 * The touchdown part of a market total is on the card that prints the total.
 *
 * Reported on 24 September 2026 for Rashee Rice (KC) and Jaxon Smith-Njigba
 * (SEA), and measured on production by `scripts/probe-td-odds-scope.mjs`
 * before anything changed: the provider posted a touchdown price for every one
 * of the 23 priced skill players sampled across ten games, the app stored it
 * and summed it, and the card dropped it. The anytime-TD market has a price
 * and no line, and the chip filter kept only markets with a line. So Rice's
 * `9.6 pts` read as `Rec yards 48.5 · Receptions 4.5`, which are 7.1 of it.
 *
 * These are built from his real board, through the real expectation, so the
 * test fails if either half stops carrying the touchdown.
 */

import { describe, expect, it } from 'vitest';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { MAX_WEEKLY_PROPS, PENDING_USAGE_MODEL, buildWeeklyCard, type WeeklyEvaluationLike } from '../src/core/startsit/weekCard.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 6, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

function prop(market: PlayerProp['market'], line: number | null, impliedProbability: number | null = null): PlayerProp {
  return {
    playerId: 'x',
    sourcePlayerName: 'x',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 1,
    consensusMethod: 'median',
    books: ['consensus'],
    impliedProbability,
  };
}

function cardFor(position: string, props: PlayerProp[]) {
  const expectation = buildExpectation(position, props, HALF_PPR);
  const evaluation: WeeklyEvaluationLike = {
    playerId: '1',
    name: 'Rashee Rice',
    position,
    team: 'KC',
    score: expectation.points,
    confidence: 'medium',
    statusFlag: null,
    ruledOut: false,
    opponent: 'MIA',
    expectation,
  };
  return { expectation, card: buildWeeklyCard(evaluation, { starting: true, slot: 'WR' }) };
}

describe('a market total shows every market in it', () => {
  it('prints the touchdown price beside the yards and catches it was summed with (Rashee Rice)', () => {
    const { expectation, card } = cardFor('WR', [
      prop('receiving_yards', 48.5),
      prop('receptions', 4.5),
      prop('anytime_td', null, 0.42),
    ]);
    expect(expectation.points).toBeCloseTo(9.62, 2);
    expect(expectation.missingMarkets).toEqual([]);
    expect(card.props.map((p) => `${p.label} ${p.value}`)).toEqual(['Rec yards 48.5', 'Anytime TD 42%', 'Receptions 4.5']);
  });

  it('keeps all four for a running back, where the old cap of three cut one', () => {
    const { card } = cardFor('RB', [
      prop('rush_yards', 85.5),
      prop('receiving_yards', 22.5),
      prop('receptions', 3.5),
      prop('anytime_td', null, 0.67),
    ]);
    expect(MAX_WEEKLY_PROPS).toBe(4);
    expect(card.props.map((p) => p.key).sort()).toEqual(
      ['prop-anytime_td', 'prop-receiving_yards', 'prop-receptions', 'prop-rush_yards'],
    );
  });

  it('shows a touchdown-only market as partial, with its one chip', () => {
    const { card } = cardFor('RB', [prop('anytime_td', null, 0.13)]);
    const market = card.lines.find((l) => l.key === 'market');
    expect(market?.detail).toBe('Partial: no rushing yards, receiving yards, receptions line yet');
    expect(card.props.map((p) => `${p.label} ${p.value}`)).toEqual(['Anytime TD 13%']);
  });

  it('still leaves out a touchdown market with no price, which is not in the total either', () => {
    const { expectation, card } = cardFor('WR', [prop('receiving_yards', 48.5), prop('receptions', 4.5), prop('anytime_td', null, null)]);
    expect(expectation.missingMarkets).toEqual(['anytime_td']);
    expect(card.props.some((p) => p.key === 'prop-anytime_td')).toBe(false);
  });

  it('names the usage model for what it is, so it cannot read as the market total being unknown', () => {
    const { card } = cardFor('WR', [prop('receiving_yards', 48.5), prop('receptions', 4.5), prop('anytime_td', null, 0.42)]);
    expect(card.pending).toContain(PENDING_USAGE_MODEL);
    expect(PENDING_USAGE_MODEL).toBe('expected points from usage');
  });
});
