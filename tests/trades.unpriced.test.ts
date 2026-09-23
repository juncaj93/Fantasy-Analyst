/**
 * A player with no market price is absent from trade valuation, not cheap.
 *
 * Measured on production on 23 September 2026: 86 of the league's 162 rostered
 * skill players had no market expectation, and the trade engine was valuing
 * them on the news and usage nudges alone — Ashton Jeanty at 3.75 and Jaxon
 * Smith-Njigba at 5.30 against a priced Bijan Robinson at 19.05. A star with no
 * line read as a bench piece, and "Bijan for Jeanty" was rejected as 80% apart
 * when one side of that gap was noise.
 *
 * The rule these tests pin is the one `core/startsit/projection.ts` already
 * keeps for the word "projected": no market, no number. An unpriced player is
 * never valued, never packaged, never a need or a surplus — and the board says
 * who was left out and why, rather than letting them vanish.
 */

import { describe, expect, it } from 'vitest';
import { candidate, signalWithNet } from './helpers/startsit.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildRosterViews, isPriced, medianByRank, needFor, type RosterView } from '../src/core/trades/rosterUtility.ts';
import { UNPRICED_SHARE_LIMIT, findBilateralTrades, pricingCoverage, unpricedLine } from '../src/core/trades/bilateral.ts';
import { buildLadder, unpricedSentence } from '../src/core/trades/ladder.ts';
import { buildLadderFor } from '../src/core/trades/ladderInputs.ts';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import type { ArbitrageRead } from '../src/core/trades/arbitrage.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'];
const profile = buildScoringProfile({}, POSITIONS);
const shape = buildRosterShape(POSITIONS);

/** `points: null` is a player no book has priced, carrying real news anyway. */
type Spec = [id: string, position: string, points: number | null, status?: string];

function inputFor([id, position, points, status]: Spec): StartSitInput {
  return candidate(id, id.toUpperCase(), position, points, {
    // Unpriced players get a strong news tally, so their nudge-only score is
    // real, positive and non-trivial — the state that was being ranked.
    ...(points == null ? { signal: signalWithNet(6, 6) } : {}),
    ...(status ? { status } : {}),
  });
}

function leagueOf(rosters: Record<string, Spec[]>) {
  const pool = new Map<string, StartSitInput>();
  for (const specs of Object.values(rosters)) for (const spec of specs) pool.set(spec[0], inputFor(spec));
  const views = buildRosterViews({
    rosters: Object.entries(rosters).map(([key, specs]) => ({ key, playerIds: specs.map((s) => s[0]) })),
    pool,
    shape,
    profile,
  });
  return { views, pool };
}

function partnerOf(views: Map<string, RosterView>, key: string) {
  return {
    view: views.get(key)!,
    partner: { key, rosterId: Number(key), displayName: `Manager ${key}`, userId: `u${key}` },
    fit: { tendencies: null, seasonsObserved: 0, historyComplete: false },
  };
}

function run(rosters: Record<string, Spec[]>, arbitrage?: Map<string, ArbitrageRead>) {
  const { views } = leagueOf(rosters);
  return findBilateralTrades({
    me: views.get('1')!,
    partners: Object.keys(rosters)
      .filter((k) => k !== '1')
      .map((k) => partnerOf(views, k)),
    ...(arbitrage ? { arbitrage } : {}),
  });
}

/** Every player id that appears anywhere in a surfaced or rejected package. */
function packaged(report: ReturnType<typeof run>): Set<string> {
  const ids = new Set<string>();
  for (const offer of report.offers) for (const p of [...offer.give, ...offer.get]) ids.add(p.playerId);
  for (const r of report.rejections) for (const id of [...r.give, ...r.get]) ids.add(id);
  return ids;
}

/**
 * A roster with a hole at RB, playing one holding a priced RB who fills it and
 * an unpriced "star" who has only news behind him.
 */
const LEAGUE: Record<string, Spec[]> = {
  '1': [
    ['qb1', 'QB', 20],
    ['rb1', 'RB', 15],
    ['rb2', 'RB', 4],
    ['wr1', 'WR', 13],
    ['wr2', 'WR', 12],
    ['wr3', 'WR', 11],
    ['wr4', 'WR', 10],
    ['te1', 'TE', 9],
  ],
  '2': [
    ['qb2', 'QB', 20],
    ['rb3', 'RB', 14],
    ['rb4', 'RB', 12],
    ['star', 'RB', null],
    ['wr5', 'WR', 8],
    ['wr6', 'WR', 7],
    ['te2', 'TE', 6],
  ],
};

