/**
 * One week, written out in full.
 *
 * Every other file in this suite tests a property. This one pins an entire
 * plan — the claims, the drops, the order, the relations, the branches — so
 * that a change anywhere in the model has to be looked at rather than merely
 * passed. It is also the fixture the closeout quotes, which means the numbers
 * in the handover and the numbers in CI cannot drift apart.
 *
 * The roster is a settled starting seven with three arguable bench spots. The
 * wire holds a back who walks into the flex, a receiver who is a real upgrade,
 * a streaming tight end, and two fillers.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { HALF_PPR, NOW, SHAPE, roster, targets, wire } from './helpers/waiverPlanner.ts';

describe('a worked week', () => {
  const plan = planWaiverClaims({
    roster: roster(),
    targets: targets(wire(), {
      wireRb: { recommended: 24, doNotExceed: 29, headline: 'Expected $18–24 · Recommended max $24' },
      wireWr: { recommended: 14, doNotExceed: 17, headline: 'Expected $11–15 · Recommended max $14' },
      wireTe: { recommended: 4, doNotExceed: 6, headline: 'Expected $2–5 · Recommended max $4' },
    }),
    shape: SHAPE,
    profile: HALF_PPR,
    budget: { remaining: 60, usesFaab: true },
    now: NOW,
    generatedAt: '2025-10-05T14:00:00.000Z',
  });

  it('produces exactly this plan', () => {
    expect(
      plan.claims.map((c) => ({
        rank: c.rank,
        add: c.addName,
        bid: c.bid,
        drop: c.dropName,
        relation: c.relation,
        netGain: c.netGain,
      })),
    ).toEqual([
      { rank: 1, add: 'Breakout Back', bid: 24, drop: 'Depth Back', relation: 'primary', netGain: 9.21 },
      { rank: 2, add: 'Emerging Receiver', bid: 14, drop: 'Depth Back', relation: 'fallback', netGain: 4.12 },
      { rank: 3, add: 'Emerging Receiver', bid: 14, drop: 'Roster Filler', relation: 'compatible', netGain: 4.02 },
      { rank: 4, add: 'Streaming Tight End', bid: 4, drop: 'Backup Tight End', relation: 'compatible', netGain: 2.45 },
    ]);
  });

  it('spends at most what the wallet holds', () => {
    /* Claims 1, 3 and 4 can all land: $24 + $14 + $4 = $42 of $60. */
    expect(plan.maxSimultaneousSpend).toBe(42);
  });

  it('lays out the branches', () => {
    expect(plan.outcomes.map((o) => ({ adds: o.addedPlayerIds, drops: o.droppedPlayerIds, spend: o.spend, kind: o.kind }))).toEqual([
      {
        adds: ['wireRb', 'wireWr', 'wireTe'],
        drops: ['benchRb', 'benchWr', 'te2'],
        spend: 42,
        kind: 'best',
      },
      { adds: ['wireRb', 'wireWr'], drops: ['benchRb', 'benchWr'], spend: 38, kind: 'partial' },
      { adds: ['wireRb', 'wireTe'], drops: ['benchRb', 'te2'], spend: 28, kind: 'partial' },
      { adds: ['wireRb'], drops: ['benchRb'], spend: 24, kind: 'partial' },
      { adds: ['wireWr', 'wireTe'], drops: ['benchRb', 'te2'], spend: 18, kind: 'partial' },
      { adds: [], drops: [], spend: 0, kind: 'none' },
    ]);
  });

  it('protects the whole starting lineup', () => {
    expect(plan.protectedPlayers.map((p) => `${p.name} (${p.reason})`)).toEqual([
      'Alpha Receiver (in_lineup)',
      'Anchor Quarterback (in_lineup)',
      'Feature Back (in_lineup)',
      'Flex Back (in_lineup)',
      'Second Back (in_lineup)',
      'Second Receiver (in_lineup)',
      'Starting Tight End (in_lineup)',
    ]);
  });

  it('shows the runner-up drops for the claim it recommends', () => {
    const forTheBack = plan.dropRanking.find((r) => r.addPlayerId === 'wireRb');
    expect(forTheBack?.drops.filter((d) => d.protection == null).map((d) => `${d.name} ${d.cost}`)).toEqual([
      'Depth Back 0',
      'Roster Filler 1.5',
      'Backup Tight End 1.5',
      'Flex Back 1.93',
    ]);
  });

  it('does the work it says it does', () => {
    expect(plan.search).toEqual({ targetsConsidered: 5, pairsEvaluated: 24, lineupsEvaluated: 89 });
    expect(plan.dropAdvice).toBe('available');
    expect(plan.generatedAt).toBe('2025-10-05T14:00:00.000Z');
  });
});
