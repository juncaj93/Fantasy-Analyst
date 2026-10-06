/**
 * A suggestion and the Compare sheet it opens must give the same answer.
 *
 * Reported 30 September 2026 and measured on production the same night
 * (`scripts/probe-banner-vs-compare.mjs`):
 *
 *     Team card      Start RJ Harvey over Mark Andrews · +2.31 · FLEX
 *     Compare sheet  Recommended: start Mark Andrews · 3.9 against −1.6
 *
 *     Harvey   score −1.58  one line of four priced (0.46)   published 9.53
 *     Andrews  score  3.86  three lines of four (5.00)       published 7.22
 *
 * The card ranked on the published figures bare, the sheet on `score`, whose
 * gap was almost all market coverage. Both now read `decisionPoints`. These
 * rebuild that board through the real engine and hold the two to one answer.
 */

import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { compareStartSit, type StartSitInput } from '../src/core/startsit/engine.ts';
import { decisionPoints } from '../src/core/startsit/decisionPoints.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'BN', 'BN', 'BN']);
const NOW = '2026-09-30T12:00:00Z';

function board(): StartSitInput[] {
  return [
    pricedCandidate('burrow', 'Joe Burrow', 'QB', 20.45, { now: NOW }),
    pricedCandidate('bijan', 'Bijan Robinson', 'RB', 19.6, { now: NOW }),
    pricedCandidate('walker', 'Kenneth Walker', 'RB', 16.8, { now: NOW }),
    pricedCandidate('stevenson', 'Rhamondre Stevenson', 'RB', 10.5, { now: NOW }),
    pricedCandidate('wilson', 'Garrett Wilson', 'WR', 13.4, { now: NOW }),
    pricedCandidate('egbuka', 'Emeka Egbuka', 'WR', 7.3, { now: NOW }),
    pricedCandidate('mcconkey', 'Ladd McConkey', 'WR', 7.85, { now: NOW }),
    pricedCandidate('laporta', 'Sam LaPorta', 'TE', 7.46, { now: NOW }),
    /* Partial markets, both questionable, as production had them. */
    candidate('andrews', 'Mark Andrews', 'TE', 5.0, { now: NOW, status: 'Questionable' }),
    candidate('harvey', 'RJ Harvey', 'RB', 0.46, { now: NOW, status: 'Questionable', signal: signalWithNet(1) }),
  ];
}

const PUBLISHED = new Map([
  ['andrews', 7.22],
  ['harvey', 9.53],
]);
const STARTING = ['burrow', 'bijan', 'walker', 'wilson', 'egbuka', 'mcconkey', 'laporta', 'andrews', 'stevenson'];

function lineup() {
  return recommendLineup(board(), SHAPE, HALF_PPR, { currentStarterIds: STARTING, published: PUBLISHED, now: NOW });
}

function compare(ids: string[], published: ReadonlyMap<string, number> | null = PUBLISHED) {
  const inputs = board().filter((i) => ids.includes(i.player.id));
  return compareStartSit(inputs, HALF_PPR, { ...(published ? { published } : {}) });
}

describe('the Andrews and Harvey board', () => {
  it('reproduces the contradiction when the sheet ranks without the published week', () => {
    /* The old sheet: `score` alone, where Andrews' three posted lines win. */
    expect(compare(['andrews', 'harvey'], null).recommendedPlayerId).toBe('andrews');
  });

  it('suggests one change, and the sheet opened on it agrees', () => {
    const result = lineup();
    const swap = result.swaps.find((s) => s.outPlayerId === 'andrews');
    expect(swap?.inPlayerId).toBe('harvey');

    const sheet = compare(['andrews', 'harvey']);
    expect(sheet.recommendedPlayerId).toBe('harvey');
    expect(sheet.margin).toBeCloseTo(swap!.gain, 2);
  });

  it('builds both numbers from the published week plus the same adjustments', () => {
    const sheet = compare(['andrews', 'harvey']);
    const harvey = sheet.evaluations.find((e) => e.playerId === 'harvey')!;
    expect(harvey.decision?.basis).toBe('published');
    expect(harvey.decision?.base).toBe(9.53);
    /* The questionable charge is in there, not only a tag beside it. */
    const status = harvey.components.find((c) => c.key === 'status')!;
    expect(status.value).toBeLessThan(0);
    expect(harvey.decision!.points).toBeLessThan(9.53);
  });
});

describe('every suggestion, against the sheet it opens', () => {
  it('never contradicts the comparison of its own two players', () => {
    const result = lineup();
    expect(result.swaps.length).toBeGreaterThan(0);
    for (const swap of result.swaps) {
      const sheet = compare([swap.inPlayerId, swap.outPlayerId]);
      expect(sheet.recommendedPlayerId).toBe(swap.inPlayerId);
      expect(sheet.margin).toBeCloseTo(swap.gain, 2);
    }
  });

  it('prints the gain the evaluations carry', () => {
    const result = lineup();
    const everyone = [...result.starters, ...result.bench];
    for (const swap of result.swaps) {
      const inE = everyone.find((e) => e.playerId === swap.inPlayerId)!;
      const outE = everyone.find((e) => e.playerId === swap.outPlayerId)!;
      expect(swap.gain).toBeCloseTo(inE.decision!.points - outE.decision!.points, 2);
    }
  });
});

describe('decisionPoints', () => {
  const evaluation = (over: Partial<Parameters<typeof decisionPoints>[0]>) => ({
    playerId: 'p',
    score: 4,
    expectation: { points: 5, missingMarkets: ['receptions'] },
    components: [
      { key: 'vegas', value: 5, unknown: false },
      { key: 'uncertainty', value: -0.4, unknown: false },
      { key: 'status', value: -1.5, unknown: false },
      { key: 'usage_level', value: 0.9, unknown: false },
    ],
    ...over,
  });

  it('is the score on a complete market', () => {
    const d = decisionPoints(evaluation({ expectation: { points: 5, missingMarkets: [] } }), PUBLISHED);
    expect(d).toMatchObject({ basis: 'market', points: 4 });
  });

  it('is the published week plus the player adjustments on a partial one', () => {
    const d = decisionPoints(evaluation({}), new Map([['p', 8]]));
    /*
     * 8 − 1.5 + 0.24: the market's partial sum and its coverage charge are left
     * out, and the 0.9 of opportunity is held to 3% of the 8-point week.
     */
    expect(d).toMatchObject({ basis: 'published', base: 8, points: 6.74 });
  });

  it('keeps the partial score when nobody published him', () => {
    expect(decisionPoints(evaluation({}), new Map())).toMatchObject({ basis: 'partial', points: 4 });
  });

  it('says unpriced when there is no market and no figure', () => {
    expect(decisionPoints(evaluation({ expectation: { points: null } }))?.basis).toBe('unpriced');
  });

  it('leaves the roster-only charge out unless asked', () => {
    const risky = evaluation({
      score: 3,
      expectation: { points: 5, missingMarkets: [] },
      components: [
        { key: 'vegas', value: 5, unknown: false },
        { key: 'replacement_risk', value: -1, unknown: false },
        { key: 'status', value: -1, unknown: false },
      ],
    });
    expect(decisionPoints(risky)?.points).toBe(4);
    expect(decisionPoints(risky, undefined, { rosterRisk: true })?.points).toBe(3);
  });
});
