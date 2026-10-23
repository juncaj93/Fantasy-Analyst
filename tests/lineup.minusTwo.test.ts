/**
 * The minus-2 rule on every screen that picks a starter (Alex's decision, 23 October 2026).
 *
 * A Sleeper-only player (one line posted, ranked on Sleeper's published week)
 * ranks at his number less 2 points, `BORROWED_RANKING_DISCOUNT`, on Team,
 * Compare, Best move's pick-up test and Matchup. It reverses `lineup@5` ("Vegas
 * first", 16 October 2026), under which he could never be started over a
 * priced player. The number shown is the undocked one; the discount only ranks.
 * Every "after" case below fails on the code before that date.
 */
import { describe, expect, it } from 'vitest';
import { recommendLineup, solveLineup } from '../src/core/startsit/lineup.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { compareStartSit } from '../src/core/startsit/engine.ts';
import { BORROWED_RANKING_DISCOUNT, rankingNumber } from '../src/core/startsit/decisionPoints.ts';
import { LINEUP_ENGINE_VERSION } from '../src/core/startsit/version.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const ONE_WR = buildRosterShape(['WR', 'BN', 'BN']);
const WR_TE = buildRosterShape(['WR', 'TE', 'BN', 'BN']);
const FLEX_ONLY = buildRosterShape(['FLEX', 'BN', 'BN']);

const starter = (r: ReturnType<typeof recommendLineup>, slot: string) => r.slots.find((s) => s.slot === slot)?.playerId ?? null;

describe('the rule', () => {
  it('is two points off a Sleeper-only number and nothing off a priced one', () => {
    expect(BORROWED_RANKING_DISCOUNT).toBe(2);
    expect(rankingNumber(7.74, true)).toBeCloseTo(5.74, 10);
    expect(rankingNumber(5.19, false)).toBe(5.19);
  });
});

describe('Team (assembleLineup)', () => {
  const priced = pricedCandidate('p', 'Priced Receiver', 'WR', 10);
  const sleeper = candidate('s', 'Sleeper Receiver', 'WR', 3);

  it('starts a Sleeper-only player more than 2 points ahead of a priced one', () => {
    const published = new Map([['s', 15]]);
    const r = assembleLineup({ inputs: [priced, sleeper], shape: ONE_WR, profile: PROFILE, currentStarterIds: ['p'], mode: 'balanced', published });
    expect(r.slots.find((s) => s.slot === 'WR')?.playerId).toBe('s');
    expect(r.swaps.map((s) => s.inPlayerId)).toEqual(['s']);
    // The swap prints the honest difference, not the docked one.
    const shown = r.starters.find((e) => e.playerId === 's')!.decision!.points;
    const out = r.bench.find((e) => e.playerId === 'p')!.decision!.points;
    expect(r.swaps[0]!.gain).toBeCloseTo(shown - out, 2);
  });

  it('keeps the priced player when the Sleeper-only one is ahead by less than 2', () => {
    const p = pricedCandidate('p', 'Priced Receiver', 'WR', 10);
    const decided = assembleLineup({ inputs: [p], shape: ONE_WR, profile: PROFILE, currentStarterIds: ['p'], mode: 'balanced', published: new Map() });
    const pricedPoints = decided.starters[0]!.decision!.points;
    const published = new Map([['s', pricedPoints + 1]]);
    const r = assembleLineup({ inputs: [p, sleeper], shape: ONE_WR, profile: PROFILE, currentStarterIds: ['p'], mode: 'balanced', published });
    expect(r.slots.find((s) => s.slot === 'WR')?.playerId).toBe('p');
    expect(r.swaps).toEqual([]);
  });

  it('the week 7 FLEX: a Questionable Sleeper-only 7.74 over a priced 5.19 (KC Concepcion Jr. over Brian Robinson Jr.)', () => {
    const robinson = pricedCandidate('br', 'Brian Robinson Jr.', 'RB', 5.19);
    const concepcion = candidate('kc', 'KC Concepcion Jr.', 'WR', 1, { status: 'Questionable' });
    const decided = assembleLineup({ inputs: [robinson], shape: FLEX_ONLY, profile: PROFILE, currentStarterIds: ['br'], mode: 'balanced', published: new Map() });
    const robinsonPoints = decided.starters[0]!.decision!.points;
    // Concepcion's Sleeper week is 2.55 above Robinson's number: 0.55 clear after the discount.
    const published = new Map([['kc', robinsonPoints + 2.55]]);
    const r = assembleLineup({ inputs: [robinson, concepcion], shape: FLEX_ONLY, profile: PROFILE, currentStarterIds: ['br'], mode: 'balanced', published });
    expect(r.slots.find((s) => s.slot === 'FLEX')?.playerId).toBe('kc');
    // Questionable is full value (D1) and keeps his chip.
    expect(r.starters.find((e) => e.playerId === 'kc')!.statusFlag).toMatch(/Questionable/);
  });

  it('two Sleeper-only players for one slot: the better Sleeper number wins', () => {
    const a = candidate('a', 'Sleeper A', 'WR', 3);
    const b = candidate('b', 'Sleeper B', 'WR', 3);
    const r = recommendLineup([a, b], ONE_WR, PROFILE, { published: new Map([['a', 9], ['b', 12]]), currentStarterIds: ['a'] });
    expect(starter(r, 'WR')).toBe('b');
  });

  it('a Sleeper-only player still fills a slot no priced player can take', () => {
    const te = candidate('t', 'Sleeper Tight End', 'TE', 2);
    const r = recommendLineup([priced, te], WR_TE, PROFILE, { published: new Map([['t', 9]]), currentStarterIds: [] });
    expect(starter(r, 'WR')).toBe('p');
    expect(starter(r, 'TE')).toBe('t');
  });

  it('the engine version moves', () => {
    expect(LINEUP_ENGINE_VERSION.startsWith('lineup@6')).toBe(true);
  });
});

