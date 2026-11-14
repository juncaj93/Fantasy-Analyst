/**
 * Round 26: smarter Waivers that look ahead, behind `WAIVERS_LOOKAHEAD`.
 *
 *  A. Opportunity: a free agent who inherits a starter's role (out for the
 *     season, on IR, traded, benched) shows on the stash line.
 *  B. Look-ahead: holes in Alex's next three weeks, covered before the week.
 *  C. Block: the opponent's need in his own terms, only when it costs Alex
 *     nothing he needs more.
 *  Caps: three lines at most, a block $3 at most, the $20 playoff reserve.
 *
 * Every describe here fails on the code before Round 26: the functions, the
 * opportunity path, the cover line and the named block did not exist.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { findOpportunities, opportunityReason, OPPORTUNITY, type OpportunityInput, type OpportunityPlayer } from '../src/core/waivers/opportunity.ts';
import { coverPickups, coverReason, LOOK_AHEAD, rosterHoles, type AheadCandidate, type AheadPlayer, type CoverRequest } from '../src/core/waivers/lookAhead.ts';
import { blockPickup, type BlockCandidate, type BlockPlayer, type BlockRequest } from '../src/core/waivers/block.ts';
import { upsideStash, type StashCandidate, type StashPlayer, type UpsideStashRequest } from '../src/core/waivers/upsideStash.ts';
import { assembleWaiverPlan, LOOK_AHEAD_LINES } from '../src/core/waivers/assemble.ts';
import { wirePool } from '../src/core/roster/wirePool.ts';
import { playerNotesOf, readPlayerNotes, MOVED_DAYS } from '../src/core/sleeper/playerNotes.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import { extraLine, extraTitle, roomLine } from '../src/web/waiverCard.ts';
import { captureDemoWaivers, DEMO_WAIVER_CLOCK, type CapturedWaivers } from './helpers/waiverDecision.ts';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import type { SupportSnapshot } from '../src/core/support/schema.ts';
import type { WaiverPlanPayload } from '../src/core/support/payloads.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench, 2 IR. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'IR', 'IR']);
const DEF = new Set(['DEF']);

// ------------------------------------------------------------------ A. Opportunity

/** Nine weeks of points: a starter scoring `rate` in every game, a backup `own`. */
const weeks = (rate: number, played = 9) => Array.from({ length: 9 }, (_, i) => (i < played ? rate : 0));

function player(id: string, fullName: string, team: string, position: string, over: Partial<OpportunityPlayer> = {}): OpportunityPlayer {
  return { id, fullName, lastName: fullName.split(' ').slice(-1)[0], team, position, active: true, ...over };
}

function oppInput(over: Partial<OpportunityInput> = {}): OpportunityInput {
  return {
    week: 10,
    players: [
      player('chase', 'Jamar Chase', 'CIN', 'WR'),
      player('wr2', 'Second Receiver', 'CIN', 'WR'),
      player('wr3', 'Third Receiver', 'CIN', 'WR'),
    ],
    rosteredIds: new Set(['chase']),
    depthOrder: new Map([
      ['chase', 1],
      ['wr2', 2],
      ['wr3', 3],
    ]),
    injuryNotes: new Map([['chase', { status: 'IR', bodyPart: 'Knee - ACL', notes: 'Surgery' }]]),
    seasonPoints: new Map([
      ['chase', weeks(18, 9)],
      ['wr2', weeks(6)],
      ['wr3', weeks(3)],
    ]),
    through: 9,
    ...over,
  };
}

