/**
 * Plan A, Plan B, Plan C — and the difference between the last two.
 *
 * The test that carries this file is the one where a bench player who covers
 * the hole at ten in the morning is locked by four in the afternoon. If Plan B
 * and Plan C ever come out the same in that fixture, the module has stopped
 * modelling the only thing it was written for.
 */

import { describe, expect, it } from 'vitest';
import { contingencyPlans, replacementTree, CONTINGENCY } from '../src/core/startsit/contingency.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { NO_INJURY_INFORMATION } from '../src/core/injury/model.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { RosterShape } from '../src/core/sleeper/scoring.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

const SHAPE: RosterShape = {
  starters: { WR: 2 },
  flex: [],
  benchSlots: 4,
  irSlots: 0,
  totalStarters: 2,
  superflex: false,
};

const NOW = '2025-10-05T14:00:00Z';
const EARLY_KICKOFF = '2025-10-05T17:00:00Z';
const LATE_KICKOFF = '2025-10-05T20:25:00Z';

function questionable(input: StartSitInput): StartSitInput {
  return {
    ...input,
    injury: {
      ...NO_INJURY_INFORMATION,
      designation: 'questionable',
      designationSource: 'sleeper',
      practice: { trend: 'stable_limited', days: [], latest: 'limited', label: 'limited all week' },
      freshness: 'fresh',
      confidence: 'high',
    },
  };
}

/** A roster where the only cover for a late starter plays early. */
function roster(): StartSitInput[] {
  return [
    questionable({ ...candidate('late', 'Late Starter', 'WR', 14, { kickoff: LATE_KICKOFF }) }),
    candidate('other', 'Other Starter', 'WR', 12, { kickoff: LATE_KICKOFF }),
    candidate('early-bench', 'Early Bench', 'WR', 10, { kickoff: EARLY_KICKOFF }),
    candidate('late-bench', 'Late Bench', 'WR', 4, { kickoff: LATE_KICKOFF }),
  ];
}

describe('the three plans', () => {
  it('covers an early announcement with the best bench player', () => {
    const tree = replacementTree('late', { roster: roster(), shape: SHAPE, profile: HALF_PPR, now: NOW })!;
    const early = tree.plans.find((p) => p.key === 'inactive_early')!;
    expect(early.replacementName).toBe('Early Bench');
    expect(early.feasible).toBe(true);
  });

  it('cannot use that player once his game has started', () => {
    const tree = replacementTree('late', { roster: roster(), shape: SHAPE, profile: HALF_PPR, now: NOW })!;
    const early = tree.plans.find((p) => p.key === 'inactive_early')!;
    const late = tree.plans.find((p) => p.key === 'inactive_late')!;
    expect(late.replacementName).toBe('Late Bench');
    expect(late.loss!).toBeGreaterThan(early.loss!);
  });

  it('reports Plan A as the lineup it actually recommends', () => {
    const tree = replacementTree('late', { roster: roster(), shape: SHAPE, profile: HALF_PPR, now: NOW })!;
    const planA = tree.plans.find((p) => p.key === 'active')!;
    expect(planA.loss).toBe(0);
    expect(planA.replacementName).toBe('Late Starter');
  });

  it('says a slot would sit empty rather than pretending it is covered', () => {
    const thin = [
      questionable(candidate('late', 'Late Starter', 'WR', 14, { kickoff: LATE_KICKOFF })),
      candidate('other', 'Other Starter', 'WR', 12, { kickoff: LATE_KICKOFF }),
    ];
    const tree = replacementTree('late', { roster: thin, shape: SHAPE, profile: HALF_PPR, now: NOW })!;
    const late = tree.plans.find((p) => p.key === 'inactive_late')!;
    expect(late.feasible).toBe(false);
    expect(late.detail).toMatch(/sits empty/);
  });

  it('does not blame an injury for a hole that was there all week', () => {
    // One receiver for two WR slots: Plan A is already a slot short, and that
    // is not something losing him on Sunday morning did.
    const short = [questionable(candidate('late', 'Late Starter', 'WR', 14, { kickoff: LATE_KICKOFF }))];
    const tree = replacementTree('late', { roster: short, shape: SHAPE, profile: HALF_PPR, now: NOW })!;
    const late = tree.plans.find((p) => p.key === 'inactive_late')!;
    // Losing him empties a slot Plan A had filled, so this is still infeasible —
    // but only for the slot he was actually in.
    expect(late.feasible).toBe(false);
    expect(late.detail.match(/WR/g) ?? []).toHaveLength(1);
  });

  it('folds the late plan into the early one when kickoff is unknown, and says so', () => {
    const noKickoff = [
      questionable(candidate('late', 'Late Starter', 'WR', 14)),
      candidate('other', 'Other Starter', 'WR', 12),
      candidate('early-bench', 'Early Bench', 'WR', 10),
    ];
    const tree = replacementTree('late', { roster: noKickoff, shape: SHAPE, profile: HALF_PPR, now: NOW })!;
    const early = tree.plans.find((p) => p.key === 'inactive_early')!;
    const late = tree.plans.find((p) => p.key === 'inactive_late')!;
    expect(late.points).toBe(early.points);
    expect(late.detail).toMatch(/Kickoff time unknown/);
    expect(tree.notes.join(' ')).toMatch(/kickoff time/);
  });
});

