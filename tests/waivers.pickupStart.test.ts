/**
 * "Pick up and start": a free agent tested through the whole lineup, not one
 * slot. Built on Alex's real week 7 roster (18 October 2026). See
 * `core/waivers/pickupStart.ts` and the tiers' `startNow`.
 */

import { describe, expect, it } from 'vitest';
import { PICKUP_START, planPickupStart, starterOutReader, type PickupPlayer, type PickupStartRequest } from '../src/core/waivers/pickupStart.ts';
import { planWaiverTiers, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);

function p(name: string, position: string, points: number | null, over: Partial<PickupPlayer> = {}): PickupPlayer {
  return {
    playerId: name,
    name,
    position,
    team: 'XX',
    points,
    basis: points == null ? 'none' : 'market',
    ruledOut: false,
    locked: false,
    designation: 'healthy',
    ...over,
  };
}

/* Alex's roster and Sleeper lineup on Sunday of week 7, at the Team screen's numbers. */
const STARTERS = ['Love', 'Bijan', 'Allen', 'Collins', 'Wilson', 'Egbuka', 'Higbee', 'Pickens', 'Walker', 'KC'];
function roster(withMcConkey = true): PickupPlayer[] {
  return [
    p('Love', 'QB', 20.4),
    p('Bijan', 'RB', 19.2),
    p('Allen', 'RB', 12.1),
    p('Collins', 'WR', 12.8),
    p('Wilson', 'WR', 13.0),
    p('Egbuka', 'WR', 6.7),
    p('Higbee', 'TE', 6.4),
    p('Pickens', 'WR', 12.8),
    p('Walker', 'RB', 17.5),
    p('KC', 'DEF', 9.9),
    ...(withMcConkey ? [p('McConkey', 'WR', 7.6)] : []),
  ];
}

const FREE = { state: 'free' as const, reason: null, until: null };

function request(candidates: PickupPlayer[], over: Partial<PickupStartRequest> = {}): PickupStartRequest {
  return {
    shape: SHAPE,
    roster: roster(),
    candidates,
    currentStarterIds: STARTERS,
    pickup: Object.fromEntries(candidates.map((c) => [c.playerId, FREE])),
    openSpots: 1,
    ...over,
  };
}

describe('the whole-lineup gain', () => {
  it('finds a back whose value only appears after a reshuffle: Pickens to WR3, the back to FLEX', () => {
    const plan = planPickupStart(request([p('McLaughlin', 'RB', 7.6)], { roster: roster(false) }));
    expect(plan.start?.playerId).toBe('McLaughlin');
    expect(plan.start?.gain).toBeCloseTo(0.9, 6);
    expect(plan.start?.over?.name).toBe('Egbuka');
    expect(plan.start?.slot).toBe('FLEX');
    /* Pickens is in a WR slot in the lineup that makes room. */
    expect(plan.start?.displaces?.name).toBe('Egbuka');
  });

  it('does not headline a free agent who only ties a player already on the bench', () => {
    const plan = planPickupStart(request([p('McLaughlin', 'RB', 7.6)]));
    expect(plan.start).toBeNull();
    expect(plan.consider.map((m) => m.playerId)).toEqual(['McLaughlin']);
    expect(plan.consider[0]?.margin).toBeCloseTo(0, 6);
    expect(plan.consider[0]?.displaces?.name).toBe('McConkey');
  });

  it('headlines a free agent who beats a WR starter, measured against the best owned lineup', () => {
    const plan = planPickupStart(request([p('Upgrade', 'WR', 9.0)]));
    expect(plan.start?.playerId).toBe('Upgrade');
    /* Against McConkey (7.6), the best the roster already has, not Egbuka. */
    expect(plan.start?.gain).toBeCloseTo(1.4, 6);
    expect(plan.start?.over?.name).toBe('Egbuka');
  });

  it('says a tie or near tie softly, and a gain clearly over the threshold out loud', () => {
    const near = planPickupStart(request([p('Near', 'WR', 7.58), p('Small', 'RB', 8.0), p('Under', 'WR', 7.5)]));
    expect(near.start).toBeNull();
    expect(near.consider.map((m) => m.playerId).sort()).toEqual(['Near', 'Small']);
    const clear = planPickupStart(request([p('Clear', 'RB', 7.6 + PICKUP_START.gain + 0.1)]));
    expect(clear.start?.playerId).toBe('Clear');
    expect(clear.start?.gain).toBeCloseTo(0.6, 6);
  });

  it('shows nothing for a free agent worse than what the roster already has', () => {
    const plan = planPickupStart(request([p('Worse', 'WR', 7.0)]));
    expect(plan.start).toBeNull();
    expect(plan.consider).toEqual([]);
    expect(plan.audit[0]?.status).toBe('below');
  });
});

