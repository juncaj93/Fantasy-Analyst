/**
 * Waivers round 2: drops by the drop score, protected starters, handcuffs to
 * elite backs only, stashes that are back before the playoffs, two holes at
 * once, and one drop per move. Built on Alex's own week 6: Joe Burrow and Sam
 * LaPorta on bye, Braelon Allen in his lineup, Bijan Robinson and Kenneth
 * Walker with their backups, and De'Von Achane out for the season.
 */

import { describe, expect, it } from 'vitest';
import { assignDrops, planWaiverTiers, type TierCandidate, type TierPlayer, type TierRequest } from '../src/core/waivers/tiers.ts';
import { buildRosterShape } from '../src/core/sleeper/rosterShape.ts';
import { dropScore, eliteBacks, eliteHandcuffs, readDrops, DROP_WEIGHTS, ELITE_RB, type DropSignals } from '../src/core/waivers/dropScore.ts';
import { parseTimeline, stashVerdict, type StashVerdict } from '../src/core/waivers/stash.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const WEEKS = [6, 7, 8];

function p(id: string, position: string, rate: number | null, over: Partial<TierPlayer> = {}): TierPlayer {
  return { playerId: id, name: id, position, team: 'XX', rate, weekly: [1, 1, 1], designation: 'healthy', byeWeek: null, ...over };
}
const bye = (week: number): Partial<TierPlayer> => ({ byeWeek: week, weekly: WEEKS.map((w) => (w === week ? 0 : 1)) });

/* Alex's sixteen, roughly: names and the shape of it, not every number. */
function alexRoster(): TierPlayer[] {
  return [
    p('Burrow', 'QB', 23, { team: 'CIN', ...bye(6) }),
    p('Bijan', 'RB', 21, { team: 'ATL' }),
    p('Walker', 'RB', 19, { team: 'KC' }),
    p('Allen', 'RB', 9, { team: 'NYJ' }),
    p('Shipley', 'RB', 7, { team: 'PHI', designation: 'out', weekly: [0, 1, 1] }),
    p('Pickens', 'WR', 15, { team: 'DAL' }),
    p('Wilson', 'WR', 14, { team: 'NYJ' }),
    p('Collins', 'WR', 15, { team: 'HOU' }),
    p('Harris', 'WR', 10, { team: 'LAC', ...bye(7) }),
    p('McConkey', 'WR', 11, { team: 'LAC', ...bye(7) }),
    p('Egbuka', 'WR', 11, { team: 'TB' }),
    p('LaPorta', 'TE', 11, { team: 'DET', ...bye(6) }),
    p('BRobinson', 'RB', 8, { team: 'ATL' }),
    p('EJohnson', 'RB', 6, { team: 'KC' }),
    p('MIN', 'DEF', 7, { team: 'MIN' }),
    p('KC', 'DEF', 6, { team: 'KC' }),
  ];
}

const sig = (id: string, position: string, over: Partial<DropSignals>): DropSignals => ({
  playerId: id,
  name: id,
  position,
  seasonPoints: 40,
  weeksPlayed: 5,
  recent: [8, 8, 8],
  projection: 8,
  role: null,
  heldWeeks: 3,
  drafted: false,
  handcuffOf: null,
  inLineup: false,
  unavailable: false,
  ...over,
});

function alexSignals(): Map<string, DropSignals> {
  return new Map(
    [
      sig('Allen', 'RB', { seasonPoints: 41, recent: [14, 6, 9], projection: 9, inLineup: true, heldWeeks: 3 }),
      sig('Shipley', 'RB', { seasonPoints: 17.3, recent: [0, 4, 6], projection: 4, inLineup: true, unavailable: true, heldWeeks: 2 }),
      sig('BRobinson', 'RB', { seasonPoints: 48.6, recent: [10, 9, 12], projection: 8, heldWeeks: 2, handcuffOf: 'Bijan' }),
      sig('EJohnson', 'RB', { seasonPoints: 15.5, recent: [3, 5, 2], projection: 5, heldWeeks: 4, handcuffOf: 'Walker' }),
      sig('McConkey', 'WR', { seasonPoints: 52, recent: [9, 12, 8], projection: 10, drafted: true }),
      sig('Egbuka', 'WR', { seasonPoints: 55, recent: [11, 10, 13], projection: 11, drafted: true }),
      sig('Walker', 'RB', { seasonPoints: 104, recent: [0, 26, 30], projection: 19, drafted: true }),
      ...['Burrow', 'Bijan', 'Pickens', 'Wilson', 'Collins', 'Harris', 'LaPorta'].map((id) =>
        sig(id, id === 'Burrow' ? 'QB' : id === 'LaPorta' ? 'TE' : id === 'Bijan' ? 'RB' : 'WR', { seasonPoints: 90, recent: [18, 18, 18], projection: 16, inLineup: true, drafted: true }),
      ),
    ].map((s) => [s.playerId, s]),
  );
}

