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
import { dropScore, eliteBacks, eliteHandcuffs, hasProduced, isDeadSpot, readDrops, DROP_WEIGHTS, ELITE_RB, type DropSignals } from '../src/core/waivers/dropScore.ts';
import { parseTimeline, stashVerdict, type StashVerdict } from '../src/core/waivers/stash.ts';
import { draftCapital } from '../src/core/waivers/tierInputs.ts';

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

/* Alex's sixteen with one cheap, just-added bench back, so there are two honest spots: Shipley to IR, and Scrub. */
const withScrub = () => alexRoster().map((x) => (x.playerId === 'KC' ? p('Scrub', 'RB', 4, { team: 'NO' }) : x));
const scrubSignals = () => new Map([...alexSignals(), ['Scrub', sig('Scrub', 'RB', { seasonPoints: 6, recent: [1, 2, 1], projection: 4, heldWeeks: 0 })]]);

describe('two holes at once', () => {
  const plan = planWaiverTiers(
    request({ roster: withScrub(), dropSignals: scrubSignals(), candidates: [LOVE, ANDREWS, STROUD], reserveEligible: new Set(['Shipley']), openReserve: 2 }),
  );

  it('makes both the QB bye fill and the TE bye fill "Do this", and says which spot each uses', () => {
    expect(plan.doThese.map((m) => m.name).sort()).toEqual(['Andrews', 'Love']);
    const spots = plan.doThese.map((m) => (m.drop?.viaReserve ? `IR:${m.drop.name}` : m.drop?.name));
    expect(spots.sort()).toEqual(['IR:Shipley', 'Scrub']);
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

  it('moves the injured starter to IR rather than cutting him, and says so', () => {
    const ir = plan.doThese.find((m) => m.drop?.viaReserve);
    expect(ir?.drop?.name).toBe('Shipley');
    expect(ir!.drop!.reason).toBe('Out; your open IR slot holds him, so no drop');
  });

  it('names the cheap, just-added back as the honest drop, with the reason', () => {
    const cut = plan.doThese.find((m) => m.drop?.name === 'Scrub');
    expect(cut!.drop!.reason).toMatch(/lowest season points on your bench \(6\.0\), added this week/);
  });

  it('lists every bench player’s drop score for the sheet, lowest first', () => {
    expect(plan.dropScores[0]?.name).toBe('Scrub');
    expect(plan.dropScores.find((d) => d.name === 'Allen')?.protectedAs).toBe('in your lineup');
    expect(plan.dropScores.find((d) => d.name === 'Shipley')?.protectedAs).toBe('in your lineup');
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

  it('gives a long-held player more benefit of the doubt the longer he is held, a just-added one none', () => {
    const fresh = dropScore(sig('a', 'WR', { heldWeeks: 0 }));
    const three = dropScore(sig('a', 'WR', { heldWeeks: 3 }));
    const six = dropScore(sig('a', 'WR', { heldWeeks: 6 }));
    const drafted = dropScore(sig('a', 'WR', { drafted: true, weeksSinceDraft: 8 }));
    expect(fresh.parts.held).toBe(0);
    expect(three.score).toBeGreaterThan(fresh.score);
    expect(six.score).toBeGreaterThan(three.score);
    expect(drafted.score).toBeGreaterThan(six.score);
  });

  it('never makes a player cheaper to cut because he is hurt', () => {
    const healthy = dropScore(sig('a', 'WR', { recent: [12, 11, 13], projection: 12, seasonPoints: 60 }));
    const hurt = dropScore(sig('a', 'WR', { recent: [0, 11, 13], projection: 2, seasonPoints: 60, injured: true, healthyRate: 12 }));
    expect(hurt.score).toBeGreaterThanOrEqual(healthy.score - 0.01);
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
 * protected (two drafted receivers kept as high picks, two elite backs'
 * handcuffs), and both "Do this" moves were handed Shipley.
 */
describe('two claims, one eligible drop (14 October)', () => {
  /* McConkey (round 4) and Egbuka (round 6) are draft capital, the backs are elite handcuffs, Scrub is the only honest drop. */
  const protections = new Map([
    ['BRobinson', { kind: 'handcuff' as const, note: 'backs up Bijan' }],
    ['EJohnson', { kind: 'handcuff' as const, note: 'backs up Walker' }],
    ['McConkey', { kind: 'draft_capital' as const, note: 'round 4 pick' }],
    ['Egbuka', { kind: 'draft_capital' as const, note: 'round 6 pick' }],
    ['Walker', { kind: 'draft_capital' as const, note: 'round 2 pick' }],
  ]);
  const MILLER = fa('Miller', 'RB', 9, { team: 'NO' });
  const CONCEPCION = fa('Concepcion', 'WR', 9, { team: 'CLE' });
  const plan = planWaiverTiers(request({ roster: withScrub(), dropSignals: scrubSignals(), candidates: [LOVE, ANDREWS, MILLER, CONCEPCION], protections }));
  const all = () => [...plan.doThese, ...plan.consider, ...plan.watch];

  it('gives the one eligible drop to one "Do this" move only', () => {
    expect(plan.doThese.find((m) => m.name === 'Love')!.drop?.name).toBe('Scrub');
    expect(plan.doThese.filter((m) => m.drop?.name === 'Scrub')).toHaveLength(1);
  });

  it('never names the same drop on two rows anywhere: Do this, Worth considering or the Watch list', () => {
    const named = all().map((m) => m.drop?.name).filter((d): d is string => d != null);
    expect(new Set(named).size).toBe(named.length);
  });

  it('says a Watch list name that would share a drop needs a roster spot', () => {
    for (const m of plan.watch) {
      if (m.drop == null) expect(m.needsSpot).toEqual([]);
      expect(m.drop?.name).not.toBe('Scrub');
    }
  });

  it('never chooses Ladd McConkey (round 4, banged up) or any protected player as the automatic drop', () => {
    for (const m of all()) {
      expect(['McConkey', 'Egbuka', 'BRobinson', 'EJohnson', 'Walker', 'Shipley']).not.toContain(m.drop?.name);
    }
  });

  it('keeps a real hole fill with no free spot at "Do this", with "pick your drop" and the cheapest options', () => {
    const andrews = plan.doThese.find((m) => m.name === 'Andrews');
    expect(andrews!.tier).toBe('do_this');
    expect(andrews!.drop).toBeNull();
    expect(andrews!.needsSpot!.length).toBeGreaterThanOrEqual(2);
    expect(andrews!.needsSpot!.length).toBeLessThanOrEqual(3);
    for (const c of andrews!.needsSpot!) expect(c.reason.length).toBeGreaterThan(0);
    /* Draft capital is offered last, after the handcuffs. */
    expect(andrews!.needsSpot![0]!.name).not.toBe('McConkey');
    expect([...plan.consider, ...plan.watch].map((m) => m.name)).not.toContain('Andrews');
  });
});

describe('the IR option', () => {
  const protections = new Map([
    ['BRobinson', { kind: 'handcuff' as const, note: 'backs up Bijan' }],
    ['EJohnson', { kind: 'handcuff' as const, note: 'backs up Walker' }],
    ['McConkey', { kind: 'market_hold' as const, note: 'drafted around pick 41' }],
    ['Egbuka', { kind: 'market_hold' as const, note: 'drafted around pick 61' }],
  ]);

  it('moves an Out player to an open IR slot ahead of any drop', () => {
    const plan = planWaiverTiers(request({ roster: withScrub(), dropSignals: scrubSignals(), candidates: [LOVE], protections, reserveEligible: new Set(['Shipley']), openReserve: 2 }));
    expect(plan.doThese[0]!.drop).toMatchObject({ name: 'Shipley', viaReserve: true });
    expect(plan.doThese[0]!.drop!.reason).toMatch(/open IR slot holds him, so no drop/);
  });

  it('uses the IR move for one hole and asks Alex to pick a drop for the second when nothing honest is left', () => {
    const plan = planWaiverTiers(request({ candidates: [LOVE, ANDREWS], protections, reserveEligible: new Set(['Shipley']), openReserve: 2 }));
    expect(plan.doThese.map((m) => m.name).sort()).toEqual(['Andrews', 'Love']);
    expect(plan.doThese.find((m) => m.name === 'Love')!.drop?.viaReserve).toBe(true);
    expect(plan.doThese.find((m) => m.name === 'Andrews')!.needsSpot!.length).toBeGreaterThan(0);
  });

  it('frees two spots with two IR moves when the league has two open slots', () => {
    const roster = alexRoster().map((x) => (x.playerId === 'Egbuka' ? { ...x, designation: 'ir', weekly: [0, 0, 0] } : x));
    const plan = planWaiverTiers(request({ roster, candidates: [LOVE, ANDREWS], protections, reserveEligible: new Set(['Shipley', 'Egbuka']), openReserve: 2 }));
    expect(plan.doThese.map((m) => m.name).sort()).toEqual(['Andrews', 'Love']);
    expect(plan.doThese.every((m) => m.drop?.viaReserve)).toBe(true);
    expect(new Set(plan.doThese.map((m) => m.drop?.name)).size).toBe(2);
  });

  it('counts IR moves against the open slots in the joint assignment', () => {
    const picks = assignDrops(
      [
        { id: 'A', priority: 1, options: [{ dropId: 'x', gain: 5, score: -1, reserve: true }] },
        { id: 'B', priority: 1, options: [{ dropId: 'y', gain: 5, score: -1, reserve: true }] },
      ],
      0,
      1,
    );
    expect(picks.size).toBe(1);
  });
});

describe('draft capital', () => {
  it('protects a round 6 or earlier pick unless he is out for the season', () => {
    const roster = [
      { playerId: 'McConkey', designation: 'questionable' },
      { playerId: 'Egbuka', designation: 'healthy' },
      { playerId: 'Late', designation: 'healthy' },
      { playerId: 'Torn', designation: 'ir' },
    ];
    const rounds = new Map([
      ['McConkey', 4],
      ['Egbuka', 6],
      ['Late', 7],
      ['Torn', 2],
    ]);
    const notes = new Map([['Torn', { status: 'IR', bodyPart: 'Knee - ACL', notes: 'Surgery' }]]);
    const out = draftCapital(roster, rounds, notes, 6);
    expect(out.get('McConkey')).toBe('round 4 pick');
    expect(out.get('Egbuka')).toBe('round 6 pick');
    expect(out.has('Late')).toBe(false);
    expect(out.has('Torn')).toBe(false);
  });
});

/*
 * Alex, 14 October, on the live screen: Tre' Harris, picked up a week before,
 * 1.2 points and no real role, sat in his lineup and was missing from the
 * drop list, which led with two elite backs' handcuffs and Emeka Egbuka.
 */
describe('a dead spot is the first drop (Tre’ Harris)', () => {
  const protections = new Map([
    ['BRobinson', { kind: 'handcuff' as const, note: 'backs up Bijan' }],
    ['EJohnson', { kind: 'handcuff' as const, note: 'backs up Walker' }],
    ['McConkey', { kind: 'draft_capital' as const, note: 'round 4 pick' }],
    ['Egbuka', { kind: 'draft_capital' as const, note: 'round 6 pick' }],
    ['Walker', { kind: 'draft_capital' as const, note: 'round 2 pick' }],
  ]);
  const signals = () => {
    const m = alexSignals();
    m.set('Harris', sig('Harris', 'WR', { seasonPoints: 1.2, recent: [1.2, 0, 0], projection: 6, inLineup: true, heldWeeks: 1, injured: true, healthyRate: 6 }));
    m.set('Egbuka', { ...m.get('Egbuka')!, draftRound: 6 });
    m.set('McConkey', { ...m.get('McConkey')!, draftRound: 4 });
    return m;
  };
  const roster = () => alexRoster().map((x) => (x.playerId === 'Harris' ? { ...x, rate: 6, designation: 'questionable' } : x));
  const plan = planWaiverTiers(request({ roster: roster(), dropSignals: signals(), candidates: [LOVE, ANDREWS], protections, reserveEligible: new Set(['Shipley']), openReserve: 2 }));

  it('counts a just-added player with nothing to show as a dead spot, and gives him no weeks-held credit', () => {
    const harris = signals().get('Harris')!;
    expect(isDeadSpot(harris)).toBe(true);
    expect(hasProduced(harris)).toBe(false);
    expect(dropScore(harris).parts.held).toBe(0);
    /* A player out now is never one: Shipley goes to IR. */
    expect(isDeadSpot(signals().get('Shipley')!)).toBe(false);
  });

  it('ranks the recent pickup first, the elite handcuffs next, and the round 6 pick only after them', () => {
    const andrews = plan.doThese.find((m) => m.name === 'Andrews')!;
    expect(andrews.tier).toBe('do_this');
    expect(andrews.drop?.name).toBe('Harris');
    const names = andrews.bestDrops!.map((c) => c.name);
    expect(names[0]).toBe('Harris');
    expect(names.slice(1).sort()).toEqual(['BRobinson', 'EJohnson']);
    expect(names).not.toContain('Egbuka');
    expect(andrews.bestDrops![0]).toMatchObject({ position: 'WR', stat: '1.2 pts' });
    expect(andrews.bestDrops![1]!.stat).toMatch(/^handcuff to /);
  });

  it('still moves Shipley to IR for Love, and puts no list under Love', () => {
    const love = plan.doThese.find((m) => m.name === 'Love')!;
    expect(love.drop).toMatchObject({ name: 'Shipley', viaReserve: true });
    expect(love.bestDrops).toBeUndefined();
  });

  it('keeps a lineup starter who has produced out of the list', () => {
    for (const m of plan.doThese) expect((m.bestDrops ?? []).map((c) => c.name)).not.toContain('Allen');
  });
});
