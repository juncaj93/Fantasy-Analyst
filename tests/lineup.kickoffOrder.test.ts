/**
 * Kickoff-smart lineup order (Alex's decision, 23 October 2026).
 *
 * When two legal lineups score the same (within 0.05 of a point), the app
 * prefers the one with the latest kickoff in FLEX and the earlier games in the
 * fixed slots, so a late swap stays possible. It never gives up more than that
 * tie, never moves a game that has started, and says nothing: only the order
 * changes.
 */
import { describe, expect, it } from 'vitest';
import { recommendLineup, KICKOFF_TIE } from '../src/core/startsit/lineup.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const WR_FLEX = buildRosterShape(['WR', 'FLEX', 'BN', 'BN']);
const NOW = '2026-10-25T12:00:00Z';
const EARLY = '2026-10-25T17:00:00Z';
const LATE = '2026-10-26T00:20:00Z';
const STARTED = '2026-10-25T11:00:00Z';

const slotOf = (r: ReturnType<typeof recommendLineup>, id: string) => r.slots.find((s) => s.playerId === id)?.slot ?? null;
const pointsOf = (r: ReturnType<typeof recommendLineup>, id: string) =>
  [...r.starters, ...r.bench].find((e) => e.playerId === id)!.decision!.points;

function lineup(late: number, opts: { lateKickoff?: string; currentStarterIds?: string[] } = {}) {
  return recommendLineup(
    [
      pricedCandidate('a', 'Alpha', 'WR', 15, { kickoff: EARLY, now: NOW }),
      pricedCandidate('b', 'Bravo', 'WR', 10, { kickoff: EARLY, now: NOW }),
      pricedCandidate('c', 'Charlie', 'WR', late, { kickoff: opts.lateKickoff ?? LATE, now: NOW }),
    ],
    WR_FLEX,
    PROFILE,
    { now: NOW, currentStarterIds: opts.currentStarterIds ?? ['a', 'b'] },
  );
}

describe('kickoff-smart order', () => {
  it('the tie is 0.05 of a point', () => {
    expect(KICKOFF_TIE).toBe(0.05);
  });

  it('on a tie, the late game starts and sits in FLEX, the early game in the fixed slot', () => {
    const r = lineup(9.97);
    const gap = pointsOf(r, 'b') - pointsOf(r, 'c');
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(KICKOFF_TIE);
    expect(slotOf(r, 'a')).toBe('WR');
    expect(slotOf(r, 'c')).toBe('FLEX');
    expect(slotOf(r, 'b')).toBeNull();
    // A tie is not a change worth suggesting, and says nothing.
    expect(r.swaps).toEqual([]);
    expect(r.notes.join(' ')).not.toMatch(/kickoff tie|late swap/i);
  });

  it('never trades projected points beyond the tie', () => {
    const r = lineup(9.5);
    expect(pointsOf(r, 'b') - pointsOf(r, 'c')).toBeGreaterThan(KICKOFF_TIE);
    expect(slotOf(r, 'b')).not.toBeNull();
    expect(slotOf(r, 'c')).toBeNull();
  });

  it('never moves a game that has started', () => {
    const r = lineup(9.97, { lateKickoff: STARTED });
    expect(slotOf(r, 'c')).toBeNull();
  });

  it('still reassigns fully: the higher number starts whatever the kickoff', () => {
    const r = lineup(12);
    expect(slotOf(r, 'c')).toBe('FLEX');
    expect(slotOf(r, 'a')).toBe('WR');
    expect(slotOf(r, 'b')).toBeNull();
  });
});