describe('what "priced" means', () => {
  it('is a market expectation, and a news-only score does not count', () => {
    const priced = evaluatePlayer(inputFor(['a', 'WR', 12]), profile);
    const unpriced = evaluatePlayer(inputFor(['b', 'WR', null]), profile);

    expect(isPriced(priced)).toBe(true);
    // The precondition that makes this a real test: the engine *did* score him,
    // and it is the nudges alone that the trade engine used to read.
    expect(unpriced.score).not.toBeNull();
    expect(unpriced.score!).toBeGreaterThan(0);
    expect(isPriced(unpriced)).toBe(false);
  });
});

describe('an unpriced player in the roster model', () => {
  it('has no value, is reported as unpriced, and is not called unscored', () => {
    const { views } = leagueOf(LEAGUE);
    const them = views.get('2')!;

    expect(them.valueOf.has('star')).toBe(false);
    expect(them.unpriced.has('star')).toBe(true);
    expect(them.unscored.has('star')).toBe(false);
    // Every priced player is still valued exactly as before.
    expect(them.valueOf.has('rb3')).toBe(true);
  });

  it('fills a slot as a body, but is neither a shortfall nor a surplus', () => {
    // Two priced RBs and two unpriced ones in a league needing 2.5 RBs.
    const need = needFor({ position: 'RB', values: [14], unpriced: 2, slots: 2.5, benchmark: [14, 12, 6] });

    expect(need.startable).toBe(3);
    // Ranks two and three are held by players nobody has priced: unknown, not
    // zero, so they cannot manufacture a hole the search would go shopping for.
    expect(need.shortfall).toBe(0);
    expect(need.level).not.toBe('hole');
    // …and "we have depth, probably" is not a reason to trade anyone away.
    expect(need.surplus).toBe(0);
  });

  it('still reports a real hole among the ranks that are priced', () => {
    const need = needFor({ position: 'RB', values: [14, 4], unpriced: 1, slots: 2.5, benchmark: [14, 12, 6] });
    expect(need.shortfall).toBe(8);
    expect(need.level).toBe('hole');
  });

  it('is skipped by the league benchmark rather than counted as a zero', () => {
    // Three rosters; the third's RB2 is unpriced. A zero there would pull the
    // median RB2 down to 8; skipping it leaves the two measured values.
    expect(medianByRank([[14, 12], [13, 8], [15, null]])).toEqual([14, 10]);
    // An absent rank is still a zero, which is the existing scarcity rule.
    expect(medianByRank([[10, 8, 6], [10], [10]])).toEqual([10, 0, 0]);
  });
});

describe('the bilateral search', () => {
  it('never puts an unpriced player in a package, on either side', () => {
    const mineUnpriced: Record<string, Spec[]> = {
      ...LEAGUE,
      '1': [...LEAGUE['1']!, ['mystery', 'WR', null]],
    };
    const report = run(mineUnpriced);
    const ids = packaged(report);

    expect(ids.has('star')).toBe(false);
    expect(ids.has('mystery')).toBe(false);
  });

  it('says who it left out of each partner, by name', () => {
    const report = run(LEAGUE);
    const left = report.rejections.find((r) => r.reason === 'unpriced_players' && r.partnerKey === '2');

    expect(left).toBeDefined();
    expect(left!.detail).toMatch(/no market price this week/);
    expect(left!.detail).toContain('STAR');
  });

  it('still finds the priced deal that exists', () => {
    // The fix narrows what is valued; it must not blank a board that has a
    // genuine, fully priced trade on it.
    const report = run(LEAGUE);
    expect(report.offers.length).toBeGreaterThan(0);
    expect(report.offers.every((o) => [...o.give, ...o.get].every((p) => p.playerId !== 'star'))).toBe(true);
  });

  it('counts coverage over tradeable, playing players only', () => {
    const withExtras: Record<string, Spec[]> = {
      ...LEAGUE,
      '2': [...LEAGUE['2']!, ['hurt', 'WR', null, 'IR']],
    };
    const { views } = leagueOf(withExtras);
    const coverage = pricingCoverage(views.get('1')!, [views.get('2')!]);

    // `hurt` has no line because he is not playing: a fact about him, not a gap.
    expect(coverage.unpriced).toBe(1);
    expect(coverage.mineUnpriced).toEqual([]);
    expect(coverage.priced).toBe(14);
  });

  it('says "not enough priced players" rather than "nothing helps", when too much is missing', () => {
    // Most of the partner's roster unpriced, and nothing priced worth trading for.
    const thin: Record<string, Spec[]> = {
      '1': LEAGUE['1']!,
      '2': [
        ['qb2', 'QB', 20],
        ['u1', 'RB', null],
        ['u2', 'RB', null],
        ['u3', 'WR', null],
        ['u4', 'WR', null],
        ['u5', 'WR', null],
        ['u6', 'TE', null],
      ],
    };
    const report = run(thin);

    expect(report.offers).toHaveLength(0);
    expect(report.pricing.tooThin).toBe(true);
    expect(report.pricing.unpriced / (report.pricing.priced + report.pricing.unpriced)).toBeGreaterThanOrEqual(
      UNPRICED_SHARE_LIMIT,
    );
    expect(report.notes[0]).toBe(
      'Not enough priced players to evaluate trades yet: 6 of 15 rostered players have no market price this week. ' +
        'Trade ideas fill in as the books post lines.',
    );
  });

  it('keeps the ordinary empty-board sentence when coverage is fine', () => {
    const settled: Record<string, Spec[]> = {
      '1': LEAGUE['1']!,
      '2': [
        ['qb2', 'QB', 20],
        ['rb3', 'RB', 3],
        ['rb4', 'RB', 2],
        ['wr5', 'WR', 5],
        ['wr6', 'WR', 4],
        ['te2', 'TE', 3],
      ],
    };
    const report = run(settled);
    expect(report.offers).toHaveLength(0);
    expect(report.pricing.tooThin).toBe(false);
    expect(report.notes[0]).not.toMatch(/priced/);
  });
});