describe('A. Opportunity: a free agent who inherits a starter’s role', () => {
  it('gives the next man in line the starter’s share when the starter is out for the season', () => {
    const [lead] = findOpportunities(oppInput());
    expect(lead).toMatchObject({ playerId: 'wr2', basis: 'inferred', reason: 'Chase out for the season, gets his targets' });
    /* His own 6 a game plus the next man's share of Chase's 18. */
    expect(lead!.estimate).toBeCloseTo(6 + OPPORTUNITY.nextShare * 18, 2);
  });

  it('names nobody when the backup is already on a roster', () => {
    expect(findOpportunities(oppInput({ rosteredIds: new Set(['chase', 'wr2', 'wr3']) }))).toEqual([]);
  });

  it('skips a rostered backup and offers the man after him at the smaller share', () => {
    const leads = findOpportunities(oppInput({ rosteredIds: new Set(['chase', 'wr2']) }));
    expect(leads.map((l) => l.playerId)).toEqual(['wr3']);
    expect(leads[0]!.estimate).toBeCloseTo(3 + OPPORTUNITY.secondShare * 18, 2);
  });

  it('measures the backup in the games his club already played without the starter', () => {
    const lead = findOpportunities(
      oppInput({
        /* Chase missed weeks 8 and 9; the backup scored 14 a game in them, 6 with Chase. */
        seasonPoints: new Map([
          ['chase', [18, 18, 18, 18, 18, 18, 18, 0, 0]],
          ['wr2', [6, 6, 6, 6, 6, 6, 6, 14, 14]],
          ['wr3', weeks(3)],
        ]),
      }),
    )[0];
    expect(lead).toMatchObject({ playerId: 'wr2', basis: 'measured', estimate: 14 });
  });

  it('reads a starter traded away as an open role on his old club', () => {
    const lead = findOpportunities(
      oppInput({
        players: [player('chase', 'Jamar Chase', 'HOU', 'WR'), player('wr2', 'Second Receiver', 'CIN', 'WR')],
        injuryNotes: new Map(),
        moved: new Map([['chase', { from: 'CIN', to: 'HOU' }]]),
      }),
    )[0];
    expect(lead).toMatchObject({ playerId: 'wr2', reason: 'Chase traded, gets his targets', vacancy: { cause: 'traded', team: 'CIN' } });
  });

  it('reads a healthy starter listed behind a weaker teammate as benched', () => {
    const lead = findOpportunities(
      oppInput({
        players: [player('vet', 'Old Back', 'NYJ', 'RB'), player('kid', 'New Back', 'NYJ', 'RB')],
        rosteredIds: new Set(['vet']),
        injuryNotes: new Map(),
        depthOrder: new Map([
          ['kid', 1],
          ['vet', 2],
        ]),
        seasonPoints: new Map([
          ['vet', weeks(13)],
          ['kid', weeks(4)],
        ]),
      }),
    )[0];
    expect(lead).toMatchObject({ playerId: 'kid', reason: 'Back benched, gets his carries', vacancy: { cause: 'benched' } });
  });

  it('never treats a one-week Out or a starter under the bar as an open role', () => {
    expect(findOpportunities(oppInput({ injuryNotes: new Map([['chase', { status: 'Out', bodyPart: 'Ankle', notes: null }]]) }))).toEqual([]);
    expect(findOpportunities(oppInput({ seasonPoints: new Map([['chase', weeks(7)], ['wr2', weeks(6)], ['wr3', weeks(3)]]) }))).toEqual([]);
  });

  it('never names a backup who is hurt himself or has sat out his club’s last two games', () => {
    const hurt = oppInput({
      injuryNotes: new Map([
        ['chase', { status: 'IR', bodyPart: 'Knee - ACL', notes: null }],
        ['wr2', { status: 'Out', bodyPart: 'Hamstring', notes: null }],
      ]),
    });
    expect(findOpportunities(hurt).map((l) => l.playerId)).toEqual(['wr3']);
    const sitting = oppInput({
      seasonPoints: new Map([
        ['chase', weeks(18)],
        ['wr2', [6, 6, 6, 6, 6, 6, 6, 0, 0]],
        ['wr3', weeks(3)],
      ]),
    });
    expect(findOpportunities(sitting).map((l) => l.playerId)).toEqual(['wr3']);
  });

  it('never offers a quarterback who already has the job', () => {
    const lead = findOpportunities(
      oppInput({
        players: [player('qb1', 'Hurt Passer', 'NYG', 'QB'), player('qb2', 'Busy Passer', 'NYG', 'QB')],
        rosteredIds: new Set(['qb1']),
        injuryNotes: new Map([['qb1', { status: 'IR', bodyPart: null, notes: null }]]),
        depthOrder: new Map(),
        seasonPoints: new Map([
          ['qb1', weeks(20)],
          ['qb2', weeks(16)],
        ]),
      }),
    );
    expect(lead).toEqual([]);
  });

  describe('a teammate who already took over the role leaves no Opportunity line (Hurts and Milton)', () => {
    /* Hurts started weeks 1 to 5 and went on IR; Philadelphia played weeks 6 to 9 without him. */
    const phi = (qb2: number[]) =>
      oppInput({
        players: [
          player('hurts', 'Jalen Hurts', 'PHI', 'QB'),
          player('milton', 'Joe Milton', 'PHI', 'QB'),
          player('mckee', 'Tanner McKee', 'PHI', 'QB'),
          player('aj', 'Philly Receiver', 'PHI', 'WR'),
          player('dg', 'Philly Back', 'PHI', 'RB'),
        ],
        rosteredIds: new Set(['hurts', 'mckee', 'aj', 'dg']),
        injuryNotes: new Map([['hurts', { status: 'IR', bodyPart: 'Knee', notes: null }]]),
        depthOrder: new Map([['milton', 1]]),
        seasonPoints: new Map([
          ['hurts', [24, 22, 26, 25, 23, 0, 0, 0, 0]],
          ['milton', weeks(0)],
          ['mckee', qb2],
          ['aj', weeks(12)],
          ['dg', weeks(10)],
        ]),
      });

    it('offers Milton nothing when McKee has started since Week 6', () => {
      expect(findOpportunities(phi([0, 0, 0, 0, 0, 14.6, 12.5, 13.1, 12.0]))).toEqual([]);
    });

    it('still offers Milton when no quarterback has taken the job', () => {
      expect(findOpportunities(phi(weeks(0))).map((l) => l.playerId)).toEqual(['milton']);
    });

    it('offers nothing on the real Eagles weeks: McKee started 6 to 8, Milton started Week 9, bye in Week 10', () => {
      /* The season row as production holds it (13 November): Hurts last played Week 5. */
      const real = phi([0, 0, 0, 0, 0, 14.6, 12.5, 7, 0]);
      real.seasonPoints = new Map([...real.seasonPoints, ['hurts', [30.7, 20.2, 12.6, 17.5, 15, 0, 0, 0, 0]], ['milton', [0, 0, 0, 0, 0, 0, 0, 0, 13.2]]]);
      real.rosteredIds = new Set(['hurts', 'aj', 'dg']);
      expect(findOpportunities(real)).toEqual([]);
    });

    it('judges a backup who already played in the role on those games only', () => {
      /* Milton alone, 13.2 in Week 9: never 13.2 plus a share of Hurts's points. */
      const solo = phi(weeks(0));
      solo.seasonPoints = new Map([...solo.seasonPoints, ['milton', [0, 0, 0, 0, 0, 0, 0, 0, 13.2]]]);
      expect(findOpportunities(solo)).toEqual([]);
    });

    it('reads only the latest four games without him', () => {
      /* McKee started weeks 3 and 4 in a short absence earlier, not since Hurts went down: the role is open. */
      const old = phi([0, 0, 15, 14, 0, 0, 0, 0, 0]);
      expect(findOpportunities(old).map((l) => l.playerId)).toEqual(['milton']);
    });
  });

  it('words the role by position', () => {
    expect(opportunityReason({ name: 'Bijan Robinson', position: 'RB', cause: 'ir' })).toBe('Robinson on IR, gets his carries');
    expect(opportunityReason({ name: 'Joe Burrow', position: 'QB', cause: 'long' })).toBe('Burrow out for weeks, gets his snaps');
  });

  it('scans the lead with the switch on and leaves the scan as it was with it off', () => {
    const players = [
      ...['chase', 'wr2', 'wr3'].map((id, i) => ({
        id,
        sleeperPlayerId: id,
        fullName: ['Jamar Chase', 'Second Receiver', 'Third Receiver'][i]!,
        firstName: '',
        lastName: '',
        team: 'CIN',
        position: 'WR',
        status: null,
        active: true,
        normalizedName: id,
        aliases: [],
      })),
    ] as CanonicalPlayer[];
    const base = {
      players,
      rosteredIds: new Set(['chase']),
      startable: new Set(['WR']),
      ranks: new Map(),
      leagueDrops: [],
      published: null,
      trending: new Map(),
      season: {
        points: { chase: weeks(18), wr2: weeks(6), wr3: weeks(3) },
        through: 9,
        depthOrder: { chase: 1, wr2: 2, wr3: 3 },
        injuryStatus: { chase: 'IR' },
      },
    };
    const off = wirePool(base);
    const on = wirePool({ ...base, opportunity: { week: 10, injuryNotes: { chase: { status: 'IR', bodyPart: 'Knee - ACL', notes: null } } } });
    expect(on.ids).toContain('wr2');
    /* Replacement levels never move: the inherited role stays out of the season pool. */
    expect(on.seasonPool).toEqual(off.seasonPool);
  });
});

