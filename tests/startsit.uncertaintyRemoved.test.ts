/**
 * `startsit@6` (15 October 2026): the uncertainty penalty is out of the score,
 * on Alex's decision. It is still computed and its reasons still feed the
 * confidence read; it adds zero points, for players and defences alike.
 */
import { describe, expect, it } from 'vitest';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { LEGACY_RULES, SCORING_RULES } from '../src/core/startsit/scoringRules.ts';
import { STARTSIT_ENGINE_VERSION } from '../src/core/startsit/version.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING } from '../src/core/demo/fixtures/dst.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import { defence } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const NACUA = TEST_PLAYERS.find((p) => p.fullName === 'Puka Nacua')!;

function prop(market: PlayerProp['market'], line: number | null, extra: Partial<PlayerProp> = {}): PlayerProp {
  return {
    playerId: 'x',
    sourcePlayerName: 'x',
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: null,
    ...extra,
  };
}

const full = (books: number) => [
  prop('receiving_yards', 70, { bookCount: books }),
  prop('receptions', 5, { bookCount: books }),
  prop('anytime_td', null, { impliedProbability: 0.3, bookCount: books }),
];

const uncertainty = (e: ReturnType<typeof evaluatePlayer>) => e.components.find((c) => c.key === 'uncertainty')!;

describe('uncertainty is out of the score', () => {
  it('bumps the engine version', () => {
    expect(STARTSIT_ENGINE_VERSION).toBe('startsit@6');
    expect(SCORING_RULES.textOnly).toContain('uncertainty');
  });

  it('charges nothing for a single book, and still says so', () => {
    const one = evaluatePlayer({ player: NACUA, props: full(1), signal: null }, HALF_PPR);
    const many = evaluatePlayer({ player: NACUA, props: full(5), signal: null }, HALF_PPR);
    expect(one.score).toBe(many.score);
    expect(one.confidenceReasons).toContain('single book behind at least one market');
    expect(uncertainty(one)).toMatchObject({ value: 0, textOnly: true });
  });

  it('charges nothing for partial coverage either: the score is the market sum plus the real nudges', () => {
    const partial = evaluatePlayer({ player: NACUA, props: [prop('receiving_yards', 70)], signal: null }, HALF_PPR);
    expect(partial.score).toBe(partial.expectation.points);
    expect(partial.confidenceReasons.join(' ')).toMatch(/partial market coverage/);
  });

  it('is the only thing that moved: the old rules with uncertainty counted still charge it', () => {
    const before = evaluatePlayer({ player: NACUA, props: full(1), signal: null }, HALF_PPR, {
      ...LEGACY_RULES,
      conversion: SCORING_RULES.conversion,
      staleScaling: SCORING_RULES.staleScaling,
      textOnly: SCORING_RULES.textOnly.filter((k) => k !== 'uncertainty'),
    });
    const after = evaluatePlayer({ player: NACUA, props: full(1), signal: null }, HALF_PPR);
    expect(uncertainty(before).value).toBeLessThan(0);
    expect(after.score! - before.score!).toBeCloseTo(-uncertainty(before).value, 2);
  });

  it('charges a defence nothing for a thin or stale line', () => {
    const profile = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);
    const fresh = evaluatePlayer(defence('d', 'Jacksonville', { spread: -7.5, total: 42.5 }), profile);
    const stale = evaluatePlayer({ ...defence('d', 'Jacksonville', { spread: -7.5, total: 42.5 }), propsStale: true }, profile);
    expect(stale.score).toBe(fresh.score);
    expect(uncertainty(stale)).toMatchObject({ value: 0, textOnly: true });
    expect(stale.confidenceReasons.join(' ')).toMatch(/stale/);
  });
});