describe('buy-low and sell-high after the change', () => {
  const read = (playerId: string, kind: ArbitrageRead['kind']): ArbitrageRead => ({
    playerId,
    kind,
    strength: 0.8,
    residualPerGame: kind === 'buy_low' ? -4 : 4,
    expectedPerGame: 12,
    observedPerGame: kind === 'buy_low' ? 8 : 16,
    games: 5,
    tdDependency: {
      profile: 'insufficient_data',
      share: null,
      touchdowns: 0,
      scoringGames: 0,
      games: 5,
      points: 0,
      display: '',
      driver: null,
    },
    tallyFactor: 1,
    headline: `${playerId} headline`,
    reasons: ['because'],
  });

  /** `arbitrageGate.test.ts`'s settled league: no upgrade clears a point. */
  const settled = (target: Spec): Record<string, Spec[]> => ({
    '1': [
      ['qb1', 'QB', 20],
      ['rb1', 'RB', 15],
      ['rb2', 'RB', 13],
      ['rbs', 'RB', 10],
      ['wr1', 'WR', 13],
      ['wr2', 'WR', 12],
      ['te1', 'TE', 9],
      ['flex1', 'WR', 11],
    ],
    '2': [
      ['qb2', 'QB', 20],
      ['rb3', 'RB', 8],
      ['rb4', 'RB', 7],
      target,
      ['wr4', 'WR', 12],
      ['wr5', 'WR', 11],
      ['te2', 'TE', 9],
    ],
  });

  it('still surfaces a buy-low on a priced player', () => {
    const report = run(settled(['wr3', 'WR', 10]), new Map([['wr3', read('wr3', 'buy_low')]]));
    const buy = report.offers.find((o) => o.get.some((p) => p.playerId === 'wr3'));

    expect(buy).toBeDefined();
    expect(buy!.category).toBe('buy_low');
  });

  it('does not price a buy-low on a player with no market this week', () => {
    // The read is about the season; the price is about this week, and there is
    // not one. He comes back the moment a book posts his line.
    const report = run(settled(['wr3', 'WR', null]), new Map([['wr3', read('wr3', 'buy_low')]]));

    expect(packaged(report).has('wr3')).toBe(false);
    expect(report.rejections.some((r) => r.reason === 'unpriced_players' && r.detail.includes('WR3'))).toBe(true);
  });
});

describe('the ladder for one named player', () => {
  const mine = LEAGUE['1']!.map(inputFor);

  it('refuses to price a target with no market, and says so', () => {
    const theirs = LEAGUE['2']!.map(inputFor);
    const built = buildLadderFor({ targetId: 'star', mineInputs: mine, theirsInputs: theirs, shape, profile })!;

    expect(built.target.value).toBeNull();
    expect(built.consolidation).toBeNull();

    const ladder = buildLadder(built.inputs);
    expect(ladder.blocked).toBe(
      'Not enough priced players to evaluate this trade: STAR has no market price this week. ' +
        'Check back once the books post lines.',
    );
    expect(ladder.rungs).toEqual([]);
  });

  it('builds a priced target exactly as before', () => {
    const theirs = LEAGUE['2']!.map(inputFor);
    const built = buildLadderFor({ targetId: 'rb3', mineInputs: mine, theirsInputs: theirs, shape, profile })!;

    expect(built.target.value).not.toBeNull();
    expect(built.inputs.unpriced).toBeUndefined();
    // Whatever the ordinary ladder rules decide about him, pricing is not it.
    expect(buildLadder(built.inputs).blocked ?? '').not.toMatch(/priced/);
  });

  it('never offers an unpriced player or a defence in the placeholder package', () => {
    const withExtras = [...mine, inputFor(['mystery', 'WR', null])];
    const theirs = LEAGUE['2']!.map(inputFor);
    const built = buildLadderFor({ targetId: 'rb3', mineInputs: withExtras, theirsInputs: theirs, shape, profile })!;

    expect(built.inputs.offering.playerIds).not.toContain('mystery');
  });

  it('names every unpriced player in one sentence', () => {
    expect(unpricedSentence(['A', 'B', 'C'])).toBe(
      'Not enough priced players to evaluate this trade: A, B and C have no market price this week. ' +
        'Check back once the books post lines.',
    );
  });
});