// ------------------------------------------------------------------ A. on the stash line

function mine(id: string, position: string, seasonRate: number): StashPlayer {
  return { playerId: `my-${id}`, name: `My ${id}`, position, team: 'GB', seasonRate, designation: 'healthy' };
}
const ROSTER: StashPlayer[] = [
  mine('qb', 'QB', 22),
  mine('rb1', 'RB', 16),
  mine('rb2', 'RB', 12),
  mine('wr1', 'WR', 15),
  mine('wr2', 'WR', 13),
  mine('wr3', 'WR', 11),
  mine('te', 'TE', 8),
  mine('flex1', 'RB', 10),
  mine('flex2', 'WR', 9),
  mine('bench1', 'WR', 6),
];

function stashRequest(over: Partial<UpsideStashRequest> = {}): UpsideStashRequest {
  return {
    shape: SHAPE,
    roster: ROSTER,
    candidates: [],
    taken: new Set(),
    excludedPositions: DEF,
    verdicts: new Map(),
    reserveTakes: (d) => d === 'ir',
    room: { reserve: 0, open: 0, dropReady: [{ playerId: 'my-bench1', name: 'Antonio Williams' }] },
    players: [],
    depthOrder: new Map(),
    injuryStatus: new Map(),
    elite: new Map(),
    spendable: 28,
    usesFaab: true,
    ...over,
  };
}
const cand = (id: string, seasonRate: number, over: Partial<StashCandidate> = {}): StashCandidate => ({
  playerId: id,
  name: `Free ${id}`,
  position: 'WR',
  team: 'CIN',
  seasonRate,
  designation: 'healthy',
  free: false,
  helpsNow: false,
  ...over,
});

