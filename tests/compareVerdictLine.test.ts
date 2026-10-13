/**
 * The line under the Compare cards names the base it is talking about (13 October 2026):
 * "the Vegas lines" only when both bases are the full Vegas number, otherwise
 * "the published projection".
 */
import { describe, expect, it } from 'vitest';
import { verdictLine } from '../src/web/components/compareSheet.tsx';
import type { StartSitComparison, StartSitEvaluation } from '../src/web/api.ts';

const player = (playerId: string, name: string, basis: 'market' | 'published', base: number, points: number): StartSitEvaluation =>
  ({
    playerId,
    name,
    position: 'WR',
    team: 'TB',
    expectation: { points: basis === 'market' ? base : 2, contributions: [], missingMarkets: [], coverage: 1, notes: [] },
    components: [{ key: 'vegas', label: 'vegas', display: '', value: basis === 'market' ? base : 2, unknown: false }],
    score: points,
    ruledOut: false,
    decision: { points, basis, base, adjustments: points - base },
  }) as unknown as StartSitEvaluation;

const comparison = (a: StartSitEvaluation, b: StartSitEvaluation): StartSitComparison =>
  ({ evaluations: [a, b], recommendedPlayerId: a.playerId, slot: { comparable: true } }) as unknown as StartSitComparison;

describe('the verdict line', () => {
  it('says Vegas lines when both bases are Vegas', () => {
    expect(verdictLine(comparison(player('a', 'Kenneth Walker', 'market', 15.1, 15.3), player('b', 'Will Shipley', 'market', 9.0, 9.0)))).toBe(
      'Start K. Walker, 6.3 pts ahead, mostly on the Vegas lines.',
    );
  });

  it('says the published projection when both bases are Sleeper weeks', () => {
    expect(verdictLine(comparison(player('a', 'Ladd McConkey', 'published', 10.2, 10.0), player('b', 'Emeka Egbuka', 'published', 9.2, 8.9)))).toBe(
      'Start L. McConkey, 1.1 pts ahead, mostly on the published projection.',
    );
  });

  it('says the published projection when only one base is Vegas', () => {
    expect(verdictLine(comparison(player('a', 'Kenneth Walker', 'market', 15.1, 15.3), player('b', 'Emeka Egbuka', 'published', 9.2, 8.9)))).toMatch(
      /mostly on the published projection\.$/,
    );
  });
});