describe('who may headline', () => {
  it('never a Sleeper-fallback number, however high', () => {
    const plan = planPickupStart(request([p('Fallback', 'RB', 15, { basis: 'published' })]));
    expect(plan.start).toBeNull();
    expect(plan.consider).toEqual([]);
    expect(plan.audit[0]?.status).toBe('not_priced');
  });

  it('not a free agent on a waiver clock: he stays on Waivers', () => {
    const fa = p('Clocked', 'RB', 12);
    const plan = planPickupStart(
      request([fa], { pickup: { Clocked: { state: 'waivers', reason: 'dropped', until: '2026-10-21T07:00:00Z' } } }),
    );
    expect(plan.start).toBeNull();
    expect(plan.notNow).toEqual([expect.objectContaining({ playerId: 'Clocked', why: 'waivers' })]);
  });

  it('not a free agent whose game has started', () => {
    const plan = planPickupStart(request([p('Kicked', 'RB', 12, { locked: true })]));
    expect(plan.start).toBeNull();
    expect(plan.notNow[0]?.why).toBe('game_started');
  });

  it('not an injured free agent', () => {
    const plan = planPickupStart(request([p('Hurt', 'RB', 12, { designation: 'questionable' })]));
    expect(plan.start).toBeNull();
    expect(plan.audit[0]?.status).toBe('injured');
  });

  it('keeps a locked starter in his slot and never moves a locked bench player in', () => {
    const r = roster().map((x) => (x.playerId === 'Egbuka' ? { ...x, locked: true } : x.playerId === 'McConkey' ? { ...x, locked: true } : x));
    const plan = planPickupStart(request([p('Upgrade', 'WR', 9.0)], { roster: r }));
    /* McConkey cannot come in and Egbuka cannot leave, so a 9.0 receiver has nobody weaker left to replace. */
    expect(plan.start).toBeNull();
  });
});

describe('a full roster', () => {
  it('pairs the add with the planner’s drop', () => {
    const plan = planPickupStart(
      request([p('McLaughlin', 'RB', 7.6)], {
        roster: roster(false),
        openSpots: 0,
        dropFor: () => ({ playerId: 'Spare', name: 'Spare' }),
      }),
    );
    expect(plan.start?.drop).toEqual({ playerId: 'Spare', name: 'Spare' });
  });

  it('makes no call when the planner has no honest drop', () => {
    const plan = planPickupStart(request([p('McLaughlin', 'RB', 7.6)], { roster: roster(false), openSpots: 0, dropFor: () => null }));
    expect(plan.start).toBeNull();
    expect(plan.audit[0]?.status).toBe('no_drop');
  });

  it('counts the drop inside the gain', () => {
    /* Dropping McConkey to add a 7.6: the lineup loses nothing and gains nothing. */
    const plan = planPickupStart(
      request([p('Same', 'WR', 7.6)], { openSpots: 0, dropFor: () => ({ playerId: 'McConkey', name: 'McConkey' }) }),
    );
    expect(plan.start).toBeNull();
    expect(plan.consider[0]?.gain).toBeCloseTo(0, 6);
  });
});