describe('A. the Opportunity pick shows in the stash category', () => {
  const lead = findOpportunities(oppInput())[0]!;

  it('stashes the backup who inherits a role worth a start, with the role as the reason', () => {
    const line = upsideStash(stashRequest({ candidates: [cand('wr2', 6, { helpsNow: true })], opportunities: new Map([['wr2', lead]]) }));
    expect(line).toMatchObject({ playerId: 'wr2', reason: 'Chase out for the season, gets his targets', path: { kind: 'opportunity', starterId: 'chase' } });
    /* Still a stash: the Round 20 stash bid, $1 at most. */
    expect(line!.bid).toEqual({ kind: 'claim', low: 1, high: 1 });
  });

  it('bids $0 to $1 and never into the $20 playoff reserve', () => {
    for (const spendable of [0, 1, 28, 80]) {
      const line = upsideStash(stashRequest({ candidates: [cand('wr2', 6)], opportunities: new Map([['wr2', lead]]), spendable }));
      expect(line!.bid.kind).toBe('claim');
      if (line!.bid.kind === 'claim') {
        expect(line!.bid.high).toBeLessThanOrEqual(1);
        expect(line!.bid.high).toBeLessThanOrEqual(spendable);
      }
    }
  });

  it('shows one Opportunity line a week, the strongest role', () => {
    const second = { ...lead, playerId: 'wr3', name: 'Third Receiver', estimate: lead.estimate - 2 };
    const line = upsideStash(
      stashRequest({
        candidates: [cand('wr3', 3), cand('wr2', 6)],
        opportunities: new Map([
          ['wr2', lead],
          ['wr3', second],
        ]),
      }),
    );
    expect(line?.playerId).toBe('wr2');
    /* The function returns one line or none: one stash a week. */
    expect(Array.isArray(line)).toBe(false);
  });

  it('never stashes a role that would not start for you', () => {
    const small = { ...lead, estimate: 7 };
    expect(upsideStash(stashRequest({ candidates: [cand('wr2', 6)], opportunities: new Map([['wr2', small]]) }))).toBeNull();
  });

  it('comes before a return-from-injury stash', () => {
    const line = upsideStash(
      stashRequest({
        candidates: [cand('back', 14, { designation: 'ir' }), cand('wr2', 6)],
        verdicts: new Map([['back', { kind: 'back_by', week: 13, label: 'back around week 13' }]]),
        opportunities: new Map([['wr2', lead]]),
      }),
    );
    expect(line?.playerId).toBe('wr2');
  });

  it('leaves the stash exactly as before with the switch off (no opportunities)', () => {
    expect(upsideStash(stashRequest({ candidates: [cand('wr2', 6, { helpsNow: true })] }))).toBeNull();
  });
});