function request(over: Partial<TierRequest> = {}): TierRequest {
  return {
    shape: SHAPE,
    weeks: WEEKS,
    weights: [1, 1, 0.5],
    leadWeeks: 2,
    roster: alexRoster(),
    candidates: [],
    openSpots: 0,
    openReserve: 2,
    protections: new Map([
      ['BRobinson', { kind: 'handcuff' as const, note: 'backs up Bijan' }],
      ['EJohnson', { kind: 'handcuff' as const, note: 'backs up Walker' }],
    ]),
    excludedPositions: new Set(['DEF']),
    replacement: new Map([
      ['QB', 15],
      ['RB', 7],
      ['WR', 8],
      ['TE', 6],
    ]),
    dropSignals: alexSignals(),
    ...over,
  };
}
const fa = (id: string, position: string, rate: number | null, over: Partial<TierCandidate> = {}): TierCandidate => p(id, position, rate, over);
const LOVE = fa('Love', 'QB', 21, { team: 'GB' });
const ANDREWS = fa('Andrews', 'TE', 10, { team: 'BAL' });
const STROUD = fa('Stroud', 'QB', 17, { team: 'HOU' });

describe('two holes at once', () => {
  const plan = planWaiverTiers(request({ candidates: [LOVE, ANDREWS, STROUD] }));

  it('makes both the QB bye fill and the TE bye fill "Do this", each with its own drop', () => {
    const names = plan.doThese.map((m) => m.name).sort();
    expect(names).toEqual(['Andrews', 'Love']);
    const drops = plan.doThese.map((m) => m.drop?.name);
    expect(new Set(drops).size).toBe(2);
    expect(drops.every((d) => d != null)).toBe(true);
    expect(plan.doThis?.name).toBe(plan.doThese[0]?.name);
  });

  it('never puts the TE bye fill on the Watch list', () => {
    expect(plan.watch.map((m) => m.name)).not.toContain('Andrews');
  });

  it('keeps a second QB for the same bye as an alternative, not a second claim', () => {
    const love = plan.doThese.find((m) => m.name === 'Love')!;
    expect(love.alternatives).toContain('Stroud');
    expect([...plan.consider, ...plan.watch].map((m) => m.name)).not.toContain('Stroud');
  });

  it('never cuts Braelon Allen, who is in the Sleeper lineup, for a quarterback', () => {
    for (const m of [...plan.doThese, ...plan.consider, ...plan.watch]) expect(m.drop?.name).not.toBe('Allen');
  });

  it('cuts the Out starter with the lowest drop score first, and says why in plain words', () => {
    const first = plan.doThese.find((m) => m.drop?.name === 'Shipley');
    expect(first).toBeDefined();
    /* Emmett Johnson has fewer season points (15.5) but is Walker's handcuff; Shipley is out and fading. */
    expect(first!.drop!.reason).toBe('out now, least points lately on your bench (2.3 a week), held 2 weeks');
  });

  it('lists every bench player’s drop score for the sheet, lowest first', () => {
    expect(plan.dropScores[0]?.name).toBe('Shipley');
    const allen = plan.dropScores.find((d) => d.name === 'Allen');
    expect(allen?.protectedAs).toBe('in your lineup');
  });
});