describe('Starter out', () => {
  const read = starterOutReader({
    players: [
      { id: 'Starter', fullName: 'Starter Back', team: 'CLE', position: 'RB' },
      { id: 'Backup', fullName: 'Backup Back', team: 'CLE', position: 'RB' },
      { id: 'Other', fullName: 'Other Back', team: 'DEN', position: 'RB' },
    ],
    injuryStatus: new Map([['Starter', 'Out']]),
    depthOrder: new Map([
      ['Starter', 1],
      ['Backup', 2],
      ['Other', 2],
    ]),
  });

  it('fires for the backup to a starter ruled Out', () => {
    expect(read(p('Backup', 'RB', 9, { team: 'CLE' }))).toEqual({ playerId: 'Starter', name: 'Starter Back' });
  });

  it('stays silent when it cannot tell', () => {
    expect(read(p('Other', 'RB', 9, { team: 'DEN' }))).toBeNull();
    expect(read(p('Unknown', 'RB', 9, { team: 'CLE' }))).toBeNull();
  });
});

describe('the tiers read the same call', () => {
  const t = (id: string, position: string, rate: number): TierPlayer => ({
    playerId: id,
    name: id,
    position,
    team: 'XX',
    rate,
    weekly: [1, 1, 1],
    designation: 'healthy',
    byeWeek: null,
  });
  const base: TierRequest = {
    shape: SHAPE,
    weeks: [7, 8, 9],
    roster: roster().map((x) => t(x.playerId, x.position, x.points ?? 0)),
    candidates: [t('McLaughlin', 'RB', 7.6), t('Upgrade', 'WR', 9.0)],
    openSpots: 1,
    openReserve: 0,
    protections: new Map(),
    excludedPositions: new Set(['DEF']),
    replacement: new Map([
      ['RB', 5],
      ['WR', 5],
    ]),
  };

  it('a headline is a "Do this" move, a tie Worth considering', () => {
    const plan = planWaiverTiers({
      ...base,
      startNow: new Map([
        ['Upgrade', { verdict: 'start' as const, gain: 1.4, displaces: 'McConkey' }],
        ['McLaughlin', { verdict: 'consider' as const, gain: 0, displaces: 'McConkey' }],
      ]),
    });
    expect(plan.doThese.map((m) => m.playerId)).toContain('Upgrade');
    expect(plan.doThese.find((m) => m.playerId === 'Upgrade')?.reason).toBe('Starts this week: +1.4 pts on your best lineup');
    const tie = plan.consider.find((m) => m.playerId === 'McLaughlin');
    expect(tie?.reasonCode).toBe('start_tie');
    expect(tie?.reason).toBe('Ties McConkey this week');
  });

  it('changes nothing without a call', () => {
    const plan = planWaiverTiers(base);
    expect([...plan.doThese, ...plan.consider].some((m) => m.reasonCode === 'start_now' || m.reasonCode === 'start_tie')).toBe(false);
  });
});

