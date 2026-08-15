/**
 * Whether he plays, and what happens if he does not.
 *
 * Two modules, one decision. `availabilityConfidence` turns a designation and a
 * practice week into a state; `assessReplacement` asks what that state costs
 * given the bench and the kickoff times. Neither invents a probability, and
 * neither is allowed to charge for the designation twice — the points for
 * "Questionable" are already in the availability penalty, and everything here
 * is about the *structure* around it.
 */

import { describe, expect, it } from 'vitest';
import { availabilityConfidence } from '../src/core/startsit/availabilityConfidence.ts';
import { assessReplacement, REPLACEMENT } from '../src/core/startsit/replacement.ts';
import { resolveInjury, type PracticeStatus } from '../src/core/injury/model.ts';

const NOW = new Date('2026-09-13T15:00:00Z');
const FRESH = '2026-09-12T18:00:00Z';
const OLD = '2026-09-05T18:00:00Z';

function state(designation: string, practice: PracticeStatus[] = [], observedAt = FRESH) {
  return resolveInjury(
    [
      { source: 'sleeper', designation: designation as never, raw: designation, observedAt },
      ...(practice.length > 0
        ? [{ source: 'nflverse', designation: 'unknown' as never, raw: null, observedAt, practice }]
        : []),
    ],
    NOW,
  );
}

describe('availability confidence', () => {
  it('reads DNP → limited → full as expected to play', () => {
    const view = availabilityConfidence(state('questionable', ['dnp', 'limited', 'full']));
    expect(view.state).toBe('high_confidence_active');
    expect(view.risky).toBe(false);
  });

  it('reads DNP → DNP → DNP as unlikely to play', () => {
    const view = availabilityConfidence(state('questionable', ['dnp', 'dnp', 'dnp']));
    expect(view.state).toBe('likely_inactive');
    expect(view.risky).toBe(true);
  });

  it('reads a limited week as probably playing but unsettled', () => {
    const view = availabilityConfidence(state('questionable', ['limited', 'limited', 'limited']));
    expect(view.state).toBe('moderate_confidence_active');
    expect(view.risky).toBe(true);
  });

  it('reads Questionable with no practice report as genuinely uncertain', () => {
    const view = availabilityConfidence(state('questionable'));
    expect(view.state).toBe('uncertain');
    expect(view.risky).toBe(true);
  });

  it('treats Out as a fact', () => {
    expect(availabilityConfidence(state('out')).state).toBe('inactive');
    expect(availabilityConfidence(state('ir')).state).toBe('inactive');
  });

  it('says nothing about a healthy player', () => {
    const view = availabilityConfidence(state('healthy'));
    expect(view.state).toBe('high_confidence_active');
    expect(view.detail).toBeNull();
  });

  it('distinguishes no designation from no information', () => {
    expect(availabilityConfidence(state('healthy')).state).toBe('high_confidence_active');
    expect(availabilityConfidence(resolveInjury([], NOW)).state).toBe('unknown');
  });

  it('pulls a stale practice week back toward uncertain', () => {
    const stale = availabilityConfidence(state('questionable', ['dnp', 'limited', 'full'], OLD));
    expect(stale.state).toBe('uncertain');
    expect(stale.evidence.join(' ')).toContain('out of date');
  });

  it('lowers confidence when the sources disagree', () => {
    const conflicted = resolveInjury(
      [
        { source: 'sleeper', designation: 'questionable', raw: 'Questionable', observedAt: FRESH },
        { source: 'nflverse', designation: 'out', raw: 'Out', observedAt: FRESH, practice: ['limited'] },
      ],
      NOW,
    );
    const view = availabilityConfidence(conflicted);
    expect(view.risky).toBe(true);
    expect(view.evidence.join(' ')).toContain('disagree');
  });
});

describe('replacement quality and late-swap exposure', () => {
  const early = '2026-09-13T17:00:00Z';
  const late = '2026-09-13T20:25:00Z';

  it('charges nothing for a player who is expected to play', () => {
    const result = assessReplacement({
      player: { name: 'Fit', kickoff: late, score: 14, availability: 'high_confidence_active' },
      alternatives: [{ playerId: 'b', name: 'Backup', kickoff: early, score: 6 }],
      now: NOW,
    });
    expect(result.points).toBe(0);
    expect(result.verdict).toBe('no_risk');
  });

  it('is covered when a fallback does not lock first', () => {
    const result = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives: [{ playerId: 'b', name: 'Late Backup', kickoff: late, score: 9 }],
      now: NOW,
    });
    expect(result.verdict).toBe('covered');
    expect(result.points).toBe(0);
    expect(result.fallbackName).toBe('Late Backup');
  });

  it('charges for an exposed late swap when the only cover locks first', () => {
    const result = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives: [{ playerId: 'b', name: 'Early Backup', kickoff: early, score: 5 }],
      now: NOW,
    });
    expect(result.verdict).toBe('late_swap_exposed');
    expect(result.points).toBeLessThan(0);
    expect(result.driver).toMatch(/late-swap/i);
  });

  it('charges more when the drop to the fallback is larger', () => {
    const shallow = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives: [{ playerId: 'b', name: 'Nearly As Good', kickoff: early, score: 13 }],
      now: NOW,
    });
    const steep = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives: [{ playerId: 'b', name: 'Much Worse', kickoff: early, score: 3 }],
      now: NOW,
    });
    expect(steep.points).toBeLessThan(shallow.points);
  });

  it('charges most for a coin flip and less for a player already written off', () => {
    const alternatives = [{ playerId: 'b', name: 'Early Backup', kickoff: early, score: 5 }];
    const coinFlip = assessReplacement({
      player: { name: 'A', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives,
      now: NOW,
    });
    const writtenOff = assessReplacement({
      player: { name: 'A', kickoff: late, score: 14, availability: 'likely_inactive' },
      alternatives,
      now: NOW,
    });
    expect(coinFlip.points).toBeLessThan(writtenOff.points);
  });

  it('says so when there is nobody to cover him at all', () => {
    const result = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives: [],
      now: NOW,
    });
    expect(result.verdict).toBe('thin_bench');
    expect(result.driver).toMatch(/no cover/i);
  });

  it('ignores an alternative whose game has already started', () => {
    const result = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 14, availability: 'uncertain' },
      alternatives: [{ playerId: 'b', name: 'Already Playing', kickoff: '2026-09-13T13:00:00Z', score: 9 }],
      now: NOW,
    });
    expect(result.verdict).toBe('thin_bench');
  });

  it('stays inside its cap', () => {
    const result = assessReplacement({
      player: { name: 'Risky', kickoff: late, score: 40, availability: 'uncertain' },
      alternatives: [{ playerId: 'b', name: 'Nobody', kickoff: early, score: 0 }],
      now: NOW,
    });
    expect(result.points).toBeGreaterThanOrEqual(-REPLACEMENT.maxPenaltyPoints);
  });
});