describe('protected starters', () => {
  it('lets a same-position add that is clearly better displace a lineup player', () => {
    const star = fa('StarRB', 'RB', 15, { team: 'SF' });
    const plan = planWaiverTiers(request({ roster: alexRoster().map((x) => (x.playerId === 'Burrow' || x.playerId === 'LaPorta' ? { ...x, byeWeek: null, weekly: [1, 1, 1] } : x)), candidates: [star] }));
    const move = [...plan.doThese, ...plan.consider, ...plan.watch].find((m) => m.name === 'StarRB');
    expect(move).toBeDefined();
    /* Allen may now be cut: StarRB is a back and six points a game better. */
    const options = ['Allen', 'Shipley', 'EJohnson', 'BRobinson', 'McConkey', 'Egbuka'];
    expect(options).toContain(move!.drop?.name);
  });

  it('does not let a quarterback displace a lineup back however good he is', () => {
    const plan = planWaiverTiers(request({ candidates: [fa('Mahomes', 'QB', 30, { team: 'KC' })] }));
    const move = [...plan.doThese, ...plan.consider].find((m) => m.name === 'Mahomes');
    expect(move?.drop?.name).not.toBe('Allen');
  });
});

describe('handcuffs to elite backs', () => {
  const points = new Map([
    ['Bijan', { total: 112, games: 5 }],
    ['Walker', { total: 104, games: 4 }],
    ['Allen', { total: 41, games: 5 }],
    ['Shipley', { total: 17, games: 5 }],
    ...Array.from({ length: 20 }, (_, i) => [`rb${i}`, { total: 100 - i * 3, games: 5 }] as const),
  ]);
  const elite = eliteBacks(points, () => true);

  it('counts Bijan Robinson and Kenneth Walker as elite, and not Braelon Allen or Will Shipley', () => {
    expect(elite.has('Bijan')).toBe(true);
    expect(elite.has('Walker')).toBe(true);
    expect(elite.has('Allen')).toBe(false);
    expect(elite.has('Shipley')).toBe(false);
    expect(elite.size).toBe(ELITE_RB.rank);
  });

  it('finds the direct backups to elite backs only', () => {
    const roster = alexRoster().map((x) => ({ playerId: x.playerId, name: x.playerId, position: x.position, team: x.team, rate: x.rate }));
    roster.push({ playerId: 'AllenBackup', name: 'AllenBackup', position: 'RB', team: 'NYJ', rate: 4 });
    const depth = new Map([
      ['Bijan', { rank: 1 }],
      ['BRobinson', { rank: 2 }],
      ['Walker', { rank: 1 }],
      ['EJohnson', { rank: 2 }],
      ['Allen', { rank: 1 }],
      ['AllenBackup', { rank: 2 }],
    ]);
    const cuffs = eliteHandcuffs({ roster, elite, depth });
    expect(cuffs.get('BRobinson')?.name).toBe('Bijan');
    expect(cuffs.get('EJohnson')?.name).toBe('Walker');
    expect(cuffs.has('AllenBackup')).toBe(false);
  });

  it('boosts a handcuff so he is rarely the drop, and says so', () => {
    const plain = dropScore(sig('x', 'RB', {}));
    const cuff = dropScore(sig('x', 'RB', { handcuffOf: 'Walker' }));
    expect(cuff.score - plain.score).toBe(3);
    const read = readDrops([sig('EJohnson', 'RB', { seasonPoints: 15.5, handcuffOf: 'Walker' }), sig('Other', 'WR', { seasonPoints: 30 })]);
    expect(read.get('EJohnson')!.reason).toMatch(/handcuff to Walker/);
  });
});

describe('the drop score', () => {
  it('weights recent weeks more than the season, and the projection most', () => {
    expect(DROP_WEIGHTS.recent).toBeGreaterThan(DROP_WEIGHTS.season);
    expect(DROP_WEIGHTS.projection).toBeGreaterThan(DROP_WEIGHTS.recent);
    const hot = dropScore(sig('a', 'WR', { seasonPoints: 40, recent: [15, 12, 3] }));
    const cold = dropScore(sig('b', 'WR', { seasonPoints: 40, recent: [3, 12, 15] }));
    expect(hot.score).toBeGreaterThan(cold.score);
  });

  it('gives a long-held or drafted player a little benefit of the doubt, a just-added one none', () => {
    const fresh = dropScore(sig('a', 'WR', { heldWeeks: 0 }));
    const held = dropScore(sig('a', 'WR', { heldWeeks: 6 }));
    const drafted = dropScore(sig('a', 'WR', { drafted: true }));
    expect(held.score).toBeGreaterThan(fresh.score);
    expect(drafted.score).toBeGreaterThan(held.score);
  });
});

