/**
 * Roster shape, said out loud: fragility, bench optionality and streaming.
 *
 * All three share one rule and it is the rule under test everywhere here —
 * none of them may touch a projection. A fragile roster does not make its
 * players worse, a Sunday-night kickoff does not make a backup better, and a
 * deep waiver wire does not lower anybody's score. They describe the roster; the
 * engine describes the players.
 */

import { describe, expect, it } from 'vitest';
import { assessFragility } from '../src/core/startsit/fragility.ts';
import { OPTIONALITY, assessOptionality } from '../src/core/startsit/optionality.ts';
import { STREAMING, assessStreaming } from '../src/core/startsit/streaming.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { NO_INJURY_INFORMATION } from '../src/core/injury/model.ts';
import type { RosterShape } from '../src/core/sleeper/scoring.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { RoleAssessment } from '../src/core/startsit/decisions.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const NOW = '2025-10-05T14:00:00Z';
const EARLY = '2025-10-05T17:00:00Z';
const LATE = '2025-10-05T20:25:00Z';

const SHAPE: RosterShape = {
  starters: { QB: 1, WR: 2, TE: 1 },
  flex: [{ slot: 'FLEX', positions: ['WR', 'TE'] }],
  benchSlots: 5,
  irSlots: 1,
  totalStarters: 5,
  superflex: false,
};

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

function fragilityOf(roster: StartSitInput[], extra: { byeWeeks?: Map<string, number | null>; currentWeek?: number } = {}) {
  const lineup = recommendLineup(roster, SHAPE, HALF_PPR, { now: NOW });
  const evaluations = roster.map((r) => evaluatePlayer({ ...r, now: NOW }, HALF_PPR));
  return assessFragility({ lineup, evaluations, shape: SHAPE, ...extra });
}

describe('lineup fragility', () => {
  const deep = [
    candidate('qb1', 'A Quarterback', 'QB', 18, { kickoff: LATE }),
    candidate('qb2', 'Backup Quarterback', 'QB', 15, { kickoff: LATE }),
    candidate('wr1', 'First Receiver', 'WR', 14, { kickoff: LATE }),
    candidate('wr2', 'Second Receiver', 'WR', 13, { kickoff: EARLY }),
    candidate('wr3', 'Third Receiver', 'WR', 12, { kickoff: LATE }),
    candidate('wr4', 'Fourth Receiver', 'WR', 11, { kickoff: LATE }),
    candidate('te1', 'A Tight End', 'TE', 10, { kickoff: EARLY }),
    candidate('te2', 'Backup Tight End', 'TE', 9, { kickoff: LATE }),
  ];

  it('calls a deep, spread-out roster solid', () => {
    const read = fragilityOf(deep);
    expect(read.band).toBe('solid');
    expect(read.findings).toEqual([]);
    expect(read.headline).toBeNull();
  });

  it('flags the position with nothing behind it, by name', () => {
    const thin = deep.filter((p) => p.player.id !== 'te2');
    const read = fragilityOf(thin);
    expect(read.findings.some((f) => f.label === 'Fragile at TE')).toBe(true);
    expect(read.score).toBeGreaterThan(0);
  });

  it('flags a shared bye that is still ahead, and ignores one already past', () => {
    const ahead = fragilityOf(deep, {
      byeWeeks: new Map([
        ['wr1', 9],
        ['te1', 9],
      ]),
      currentWeek: 5,
    });
    const past = fragilityOf(deep, {
      byeWeeks: new Map([
        ['wr1', 3],
        ['te1', 3],
      ]),
      currentWeek: 5,
    });
    expect(ahead.findings.some((f) => f.kind === 'shared_bye')).toBe(true);
    expect(past.findings.some((f) => f.kind === 'shared_bye')).toBe(false);
  });

  it('flags a lineup with no late window at all', () => {
    const allEarly = deep.map((p) => ({ ...p, kickoff: EARLY }));
    const read = fragilityOf(allEarly);
    expect(read.findings.some((f) => f.kind === 'early_lock')).toBe(true);
  });

  it('names the late-game insurance problem when a questionable starter has no cover in time', () => {
    const exposed = [
      candidate('qb1', 'A Quarterback', 'QB', 18, { kickoff: LATE }),
      candidate('qb2', 'Backup Quarterback', 'QB', 15, { kickoff: LATE }),
      questionable(candidate('wr1', 'First Receiver', 'WR', 14, { kickoff: LATE })),
      candidate('wr2', 'Second Receiver', 'WR', 13, { kickoff: EARLY }),
      candidate('wr3', 'Third Receiver', 'WR', 12, { kickoff: EARLY }),
      candidate('te1', 'A Tight End', 'TE', 10, { kickoff: EARLY }),
      candidate('te2', 'Backup Tight End', 'TE', 9, { kickoff: EARLY }),
    ];
    const read = fragilityOf(exposed);
    expect(read.findings.some((f) => f.kind === 'questionable_late')).toBe(true);
    expect(read.headline).toBeTruthy();
  });

  it('is bounded, and never moves a projection', () => {
    const disaster = [
      candidate('qb1', 'A Quarterback', 'QB', 18, { kickoff: EARLY }),
      candidate('wr1', 'First Receiver', 'WR', 14, { kickoff: EARLY }),
      questionable(candidate('wr2', 'Second Receiver', 'WR', 13, { kickoff: EARLY })),
      candidate('te1', 'A Tight End', 'TE', 10, { kickoff: EARLY }),
    ];
    const read = fragilityOf(disaster, {
      byeWeeks: new Map([
        ['qb1', 9],
        ['wr1', 9],
      ]),
      currentWeek: 5,
    });
    expect(read.score).toBeLessThanOrEqual(100);
    expect(read.band).toBe('brittle');
    expect(read.projectionEffect).toBe(0);

    // The same players score the same whether the roster is brittle or not.
    const alone = evaluatePlayer({ ...disaster[1]!, now: NOW }, HALF_PPR).score;
    const inDeepRoster = evaluatePlayer({ ...deep[2]!, now: NOW }, HALF_PPR).score;
    expect(alone).toBe(inDeepRoster);
  });
});