describe('staying quiet', () => {
  it('builds nothing for a healthy lineup with a deep bench', () => {
    const healthy = [
      candidate('a', 'A Starter', 'WR', 14, { kickoff: LATE_KICKOFF }),
      candidate('b', 'B Starter', 'WR', 13, { kickoff: LATE_KICKOFF }),
      candidate('c', 'C Bench', 'WR', 12.5, { kickoff: LATE_KICKOFF }),
      candidate('d', 'D Bench', 'WR', 12.2, { kickoff: LATE_KICKOFF }),
    ];
    expect(contingencyPlans({ roster: healthy, shape: SHAPE, profile: HALF_PPR, now: NOW })).toEqual([]);
  });

  it('surfaces the questionable starter, and puts the biggest exposure first', () => {
    const trees = contingencyPlans({ roster: roster(), shape: SHAPE, profile: HALF_PPR, now: NOW });
    expect(trees.map((t) => t.playerId)).toContain('late');
    expect(trees[0]!.playerId).toBe('late');
    expect(trees[0]!.reason).toMatch(/uestionable|limited|risk|cover/i);
  });

  it('says nothing about a player whose game has already started', () => {
    const kickedOff = roster().map((r) =>
      r.player.id === 'late' ? { ...r, now: '2025-10-05T21:00:00Z' } : { ...r, now: '2025-10-05T21:00:00Z' },
    );
    const tree = replacementTree('late', {
      roster: kickedOff,
      shape: SHAPE,
      profile: HALF_PPR,
      now: '2025-10-05T21:00:00Z',
    });
    expect(tree).toBeNull();
  });
});

describe('waiver pivot', () => {
  it('is offered only when it beats the bench by a real margin, and is labelled', () => {
    const pivot = candidate('fa', 'Free Agent', 'WR', 11, { kickoff: LATE_KICKOFF });
    const tree = replacementTree('late', {
      roster: roster(),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      waiverCandidates: [pivot],
    })!;
    expect(tree.waiverPivot!.playerId).toBe('fa');
    expect(tree.waiverPivot!.gain).toBeGreaterThanOrEqual(CONTINGENCY.waiverPivotGain);
    expect(tree.waiverPivot!.detail).toMatch(/waiver pivot, not a lineup move/);
  });

  it('is not offered when the bench already covers it', () => {
    const marginal = candidate('fa', 'Free Agent', 'WR', 4.2, { kickoff: LATE_KICKOFF });
    const tree = replacementTree('late', {
      roster: roster(),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      waiverCandidates: [marginal],
    })!;
    expect(tree.waiverPivot).toBeNull();
  });

  it('never lets a waiver player into a plan', () => {
    const pivot = candidate('fa', 'Free Agent', 'WR', 11, { kickoff: LATE_KICKOFF });
    const tree = replacementTree('late', {
      roster: roster(),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      waiverCandidates: [pivot],
    })!;
    expect(tree.plans.every((p) => p.replacementId !== 'fa')).toBe(true);
  });
});