describe('the sentence the Trades screen prints', () => {
  it('names the reader’s own left-out players, capped at four', () => {
    expect(unpricedLine({ priced: 66, unpriced: 70, mineUnpriced: ['A', 'B', 'C', 'D', 'E', 'F'], tooThin: true })).toBe(
      '70 of 136 rostered players have no market price this week and are left out of trade ideas until the ' +
        'books post lines. Yours: A, B, C, D and 2 more.',
    );
    expect(unpricedLine({ priced: 10, unpriced: 0, mineUnpriced: [], tooThin: false })).toBeNull();
  });

  it('is left off an empty board whose note already says the same thing', () => {
    const report = run({
      '1': LEAGUE['1']!,
      '2': [['qb2', 'QB', 20], ['u1', 'RB', null], ['u2', 'RB', null], ['u3', 'WR', null], ['u4', 'WR', null]],
    });
    expect(report.offers).toHaveLength(0);
    expect(report.pricing.tooThin).toBe(true);
    expect(report.pricing.line).toBeNull();
  });

  it('is printed beside offers when some players were left out', () => {
    const report = run(LEAGUE);
    expect(report.offers.length).toBeGreaterThan(0);
    expect(report.pricing.line).toMatch(/^1 of \d+ rostered players has no market price this week and is left out/);
  });
});

describe('a lineup change that moves an unpriced player', () => {
  /*
   * My second running back has no line, only news. Any running back I acquire
   * benches him, and the optimiser would price that as "12 points in, his
   * news-only score out" — a gain measured against noise.
   */
  const GHOST: Record<string, Spec[]> = {
    '1': [
      ['qb1', 'QB', 20],
      ['rb1', 'RB', 15],
      ['ghost', 'RB', null],
      ['wr1', 'WR', 13],
      ['wr2', 'WR', 12],
      ['wr3', 'WR', 11],
      ['wr4', 'WR', 10],
      ['te1', 'TE', 9],
    ],
    '2': [
      ['qb2', 'QB', 20],
      ['rb3', 'RB', 14],
      ['rb4', 'RB', 12],
      ['rb5', 'RB', 11],
      ['wr5', 'WR', 6],
      ['te2', 'TE', 6],
    ],
  };

  it('is refused and named, rather than scored', () => {
    const report = run(GHOST);
    const refused = report.rejections.filter((r) => r.reason === 'unpriced_lineup');

    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]!.detail).toBe(
      'not enough priced players to evaluate this trade: it would move GHOST in or out of your lineup, with no market price this week',
    );
    // Nothing surfaced rests on a delta that benched him.
    expect(report.offers.every((o) => !o.user.displaced.includes('ghost'))).toBe(true);
  });

  it('blocks the ladder for the same move, with his name in the sentence', () => {
    const built = buildLadderFor({
      targetId: 'rb4',
      mineInputs: GHOST['1']!.map(inputFor),
      theirsInputs: GHOST['2']!.map(inputFor),
      shape,
      profile,
    })!;

    expect(built.target.value).not.toBeNull();
    expect(built.inputs.unpriced).toEqual(['GHOST']);
    expect(buildLadder(built.inputs).blocked).toBe(
      'Not enough priced players to evaluate this trade: GHOST has no market price this week. Check back once the books post lines.',
    );
  });

  it('is exposed on the delta for the roster it happens to', () => {
    const { views } = leagueOf(GHOST);
    const delta = views.get('1')!.delta(['wr4'], ['rb4']);
    expect(delta.unpricedMoved).toEqual(['ghost']);
    // A swap that leaves him where he was does not trip it.
    expect(views.get('1')!.delta(['wr4'], ['wr5']).unpricedMoved).toEqual([]);
  });
});
