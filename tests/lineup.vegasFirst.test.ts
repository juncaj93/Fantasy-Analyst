/**
 * Vegas first on the Team screen (16 October 2026, `lineup@5`).
 *
 * A Sleeper-only player (one line posted, ranked on Sleeper's published week)
 * is never started or suggested over a healthy, fully priced player. He takes
 * a slot only when no priced player can. Before this, he ranked at his number
 * less 2 points (`BORROWED_RANKING_DISCOUNT`), so more than 2 ahead won.
 * `assembleLineup` (the Team screen) turns it on; the waiver planner and the
 * trade engine call `recommendLineup` without it and keep the discount.
 */
import { describe, expect, it } from 'vitest';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { LINEUP_ENGINE_VERSION } from '../src/core/startsit/version.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, pricedCandidate } from './helpers/startsit.ts';

const PROFILE = buildScoringProfile({ rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 }, []);
const ONE_WR = buildRosterShape(['WR', 'BN', 'BN']);
const WR_TE = buildRosterShape(['WR', 'TE', 'BN', 'BN']);

const starter = (r: ReturnType<typeof recommendLineup>, slot: string) => r.slots.find((s) => s.slot === slot)?.playerId ?? null;

describe('Vegas first: a Sleeper-only player cannot be started over a priced one', () => {
  const priced = pricedCandidate('p', 'Priced Receiver', 'WR', 10);
  const sleeper = candidate('s', 'Sleeper Receiver', 'WR', 3);
  // His published week is well over 2 points ahead of the priced player's number.
  const published = new Map([['s', 15]]);

  it('before: more than 2 points ahead, the Sleeper-only player took the slot (the old discount)', () => {
    const r = recommendLineup([priced, sleeper], ONE_WR, PROFILE, { published, currentStarterIds: ['p'] });
    expect(starter(r, 'WR')).toBe('s');
    expect(r.swaps.map((s) => s.inPlayerId)).toEqual(['s']);
  });

  it('after: the priced player keeps the slot and no swap to the Sleeper-only player is suggested', () => {
    const r = recommendLineup([priced, sleeper], ONE_WR, PROFILE, { published, currentStarterIds: ['p'], vegasFirst: true });
    expect(starter(r, 'WR')).toBe('p');
    expect(r.swaps).toEqual([]);
  });

  it('after: a Sleeper-only starter is moved out for the priced player on the bench', () => {
    const r = recommendLineup([priced, sleeper], ONE_WR, PROFILE, { published, currentStarterIds: ['s'], vegasFirst: true });
    expect(starter(r, 'WR')).toBe('p');
    expect(r.swaps).toMatchObject([{ inPlayerId: 'p', outPlayerId: 's' }]);
    // The honest gap, negative, and a reason that says why anyway.
    expect(r.swaps[0]!.gain).toBeLessThan(0);
    expect(r.swaps[0]!.reason).toMatch(/full set of Vegas lines.*only Sleeper's projection/);
  });

  it('a Sleeper-only player still fills a slot no priced player can take', () => {
    const te = candidate('t', 'Sleeper Tight End', 'TE', 2);
    const r = recommendLineup([priced, te], WR_TE, PROFILE, { published: new Map([['t', 9]]), currentStarterIds: [], vegasFirst: true });
    expect(starter(r, 'WR')).toBe('p');
    expect(starter(r, 'TE')).toBe('t');
  });

  it('two Sleeper-only players for one slot: the better Sleeper number wins, as before', () => {
    const a = candidate('a', 'Sleeper A', 'WR', 3);
    const b = candidate('b', 'Sleeper B', 'WR', 3);
    const r = recommendLineup([a, b], ONE_WR, PROFILE, { published: new Map([['a', 9], ['b', 12]]), currentStarterIds: ['a'], vegasFirst: true });
    expect(starter(r, 'WR')).toBe('b');
  });

  it('priced players still order on their own numbers', () => {
    const low = pricedCandidate('l', 'Low Priced', 'WR', 6);
    const r = recommendLineup([low, priced, sleeper], ONE_WR, PROFILE, { published, currentStarterIds: ['l'], vegasFirst: true });
    expect(starter(r, 'WR')).toBe('p');
  });

  it('the Team screen (assembleLineup) applies it; the engine version moves', () => {
    const r = assembleLineup({
      inputs: [priced, sleeper],
      shape: ONE_WR,
      profile: PROFILE,
      currentStarterIds: ['p'],
      mode: 'balanced',
      published,
    });
    expect(r.slots.find((s) => s.slot === 'WR')?.playerId).toBe('p');
    expect(r.swaps).toEqual([]);
    expect(LINEUP_ENGINE_VERSION.startsWith('lineup@5')).toBe(true);
  });
});