// ------------------------------------------------------------------ B. Look-ahead

/** Alex for weeks 11, 12, 13: one TE, on bye in week 12; a deep bench elsewhere. */
function me(id: string, position: string, rate: number, weekly: number[] = [1, 1, 1], byeWeek: number | null = null): AheadPlayer {
  return { playerId: id, name: `My ${id}`, position, team: 'GB', rate, weekly, byeWeek };
}
const MY_WEEKS = [11, 12, 13];
const MY_ROSTER: AheadPlayer[] = [
  me('qb', 'QB', 21),
  me('rb1', 'RB', 16),
  me('rb2', 'RB', 13),
  me('rb3', 'RB', 11),
  me('wr1', 'WR', 15),
  me('wr2', 'WR', 13),
  me('wr3', 'WR', 12),
  me('wr4', 'WR', 10),
  me('te', 'TE', 9, [1, 0, 1], 12),
];
function free(id: string, position: string, rate: number, over: Partial<AheadCandidate> = {}): AheadCandidate {
  return { playerId: id, name: `Free ${id}`, position, team: 'MIA', rate, weekly: [1, 1, 1], byeWeek: null, ...over };
}
function coverRequest(over: Partial<CoverRequest> = {}): CoverRequest {
  return {
    shape: SHAPE,
    roster: MY_ROSTER,
    weeks: MY_WEEKS,
    excludedPositions: DEF,
    candidates: [free('te1', 'TE', 7)],
    leadWeeks: 1,
    taken: new Set(),
    covered: new Set(),
    room: [{ kind: 'drop', playerId: 'wr4', name: 'Antonio Williams' }],
    spendable: 28,
    usesFaab: true,
    ...over,
  };
}

