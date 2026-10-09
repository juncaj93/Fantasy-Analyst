/**
 * The tiered waiver planner: lineup gain over three weeks, holes, depth, dead
 * spots, one roster spot used once, Alex's preferences, and unknown kept
 * unknown. See `core/waivers/tiers.ts`.
 */

import { describe, expect, it } from 'vitest';
import { planWaiverTiers, TIER_RULES, type TierCandidate, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const WEEKS = [6, 7, 8];

function p(id: string, position: string, rate: number | null, over: Partial<TierPlayer> = {}): TierPlayer {
  return { playerId: id, name: id, position, team: 'XX', rate, weekly: [1, 1, 1], designation: 'healthy', byeWeek: null, ...over };
}
const bye = (week: number): Partial<TierPlayer> => ({ byeWeek: week, weekly: WEEKS.map((w) => (w === week ? 0 : 1)) });

/* A full sixteen: ten starters and six bench, one of them nobody would start. */
function roster(over: Record<string, Partial<TierPlayer>> = {}): TierPlayer[] {
  const base = [
    p('QB1', 'QB', 20),
    p('RB1', 'RB', 16),
    p('RB2', 'RB', 13),
    p('WR1', 'WR', 15),
    p('WR2', 'WR', 13),
    p('WR3', 'WR', 11),
    p('TE1', 'TE', 9),
    p('RB3', 'RB', 10),
    p('WR4', 'WR', 10),
    p('DEF1', 'DEF', 7),
    p('TE2', 'TE', 7),
    p('RB4', 'RB', 8),
    p('WR5', 'WR', 8),
    p('RB5', 'RB', 6),
    p('WR6', 'WR', 6),
    p('Dead', 'RB', 3),
  ];
  return base.map((x) => ({ ...x, ...(over[x.playerId] ?? {}) }));
}

function request(over: Partial<TierRequest> = {}): TierRequest {
  return {
    shape: SHAPE,
    weeks: WEEKS,
    roster: roster(),
    candidates: [],
    openSpots: 0,
    openReserve: 0,
    protections: new Map(),
    excludedPositions: new Set(['DEF']),
    replacement: new Map([
      ['QB', 15],
      ['RB', 7],
      ['WR', 7],
      ['TE', 6],
    ]),
    ...over,
  };
}
const fa = (id: string, position: string, rate: number | null, over: Partial<TierCandidate> = {}): TierCandidate => p(id, position, rate, over);

describe('a hole from a bye', () => {
  it('makes a backup QB the "Do this" move when your only QB is on bye next week', () => {
    const plan = planWaiverTiers(
      request({ roster: roster({ QB1: bye(6) }), candidates: [fa('Stream', 'QB', 16), fa('Depth', 'WR', 9)] }),
    );
    expect(plan.doThis?.playerId).toBe('Stream');
    expect(plan.doThis?.reasonCode).toBe('hole_bye');
    expect(plan.doThis?.reason).toBe('Your QB QB1 is on bye in week 6');
    /* He fills week 6 in full; the spare-QB charge applies, since he sits in weeks 7 and 8 but starts week 6. */
    expect(plan.doThis?.byWeek[0]?.change).toBe(16);
    expect(plan.doThis?.drop?.name).toBe('Dead');
  });

  it('is depth to consider, not a must-do, when the bye is two weeks out', () => {
    const plan = planWaiverTiers(request({ roster: roster({ QB1: bye(8) }), candidates: [fa('Stream', 'QB', 16)] }));
    expect(plan.doThis).toBeNull();
    const move = plan.consider.find((m) => m.playerId === 'Stream');
    expect(move?.reasonCode).toBe('bye_depth');
    expect(move?.reason).toBe('Your QB QB1 is on bye in week 8');
    /* Half weight for week 8, less the spare-QB charge: 8 − 1.5. */
    expect(move?.gain).toBeCloseTo(6.5, 1);
    expect(move?.prefs.map((x) => x.key)).toEqual(['spare_qb_te']);
  });
});

describe('one need, one row', () => {
  it('lists the best answer to a bye and carries the rest as alternatives', () => {
    const plan = planWaiverTiers(
      request({ roster: roster({ QB1: bye(6) }), candidates: [fa('QBa', 'QB', 18), fa('QBb', 'QB', 16), fa('QBc', 'QB', 15)] }),
    );
    expect(plan.doThis?.playerId).toBe('QBa');
    expect(plan.doThis?.alternatives).toEqual(['QBb', 'QBc']);
    expect([...plan.consider, ...plan.watch].map((m) => m.playerId)).not.toContain('QBb');
  });

  it('treats next week as a first-week hole while this week is still in play', () => {
    const plan = planWaiverTiers(
      request({ roster: roster({ QB1: bye(7) }), weights: [1, 1, 0.5], leadWeeks: 2, candidates: [fa('Stream', 'QB', 16)] }),
    );
    expect(plan.doThis?.reasonCode).toBe('hole_bye');
    expect(plan.doThis?.reason).toBe('Your QB QB1 is on bye in week 7');
  });
});

describe('a hole from an injury', () => {
  it('names the injured starter when the slot has nobody to fill it', () => {
    /* One TE and he is Out; the backup TE is gone. */
    const r = roster({ TE1: { designation: 'out', weekly: [0, 0.5, 1] } }).filter((x) => x.playerId !== 'TE2');
    r.push(p('Spare', 'WR', 5));
    const plan = planWaiverTiers(request({ roster: r, candidates: [fa('NewTE', 'TE', 8)] }));
    expect(plan.doThis?.playerId).toBe('NewTE');
    expect(plan.doThis?.reasonCode).toBe('hole_injury');
    expect(plan.doThis?.reason).toBe('Your TE TE1 is Out');
  });
});

describe('dead roster spots', () => {
  it('lists a bench player nobody would start, even with no pickup worth making', () => {
    const plan = planWaiverTiers(request({ candidates: [fa('Meh', 'WR', 5)] }));
    expect(plan.doThis).toBeNull();
    expect(plan.consider).toEqual([]);
    expect(plan.dropReady.map((d) => d.name)).toContain('Dead');
    const dead = plan.dropReady.find((d) => d.name === 'Dead')!;
    expect(dead.reason).toBe('No start in weeks 6 to 8; a free agent is as good');
    /* A starter and a bench player above a free agent are not dead. */
    expect(plan.dropReady.map((d) => d.name)).not.toContain('RB1');
    expect(plan.dropReady.map((d) => d.name)).not.toContain('RB4');
  });

  it('never calls a protected player or an unvalued one dead', () => {
    const plan = planWaiverTiers(
      request({
        roster: [...roster().filter((x) => x.playerId !== 'Dead'), p('Cuff', 'RB', 3), p('Unknown', 'RB', null)],
        protections: new Map([['Cuff', { kind: 'handcuff', note: 'backs up RB1' }]]),
      }),
    );
    expect(plan.dropReady.map((d) => d.name)).not.toContain('Cuff');
    expect(plan.dropReady.map((d) => d.name)).not.toContain('Unknown');
  });
});

describe('one roster spot is used once', () => {
  it('gives the shared drop to the stronger move and says the two compete for it', () => {
    /* Only one cuttable player is worse than both adds. */
    const r = roster().map((x) => (x.playerId === 'RB5' || x.playerId === 'WR6' ? { ...x, rate: 9.5 } : x));
    const plan = planWaiverTiers(
      request({ roster: r, candidates: [fa('BigRB', 'RB', 14), fa('BigWR', 'WR', 13.5)] }),
    );
    const listed = [plan.doThis, ...plan.consider].filter((m) => m != null);
    const first = listed.find((m) => m!.drop?.name === 'Dead')!;
    expect(first.playerId).toBe('BigRB');
    const second = listed.find((m) => m!.playerId === 'BigWR')!;
    expect(second.drop?.name).not.toBe('Dead');
    expect(second.competesWith).toContain('BigRB');
    expect(first.competesWith).toContain('BigWR');
  });

  it('uses an open roster spot before any drop', () => {
    const plan = planWaiverTiers(request({ openSpots: 1, candidates: [fa('BigRB', 'RB', 14)] }));
    const move = plan.doThis ?? plan.consider[0];
    expect(move?.drop).toBeNull();
  });
});

describe('Alex’s preferences', () => {
  it('charges a spare TE who would sit, and not one who starts next week', () => {
    const plan = planWaiverTiers(request({ candidates: [fa('SpareTE', 'TE', 8.5), fa('StarTE', 'TE', 16)] }));
    const all = [plan.doThis, ...plan.consider, ...plan.watch].filter((m) => m != null);
    const spare = all.find((m) => m!.playerId === 'SpareTE');
    if (spare) expect(spare.prefs.map((x) => x.key)).toContain('spare_qb_te');
    const star = all.find((m) => m!.playerId === 'StarTE')!;
    expect(star.prefs).toEqual([]);
  });

  it('never adds or drops a defence: the defence planner owns it', () => {
    const plan = planWaiverTiers(request({ candidates: [fa('BestDEF', 'DEF', 15)] }));
    expect([plan.doThis, ...plan.consider, ...plan.watch].filter((m) => m != null)).toEqual([]);
    expect(plan.dropReady.map((d) => d.position)).not.toContain('DEF');
  });

  it('leans RB when two moves are close, on the order only', () => {
    const plan = planWaiverTiers(request({ openSpots: 2, candidates: [fa('WRx', 'WR', 11.1), fa('RBx', 'RB', 11)] }));
    const order = [plan.doThis, ...plan.consider].filter((m) => m != null).map((m) => m!.playerId);
    expect(order.indexOf('RBx')).toBeLessThan(order.indexOf('WRx'));
    const wr = [plan.doThis, ...plan.consider].find((m) => m?.playerId === 'WRx')!;
    expect(wr.gain).toBeGreaterThan([plan.doThis, ...plan.consider].find((m) => m?.playerId === 'RBx')!.gain);
  });
});

describe('thin data stays unknown', () => {
  it('never values a free agent with no number, and counts him', () => {
    const plan = planWaiverTiers(request({ roster: roster({ QB1: bye(6) }), candidates: [fa('NoNumberQB', 'QB', null)] }));
    expect(plan.doThis).toBeNull();
    expect(plan.unvalued).toBe(1);
    expect(plan.valued).toBe(0);
  });

  it('never cuts a better player for a worse one because he is hurt for a while', () => {
    const r = roster({ RB1: { designation: 'ir', weekly: [0, 0, 0] } });
    const plan = planWaiverTiers(request({ roster: r, candidates: [fa('Fill', 'RB', 11)] }));
    const move = plan.doThis ?? plan.consider[0];
    expect(move?.drop?.name).not.toBe('RB1');
  });
});

describe('the thresholds', () => {
  it('are in lineup points, and ordered', () => {
    expect(TIER_RULES.doThis).toBeGreaterThan(TIER_RULES.consider);
    expect(TIER_RULES.consider).toBeGreaterThan(TIER_RULES.watch);
    expect(TIER_RULES.weights[0]).toBe(1);
  });

  it('puts a small gain on the watch list, not in a tier that asks for a move', () => {
    const plan = planWaiverTiers(request({ candidates: [fa('Slight', 'WR', 6.7)] }));
    expect(plan.consider).toEqual([]);
    expect(plan.watch.every((m) => m.gain < TIER_RULES.consider)).toBe(true);
  });
});
