/**
 * Draft decision quality.
 *
 * These are advice, not measurements, so the tests are mostly about restraint:
 * a tier cliff that fires on every gap, an AVOID that bans a player outright,
 * or a ★ that overrules the board would each be worse than not having the
 * feature. The cases below pin the boundaries in both directions — it fires
 * when it should, and stays quiet when it should not.
 */

import { describe, expect, it } from 'vitest';
import {
  DECISION_THRESHOLDS,
  assessAvoid,
  assessTierCliff,
  assessWait,
  buildPositionTiers,
  myGuy,
  rosterAlerts,
  tierBreakGap,
  toMyGuyLevel,
} from '../src/core/draft/decisions.ts';
import { computeNeed } from '../src/core/draft/need.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN']);
const needsFor = (counts: Record<string, number>) => computeNeed(SHAPE, counts);

describe('tiers', () => {
  it('scales the gap that separates tiers with draft position', () => {
    // Eight picks is a chasm at the top of the board and noise at the bottom.
    expect(tierBreakGap(10)).toBe(DECISION_THRESHOLDS.tiers.minGap);
    expect(tierBreakGap(200)).toBeGreaterThan(DECISION_THRESHOLDS.tiers.minGap);
  });

  it('groups players with no meaningful gap between them', () => {
    const tiers = buildPositionTiers([10, 12, 14, 45, 47, 90]);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]!.adps).toEqual([10, 12, 14]);
    expect(tiers[1]!.adps).toEqual([45, 47]);
    expect(tiers[2]!.adps).toEqual([90]);
    expect(tiers[0]!.gapToNext).toBe(31);
    expect(tiers[2]!.gapToNext).toBeNull();
  });

  it('treats an unbroken run as one tier', () => {
    expect(buildPositionTiers([20, 22, 24, 26, 28])).toHaveLength(1);
  });

  it('says nothing without an ADP', () => {
    const cliff = assessTierCliff({
      position: 'TE',
      playerAdp: null,
      availableAdps: [10, 40],
      picksUntilNext: 20,
      needScore: 1,
    });
    expect(cliff.severity).toBe('none');
    expect(cliff.message).toBeNull();
  });
});

describe('tier cliffs', () => {
  /** The brief's own example: the last TE before a long gap, at a position you need. */
  it('flags the last player in a tier when the next group is far away', () => {
    const cliff = assessTierCliff({
      position: 'TE',
      playerAdp: 40,
      availableAdps: [40, 62, 66, 70],
      picksUntilNext: 18,
      needScore: 1,
    });
    expect(cliff.severity).toBe('last_in_tier');
    expect(cliff.message).toContain('Last TE in this tier');
    expect(cliff.message).toContain('22 picks later');
    expect(cliff.score).toBeGreaterThan(0.5);
  });

  it('stays quiet when the position runs deep past your next pick', () => {
    const cliff = assessTierCliff({
      position: 'WR',
      playerAdp: 30,
      availableAdps: [30, 33, 36, 39, 42, 45, 48, 51, 54],
      picksUntilNext: 10,
      needScore: 1,
    });
    expect(cliff.severity).toBe('none');
    expect(cliff.message).toBeNull();
  });

  it('stays quiet when your next pick is imminent', () => {
    // Nothing can fall off a cliff in two picks.
    const cliff = assessTierCliff({
      position: 'TE',
      playerAdp: 40,
      availableAdps: [40, 62, 66],
      picksUntilNext: 2,
      needScore: 1,
    });
    expect(cliff.severity).toBe('none');
  });

  it('matters less at a position that is already covered', () => {
    const input = {
      position: 'TE' as const,
      playerAdp: 40,
      availableAdps: [40, 62, 66, 70],
      picksUntilNext: 18,
    };
    const needed = assessTierCliff({ ...input, needScore: 1 });
    const covered = assessTierCliff({ ...input, needScore: 0.1 });
    expect(covered.severity).toBe('last_in_tier');
    expect(covered.score).toBeLessThan(needed.score);
  });
});

describe('the automatic AVOID tag', () => {
  it('fires at the configured lifetime threshold and not one point above it', () => {
    expect(assessAvoid(DECISION_THRESHOLDS.avoid.lifetimeNet, 0).active).toBe(true);
    expect(assessAvoid(DECISION_THRESHOLDS.avoid.lifetimeNet + 1, 0).active).toBe(false);
  });

  it('is reachable by an imported tally row at its real magnitude', () => {
    // The whole point of the magnitude repair: "Kyle Pitts -5" is one row.
    const tag = assessAvoid(-5, 0);
    expect(tag.active).toBe(true);
    expect(tag.message).toBe('AVOID — lifetime tally -5');
  });

  it('gets louder as the record gets worse, without ever becoming a ban', () => {
    const mild = assessAvoid(-5, 0);
    const severe = assessAvoid(-12, 0);
    expect(severe.score).toBeLessThan(mild.score);
    expect(severe.score).toBeGreaterThanOrEqual(-1);
  });

  it('keeps the tag but notes an improving trend, rather than erasing history', () => {
    const tag = assessAvoid(-8, 5);
    expect(tag.active).toBe(true);
    expect(tag.trendNote).toContain('Recent trend improving');
  });

  it('says nothing about a player the ledger is fine with', () => {
    const tag = assessAvoid(4, 2);
    expect(tag.active).toBe(false);
    expect(tag.score).toBe(0);
  });
});

