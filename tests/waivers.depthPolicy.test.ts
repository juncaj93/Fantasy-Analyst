/**
 * Positional depth, and the two supplementary signals, on the waiver board.
 *
 * Opened by the live board of 25 September 2026, which recommended four tight
 * ends in a row to a roster already holding two. Each cleared the bar because
 * the bar was the weakest flex-eligible man on the bench — a running back — so
 * every tight end on the wire "beat" him. The policy in
 * `core/waivers/depthPolicy.ts` fixes the comparison, and these tests name the
 * invariants rather than freezing a board:
 *
 *   - a slot position at its cap is measured against its own weakest player,
 *     at the starter-upgrade bar, and at most one such add is offered;
 *   - backs and receivers are uncapped, with a lean toward backs that breaks
 *     ties and never a real gap;
 *   - Sleeper's trending adds lift a borderline call and break a near-tie, and
 *     never invent a call the projection does not already favour;
 *   - a second defence is allowed only in the week before the playoffs.
 *
 * The live case is rebuilt at the bottom from the numbers measured on it.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import {
  ATTENTION_WEIGHT,
  MEANINGFUL_UPGRADE_GAIN,
  recommendWaiverUpgrades,
  type WaiverAttention,
} from '../src/core/startsit/waivers.ts';
import { DEPTH_LEAN, depthCap, inPlayoffPrep } from '../src/core/waivers/depthPolicy.ts';
import { planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
import { caseLines } from '../src/core/waivers/claimPlan.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

/** Tony's Pizza's own shape, with a tight-end slot and two flexes. */
const SHAPE = buildRosterShape([
  'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
]);

/**
 * Two tight ends, both starting (one at TE, one in the flex), and a weak back
 * at the bottom of the bench — the live board's exact shape.
 *
 * `backupEnd` moves the second tight end to the bench, which is the case the
 * positional comparison exists for: a tight end who clearly beats a *starter*
 * is a starter upgrade and is answered by the upgrade tier, at its own bar.
 */
function roster(opts: { backupEnd?: boolean } = {}) {
  return [
    candidate('qb1', 'Starting Passer', 'QB', 22),
    candidate('rb1', 'Lead Back', 'RB', 19),
    candidate('rb2', 'Second Back', 'RB', 18),
    candidate('wr1', 'Wideout One', 'WR', 14),
    candidate('wr2', 'Wideout Two', 'WR', 12),
    candidate('wr3', 'Wideout Three', 'WR', 11),
    candidate('te1', 'Tight End One', 'TE', 11.5),
    candidate('te2', 'Tight End Two', 'TE', opts.backupEnd ? 6 : 11),
    candidate('wr4', 'Flex Wideout', 'WR', 9),
    candidate('rb3', 'Weak Back', 'RB', 1),
    // A flex back good enough to push the second tight end to the bench.
    ...(opts.backupEnd ? [candidate('rb4', 'Flex Back', 'RB', 8)] : []),
  ];
}
const ROSTER_IDS = roster({ backupEnd: true }).map((c) => c.player.id);

function scan(
  wire: ReturnType<typeof candidate>[],
  extra: { attention?: WaiverAttention; week?: number; playoffWeeks?: number[]; backupEnd?: boolean } = {},
) {
  return recommendWaiverUpgrades({
    roster: roster({ backupEnd: extra.backupEnd ?? false }),
    candidates: wire,
    shape: SHAPE,
    profile: HALF_PPR,
    rosteredPlayerIds: ROSTER_IDS,
    calendar: { week: extra.week ?? 3, playoffWeeks: extra.playoffWeeks ?? [15, 16, 17] },
    ...(extra.attention ? { attention: extra.attention } : {}),
  });
}