describe('B. Look-ahead: holes in the next three weeks, covered before the week', () => {
  it('finds the week-12 TE bye the bench cannot cover', () => {
    const holes = rosterHoles({ shape: SHAPE, roster: MY_ROSTER, weeks: MY_WEEKS, excludedPositions: DEF });
    expect(holes).toEqual([expect.objectContaining({ week: 12, position: 'TE', cause: 'bye', missing: { playerId: 'te', name: 'My te' } })]);
  });

  it('covers the bye when the wire at TE is thin, with the week in the reason', () => {
    const [line] = coverPickups(coverRequest());
    expect(line).toMatchObject({ playerId: 'te1', week: 12, reason: 'covers your Week 12 bye at TE', room: { kind: 'drop', playerId: 'wr4' } });
  });

  it('waits for the week’s own run when many free agents could cover a later week', () => {
    const deep = [free('te1', 'TE', 7), free('te2', 'TE', 6.5), free('te3', 'TE', 6)];
    expect(coverPickups(coverRequest({ candidates: deep }))).toEqual([]);
    /* ...but a hole in the week the next run reaches is covered now. */
    expect(coverPickups(coverRequest({ candidates: deep, leadWeeks: 2 }))).toHaveLength(1);
  });

  it('covers a returning injury only for the weeks he is still out', () => {
    const roster = MY_ROSTER.map((p) => (p.playerId === 'te' ? me('te', 'TE', 9, [0, 1, 1]) : p));
    const [line] = coverPickups(coverRequest({ roster }));
    expect(line).toMatchObject({ week: 11, reason: 'covers Week 11 at TE, te out' });
  });

  it('offers nothing when the bench already fills the hole (no pickup for a hole he already fills)', () => {
    const roster = [...MY_ROSTER, me('te2', 'TE', 8)];
    expect(rosterHoles({ shape: SHAPE, roster, weeks: MY_WEEKS, excludedPositions: DEF })).toEqual([]);
    expect(coverPickups(coverRequest({ roster }))).toEqual([]);
  });

  it('offers nothing for a hole a move already on screen fills', () => {
    expect(coverPickups(coverRequest({ covered: new Set(['12:TE']) }))).toEqual([]);
  });

  it('never bids into the $20 playoff reserve', () => {
    const [line] = coverPickups(coverRequest({ spendable: 0 }));
    expect(line?.bid).toEqual({ kind: 'claim', low: 0, high: 0 });
    for (const spendable of [1, 3, 28]) {
      const [l] = coverPickups(coverRequest({ spendable }));
      if (l?.bid.kind === 'claim') expect(l.bid.high).toBeLessThanOrEqual(spendable);
    }
  });

  it('needs a spot: no room, no cover', () => {
    expect(coverPickups(coverRequest({ room: [] }))).toEqual([]);
  });

  it('says it the way Alex reads it', () => {
    expect(coverReason({ week: 12, position: 'TE', cause: 'bye', missing: { playerId: 'x', name: 'Sam LaPorta' } })).toBe('covers your Week 12 bye at TE');
    expect(coverReason({ week: 11, position: 'RB', cause: 'injury', missing: { playerId: 'x', name: 'Breece Hall' } })).toBe('covers Week 11 at RB, Hall out');
    const line = coverPickups(coverRequest())[0]!;
    expect(extraLine('cover', line)).toMatch(/^Add: Free te1 \(covers your Week 12 bye at TE\), bid \$\d+$/);
    expect(roomLine(line.room)).toBe('Drop Antonio Williams (drop-ready)');
    expect(extraTitle(['stash', 'cover', 'block'])).toBe('Cover, stash and block');
    expect(extraTitle(['stash', 'block'])).toBe('Stash and block');
  });
});

// ------------------------------------------------------------------ C. Block

function opp(id: string, position: string, points: number, over: Partial<BlockPlayer> = {}): BlockPlayer {
  return { playerId: id, name: `Their ${id}`, position, team: 'KC', points, designation: 'healthy', onBye: false, ...over };
}
const OPP: BlockPlayer[] = [
  opp('qb', 'QB', 19),
  opp('rb1', 'RB', 15),
  opp('rb2', 'RB', 13),
  opp('wr1', 'WR', 16),
  opp('wr2', 'WR', 14),
  opp('wr3', 'WR', 12),
  opp('te', 'TE', 9),
  opp('flex1', 'WR', 11),
  opp('flex2', 'RB', 10.5),
  opp('bench-wr', 'WR', 6),
];
const blockFa = (id: string, position: string, points: number): BlockCandidate => ({
  playerId: id,
  name: `Free ${id}`,
  position,
  team: 'DET',
  points,
  designation: 'healthy',
  onBye: false,
  addable: true,
  free: false,
});
function blockRequest(over: Partial<BlockRequest> = {}): BlockRequest {
  return {
    shape: SHAPE,
    opponent: { rosterId: 7, roster: OPP },
    candidates: [blockFa('te9', 'TE', 8)],
    taken: new Set(),
    excludedPositions: DEF,
    room: [{ kind: 'open' }],
    spendable: 28,
    usesFaab: true,
    named: { opponentName: 'Matty' },
    ...over,
  };
}