describe('My Guy', () => {
  it('grows with the star level and stays bounded at the top', () => {
    expect(myGuy(1).score).toBeLessThan(myGuy(2).score);
    expect(myGuy(2).score).toBeLessThan(myGuy(3).score);
    expect(myGuy(3).score).toBeLessThanOrEqual(1);
  });

  it('renders the stars and the name the UI shows', () => {
    expect(myGuy(2).stars).toBe('★★');
    expect(myGuy(3).label).toBe('Must-Have');
    expect(myGuy(0).stars).toBe('');
  });

  it('treats anything unexpected as unflagged', () => {
    expect(toMyGuyLevel(null)).toBe(0);
    expect(toMyGuyLevel(9)).toBe(0);
    expect(toMyGuyLevel('2')).toBe(2);
  });
});

describe('can this player wait', () => {
  const quiet = assessTierCliff({
    position: 'WR',
    playerAdp: 30,
    availableAdps: [30, 33, 36, 39, 42, 45, 48],
    picksUntilNext: 8,
    needScore: 0.5,
  });

  const base = { cliff: quiet, needScore: 0.5, expectedRemaining: 5, position: 'WR', nextPick: 40 };

  it('says a very likely survivor will probably still be there', () => {
    expect(assessWait({ ...base, survivalProbability: 0.92 }).state).toBe('likely_available_later');
  });

  it('says a comfortable survivor can probably wait, and gives the number', () => {
    const guidance = assessWait({ ...base, survivalProbability: 0.76 });
    expect(guidance.state).toBe('can_probably_wait');
    expect(guidance.detail).toContain('76%');
    expect(guidance.detail).toContain('comparable WRs');
  });

  it('calls a borderline survivor risky', () => {
    expect(assessWait({ ...base, survivalProbability: 0.45 }).state).toBe('risky_to_wait');
  });

  it('says take him now when he is unlikely to last', () => {
    const guidance = assessWait({ ...base, survivalProbability: 0.18 });
    expect(guidance.state).toBe('take_now');
    expect(guidance.detail).toContain('18%');
  });

  /** The brief's example: a tier cliff beats a comfortable-looking probability. */
  it('overrides a good survival estimate when the tier ends at a position you need', () => {
    const cliff = assessTierCliff({
      position: 'TE',
      playerAdp: 40,
      availableAdps: [40, 70, 74],
      picksUntilNext: 18,
      needScore: 1,
    });
    const guidance = assessWait({
      survivalProbability: 0.7,
      cliff,
      needScore: 1,
      expectedRemaining: 2,
      position: 'TE',
      nextPick: 58,
    });
    expect(guidance.state).toBe('take_now');
    expect(guidance.detail).toContain('you still need TE');
  });

  it('does not override when the position is already covered', () => {
    const cliff = assessTierCliff({
      position: 'TE',
      playerAdp: 40,
      availableAdps: [40, 70, 74],
      picksUntilNext: 18,
      needScore: 0.1,
    });
    expect(assessWait({ survivalProbability: 0.7, cliff, needScore: 0.1, expectedRemaining: 2, position: 'TE', nextPick: 58 }).state).toBe(
      'can_probably_wait',
    );
  });

  it('admits when there is no ADP to reason from', () => {
    const guidance = assessWait({ ...base, survivalProbability: null });
    expect(guidance.state).toBe('unknown');
    expect(guidance.detail).toContain('no way to say');
  });
});

describe('roster construction alerts', () => {
  it('is relaxed about a missing starter early', () => {
    const alerts = rosterAlerts({
      shape: SHAPE,
      counts: { RB: 1, WR: 1 },
      needs: needsFor({ RB: 1, WR: 1 }),
      round: 3,
      totalRounds: 15,
    });
    const te = alerts.find((a) => a.key === 'starter:TE')!;
    expect(te.severity).toBe('info');
    expect(te.detail).toContain('still early');
  });

  it('gets louder about the same gap late, and counts the picks left', () => {
    const alerts = rosterAlerts({
      shape: SHAPE,
      counts: { RB: 3, WR: 5, QB: 1 },
      needs: needsFor({ RB: 3, WR: 5, QB: 1 }),
      round: 12,
      totalRounds: 15,
    });
    const te = alerts.find((a) => a.key === 'starter:TE')!;
    expect(te.severity).toBe('urgent');
    expect(te.message).toBe('Still need a starting TE');
    expect(te.detail).toContain('4 picks left');
  });

  it('notices a lopsided roster and names the position that is short', () => {
    const counts = { WR: 5, RB: 1, QB: 1, TE: 1 };
    const alerts = rosterAlerts({ shape: SHAPE, counts, needs: needsFor(counts), round: 8, totalRounds: 15 });
    const lopsided = alerts.find((a) => a.key.startsWith('lopsided:'))!;
    expect(lopsided.message).toContain('5 WRs already');
    expect(lopsided.positions).toEqual(['RB']);
  });

  it('says so plainly when the starting lineup is covered', () => {
    const counts = { QB: 1, RB: 2, WR: 2, TE: 1 };
    const alerts = rosterAlerts({ shape: SHAPE, counts, needs: needsFor(counts), round: 6, totalRounds: 15 });
    expect(alerts.some((a) => a.key === 'starters:covered')).toBe(true);
  });

  it('calls out a missing QB in a superflex league in those words', () => {
    const superflex = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'BN', 'BN']);
    const counts = { RB: 2, WR: 2, TE: 1 };
    const alerts = rosterAlerts({
      shape: superflex,
      counts,
      needs: computeNeed(superflex, counts),
      round: 5,
      totalRounds: 15,
    });
    expect(alerts.some((a) => a.message === 'No QB yet in a superflex league')).toBe(true);
  });
});