describe('a slot position at its cap', () => {
  it('stops four tight ends that each beat a weak back from all reaching the board', () => {
    const advice = scan([
      candidate('fa-te1', 'Wire End A', 'TE', 7.6),
      candidate('fa-te2', 'Wire End B', 'TE', 7.6),
      candidate('fa-te3', 'Wire End C', 'TE', 7.5),
      candidate('fa-te4', 'Wire End D', 'TE', 6.4),
    ]);

    // Every one of them beats the weak back by six points. None beats the
    // weaker tight end, which is the comparison that matters.
    expect(advice.valueAdds.filter((v) => v.position === 'TE')).toEqual([]);
  });

  it('offers exactly one tight end, the best, when some are clear upgrades on the one you hold', () => {
    const advice = scan(
      [
        candidate('fa-te1', 'Standout End', 'TE', 9.8),
        candidate('fa-te2', 'Also Better End', 'TE', 9.7),
        candidate('fa-te3', 'Merely Fine End', 'TE', 7),
      ],
      { backupEnd: true },
    );

    const ends = advice.valueAdds.filter((v) => v.position === 'TE');
    expect(ends.map((v) => v.name)).toEqual(['Standout End']);
    expect(ends[0]!.overName).toBe('Tight End Two');
    expect(ends[0]!.basis.comparedTo).toBe('position');
    expect(ends[0]!.basis.bar).toBeGreaterThanOrEqual(MEANINGFUL_UPGRADE_GAIN);
    expect(ends[0]!.reasons[0]).toMatch(/Clear upgrade on Tight End Two/);
  });

  it('does not offer a tight end who is better, but not clearly better', () => {
    const advice = scan([candidate('fa-te1', 'Slightly Better End', 'TE', 7)], { backupEnd: true });
    expect(advice.valueAdds).toEqual([]);
  });

  it('derives the cap from the league shape, and not from a list of names', () => {
    const ctx = { shape: SHAPE, week: 3, playoffWeeks: [15, 16, 17] };
    expect(depthCap('TE', ctx)).toBe(1);
    expect(depthCap('QB', ctx)).toBe(1);
    expect(depthCap('RB', ctx)).toBeNull();
    expect(depthCap('WR', ctx)).toBeNull();

    const superflex = buildRosterShape(['QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'BN']);
    expect(depthCap('QB', { ...ctx, shape: superflex })).toBe(2);
  });
});

describe('a defence', () => {
  it('is capped at one until the week before the playoffs, then at two', () => {
    const playoffWeeks = [15, 16, 17];
    expect(depthCap('DEF', { shape: SHAPE, week: 9, playoffWeeks })).toBe(1);
    expect(depthCap('DEF', { shape: SHAPE, week: 13, playoffWeeks })).toBe(1);
    expect(depthCap('DEF', { shape: SHAPE, week: 14, playoffWeeks })).toBe(2);
    expect(inPlayoffPrep({ week: 14, playoffWeeks })).toBe(true);
    expect(inPlayoffPrep({ week: 14, playoffWeeks: [] })).toBe(false);
  });
});

describe('a defence on the generic scan', () => {
  it('is never offered as a swap for the one you hold, which is the defence planner\'s call', () => {
    const advice = recommendWaiverUpgrades({
      roster: [...roster(), candidate('def1', 'Held Defence', 'DEF', 4)],
      candidates: [candidate('fa-def', 'Much Better Defence', 'DEF', 12)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: [...ROSTER_IDS, 'def1'],
      calendar: { week: 3, playoffWeeks: [15, 16, 17] },
    });
    expect(advice.valueAdds).toEqual([]);
    expect(advice.upgrades).toEqual([]);
  });
});

describe('backs and receivers', () => {
  it('are uncapped: several can clear at once', () => {
    const advice = scan([
      candidate('fa-rb1', 'Wire Back A', 'RB', 7),
      candidate('fa-rb2', 'Wire Back B', 'RB', 6),
      candidate('fa-wr1', 'Wire Receiver A', 'WR', 6.5),
    ]);
    expect(advice.valueAdds.map((v) => v.name).sort()).toEqual(['Wire Back A', 'Wire Back B', 'Wire Receiver A']);
    expect(advice.valueAdds.every((v) => v.basis.comparedTo === 'bench')).toBe(true);
  });

  it('lean toward a back when the two are close', () => {
    const advice = scan([candidate('fa-wr1', 'Close Receiver', 'WR', 5.6), candidate('fa-rb1', 'Close Back', 'RB', 5.5)]);
    expect(advice.valueAdds.map((v) => v.name)).toEqual(['Close Back', 'Close Receiver']);
    expect(advice.valueAdds[0]!.basis.lean).toBe(DEPTH_LEAN.RB);
  });

  it('never let the lean override a real gap', () => {
    const advice = scan([candidate('fa-wr1', 'Better Receiver', 'WR', 6.5), candidate('fa-rb1', 'Worse Back', 'RB', 5.5)]);
    expect(advice.valueAdds.map((v) => v.name)).toEqual(['Better Receiver', 'Worse Back']);
  });
});

describe("Sleeper's trending adds", () => {
  const hot = (id: string, heat = 1, rank = 1): WaiverAttention => new Map([[id, { heat, rank }]]);

  it('break a near-tie the projection could not', () => {
    const wire = [candidate('fa-wr1', 'Quiet Receiver', 'WR', 6.0), candidate('fa-wr2', 'Hot Receiver', 'WR', 5.9)];
    expect(scan(wire).valueAdds[0]!.name).toBe('Quiet Receiver');

    const withHeat = scan(wire, { attention: hot('fa-wr2') });
    expect(withHeat.valueAdds[0]!.name).toBe('Hot Receiver');
    expect(withHeat.valueAdds[0]!.basis.attention).toEqual({ rank: 1, heat: 1, nudge: ATTENTION_WEIGHT });
    // The projection claim is untouched: gain is still the points gap.
    expect(withHeat.valueAdds[0]!.gain).toBeCloseTo(scan(wire).valueAdds[1]!.gain, 5);
  });

  it('lift a call the projection favours over a bar it only just misses', () => {
    // Measured against the benched tight end at the upgrade bar, and placed
    // half a point short of whatever that bar is: inside a full-heat nudge.
    const probe = scan([candidate('fa-te0', 'Probe End', 'TE', 9.9)], { backupEnd: true }).valueAdds[0]!;
    const shortBy = 6 + probe.basis.bar - 0.5;
    const wire = [candidate('fa-te1', 'Borderline End', 'TE', shortBy)];
    expect(scan(wire, { backupEnd: true }).valueAdds).toEqual([]);
    expect(scan(wire, { backupEnd: true, attention: hot('fa-te1') }).valueAdds.map((v) => v.name)).toEqual([
      'Borderline End',
    ]);
  });

  it('never invent a call the projection does not favour', () => {
    const wire = [candidate('fa-te1', 'Hyped End', 'TE', 5.5)];
    expect(scan(wire, { backupEnd: true, attention: hot('fa-te1') }).valueAdds).toEqual([]);
  });

  it('move nothing when a surge is small', () => {
    const wire = [candidate('fa-te1', 'Borderline End', 'TE', 8)];
    expect(scan(wire, { backupEnd: true }).valueAdds).toEqual([]);
    expect(scan(wire, { backupEnd: true, attention: hot('fa-te1', 0.1, 45) }).valueAdds).toEqual([]);
  });
});

describe('See why', () => {
  it('names the projection, the comparison, the trending read and the lean', () => {
    const advice = scan([candidate('fa-rb1', 'Wire Back', 'RB', 7)], { attention: new Map([['fa-rb1', { heat: 0.72, rank: 15 }]]) });
    const board = buildWaiverBoard({ upgrades: advice.upgrades, valueAdds: advice.valueAdds });
    const lines = caseLines('Wire Back', board.rows[0]!);

    expect(lines.join('\n')).toMatch(/projects Wire Back for 7\.0 pts/);
    expect(lines.join('\n')).toMatch(/better than Weak Back/);
    expect(lines.join('\n')).toMatch(/held for depth with no cap/);
    expect(lines.join('\n')).toMatch(/#15 on Sleeper's trending adds.*does not change his projection/);
    expect(lines.join('\n')).toMatch(/lean/);
  });
});

/*
 * The live case, rebuilt by hand.
 *
 * Measured on production on 25 September 2026 (week 3) with the Probe workflow
 * and `scripts/probe-waiver-depth.mjs`: two tight ends both starting, a
 * questionable back at the bottom of the bench scoring below zero, and a wire
 * whose best four players were tight ends. The plan read
 * `Add Pat Freiermuth · Drop Emanuel Wilson` while Emanuel Wilson was the #1
 * add in all of Sleeper. The real snapshot is league data and stays out of the
 * repository; these are its shape and its numbers.
 */
describe('the live board of 25 September 2026, rebuilt', () => {
  const wire = [
    candidate('henry', 'Hunter Henry', 'TE', 7.64),
    candidate('freiermuth', 'Pat Freiermuth', 'TE', 7.62),
    candidate('ferguson', 'Terrance Ferguson', 'TE', 7.59),
    candidate('gadsden', 'Oronde Gadsden', 'TE', 6.37),
    candidate('allgeier', 'Tyler Allgeier', 'RB', 6.76),
    candidate('white', 'Rachaad White', 'RB', 6.06),
    candidate('allen', 'Keenan Allen', 'WR', 5.55),
  ];

  it('offers no third tight end, and the backs and receivers instead', () => {
    const advice = scan(wire);
    expect(advice.valueAdds.filter((v) => v.position === 'TE')).toEqual([]);
    expect(advice.valueAdds.map((v) => v.name)).toEqual(['Tyler Allgeier', 'Rachaad White', 'Keenan Allen']);
  });

  it('never names the #1 add in Sleeper as the cut', () => {
    const mine = [...roster(), candidate('wilson', 'Emanuel Wilson', 'RB', 1.3)];
    const base = {
      roster: mine,
      targets: [{ input: candidate('allgeier', 'Tyler Allgeier', 'RB', 12), boardRank: 1 }],
      shape: SHAPE,
      profile: HALF_PPR,
      week: 3,
    };
    const without = planWaiverClaims(base);
    expect(without.claims[0]?.dropName).toBe('Weak Back');

    const withRoom = planWaiverClaims({ ...base, roster: [...roster().slice(0, -1), candidate('wilson', 'Emanuel Wilson', 'RB', 1)], roomIsAdding: new Map([['wilson', 1]]) });
    for (const claim of withRoom.claims) expect(claim.dropName).not.toBe('Emanuel Wilson');
    expect(withRoom.protectedPlayers).toContainEqual(
      expect.objectContaining({ name: 'Emanuel Wilson', reason: 'room_is_adding' }),
    );
  });
});
