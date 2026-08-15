/**
 * How much of one NFL offence the board will let you own.
 *
 * The property that matters most here is the one that is easiest to lose in a
 * refactor: a quarterback and his receiver must not be treated as the same
 * thing as a running back and his receiver. One is a stack and is rewarded; the
 * other splits a finite pool of touches and is mildly discouraged. Neither is
 * ever a ban.
 */

import { describe, expect, it } from 'vitest';
import { CONCENTRATION, assessConcentration, roundRamp } from '../src/core/draft/concentration.ts';
import { rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

function assess(position: string, team: string, roster: { position: string; team: string }[], round = 8) {
  return assessConcentration({ position, team, roster, round, totalRounds: 15 });
}

describe('same-team skill concentration', () => {
  it('leaves a clean roster alone', () => {
    expect(assess('WR', 'DET', [{ position: 'RB', team: 'KC' }]).score).toBe(0);
  });

  it('applies a bounded penalty to a second non-quarterback from one offence', () => {
    const result = assess('WR', 'DET', [{ position: 'RB', team: 'DET' }]);
    expect(result.score).toBeLessThan(0);
    expect(result.score).toBeGreaterThan(-1);
    expect(result.display).toContain('DET');
  });

  it('penalises a third same-team skill player more than a second', () => {
    const second = assess('WR', 'DET', [{ position: 'RB', team: 'DET' }]);
    const third = assess('WR', 'DET', [
      { position: 'RB', team: 'DET' },
      { position: 'WR', team: 'DET' },
    ]);
    expect(third.score).toBeLessThan(second.score);
  });

  it('treats WR + WR, WR + TE and TE + TE the same way it treats RB + WR', () => {
    const pairs: [string, string][] = [
      ['WR', 'WR'],
      ['TE', 'WR'],
      ['TE', 'TE'],
      ['RB', 'TE'],
    ];
    for (const [incoming, rostered] of pairs) {
      expect(assess(incoming, 'CIN', [{ position: rostered, team: 'CIN' }]).score).toBeLessThan(0);
    }
  });

  it('never becomes a ban, however many of one offence you own', () => {
    const result = assess('WR', 'CIN', [
      { position: 'RB', team: 'CIN' },
      { position: 'WR', team: 'CIN' },
      { position: 'TE', team: 'CIN' },
      { position: 'WR', team: 'CIN' },
    ]);
    expect(result.score).toBeGreaterThanOrEqual(-1);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('ignores a player whose NFL team is unknown rather than guessing one', () => {
    expect(assess('WR', '', [{ position: 'RB', team: '' }]).score).toBe(0);
  });

  it('is discounted in round one and full by the end of the draft', () => {
    const early = assess('WR', 'DET', [{ position: 'RB', team: 'DET' }], 1);
    const late = assess('WR', 'DET', [{ position: 'RB', team: 'DET' }], 15);
    expect(Math.abs(early.score)).toBeLessThan(Math.abs(late.score));
    expect(roundRamp(1, 15)).toBeCloseTo(CONCENTRATION.earlyRoundFloor, 3);
    expect(roundRamp(15, 15)).toBe(1);
  });
});

describe('quarterback stacking is not concentration', () => {
  it('does not penalise a receiver joining his own quarterback', () => {
    const result = assess('WR', 'CIN', [{ position: 'QB', team: 'CIN' }]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.driver).toContain('Stack');
  });

  it('does not penalise a tight end joining his own quarterback', () => {
    expect(assess('TE', 'CIN', [{ position: 'QB', team: 'CIN' }]).score).toBeGreaterThan(0);
  });

  it('rewards the quarterback who completes the stack from the other direction', () => {
    const result = assess('QB', 'CIN', [{ position: 'WR', team: 'CIN' }]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.isQuarterbackOfOwned).toBe(true);
  });

  it('does not penalise a quarterback for his own team’s running back', () => {
    expect(assess('QB', 'CIN', [{ position: 'RB', team: 'CIN' }]).score).toBe(0);
  });

  it('pays less for the second pass-catcher in a stack than the first', () => {
    const first = assess('WR', 'CIN', [{ position: 'QB', team: 'CIN' }]);
    const second = assess('WR', 'CIN', [
      { position: 'QB', team: 'CIN' },
      { position: 'WR', team: 'CIN' },
    ]);
    expect(second.score).toBeLessThan(first.score);
  });

  it('lets concentration partly offset a stack when a back is already owned', () => {
    const clean = assess('WR', 'CIN', [{ position: 'QB', team: 'CIN' }]);
    const crowded = assess('WR', 'CIN', [
      { position: 'QB', team: 'CIN' },
      { position: 'RB', team: 'CIN' },
    ]);
    expect(crowded.score).toBeLessThan(clean.score);
  });
});

// ------------------------------------------------------------ on the board

function entry(id: string, position: string, adp: number, team: string): AvailablePlayerInput {
  return {
    player: player({ id, fullName: `${position} ${id}`, position, team }),
    adp,
    adpRank: Math.round(adp),
    signal: null,
  };
}

function board(roster: { position: string; team: string }[] | undefined, entries: AvailablePlayerInput[]) {
  return rankAvailablePlayers(entries, {
    currentPick: 60,
    nextPick: 75,
    shape: SHAPE,
    profile: HALF_PPR,
    rosterCounts: { QB: 1, RB: 1, WR: 1, TE: 0 },
    totalPicks: 180,
    rosterPlayers: roster,
  });
}

describe('on a real board', () => {
  const contribution = (rec: { components: { key: string; contribution: number }[] }) =>
    rec.components.find((c) => c.key === 'team_concentration')?.contribution ?? 0;

  it('reorders two otherwise-identical players by roster overlap', () => {
    const ranked = board(
      [{ position: 'RB', team: 'DET' }],
      [entry('crowded', 'WR', 60, 'DET'), entry('clear', 'WR', 60, 'SEA')],
    );
    expect(ranked[0]!.playerId).toBe('clear');
    expect(contribution(ranked.find((r) => r.playerId === 'crowded')!)).toBeLessThan(0);
  });

  it('is outrun by a large enough value edge', () => {
    // Same offence as a back already owned, but forty picks of value in hand.
    const ranked = board(
      [{ position: 'RB', team: 'DET' }],
      [entry('bargain', 'WR', 20, 'DET'), entry('clear', 'WR', 60, 'SEA')],
    );
    expect(ranked[0]!.playerId).toBe('bargain');
  });

  it('says nothing when the drafted roster is not known', () => {
    const ranked = board(undefined, [entry('a', 'WR', 60, 'DET'), entry('b', 'WR', 60, 'SEA')]);
    for (const rec of ranked) {
      expect(contribution(rec)).toBe(0);
      expect(rec.components.find((c) => c.key === 'team_concentration')!.unknown).toBe(true);
    }
  });

  it('keeps the effect inside its weight', () => {
    const ranked = board(
      [
        { position: 'RB', team: 'DET' },
        { position: 'WR', team: 'DET' },
        { position: 'TE', team: 'DET' },
      ],
      [entry('fourth', 'WR', 60, 'DET')],
    );
    expect(Math.abs(contribution(ranked[0]!))).toBeLessThanOrEqual(CONCENTRATION.weight + 1e-9);
  });

  it('surfaces the reason on the card when it moved the ranking', () => {
    const ranked = board(
      [
        { position: 'RB', team: 'DET' },
        { position: 'WR', team: 'DET' },
      ],
      [entry('third', 'WR', 60, 'DET')],
    );
    expect(ranked[0]!.counterpoints.join(' ')).toMatch(/concentration penalty/i);
  });
});