describe('joint drop assignment', () => {
  it('never pairs two moves with the same drop, and keeps the most total gain', () => {
    const picks = assignDrops(
      [
        { id: 'A', priority: 1, options: [{ dropId: 'X', gain: 10, score: 1 }, { dropId: 'Y', gain: 9, score: 2 }] },
        { id: 'B', priority: 1, options: [{ dropId: 'X', gain: 8, score: 1 }, { dropId: 'Z', gain: 2, score: 3 }] },
      ],
      0,
    );
    /* A on Y and B on X (17) beats A on X and B on Z (12). */
    expect(picks.get('A')).toBe(1);
    expect(picks.get('B')).toBe(0);
  });

  it('places the "Do this" moves first when there are not enough drops for everyone', () => {
    const picks = assignDrops(
      [
        { id: 'consider', priority: 0, options: [{ dropId: 'X', gain: 20, score: 1 }] },
        { id: 'hole', priority: 1, options: [{ dropId: 'X', gain: 5, score: 1 }] },
      ],
      0,
    );
    expect(picks.get('hole')).toBe(0);
    expect(picks.has('consider')).toBe(false);
  });

  it('uses an open roster spot before any drop', () => {
    const picks = assignDrops([{ id: 'A', priority: 1, options: [{ dropId: null, gain: 5, score: -1 }, { dropId: 'X', gain: 5, score: 1 }] }], 1);
    expect(picks.get('A')).toBe(0);
  });
});

