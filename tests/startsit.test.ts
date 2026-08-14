import { describe, expect, it } from 'vitest';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { compareStartSit, evaluatePlayer } from '../src/core/startsit/engine.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import { TEST_PLAYERS } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const FULL_PPR = buildScoringProfile({ rec: 1, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);

const NACUA = TEST_PLAYERS.find((p) => p.fullName === 'Puka Nacua')!;
const BIJAN = TEST_PLAYERS.find((p) => p.fullName === 'Bijan Robinson')!;
const LOVE = TEST_PLAYERS.find((p) => p.fullName === 'Jordan Love')!;

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

function signal(net: number, items = 3): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last30 = { ...s.raw };
  return s;
}

describe('buildExpectation', () => {
  it('converts WR markets with league scoring', () => {
    const exp = buildExpectation('WR', [prop('receiving_yards', 70), prop('receptions', 5)], HALF_PPR);
    // 70 * 0.1 + 5 * 0.5 = 9.5
    expect(exp.points).toBeCloseTo(9.5, 2);
  });

  it('reflects the league PPR setting', () => {
    const half = buildExpectation('WR', [prop('receiving_yards', 70), prop('receptions', 5)], HALF_PPR);
    const full = buildExpectation('WR', [prop('receiving_yards', 70), prop('receptions', 5)], FULL_PPR);
    expect(full.points! - half.points!).toBeCloseTo(2.5, 2);
  });

  it('applies the TE premium only to tight ends', () => {
    const teProfile = buildScoringProfile({ rec: 0.5, bonus_rec_te: 0.5, rec_yd: 0.1 }, []);
    const te = buildExpectation('TE', [prop('receptions', 5)], teProfile);
    const wr = buildExpectation('WR', [prop('receptions', 5)], teProfile);
    expect(te.points!).toBeGreaterThan(wr.points!);
  });

  it('converts an anytime TD price into expected points', () => {
    const exp = buildExpectation('WR', [prop('anytime_td', null, { impliedProbability: 0.4 })], HALF_PPR);
    expect(exp.points).toBeCloseTo(2.4, 2); // 0.4 * 6
  });

  it('does not double-count TDs for a QB', () => {
    const exp = buildExpectation(
      'QB',
      [prop('pass_yards', 250), prop('pass_tds', 1.5), prop('anytime_td', null, { impliedProbability: 0.5 })],
      HALF_PPR,
    );
    // 250*0.04 + 1.5*4 = 16; the anytime TD market is intentionally excluded.
    expect(exp.points).toBeCloseTo(16, 2);
  });

  it('reports missing markets instead of imputing them', () => {
    const exp = buildExpectation('WR', [prop('receiving_yards', 70)], HALF_PPR);
    expect(exp.missingMarkets).toContain('receptions');
    expect(exp.missingMarkets).toContain('anytime_td');
    expect(exp.coverage).toBeLessThan(1);
    expect(exp.notes.join(' ')).toContain('missing market');
  });

  it('returns null points when nothing usable is available', () => {
    const exp = buildExpectation('WR', [], HALF_PPR);
    expect(exp.points).toBeNull();
    expect(exp.notes.join(' ')).toContain('no usable Vegas markets');
  });

  it('tracks the thinnest book count behind the expectation', () => {
    const exp = buildExpectation(
      'WR',
      [prop('receiving_yards', 70, { bookCount: 4 }), prop('receptions', 5, { bookCount: 1 })],
      HALF_PPR,
    );
    expect(exp.minBookCount).toBe(1);
  });
});

