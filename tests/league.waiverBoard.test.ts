/**
 * The waiver view-model: horizons, streaming, and the rule that priority is
 * never a number on its own.
 */

import { describe, expect, it } from 'vitest';
import {
  HORIZON_LABELS,
  STREAM_DEPTH,
  buildWaiverBoard,
  buildWaiverRow,
  classifyHorizon,
  streamingVerdict,
  type WaiverCandidateInput,
} from '../src/core/league/waiverBoard.ts';
import type { FaabEstimate } from '../src/core/league/faab.ts';
import type { CompetitionAssessment } from '../src/core/league/competition.ts';

const COST: FaabEstimate = {
  low: 4,
  high: 7,
  known: true,
  display: '$4–7 expected',
  demand: 0.4,
  drivers: [],
  sample: 20,
  notes: [],
};

const QUIET: CompetitionAssessment = { label: 'Low competition', needyTeams: 0, bidders: [], reasons: [] };

function candidate(over: Partial<WaiverCandidateInput> = {}): WaiverCandidateInput {
  return {
    playerId: 'p1',
    name: 'A Player',
    position: 'RB',
    team: 'BUF',
    thisWeek: { points: 11, display: '11.0 pts', known: true },
    next4: { points: 10, display: '10.0 pts', known: true },
    needFit: 'upgrade',
    gain: 3,
    expectedCost: COST,
    competition: QUIET,
    ...over,
  };
}

describe('multi-week value', () => {
  it('tells a one-week streamer from a multi-week hold', () => {
    const streamer = classifyHorizon({
      needFit: 'fills_hole',
      thisWeek: { points: 9, display: '', known: true },
      next4: { points: null, display: '', known: false },
    });
    const hold = classifyHorizon({
      needFit: 'depth',
      thisWeek: { points: 9, display: '', known: true },
      next4: { points: 9, display: '', known: true },
      roleTrend: 'rising_high',
    });

    expect(streamer).toBe('emergency_streamer');
    expect(hold).toBe('multi_week_hold');
  });

  it('calls a player who starts now and holds up a direct starter', () => {
    expect(
      classifyHorizon({
        needFit: 'fills_hole',
        thisWeek: { points: 12, display: '', known: true },
        next4: { points: 11, display: '', known: true },
      }),
    ).toBe('direct_starter');
  });

  it('is a stash when nothing about him is immediate', () => {
    expect(
      classifyHorizon({
        needFit: 'depth',
        thisWeek: { points: 3, display: '', known: true },
        next4: { points: null, display: '', known: false },
      }),
    ).toBe('stash');
  });
});

describe('temporary injury beneficiary', () => {
  it('outranks "direct starter", because the return date is what prices him', () => {
    const horizon = classifyHorizon({
      needFit: 'fills_hole',
      thisWeek: { points: 12, display: '', known: true },
      next4: { points: 11, display: '', known: true },
      injuryBeneficiary: true,
      starterReturnsInWeeks: 2,
    });
    expect(horizon).toBe('temporary_beneficiary');
    expect(HORIZON_LABELS[horizon]).toContain('shelf life');
  });

  it('discounts him harder when the starter is back next week', () => {
    const soon = buildWaiverRow(candidate({ injuryBeneficiary: true, starterReturnsInWeeks: 1 }));
    const later = buildWaiverRow(candidate({ injuryBeneficiary: true, starterReturnsInWeeks: 5 }));
    expect(soon.priority).toBeLessThan(later.priority);
    expect(soon.priorityParts.find((p) => p.key === 'shelf_life')!.label).toContain('1 week');
  });

  it('is a real job, not a loan, when the absence has no end in sight', () => {
    // A season-ending absence beyond the fantasy horizon: he simply has the job.
    expect(
      classifyHorizon({
        needFit: 'fills_hole',
        thisWeek: { points: 12, display: '', known: true },
        next4: { points: 11, display: '', known: true },
        injuryBeneficiary: true,
        starterReturnsInWeeks: 10,
      }),
    ).toBe('direct_starter');
  });
});

describe('streaming', () => {
  it('says stream it when the position is deep', () => {
    const verdict = streamingVerdict('QB', 16, [15.5, 15.2, 15, 14.8]);
    expect(verdict!.streamable).toBe(true);
    expect(verdict!.comparable).toBeGreaterThanOrEqual(STREAM_DEPTH);
  });

  it('says pay for him when nobody is close', () => {
    const verdict = streamingVerdict('QB', 22, [12, 11, 10]);
    expect(verdict!.streamable).toBe(false);
    expect(verdict!.note).toContain('nobody left on waivers grades close');
  });

  it('is not asked at positions where streaming is not a strategy', () => {
    expect(streamingVerdict('RB', 12, [11.9, 11.8, 11.7, 11.6])).toBeNull();
  });

  it('lowers priority for a streamable position', () => {
    const scarce = buildWaiverRow(candidate({ position: 'QB', replacementPool: [4, 3] }));
    const deep = buildWaiverRow(candidate({ position: 'QB', replacementPool: [10.9, 10.8, 10.7, 10.6] }));
    expect(deep.priority).toBeLessThan(scarce.priority);
    expect(deep.reasons.join(' ')).toContain('stream the position');
  });
});

describe('priority is never magic', () => {
  it('publishes parts that sum to the number', () => {
    const row = buildWaiverRow(candidate({ needFit: 'fills_hole', roleTrend: 'rising_high' }));
    const sum = row.priorityParts.reduce((a, p) => a + p.value, 0);
    expect(row.priority).toBeCloseTo(Math.max(0, Math.min(100, Math.round(sum * 10) / 10)), 5);
    expect(row.priorityParts.length).toBeGreaterThan(2);
  });

  it('keeps every dimension separately readable', () => {
    const row = buildWaiverRow(candidate());
    expect(row.thisWeek.known).toBe(true);
    expect(row.needFitLabel).toBeTruthy();
    expect(row.expectedCost.display).toBe('$4–7 expected');
    expect(row.competition.label).toBe('Low competition');
    expect(row.horizonLabel).toBeTruthy();
  });

  it('does not let a cheap nobody outrank a real starter', () => {
    const nobody = candidate({
      playerId: 'cheap',
      name: 'Cheap Nobody',
      needFit: 'none',
      gain: null,
      thisWeek: { points: 1, display: '1.0 pts', known: true },
      next4: { points: 1, display: '1.0 pts', known: true },
      expectedCost: { ...COST, low: 1, high: 1, display: '$1 expected' },
    });
    const starter = candidate({
      playerId: 'starter',
      name: 'Real Starter',
      needFit: 'fills_hole',
      gain: 6,
      expectedCost: { ...COST, low: 28, high: 34, display: '$28–34 expected' },
    });

    const board = buildWaiverBoard([nobody, starter]);
    expect(board[0]!.playerId).toBe('starter');
  });

  it('is stable between refreshes that changed nothing', () => {
    const inputs = [candidate({ playerId: 'a', name: 'A' }), candidate({ playerId: 'b', name: 'B' })];
    expect(buildWaiverBoard(inputs).map((r) => r.playerId)).toEqual(
      buildWaiverBoard([...inputs].reverse()).map((r) => r.playerId),
    );
  });

  it('reports an unknown four-week outlook as unknown, not as zero', () => {
    const row = buildWaiverRow(candidate({ next4: { points: null, display: 'not published', known: false } }));
    expect(row.next4.known).toBe(false);
    expect(row.priorityParts.find((p) => p.key === 'next4')).toBeUndefined();
  });
});