describe('stashes and season-ending injuries', () => {
  it('reads a torn ACL as out for the season', () => {
    const v = stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Knee - ACL', notes: 'Surgery' }, week: 6 });
    expect(v.kind).toBe('season_ending');
    expect(stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Achilles', notes: 'Surgery' }, week: 6 }).kind).toBe('season_ending');
    expect(stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Foot', notes: 'Out for the season' }, week: 6 }).kind).toBe('season_ending');
  });

  it('keeps a timeline that ends before week 15, and refuses one after week 14', () => {
    expect(parseTimeline('Surgery, out 4-6 weeks')).toBe(6);
    expect(stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Hamstring', notes: 'out 4-6 weeks' }, week: 6 })).toMatchObject({ kind: 'back_by', week: 12 });
    expect(stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Hamstring', notes: 'out 6-8 weeks' }, week: 9 })).toMatchObject({ kind: 'too_late', week: 17 });
  });

  it('calls an IR player with no timeline "return unknown"', () => {
    expect(stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Ankle', notes: 'Sprain' }, week: 6 }).kind).toBe('unknown');
  });

  const ACHANE = fa('Achane', 'RB', 18, { team: 'MIA', designation: 'ir', weekly: [0, 0, 0] });
  const HURT = fa('Hurt', 'RB', 16, { team: 'SEA', designation: 'ir', weekly: [0, 0, 0] });
  const SOON = fa('Soon', 'RB', 15, { team: 'NO', designation: 'out', weekly: [0, 1, 1] });
  const verdicts = (map: Record<string, StashVerdict>) => new Map(Object.entries(map));

  it('never offers a season-ending player, on any list', () => {
    const plan = planWaiverTiers(request({ candidates: [ACHANE], stash: verdicts({ Achane: { kind: 'season_ending', label: 'out for the season (Knee - ACL · Surgery)' } }) }));
    const all = [...plan.doThese, ...plan.consider, ...plan.watch].map((m) => m.name);
    expect(all).not.toContain('Achane');
    expect(plan.excluded[0]).toMatchObject({ name: 'Achane' });
  });

  it('puts a return-unknown player on the Watch list, labelled, not in Worth considering', () => {
    const plan = planWaiverTiers(request({ candidates: [HURT], stash: verdicts({ Hurt: { kind: 'unknown', label: 'return unknown' } }) }));
    expect(plan.consider.map((m) => m.name)).not.toContain('Hurt');
    const watch = plan.watch.find((m) => m.name === 'Hurt');
    expect(watch?.stashLabel).toBe('return unknown');
    expect(watch?.reasonCode).toBe('ir_stash');
  });

  it('lets a stash who is back before the playoffs into Worth considering', () => {
    const plan = planWaiverTiers(request({ candidates: [HURT], stash: verdicts({ Hurt: { kind: 'back_by', week: 9, label: 'back around week 9' } }) }));
    const m = plan.consider.find((x) => x.name === 'Hurt');
    expect(m?.reasonCode).toBe('ir_stash');
    expect(m?.reason).toMatch(/back around week 9/);
  });

  it('never recommends a stash back after week 14', () => {
    const plan = planWaiverTiers(request({ candidates: [HURT], stash: verdicts({ Hurt: { kind: 'too_late', week: 16, label: 'back around week 16, after the playoffs start' } }) }));
    expect([...plan.doThese, ...plan.consider, ...plan.watch].map((m) => m.name)).not.toContain('Hurt');
  });

  it('reads a plain Out as back soon', () => {
    const v = stashVerdict({ designation: 'out', note: { status: 'Out', bodyPart: 'Toe', notes: 'Sprain' }, week: 6 });
    expect(v.kind).toBe('back_by');
    const plan = planWaiverTiers(request({ candidates: [SOON], stash: verdicts({ Soon: v }) }));
    expect([...plan.doThese, ...plan.consider, ...plan.watch].map((m) => m.name)).toContain('Soon');
  });
});

/*
 * The live board of 14 October 2026: every bench player but Will Shipley was
 * protected (two drafted receivers as market holds, two elite backs' handcuffs),
 * and both "Do this" moves were handed Shipley.
 */
describe('one open drop and two holes (14 October)', () => {
  const protections = new Map([
    ['BRobinson', { kind: 'handcuff' as const, note: 'backs up Bijan' }],
    ['EJohnson', { kind: 'handcuff' as const, note: 'backs up Walker' }],
    ['McConkey', { kind: 'market_hold' as const, note: 'drafted around pick 41' }],
    ['Egbuka', { kind: 'market_hold' as const, note: 'drafted around pick 61' }],
  ]);
  const plan = planWaiverTiers(request({ candidates: [LOVE, ANDREWS], protections }));

  it('still gives each "Do this" move its own drop', () => {
    const drops = plan.doThese.map((m) => m.drop?.name);
    expect(plan.doThese.map((m) => m.name).sort()).toEqual(['Andrews', 'Love']);
    expect(new Set(drops).size).toBe(2);
  });

  it('reaches for a market hold before an elite back’s handcuff', () => {
    const drops = plan.doThese.map((m) => m.drop?.name);
    expect(drops).toContain('Shipley');
    expect(drops.some((d) => d === 'McConkey' || d === 'Egbuka')).toBe(true);
    expect(drops).not.toContain('BRobinson');
    expect(drops).not.toContain('EJohnson');
  });

  it('never offers Kenneth Walker as a drop for a quarterback', () => {
    for (const m of [...plan.doThese, ...plan.consider, ...plan.watch]) expect(m.drop?.name).not.toBe('Walker');
  });

  it('prefers an open drop unless the protected one keeps clearly more points', () => {
    const near = assignDrops([{ id: 'A', priority: 1, options: [{ dropId: 'open', gain: 5, score: 2, held: 0 }, { dropId: 'cuff', gain: 8, score: 8, held: 2 }] }], 0);
    expect(near.get('A')).toBe(0);
    const far = assignDrops([{ id: 'A', priority: 1, options: [{ dropId: 'open', gain: 1, score: 2, held: 0 }, { dropId: 'hold', gain: 9, score: 8, held: 1 }] }], 0);
    expect(far.get('A')).toBe(1);
  });
});