describe('evaluatePlayer', () => {
  it('keeps the Vegas expectation and the news signal as separate components', () => {
    const evaluation = evaluatePlayer(
      { player: NACUA, props: [prop('receiving_yards', 70), prop('receptions', 5)], signal: signal(4) },
      HALF_PPR,
    );
    const keys = evaluation.components.map((c) => c.key);
    expect(keys).toEqual(['vegas', 'news_recent', 'news_raw', 'status', 'uncertainty', 'role_trend']);
  });

  it('caps the news contribution so it cannot dominate the market', () => {
    const evaluation = evaluatePlayer({ player: NACUA, props: [], signal: signal(50) }, HALF_PPR);
    const news = evaluation.components.find((c) => c.key === 'news_recent')!;
    expect(news.value).toBeLessThanOrEqual(2.1);
  });

  it('applies a heavy penalty to a player ruled out', () => {
    const evaluation = evaluatePlayer(
      { player: NACUA, props: [prop('receiving_yards', 90)], signal: null, injuryStatus: 'Out' },
      HALF_PPR,
    );
    expect(evaluation.score!).toBeLessThan(-50);
  });

  it('drops confidence to low with no Vegas data', () => {
    const evaluation = evaluatePlayer({ player: NACUA, props: [], signal: signal(2) }, HALF_PPR);
    expect(evaluation.confidence).toBe('low');
    expect(evaluation.confidenceReasons).toContain('no Vegas data');
  });

  it('penalises stale prop data and says so', () => {
    const fresh = evaluatePlayer(
      { player: NACUA, props: [prop('receiving_yards', 70), prop('receptions', 5), prop('anytime_td', null, { impliedProbability: 0.3 })], signal: null },
      HALF_PPR,
    );
    const stale = evaluatePlayer(
      {
        player: NACUA,
        props: [prop('receiving_yards', 70), prop('receptions', 5), prop('anytime_td', null, { impliedProbability: 0.3 })],
        signal: null,
        propsStale: true,
      },
      HALF_PPR,
    );
    expect(stale.score!).toBeLessThan(fresh.score!);
    expect(stale.confidenceReasons).toContain('prop data is stale');
  });

  it('returns a null score when there is nothing at all to go on', () => {
    const evaluation = evaluatePlayer({ player: NACUA, props: [], signal: null }, HALF_PPR);
    expect(evaluation.score).toBeNull();
  });
});

describe('compareStartSit', () => {
  const strong = { player: NACUA, props: [prop('receiving_yards', 95), prop('receptions', 7)], signal: null };
  const weak = { player: BIJAN, props: [prop('rush_yards', 40), prop('receiving_yards', 15), prop('receptions', 2)], signal: null };

  it('recommends the higher market expectation', () => {
    const result = compareStartSit([strong, weak], HALF_PPR);
    expect(result.recommendedPlayerId).toBe(NACUA.id);
    expect(result.reasons.join(' ')).toContain('market expectation');
  });

  it('reports the margin between the top two', () => {
    const result = compareStartSit([strong, weak], HALF_PPR);
    expect(result.margin!).toBeGreaterThan(0);
  });

  it('lowers confidence on a close call', () => {
    // 60*0.1 + 4*0.5 = 8.0 vs 55*0.1 + 20*0.1 + 1*0.5 = 8.0, before penalties.
    const a = { player: NACUA, props: [prop('receiving_yards', 60), prop('receptions', 4)], signal: null };
    const b = {
      player: BIJAN,
      props: [prop('rush_yards', 55), prop('receiving_yards', 20), prop('receptions', 1)],
      signal: null,
    };
    const result = compareStartSit([a, b], HALF_PPR);
    expect(result.confidence).not.toBe('high');
    expect(result.reasons.join(' ')).toContain('close call');
  });

  it('warns clearly when a candidate has no Vegas data instead of scoring it zero', () => {
    const result = compareStartSit([strong, { player: LOVE, props: [], signal: signal(3) }], HALF_PPR);
    expect(result.warnings.join(' ')).toContain('no Vegas data');
    expect(result.confidence).not.toBe('high');
    const loveEval = result.evaluations.find((e) => e.playerId === LOVE.id)!;
    expect(loveEval.expectation.points).toBeNull();
  });

  it('withholds a recommendation when nothing is usable', () => {
    const result = compareStartSit(
      [
        { player: NACUA, props: [], signal: null },
        { player: BIJAN, props: [], signal: null },
      ],
      HALF_PPR,
    );
    expect(result.recommendedPlayerId).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.warnings.join(' ')).toContain('recommendation withheld');
  });

  it('flags an injury status on the recommended player', () => {
    const result = compareStartSit([{ ...strong, injuryStatus: 'Questionable' }, weak], HALF_PPR);
    expect(result.warnings.join(' ')).toContain('Questionable');
  });

  it('is deterministic', () => {
    const a = compareStartSit([strong, weak], HALF_PPR);
    const b = compareStartSit([strong, weak], HALF_PPR);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