describe('a full roster with no honest drop (Alex, 20 October 2026)', () => {
  const choices = [
    { playerId: 'Spare', name: 'Spare Back', reason: 'no start in weeks 6 to 8' },
    { playerId: 'Egbuka', name: 'Egbuka', reason: 'bench' },
  ];
  const full = (candidates: PickupPlayer[]) =>
    request(candidates, { openSpots: 0, dropFor: () => null, spotChoices: () => choices });

  it('still headlines a big gain, with "Pick your drop" and no named drop', () => {
    const plan = planPickupStart(full([p('Big', 'RB', 10.0)]));
    expect(plan.start?.playerId).toBe('Big');
    expect(plan.start?.gain).toBeCloseTo(10.0 - 7.6, 6);
    expect(plan.start?.drop).toBeNull();
    expect(plan.start?.pickDrop?.map((c) => c.playerId)).toEqual(['Spare', 'Egbuka']);
  });

  it('never offers a player who starts beside him as the drop', () => {
    const plan = planPickupStart(
      request([p('Big', 'RB', 10.0)], { openSpots: 0, dropFor: () => null, spotChoices: () => [{ playerId: 'Wilson', name: 'Wilson' }, ...choices] }),
    );
    expect(plan.start?.pickDrop?.map((c) => c.playerId)).not.toContain('Wilson');
  });

  it('does not headline a small gain', () => {
    const plan = planPickupStart(full([p('Small', 'RB', 7.9)]));
    expect(plan.start).toBeNull();
    expect(plan.consider[0]?.playerId).toBe('Small');
    expect(plan.consider[0]?.pickDrop?.length).toBeGreaterThan(0);
  });

  it('pairs the honest drop as before when the planner has one', () => {
    const plan = planPickupStart(
      request([p('Big', 'RB', 10.0)], { openSpots: 0, dropFor: () => ({ playerId: 'Spare', name: 'Spare' }), spotChoices: () => choices }),
    );
    expect(plan.start?.drop).toEqual({ playerId: 'Spare', name: 'Spare' });
    expect(plan.start?.pickDrop).toBeNull();
  });

  it('shows the gain for every scanned free agent in the audit, whatever stops him', () => {
    const plan = planPickupStart(
      request(
        [p('Priced', 'RB', 9.0), p('Fallback', 'WR', 9.0, { basis: 'published' }), p('Hurt', 'RB', 9.0, { designation: 'questionable' }), p('NoDrop', 'WR', 9.0)],
        { openSpots: 0, dropFor: () => null, spotChoices: () => [] },
      ),
    );
    for (const row of plan.audit) expect(row.gain, row.name).not.toBeNull();
    expect(plan.audit.find((r) => r.name === 'NoDrop')?.status).toBe('no_drop');
    expect(plan.audit.find((r) => r.name === 'NoDrop')?.gain).toBeCloseTo(1.4, 6);
  });
});

describe('the band between a tie and the headline', () => {
  it('a gain of 0.3 is Worth considering, not nothing', () => {
    const plan = planPickupStart(request([p('Close', 'WR', 7.9)]));
    expect(plan.start).toBeNull();
    expect(plan.consider[0]?.playerId).toBe('Close');
    expect(plan.consider[0]?.gain).toBeCloseTo(0.3, 6);
  });
});

describe('the tiers with a full roster and no honest drop', () => {
  it('keep a pick-up-and-start move in "Do this" with "Pick your drop"', () => {
    const t = (id: string, position: string, rate: number): TierPlayer => ({ playerId: id, name: id, position, team: 'XX', rate, weekly: [1, 1, 1], designation: 'healthy', byeWeek: null });
    /* Nobody on the bench is worth less than a replacement-level back, so the planner has no honest drop. */
    const plan = planWaiverTiers({
      shape: SHAPE,
      weeks: [6, 7, 8],
      roster: [...roster().map((x) => t(x.playerId, x.position, x.points ?? 0)), t('B1', 'QB', 18), t('B2', 'QB', 17), t('B3', 'TE', 9), t('B4', 'TE', 8), t('B5', 'QB', 16)],
      candidates: [t('Big', 'RB', 10)],
      openSpots: 0,
      openReserve: 0,
      protections: new Map(),
      excludedPositions: new Set(['DEF']),
      replacement: new Map([['RB', 9.9], ['WR', 5], ['QB', 5], ['TE', 2]]),
      startNow: new Map([['Big', { verdict: 'start' as const, gain: 2.4, displaces: 'McConkey' }]]),
    });
    const move = plan.doThese.find((m) => m.playerId === 'Big');
    expect(move?.reasonCode).toBe('start_now');
    expect(move?.drop).toBeNull();
    expect(move?.needsSpot).toBeDefined();
  });
});

describe('defences', () => {
  it('are the defence planner\'s: never called, and labelled as that in the audit', () => {
    const plan = planPickupStart(request([p('Saints', 'DEF', 12.0)]));
    expect(plan.start).toBeNull();
    expect(plan.consider).toEqual([]);
    expect(plan.audit[0]?.status).toBe('defence_planner');
    expect(plan.audit[0]?.gain).not.toBeNull();
  });
});