const STABLE_ROLE = { trend: 'stable', label: 'Role stable', detail: '', metrics: [], games: 8 } as RoleAssessment;

describe('bench optionality', () => {
  const window = { firstKickoff: EARLY, lastKickoff: LATE };

  it('prefers a player who covers more slots', () => {
    const flexible = assessOptionality(
      { playerId: 'a', name: 'Flexible', position: 'WR', kickoff: LATE, role: STABLE_ROLE, playableAtPosition: 4, slotsAtPosition: 2 },
      SHAPE,
      window,
    );
    const narrow = assessOptionality(
      { playerId: 'b', name: 'Narrow', position: 'QB', kickoff: LATE, role: STABLE_ROLE, playableAtPosition: 3, slotsAtPosition: 1 },
      SHAPE,
      window,
    );
    expect(flexible.eligibleSlots).toContain('FLEX');
    expect(flexible.score).toBeGreaterThan(narrow.score);
  });

  it('prefers a player who plays later', () => {
    const late = assessOptionality(
      { playerId: 'a', name: 'Late', position: 'WR', kickoff: LATE, role: STABLE_ROLE, playableAtPosition: 4, slotsAtPosition: 2 },
      SHAPE,
      window,
    );
    const early = assessOptionality(
      { playerId: 'b', name: 'Early', position: 'WR', kickoff: EARLY, role: STABLE_ROLE, playableAtPosition: 4, slotsAtPosition: 2 },
      SHAPE,
      window,
    );
    expect(late.score).toBeGreaterThan(early.score);
    expect(late.reasons.join(' ')).toMatch(/plays late/);
  });

  it('discounts a cover whose own role is disappearing', () => {
    const falling = assessOptionality(
      {
        playerId: 'a',
        name: 'Falling',
        position: 'WR',
        kickoff: LATE,
        role: { ...STABLE_ROLE, trend: 'falling_high', label: 'Role falling — high confidence' },
        playableAtPosition: 4,
        slotsAtPosition: 2,
      },
      SHAPE,
      window,
    );
    const steady = assessOptionality(
      { playerId: 'b', name: 'Steady', position: 'WR', kickoff: LATE, role: STABLE_ROLE, playableAtPosition: 4, slotsAtPosition: 2 },
      SHAPE,
      window,
    );
    expect(falling.score).toBeLessThan(steady.score);
  });

  it('values the only other player at a thin position', () => {
    const scarce = assessOptionality(
      { playerId: 'a', name: 'Only Other TE', position: 'TE', kickoff: LATE, role: STABLE_ROLE, playableAtPosition: 2, slotsAtPosition: 1 },
      SHAPE,
      window,
    );
    expect(scarce.reasons.join(' ')).toMatch(/few playable TEs/);
  });

  it('has no points field at all, which is the guard', () => {
    const read = assessOptionality(
      { playerId: 'a', name: 'Anyone', position: 'WR', kickoff: LATE, role: STABLE_ROLE, playableAtPosition: 4, slotsAtPosition: 2 },
      SHAPE,
      window,
    );
    expect('points' in read).toBe(false);
    expect(read.score).toBeLessThanOrEqual(100);
    expect(Object.values(OPTIONALITY.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('streaming intelligence', () => {
  const shape = SHAPE;

  it('says hold when the rostered player is clear of the wire', () => {
    const read = assessStreaming({
      position: 'QB',
      roster: [candidate('qb1', 'An Elite QB', 'QB', 24, { kickoff: LATE })],
      available: [
        candidate('fa1', 'Wire QB One', 'QB', 16, { kickoff: LATE }),
        candidate('fa2', 'Wire QB Two', 'QB', 15, { kickoff: LATE }),
        candidate('fa3', 'Wire QB Three', 'QB', 14, { kickoff: LATE }),
      ],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(read.verdict).toBe('hold');
    expect(read.detail).toMatch(/worth the roster spot/i);
  });

  it('says streamable when the wire is as good as what is rostered', () => {
    const read = assessStreaming({
      position: 'QB',
      roster: [candidate('qb1', 'A Mediocre QB', 'QB', 17, { kickoff: LATE })],
      available: [
        candidate('fa1', 'Wire QB One', 'QB', 16.5, { kickoff: LATE }),
        candidate('fa2', 'Wire QB Two', 'QB', 16, { kickoff: LATE }),
        candidate('fa3', 'Wire QB Three', 'QB', 15.5, { kickoff: LATE }),
      ],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(read.verdict).toBe('streamable');
    expect(read.replacementLevel!).toBeGreaterThan(0);
    expect(read.options).toHaveLength(STREAMING.poolDepth);
  });

  it('names an outright upgrade when the wire is better', () => {
    const read = assessStreaming({
      position: 'TE',
      roster: [candidate('te1', 'A Bad TE', 'TE', 6, { kickoff: LATE })],
      available: [candidate('fa1', 'Wire TE', 'TE', 12, { kickoff: LATE })],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(read.verdict).toBe('upgrade_available');
    expect(read.options[0]!.edge!).toBeGreaterThan(0);
  });

  it('declines at a position the league starts several of', () => {
    const read = assessStreaming({
      position: 'WR',
      roster: [candidate('wr1', 'A Receiver', 'WR', 12, { kickoff: LATE })],
      available: [candidate('fa1', 'Wire WR', 'WR', 11, { kickoff: LATE })],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(read.verdict).toBe('unknown');
    expect(read.notes.join(' ')).toMatch(/not a streaming position/);
  });

  it('holds rather than guessing when nobody available can be scored', () => {
    const read = assessStreaming({
      position: 'QB',
      roster: [candidate('qb1', 'A Quarterback', 'QB', 18, { kickoff: LATE })],
      available: [candidate('fa1', 'Unpriced', 'QB', null, { kickoff: LATE })],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(read.verdict).toBe('hold');
    expect(read.notes.join(' ')).toMatch(/empty or unscorable/);
  });

  it('uses the median of the pool, not its best week', () => {
    const read = assessStreaming({
      position: 'QB',
      roster: [candidate('qb1', 'A Quarterback', 'QB', 18, { kickoff: LATE })],
      available: [
        candidate('fa1', 'One Good Matchup', 'QB', 17.5, { kickoff: LATE }),
        candidate('fa2', 'Ordinary', 'QB', 12, { kickoff: LATE }),
        candidate('fa3', 'Ordinary Too', 'QB', 11.5, { kickoff: LATE }),
      ],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    // The wire's best is close; the wire itself is not.
    expect(read.replacementLevel!).toBeLessThan(read.options[0]!.score!);
    expect(read.verdict).toBe('hold');
  });

  it('never recommends dropping anybody', () => {
    const read = assessStreaming({
      position: 'TE',
      roster: [candidate('te1', 'A Bad TE', 'TE', 6, { kickoff: LATE })],
      available: [candidate('fa1', 'Wire TE', 'TE', 12, { kickoff: LATE })],
      shape,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(`${read.detail} ${read.notes.join(' ')}`.toLowerCase()).not.toMatch(/\bdrop\b/);
  });
});
