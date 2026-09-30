/**
 * A player in the IR slot is not a starter, whatever his designation says.
 *
 * Found on 30 September 2026 against the live league: Nico Collins sat in the
 * owner's IR slot, Sleeper's designation for him was Questionable, and the Team
 * screen started him at WR with a normal-looking 10.55. The engine only ruled a
 * player out by designation (Out, IR, PUP, suspended), and Sleeper lets a
 * Questionable player into an IR slot, so nothing stopped it. Moving him into the
 * lineup would mean first taking him off IR, which is a roster move and not a
 * start/sit call.
 *
 * Asserted through `recommendLineup`, which the Team screen, the waiver planner
 * and the drop list all read, and once through the waiver scan's own baseline.
 */

import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { pricedCandidate as candidate } from './helpers/startsit.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';

const POSITIONS = ['QB', 'WR', 'WR', 'BN', 'BN', 'IR'];
const SHAPE = buildRosterShape(POSITIONS);
const PROFILE = buildScoringProfile({ rec: 0.5 }, POSITIONS);

/** The best receiver on the roster is the one in the IR slot. */
function roster(over: { reserved?: boolean } = {}): StartSitInput[] {
  return [
    candidate('qb', 'Joe Burrow', 'QB', 20),
    {
      ...candidate('collins', 'Nico Collins', 'WR', 14, { status: 'Questionable' }),
      ...(over.reserved === false ? {} : { onReserve: true }),
    },
    candidate('wilson', 'Garrett Wilson', 'WR', 11),
    candidate('egbuka', 'Emeka Egbuka', 'WR', 6),
    candidate('mcconkey', 'Ladd McConkey', 'WR', 5),
  ];
}

describe('a player in the IR slot', () => {
  it('is started on the numbers alone when nothing says where he sits, which was the bug', () => {
    const lineup = recommendLineup(roster({ reserved: false }), SHAPE, PROFILE);
    expect(lineup.slots.map((s) => s.playerId)).toContain('collins');
  });

  it('is never put in a starting slot, and the next healthy receiver takes it', () => {
    const lineup = recommendLineup(roster(), SHAPE, PROFILE);
    const wrs = lineup.slots.filter((s) => s.slot === 'WR').map((s) => s.playerId);
    expect(wrs).not.toContain('collins');
    expect(wrs.sort()).toEqual(['egbuka', 'wilson']);
  });

  it('stays on the bench list, so he does not vanish from the screen', () => {
    const lineup = recommendLineup(roster(), SHAPE, PROFILE);
    expect(lineup.bench.map((e) => e.playerId)).toContain('collins');
  });

  it('does not count toward the lineup total', () => {
    const withHim = recommendLineup(roster({ reserved: false }), SHAPE, PROFILE);
    const without = recommendLineup(roster(), SHAPE, PROFILE);
    expect(without.recommendedPoints).toBeLessThan(withHim.recommendedPoints);
  });

  it('draws no weekly warning while he is where the owner put him', () => {
    const lineup = recommendLineup(roster(), SHAPE, PROFILE);
    expect(lineup.warnings.join(' ')).not.toMatch(/Nico Collins/);
  });

  it('is called out by the slot if Sleeper somehow has him starting', () => {
    const lineup = recommendLineup(roster(), SHAPE, PROFILE, { currentStarterIds: ['qb', 'collins', 'wilson'] });
    expect(lineup.warnings).toContain('Nico Collins is in your IR slot and is currently in your lineup — not a playable starter');
  });

  it('keeps his score and his real designation, so every other screen still reads true', () => {
    const evaluation = evaluatePlayer(roster()[1]!, PROFILE);
    expect(evaluation.ruledOut).toBe(true);
    expect(evaluation.onReserve).toBe(true);
    expect(evaluation.score).not.toBeNull();
    expect(evaluation.injury.designation).toBe('questionable');
  });

  it('leaves a player outside the IR slot exactly as he was', () => {
    const evaluation = evaluatePlayer(roster()[2]!, PROFILE);
    expect(evaluation.ruledOut).toBe(false);
    expect('onReserve' in evaluation).toBe(false);
  });
});