describe('Best move (solveLineup)', () => {
  it('seats a Sleeper-only number more than 2 ahead, and not one less than 2 ahead', () => {
    const shape = buildRosterShape(['WR', 'BN']);
    const ahead = solveLineup(
      [
        { playerId: 'p', name: 'P', position: 'WR', points: 10, borrowed: false },
        { playerId: 's', name: 'S', position: 'WR', points: 12.5, borrowed: true },
      ],
      shape,
    );
    expect([...ahead.starterIds]).toEqual(['s']);
    const close = solveLineup(
      [
        { playerId: 'p', name: 'P', position: 'WR', points: 10, borrowed: false },
        { playerId: 's', name: 'S', position: 'WR', points: 11.5, borrowed: true },
      ],
      shape,
    );
    expect([...close.starterIds]).toEqual(['p']);
  });
});

describe('Compare', () => {
  const compare = (inputs: Parameters<typeof compareStartSit>[0], published: Record<string, number>) =>
    compareStartSit(inputs, PROFILE, { published: new Map(Object.entries(published)) });
  const points = (c: ReturnType<typeof compare>, id: string) => c.evaluations.find((e) => e.playerId === id)!.decision!.points;

  it('picks a Sleeper-only player more than 2 ahead', () => {
    const c = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 6), candidate('m', 'Ladd McConkey', 'WR', 3)], { m: 25 });
    expect(c.recommendedPlayerId).toBe('m');
    expect(c.sleeperOnly).toBeUndefined();
    expect(c.margin).toBeCloseTo(points(c, 'm') - points(c, 'w'), 2);
  });

  it('keeps the priced pick when the Sleeper-only player is ahead by less than 2, and names him second', () => {
    const base = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 12)], {});
    const c = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 12), candidate('m', 'Ladd McConkey', 'WR', 3)], { m: points(base, 'w') + 1 });
    expect(c.recommendedPlayerId).toBe('w');
    expect(c.sleeperOnly).toMatchObject({ playerId: 'm' });
    expect(c.sleeperOnly!.aheadBy).toBeCloseTo(1, 1);
  });

  it('two Sleeper-only players and a priced one: each on its own docked number', () => {
    const c = compare(
      [pricedCandidate('w', 'Garrett Wilson', 'WR', 11), candidate('m', 'Ladd McConkey', 'WR', 3), candidate('p', 'George Pickens', 'WR', 3)],
      { m: 13, p: 30 },
    );
    expect(c.recommendedPlayerId).toBe('p');
  });

  it('all Sleeper-only: the best Sleeper number wins', () => {
    const c = compare([candidate('m', 'Ladd McConkey', 'WR', 3), candidate('p', 'George Pickens', 'WR', 3)], { m: 13, p: 16 });
    expect(c.recommendedPlayerId).toBe('p');
    expect(c.sleeperOnly).toBeUndefined();
  });

  it('a Sleeper-only player behind the pick is not named at all', () => {
    const c = compare([pricedCandidate('w', 'Garrett Wilson', 'WR', 14), candidate('m', 'Ladd McConkey', 'WR', 3)], { m: 8 });
    expect(c.recommendedPlayerId).toBe('w');
    expect(c.sleeperOnly).toBeUndefined();
  });
});
