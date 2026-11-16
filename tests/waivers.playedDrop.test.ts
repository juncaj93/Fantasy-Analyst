/**
 * Round 30, item 2: a player whose game has started or finished is never the
 * drop in a this-week lineup move.
 *
 * Live, Sunday 15 November 11:51 PM (Round 29 audit, A2): Waivers' "Do this"
 * and Team's Best move both said "add Quentin Johnston, drop Hunter Henry,
 * +1.5" with every one of Alex's starters already played. Sleeper will not cut
 * Henry until the week rolls over, and taking a played starter out of the
 * lineup before it is solved invented the +1.5.
 */

import { describe, expect, it } from 'vitest';
import { planPickupStart, type PickupPlayer, type PickupStartRequest } from '../src/core/waivers/pickupStart.ts';
import { planWaiverTiers, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { pickupDropFor } from '../src/core/waivers/assemble.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);

function p(name: string, position: string, points: number, over: Partial<PickupPlayer> = {}): PickupPlayer {
  return { playerId: name, name, position, team: 'XX', points, basis: 'market', ruledOut: false, locked: false, designation: 'healthy', ...over };
}

const STARTERS = ['Stroud', 'Bijan', 'Johnson', 'Collins', 'JSN', 'Cooper', 'Henry', 'McConkey', 'Concepcion', 'HOU'];

/**
 * Sunday night of week 10: every starter has played except McConkey, who is
 * Monday night. The bench: LaPorta (played) and Spare (Monday night).
 */
function sundayNight(): PickupPlayer[] {
  const played = { locked: true };
  return [
    p('Stroud', 'QB', 32.2, played),
    p('Bijan', 'RB', 17.0, played),
    p('Johnson', 'RB', 15.3, played),
    p('Collins', 'WR', 16.2, played),
    p('JSN', 'WR', 16.4, played),
    p('Cooper', 'WR', 7.0, played),
    p('Henry', 'TE', 8.3, played),
    p('McConkey', 'WR', 6.0),
    p('Concepcion', 'WR', 8.8, played),
    p('HOU', 'DEF', 7.0, played),
    p('LaPorta', 'TE', 10.0, played),
    p('Spare', 'RB', 3.0),
  ];
}

function request(over: Partial<PickupStartRequest> = {}): PickupStartRequest {
  return {
    shape: SHAPE,
    roster: sundayNight(),
    /* A Monday-night receiver, free to add now. */
    candidates: [p('Johnston', 'WR', 9.5)],
    currentStarterIds: STARTERS,
    pickup: { Johnston: { state: 'free', reason: null, until: null } },
    openSpots: 0,
    ...over,
  };
}

describe('the pickup call never drops a player who has played', () => {
  it('ignores a played starter the planner named, and invents no gain from his slot', () => {
    /*
     * The planner's drop is Cooper, a starter whose game is over. Before Round
     * 30 his slot was freed for Johnston: "drop Cooper, +2.5". With no other
     * drop to offer there is no call at all.
     */
    const plan = planPickupStart(request({ dropFor: () => ({ playerId: 'Cooper', name: 'Cooper' }), spotChoices: () => [] }));
    const moves = [plan.start, ...plan.consider].filter((m) => m != null);
    expect(moves.some((m) => m!.drop?.playerId === 'Cooper')).toBe(false);
    expect(plan.start).toBeNull();
    expect(plan.audit.find((r) => r.playerId === 'Johnston')?.status).toBe('no_drop');
  });

  it('starts him over the one unplayed starter, with the next-best drop who has not played', () => {
    const plan = planPickupStart(
      request({
        dropFor: () => ({ playerId: 'Spare', name: 'Spare' }),
        spotChoices: () => [],
      }),
    );
    expect(plan.start?.playerId).toBe('Johnston');
    expect(plan.start?.over?.name).toBe('McConkey');
    expect(plan.start?.gain).toBeCloseTo(9.5 - 6.0, 6);
    expect(plan.start?.drop?.playerId).toBe('Spare');
  });

  it('never lists a played player under "Pick your drop"', () => {
    const plan = planPickupStart(
      request({
        dropFor: () => ({ playerId: 'Henry', name: 'Henry' }),
        spotChoices: () => [
          { playerId: 'LaPorta', name: 'LaPorta' },
          { playerId: 'Henry', name: 'Henry' },
          { playerId: 'Spare', name: 'Spare' },
        ],
      }),
    );
    expect(plan.start?.playerId).toBe('Johnston');
    expect(plan.start?.drop).toBeNull();
    expect(plan.start?.pickDrop?.map((c) => c.playerId)).toEqual(['Spare']);
  });

  it('still drops a player who has not played yet, as before', () => {
    const plan = planPickupStart(request({ dropFor: () => ({ playerId: 'Spare', name: 'Spare' }) }));
    expect(plan.start?.drop).toEqual({ playerId: 'Spare', name: 'Spare' });
  });
});

describe('the planner hands the call the next-best drop who has not played', () => {
  const choices = [
    { playerId: 'Henry', name: 'Henry' },
    { playerId: 'LaPorta', name: 'LaPorta' },
    { playerId: 'Spare', name: 'Spare' },
  ];

  it('skips the planner’s own drop and every other played player', () => {
    const next = pickupDropFor({ drop: { playerId: 'Henry', name: 'Henry', position: 'TE' } }, choices, new Set(['Henry', 'LaPorta']));
    expect(next).toEqual({ playerId: 'Spare', name: 'Spare' });
  });

  it('keeps the planner’s drop when he has not played', () => {
    const next = pickupDropFor({ drop: { playerId: 'Spare', name: 'Spare', position: 'RB' } }, choices, new Set(['Henry']));
    expect(next).toEqual({ playerId: 'Spare', name: 'Spare' });
  });

  it('says nobody when everyone on the list has played', () => {
    const next = pickupDropFor({ drop: { playerId: 'Henry', name: 'Henry', position: 'TE' } }, choices, new Set(['Henry', 'LaPorta', 'Spare']));
    expect(next).toBeNull();
  });
});

describe('the "Do this" row on Waivers names the same drop as Team', () => {
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
    weeks: [10, 11, 12],
    /*
     * On the planner's season rates Spare and McConkey are useful (9.0 each),
     * so its natural cut is a played player: Cooper, the cheapest receiver.
     */
    roster: sundayNight().map((x) => t(x.playerId, x.position, x.playerId === 'Spare' || x.playerId === 'McConkey' ? 9.0 : (x.points ?? 0))),
    candidates: [t('Johnston', 'WR', 9.5)],
    openSpots: 0,
    openReserve: 0,
    protections: new Map(),
    excludedPositions: new Set(['DEF']),
    replacement: new Map([
      ['RB', 2],
      ['WR', 2],
      ['TE', 2],
      ['QB', 2],
    ]),
  };
  const call = { verdict: 'start' as const, gain: 3.5, displaces: 'McConkey' };

  it('without the played list, the planner’s cheapest drop can be a player who has played', () => {
    /* The control: Cooper (7.0, played Sunday) is the planner's natural cut here. */
    const plan = planWaiverTiers({ ...base, startNow: new Map([['Johnston', call]]) });
    const move = plan.doThese.find((m) => m.playerId === 'Johnston');
    expect(move?.reasonCode).toBe('start_now');
    expect(move?.drop?.playerId).toBe('Cooper');
  });

  it('with it, the row never names a played player, and uses the call’s own drop', () => {
    const played = new Set(sundayNight().filter((x) => x.locked).map((x) => x.playerId));
    const plan = planWaiverTiers({ ...base, startNow: new Map([['Johnston', { ...call, drop: 'Spare' }]]), played });
    const move = plan.doThese.find((m) => m.playerId === 'Johnston');
    expect(move?.reasonCode).toBe('start_now');
    expect(move?.drop?.playerId).toBe('Spare');
    for (const d of move?.bestDrops ?? []) expect(played.has(d.playerId), d.name).toBe(false);
  });

  it('with no unplayed drop left, it says "Pick your drop" and lists nobody who has played', () => {
    const everyone = new Set(sundayNight().map((x) => x.playerId));
    const plan = planWaiverTiers({ ...base, startNow: new Map([['Johnston', { ...call, drop: null }]]), played: everyone });
    const move = plan.doThese.find((m) => m.playerId === 'Johnston');
    expect(move?.drop ?? null).toBeNull();
    for (const d of move?.needsSpot ?? []) expect(everyone.has(d.playerId), d.name).toBe(false);
  });
});