describe('C. Block: the opponent’s need in his own terms', () => {
  it('says "Matty has no TE this week" when his only TE is on bye', () => {
    const roster = OPP.map((p) => (p.playerId === 'te' ? { ...p, onBye: true } : p));
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster } }))?.reason).toBe('Matty has no TE this week');
  });

  it('says "Matty is thin at WR" when the free agent beats a weak starter by the toss-up bar', () => {
    const roster = OPP.map((p) => (p.playerId === 'wr3' ? { ...p, points: 5 } : p.playerId === 'flex1' ? { ...p, points: 4 } : p));
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, candidates: [blockFa('wr9', 'WR', 12)] }))?.reason).toBe('Matty is thin at WR');
  });

  it('blocks nothing when he has no hole or thin slot', () => {
    expect(blockPickup(blockRequest())).toBeNull();
  });

  it('costs Alex nothing he needs: no spot left, no block; never above $3', () => {
    const roster = OPP.map((p) => (p.playerId === 'te' ? { ...p, onBye: true } : p));
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, room: [] }))).toBeNull();
    const line = blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, spendable: 50 }))!;
    if (line.bid.kind === 'claim') expect(line.bid.high).toBeLessThanOrEqual(3);
    /* Nothing left above the reserve: no block. */
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, spendable: 0 }))).toBeNull();
  });

  it('keeps today’s words with the switch off', () => {
    const roster = OPP.map((p) => (p.playerId === 'te' ? { ...p, onBye: true } : p));
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, named: null }))?.reason).toBe('opponent needs a TE');
  });
});

// ------------------------------------------------------------------ trades on record

describe('the daily player sync records a club move', () => {
  const raw = (team: string) => ({ chase: { position: 'WR', team, depth_chart_order: 1 } });

  it('sees a club change against the last row and keeps it about six weeks', () => {
    const day1 = playerNotesOf(raw('CIN'), new Date('2026-11-01T09:00:00Z'));
    expect(readPlayerNotes(day1).moved).toEqual({});
    const day2 = playerNotesOf(raw('HOU'), new Date('2026-11-02T09:00:00Z'), day1);
    expect(readPlayerNotes(day2).moved).toEqual({ chase: { from: 'CIN', to: 'HOU' } });
    const later = playerNotesOf(raw('HOU'), new Date(Date.parse('2026-11-02T09:00:00Z') + (MOVED_DAYS + 1) * 86_400_000), day2);
    expect(readPlayerNotes(later).moved).toEqual({});
  });
});

// ------------------------------------------------------------------ caps, through the assembly

describe('caps through the assembly: three lines at most, the switch decides', () => {
  let captured: CapturedWaivers;
  beforeAll(async () => {
    captured = await captureDemoWaivers();
  });

  async function replay(lookahead: boolean) {
    const { request } = waiverRequestFromSnapshot(captured.snapshot as unknown as SupportSnapshot<WaiverPlanPayload>);
    const rival = request.rosters.find((r) => !r.isMine)!;
    const byName = new Map(request.players.map((p) => [p.fullName, p.id] as const));
    const published = new Map<string, number>([
      [rival.playerIds[0]!, 15],
      [byName.get('Kai Brennan')!, 11],
      [byName.get('Dane Petrossian')!, 9],
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(DEMO_WAIVER_CLOCK));
    try {
      return (
        await assembleWaiverPlan({
          ...request,
          published,
          opponent: { rosterId: rival.rosterId, designations: { [rival.playerIds[0]!]: 'out' } },
          lookahead,
        })
      ).tiers!;
    } finally {
      vi.useRealTimers();
    }
  }

  it('with the switch off, the block reads as before and no cover line is sent', async () => {
    const tiers = await replay(false);
    expect(tiers.block?.reason).toBe('opponent needs a WR');
    expect(tiers.cover).toBeUndefined();
  });

  it('with it on, the block names the opponent, and stash, cover and block together are three at most', async () => {
    const tiers = await replay(true);
    expect(tiers.block?.reason).toMatch(/ (has no|is thin at) WR( this week)?$/);
    const lines = (tiers.upsideStash ? 1 : 0) + (tiers.cover?.length ?? 0) + (tiers.block ? 1 : 0);
    expect(lines).toBeLessThanOrEqual(LOOK_AHEAD_LINES);
    expect(LOOK_AHEAD.maxCovers).toBeLessThanOrEqual(LOOK_AHEAD_LINES);
    /* One player, one line. */
    const ids = [tiers.upsideStash?.playerId, tiers.block?.playerId, ...(tiers.cover ?? []).map((c) => c.playerId)].filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
